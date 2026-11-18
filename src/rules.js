'use strict';
// 根据分配结果生成各节点的规则文件，并通知 mihomo 刷新对应 rule-provider
const fs = require('fs');
const path = require('path');
const { isExcluded } = require('./domain');

const PLACEHOLDER = 'autoroute-placeholder.invalid';

class RuleWriter {
  constructor(cfg, api, store, groups, log) {
    this.cfg = cfg;
    this.api = api;
    this.store = store;
    this.groups = groups;
    this.log = log;
    this.dir = path.join(cfg.vergeHome, 'autoroute');
    this.last = new Map(); // provider -> 已被内核接受的规则内容
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

  async flush(force = false) {
    while (this.running) {
      await this.running.catch(() => {});
    }
    this.running = this._flush(force)
      .catch((e) => {
        this.lastError = e.message;
        throw e;
      })
      .finally(() => { this.running = null; });
    return this.running;
  }

  async _flush(force) {
    if (!this.groups.installed) {
      this.last.clear();
      this.lastError = null;
      return [];
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const byNode = new Map();
    for (const e of this.store.list()) {
      if (isExcluded(this.cfg, e.domain)) continue;
      if (!byNode.has(e.node)) byNode.set(e.node, []);
      byNode.get(e.node).push(e.domain);
    }
    const changed = [];
    const active = new Set();
    for (const [node, port] of this.groups.mapping) {
      const name = this.groups.providerOf(port);
      active.add(name);
      const domains = (byNode.get(node) || []).sort();
      const content = [`# AutoRoute -> ${node}（自动生成，请勿手动编辑）`, PLACEHOLDER, ...domains.map((d) => `+.${d}`)].join('\n') + '\n';
      const file = this.fileOfProvider(name);
      if (!force && this.last.get(name) === content && fs.existsSync(file)) continue;
      let onDisk = null;
      try {
        onDisk = fs.readFileSync(file, 'utf8');
      } catch {
        onDisk = null;
      }
      if (onDisk !== content) fs.writeFileSync(file, content, 'utf8');
      this.last.delete(name);
      changed.push({ name, content });
    }
    for (const name of this.last.keys()) if (!active.has(name)) this.last.delete(name);
    let failure = null;
    const synced = [];
    for (const { name, content } of changed) {
      try {
        await this.api.refreshRuleProvider(name);
        this.last.set(name, content);
        synced.push(name);
      } catch (e) {
        failure = `刷新 ${name} 失败：${e.message}`;
        this.log.warn(`[rules] ${failure}`);
      }
    }
    this.lastError = failure;
    if (synced.length) this.log.info(`[rules] 已刷新 ${synced.length} 个规则集`);
    return synced;
  }

  /** 在内核加载前准备各 provider 对应的文件。 */
  ensureFiles(providers) {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const name of providers) {
      const file = this.fileOfProvider(name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, `# AutoRoute（自动生成）\n${PLACEHOLDER}\n`, 'utf8');
    }
  }
}

module.exports = { RuleWriter, PLACEHOLDER };
