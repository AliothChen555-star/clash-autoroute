'use strict';
// 核心调度：新域名拦截 → 竞速测速 → 写规则；以及复测、过期、使用情况统计
const { mainDomain, isExcluded } = require('./domain');
const { pickBest } = require('./prober');

class Engine {
  constructor({ cfg, api, store, groups, rules, prober, log }) {
    Object.assign(this, { cfg, api, store, groups, rules, prober, log });
    this.paused = false;
    this.inflight = new Map(); // domain -> Promise<entry|null>
    this.failCache = new Map(); // domain -> until(ms)
    this.events = [];
    this.stats = { hooked: 0, assigned: 0, fallback: 0, startedAt: Date.now() };
    this.seenConn = new Set();
    this.retesting = false;
  }

  event(type, msg) {
    this.events.unshift({ t: Date.now(), type, msg });
    if (this.events.length > 300) this.events.length = 300;
    this.log.info(msg);
  }

  fallback(reason) {
    this.stats.fallback++;
    return { port: this.cfg.listenerBase, node: null, reason };
  }

  /** Hook 收到的每个连接：返回应交给哪个 listener 端口 */
  async route(host, port) {
    this.stats.hooked++;
    const domain = mainDomain(host);
    if (!domain) return this.fallback('无域名');
    if (this.paused) return this.fallback('已暂停');
    if (isExcluded(this.cfg, domain)) return this.fallback('排除列表');

    const e = this.store.get(domain);
    if (e) {
      const p = this.groups.portOf(e.node);
      if (p) {
        // 规则集刷新前的短暂窗口里，同域名连接仍会到这里
        e.lastSeen = Date.now();
        return { port: p, node: e.node, reason: '已分配' };
      }
      if (e.state === 'locked') return this.fallback(`锁定节点 ${e.node} 不可用`);
      this.store.delete(domain);
      this.event('stale', `${domain}：原节点 ${e.node} 已不在组内，重新测速`);
    }

    const until = this.failCache.get(domain);
    if (until && until > Date.now()) return this.fallback('近期测速失败');

    let pr = this.inflight.get(domain);
    if (!pr) {
      pr = this.assign(domain, host, port).finally(() => this.inflight.delete(domain));
      this.inflight.set(domain, pr);
    }
    const r = await pr;
    if (r) {
      const p = this.groups.portOf(r.node);
      if (p) return { port: p, node: r.node, reason: '新分配' };
    }
    return this.fallback('测速失败');
  }

  async assign(domain, host, port) {
    const nodes = this.groups.nodes();
    if (!nodes.length) return null;
    const version = this.groups.version;
    const t0 = Date.now();
    const { decision, all } = this.prober.probe(host, port, nodes, true);
    const best = await decision;
    if (this.paused || isExcluded(this.cfg, domain)) return null;
    const current = this.store.get(domain);
    if (current) return current; // 测速等待期间用户可能已经手动选定出口
    if (version !== this.groups.version) return null;
    if (!best) {
      this.failCache.set(domain, Date.now() + this.cfg.failCacheMinutes * 60e3);
      this.event('fail', `${domain}：所有节点测速失败，暂走原出口`);
      return null;
    }
    const now = Date.now();
    const entry = {
      domain,
      node: best.node,
      delay: best.delay,
      state: this.cfg.autoLock ? 'locked' : 'auto',
      delays: best.delays,
      sampleHost: host,
      createdAt: now,
      testedAt: now,
      lastSeen: now,
      hits: 1,
    };
    this.store.set(entry);
    this.failCache.delete(domain);
    this.rules.schedule();
    this.stats.assigned++;
    this.event('assign', `${domain} → ${best.node}（${best.delay}ms，等待 ${now - t0}ms）`);

    // 其余节点测完后补全延迟表；若后到结果明显更快（unified-delay 下可能出现），自动模式下修正
    all.then((delays) => {
      const cur = this.store.get(domain);
      if (cur !== entry || version !== this.groups.version || isExcluded(this.cfg, domain)) return;
      cur.delays = delays;
      const b = pickBest(delays);
      if (typeof delays[cur.node] === 'number') cur.delay = delays[cur.node];
      if (!this.paused && cur.state === 'auto' && b && b.node !== cur.node && this.shouldSwitch(cur.delay, b.delay)) {
        this.event('switch', `${domain}：${cur.node} → ${b.node}（${cur.delay}ms → ${b.delay}ms）`);
        cur.node = b.node;
        cur.delay = b.delay;
        this.rules.schedule();
      }
      this.store.save();
    });
    return entry;
  }

  shouldSwitch(curDelay, newDelay) {
    if (typeof newDelay !== 'number') return false;
    if (typeof curDelay !== 'number') return true; // 当前节点已不通
    return newDelay < curDelay * (1 - this.cfg.switchThreshold) && curDelay - newDelay >= this.cfg.switchMinDiffMs;
  }

  /** 完整重测一个域名；manual=true 时锁定条目也会测，但不会自动改节点 */
  async retest(domain, manual = false) {
    const e = this.store.get(domain);
    if (!e) throw new Error('条目不存在');
    if (isExcluded(this.cfg, domain)) throw new Error('域名已排除，请先在接入设置中解除排除');
    const nodes = this.groups.nodes();
    if (!nodes.length) throw new Error('没有可用节点（扩展脚本未生效？）');
    const version = this.groups.version;
    const { all } = this.prober.probe(e.sampleHost || domain, 443, nodes, false);
    const delays = await all;
    const cur = this.store.get(domain);
    if (cur !== e || version !== this.groups.version || isExcluded(this.cfg, domain)) {
      throw new Error('条目或代理组已变更，请重新测速');
    }
    cur.delays = delays;
    cur.testedAt = Date.now();
    cur.delay = typeof delays[cur.node] === 'number' ? delays[cur.node] : null;
    const b = pickBest(delays);
    if (cur.state === 'auto' && b && b.node !== cur.node && (manual ? b.delay < (cur.delay ?? Infinity) : !this.paused && this.shouldSwitch(cur.delay, b.delay))) {
      this.event('switch', `${domain}：${cur.node} → ${b.node}（${cur.delay ?? '超时'} → ${b.delay}ms，${manual ? '手动重测' : '定期复测'}）`);
      cur.node = b.node;
      cur.delay = b.delay;
      this.rules.schedule();
    }
    this.store.save();
    return cur;
  }

  /** 定期复测：自动条目、超过 retestHours 未测、近期仍在使用 */
  async retestCycle(limit = 5) {
    if (this.retesting || this.paused || !this.groups.installed) return;
    this.retesting = true;
    try {
      const now = Date.now();
      const due = this.store
        .list()
        .filter(
          (e) =>
            e.state === 'auto' &&
            !isExcluded(this.cfg, e.domain) &&
            this.groups.portOf(e.node) &&
            now - (e.testedAt || 0) > this.cfg.retestHours * 3600e3 &&
            now - (e.lastSeen || 0) < this.cfg.retestActiveDays * 86400e3,
        )
        .sort((a, b) => (a.testedAt || 0) - (b.testedAt || 0))
        .slice(0, limit);
      for (const e of due) {
        try {
          await this.retest(e.domain, false);
        } catch (err) {
          this.log.warn(`[retest] ${e.domain}：${err.message}`);
        }
      }
    } finally {
      this.retesting = false;
    }
  }

  /** 自动条目长期未使用则移除 */
  expire() {
    const now = Date.now();
    let n = 0;
    for (const e of this.store.list()) {
      if (e.state === 'auto' && now - (e.lastSeen || e.createdAt || 0) > this.cfg.expireDays * 86400e3) {
        this.store.delete(e.domain);
        n++;
      }
    }
    if (n) {
      this.event('expire', `清理 ${n} 个超过 ${this.cfg.expireDays} 天未使用的自动条目`);
      this.rules.schedule();
    }
    for (const [d, until] of this.failCache) if (until < now) this.failCache.delete(d);
  }

  /** 从 /connections 统计各条目的使用情况（命中 autoroute 规则集的连接） */
  async watchConnections() {
    let j;
    try {
      j = await this.api.get('/connections', 8000);
    } catch {
      return;
    }
    const now = Date.now();
    const ids = new Set();
    let dirty = false;
    for (const c of (j && j.connections) || []) {
      ids.add(c.id);
      if (c.rule !== 'RuleSet' || !String(c.rulePayload || '').startsWith('autoroute-p')) continue;
      const m = c.metadata || {};
      const d = mainDomain(m.host || m.sniffHost);
      const e = d && this.store.get(d);
      if (!e) continue;
      e.lastSeen = now;
      if (!this.seenConn.has(c.id)) e.hits = (e.hits || 0) + 1;
      dirty = true;
    }
    this.seenConn = ids;
    if (dirty) this.store.save();
  }

  // ---- 面板操作 ----
  setState(domain, state) {
    const e = this.store.get(domain);
    if (!e) throw new Error('条目不存在');
    e.state = state;
    this.store.save();
    this.event(state === 'locked' ? 'lock' : 'unlock', `${domain}：${state === 'locked' ? '已锁定' : '已解锁'}（${e.node}）`);
    return e;
  }

  setNode(domain, node, lock = true) {
    if (isExcluded(this.cfg, domain)) throw new Error('域名已排除，请先在接入设置中解除排除');
    if (!this.groups.portOf(node)) throw new Error(`节点 ${node} 不在当前映射中`);
    const now = Date.now();
    let e = this.store.get(domain);
    if (!e) {
      e = { domain, delays: {}, delay: null, sampleHost: domain, createdAt: now, testedAt: 0, lastSeen: now, hits: 0 };
    }
    e.node = node;
    e.delay = e.delays && typeof e.delays[node] === 'number' ? e.delays[node] : null;
    if (lock) e.state = 'locked';
    else e.state = e.state || 'auto';
    this.store.set(e);
    this.failCache.delete(domain);
    this.rules.schedule();
    this.event('manual', `${domain} → ${node}（手动${lock ? '，已锁定' : ''}）`);
    return e;
  }

  remove(domain) {
    const ok = this.store.delete(domain);
    if (ok) {
      this.rules.schedule();
      this.event('delete', `${domain}：已删除，下次访问将重新测速`);
    }
    return ok;
  }
}

module.exports = { Engine };
