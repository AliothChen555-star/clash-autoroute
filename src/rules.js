'use strict';
// 根据分配结果生成各节点的规则文件，并通知 mihomo 刷新对应 rule-provider
const fs = require('fs');
const path = require('path');
const { isExcluded } = require('./domain');

const PLACEHOLDER = 'autoroute-placeholder.invalid';
const PLACEHOLDER_RE = /^autoroute-placeholder(?:-\d+)?\.invalid$/;
const RULE_LIST_PATH = '/api/rule-lists/';

function replaceFile(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return '';
  }
}

function loadedCount(providers, name) {
  const count = providers[name]?.ruleCount;
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

class RuleWriter {
  constructor(cfg, api, store, groups, log) {
    this.cfg = cfg;
    this.api = api;
    this.store = store;
    this.groups = groups;
    this.log = log;
    this.dir = path.join(cfg.vergeHome, 'autoroute');
    this.written = new Map(); // provider -> 当前文件和最近一次确认的条数
    this.lastError = null;
    this.timer = null;
    this.running = null;
  }

  fileOfProvider(provider) {
    return path.join(this.dir, provider.slice('autoroute-'.length) + '.list');
  }

  /** 合并短时间内的多次变更 */
  schedule(delay = 120) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((e) => this.log.error(`[rules] 写入失败：${e.message}`));
    }, delay);
  }

  async flush() {
    while (this.running) {
      await this.running.catch(() => {});
    }
    this.running = this._flush()
      .catch((e) => {
        this.lastError = e.message;
        throw e;
      })
      .finally(() => { this.running = null; });
    return this.running;
  }

  async readProviders() {
    const result = await this.api.get('/providers/rules');
    if (!result?.providers || typeof result.providers !== 'object') throw new Error('内核未返回规则集列表');
    return result.providers;
  }

  async _flush() {
    if (!this.groups.installed) {
      this.written.clear();
      this.lastError = null;
      return [];
    }
    const version = this.groups.version;
    const before = await this.readProviders();
    if (version !== this.groups.version) throw new Error('代理组已变更，等待重新核对规则集');
    fs.mkdirSync(this.dir, { recursive: true });
    const byNode = new Map();
    for (const e of this.store.list()) {
      if (isExcluded(this.cfg, e.domain) || PLACEHOLDER_RE.test(e.domain)) continue;
      if (!byNode.has(e.node)) byNode.set(e.node, []);
      byNode.get(e.node).push(e.domain);
    }
    const active = new Set();
    const ready = new Map();
    const errors = new Map();
    for (const [node, port] of this.groups.mapping) {
      const name = this.groups.providerOf(port);
      active.add(name);
      try {
        const count = loadedCount(before, name);
        if (count === null) throw new Error('内核未返回已加载条数');
        const domains = (byNode.get(node) || []).sort().map((d) => `+.${d}`);
        const body = domains.join('\n');
        const file = this.fileOfProvider(name);
        const onDisk = readFile(file);
        let state = this.written.get(name);
        if (!state || state.body !== body || state.content !== onDisk) {
          // 条数也能区分业务域名数量相同的两版。重试沿用已经写好的版本。
          const previousCounts = new Set([count, state?.count, state?.lastCount,
            onDisk.split('\n').filter((line) => line.trim() && !line.startsWith('#')).length]);
          const placeholders = [PLACEHOLDER];
          while (previousCounts.has(domains.length + placeholders.length)) {
            placeholders.push(`autoroute-placeholder-${placeholders.length + 1}.invalid`);
          }
          const content = [`# AutoRoute -> ${node}（自动生成，请勿手动编辑）`, ...placeholders, ...domains].join('\n') + '\n';
          replaceFile(file, content);
          state = { body, content, count: domains.length + placeholders.length, lastCount: state?.lastCount, version: null };
          this.written.set(name, state);
        }
        ready.set(name, state);
      } catch (e) {
        errors.set(name, e.message);
      }
    }
    for (const name of this.written.keys()) if (!active.has(name)) this.written.delete(name);

    const refreshed = new Set();
    for (const [name, state] of ready) {
      if (state.version === version && loadedCount(before, name) === state.count) continue;
      state.version = null;
      try {
        await this.api.refreshRuleProvider(name);
        refreshed.add(name);
      } catch (e) {
        errors.set(name, e.message);
      }
      if (version !== this.groups.version) throw new Error('代理组已变更，等待重新核对规则集');
    }

    const after = refreshed.size ? await this.readProviders() : before;
    if (version !== this.groups.version) throw new Error('代理组已变更，等待重新核对规则集');
    const synced = [];
    for (const [name, state] of ready) {
      if (errors.has(name)) continue;
      const actual = loadedCount(after, name);
      if (actual !== state.count) {
        state.version = null;
        const hint = after[name]?.vehicleType === 'File' ? '（服务模式请重新写入并应用扩展脚本）' : '';
        errors.set(name, `应加载 ${state.count} 条，内核返回 ${actual ?? '未知'}${hint}`);
        continue;
      }
      state.version = version;
      state.lastCount = actual;
      if (refreshed.has(name)) synced.push(name);
    }
    const failure = [...errors].map(([name, reason]) => `${name}：${reason}`).join('。') || null;
    if (failure && failure !== this.lastError) this.log.warn(`[rules] ${failure}`);
    this.lastError = failure;
    if (synced.length) this.log.info(`[rules] 已刷新 ${synced.length} 个规则集`);
    return synced;
  }

  /** 在内核加载前准备各 provider 对应的文件。 */
  ensureFiles(providers) {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const name of providers) {
      const file = this.fileOfProvider(name);
      if (!fs.existsSync(file)) replaceFile(file, `# AutoRoute（自动生成）\n${PLACEHOLDER}\n`);
    }
  }
}

module.exports = { RuleWriter, PLACEHOLDER, RULE_LIST_PATH };
