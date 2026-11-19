'use strict';
// 从 mihomo 运行时读取「节点 ↔ listener 端口」映射。
// 映射以扩展脚本注入的规则 `RULE-SET,autoroute-p<端口>-<节点标识>,<节点>` 为准，
// 因此插件无需重算端口，也不会因组成员顺序差异而错位。

const PROVIDER_RE = /^autoroute-p(\d{1,5})(?:-[a-f0-9]{16})?$/;
const REVISION_RE = /^AutoRoute-UDP-([a-f0-9]+)$/;

class Groups {
  constructor(cfg, api, log) {
    this.cfg = cfg;
    this.api = api;
    this.log = log;
    this.mapping = new Map(); // node -> port
    this.providers = new Map(); // port -> provider
    this.fallbackTarget = null;
    this.fallbackNow = null;
    this.fallbackRuleActive = false;
    this.chinaRules = [];
    this.revision = null;
    this.mode = null;
    this.ok = false; // 能否连上内核
    this.lastError = null;
    this.version = 0; // 映射变化计数
    this.refreshing = null;
  }

  get installed() {
    return this.mapping.size > 0;
  }

  autoNodes() {
    return [...this.mapping.keys()];
  }

  portOf(node) {
    return this.mapping.get(node) || null;
  }

  providerOf(port) {
    return this.providers.get(port) || `autoroute-p${port}`;
  }

  refresh() {
    if (!this.refreshing) this.refreshing = this._refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async _refresh() {
    try {
      const [j, config] = await Promise.all([
        this.api.get('/rules'),
        this.api.get('/configs').catch(() => null),
      ]);
      const next = new Map();
      const providers = new Map();
      const chinaRules = new Set();
      let firstMatch = null;
      let revision = null;
      const rules = j?.rules || [];
      for (const r of rules) {
        if (r.extra?.disabled) continue;
        if (r.type === 'Match' && !firstMatch) firstMatch = r;
        if (!firstMatch && r.proxy === 'AutoRoute-Direct' && String(r.payload).toLowerCase() === 'cn') {
          if (r.type === 'GeoSite') chinaRules.add('domain');
          if (r.type === 'GeoIP') chinaRules.add('ip');
        }
        if (r.type === 'Network') revision = REVISION_RE.exec(r.proxy || '')?.[1] || revision;
        if (r.type !== 'RuleSet') continue;
        const m = PROVIDER_RE.exec(r.payload || '');
        if (m) {
          const port = Number(m[1]);
          const node = r.proxy === 'AutoRoute-Direct' ? 'DIRECT' : r.proxy;
          next.set(node, port);
          providers.set(port, r.payload);
        }
      }
      let fb = null;
      let active = null;
      if (next.size) {
        try {
          const g = await this.api.get(`/proxies/${encodeURIComponent('AutoRoute-Fallback')}`);
          fb = (g && g.all && g.all[1]) || null;
          active = g?.now || null;
        } catch {
          fb = null;
        }
      }
      const changed = !this.ok || revision !== this.revision ||
        !sameMap(next, this.mapping) || !sameMap(providers, this.providers);
      this.mapping = next;
      this.providers = providers;
      this.fallbackTarget = fb;
      this.fallbackNow = active;
      this.fallbackRuleActive = firstMatch?.proxy === 'AutoRoute-Fallback';
      this.chinaRules = [...chinaRules];
      this.revision = revision;
      this.mode = config?.mode?.toLowerCase() || null;
      this.ok = true;
      this.lastError = null;
      if (changed) {
        this.version++;
        this.log.info(`[groups] 节点映射更新：${next.size} 个节点${fb ? `，原出口 ${fb}` : ''}`);
      }
      return changed;
    } catch (e) {
      this.ok = false;
      this.lastError = e.message;
      return false;
    }
  }

  /** 目标组的直接成员（供面板展示 / 设置） */
  async listGroups() {
    const j = await this.api.get('/proxies');
    const out = [];
    for (const p of Object.values((j && j.proxies) || {})) {
      if (Array.isArray(p.all) && !String(p.name).startsWith('AutoRoute-') && p.name !== 'GLOBAL') {
        out.push({ name: p.name, type: p.type, members: p.all });
      }
    }
    return out;
  }
}

function sameMap(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

module.exports = { Groups, PROVIDER_RE };
