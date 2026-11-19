'use strict';
// 核心调度：新域名拦截 → 竞速测速 → 写规则；以及复测、过期、使用情况统计
const { mainDomain, isExcluded } = require('./domain');
const { pickBest } = require('./prober');

const DECISION_TIMEOUT_MS = 3500;

function waitForDecision(decision, signal) {
  if (signal?.aborted) return Promise.resolve(undefined);
  let stop;
  const deadline = new Promise((resolve) => { stop = () => resolve(undefined); });
  const timer = setTimeout(stop, DECISION_TIMEOUT_MS);
  signal?.addEventListener('abort', stop, { once: true });
  return Promise.race([decision, deadline]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  });
}

class Engine {
  constructor({ cfg, api, store, groups, rules, prober, log }) {
    Object.assign(this, { cfg, api, store, groups, rules, prober, log });
    this.paused = false;
    this.measurements = new Map(); // domain -> 当前允许提交结果的测速批次
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
  async route(host, port, signal) {
    this.stats.hooked++;
    const domain = mainDomain(host);
    if (!domain) return this.fallback('无域名');
    if (this.paused) return this.fallback('已暂停');
    if (isExcluded(this.cfg, domain)) return this.fallback('排除列表');

    const existing = this.existingRoute(domain);
    if (existing) return existing;
    if (this.failCache.get(domain) > Date.now()) return this.fallback('近期测速失败');

    let batch = this.measurements.get(domain);
    if (batch?.kind !== 'initial' || batch.version !== this.groups.version) {
      const nodes = this.groups.autoNodes();
      if (!nodes.length) return this.fallback('没有可用节点');
      batch = this.startAssignment(domain, host, port, nodes);
    }
    batch.waiters++;
    let handedOff = false;
    try {
      const best = await waitForDecision(batch.decision, signal);
      if (signal?.aborted) return null;
      if (this.paused) return this.fallback('已暂停');
      if (isExcluded(this.cfg, domain)) return this.fallback('排除列表');
      const current = this.existingRoute(domain);
      if (current) return current;
      if (!this.isCurrent(domain, batch)) return this.fallback('测速期间设置已变更');
      if (best === undefined) return this.fallback('等待测速超时');
      if (!best) {
        if (!batch.reportedFailure) {
          batch.reportedFailure = true;
          this.failCache.set(domain, Date.now() + this.cfg.failCacheMinutes * 60e3);
          this.event('fail', `${domain}：所有节点测速失败，暂走原出口`);
        }
        return this.fallback('测速失败');
      }
      const outlet = this.groups.portOf(best.node);
      if (!outlet) return this.fallback('节点已变更');
      handedOff = true;
      return {
        port: outlet,
        node: best.node,
        reason: '首连候选',
        finish: (connected) => {
          try {
            if (connected) this.confirmAssignment(domain, batch, best, outlet);
          } finally {
            this.releaseAssignment(domain, batch);
          }
        },
      };
    } finally {
      if (!handedOff) this.releaseAssignment(domain, batch);
    }
  }

  existingRoute(domain) {
    const entry = this.store.get(domain);
    if (!entry) return null;
    const port = this.groups.portOf(entry.node);
    if (port) {
      // 规则集刷新前的短暂窗口里，同域名连接仍会到这里
      entry.lastSeen = Date.now();
      return { port, node: entry.node, reason: '已分配' };
    }
    if (entry.state === 'locked') return this.fallback(`锁定节点 ${entry.node} 不可用`);
    this.store.delete(domain);
    this.measurements.delete(domain);
    this.event('stale', `${domain}：原节点 ${entry.node} 已不在组内，重新测速`);
    return null;
  }

  startAssignment(domain, host, port, nodes) {
    const startedAt = Date.now();
    const { decision, all } = this.prober.probe(host, port, nodes, true);
    const batch = { kind: 'initial', version: this.groups.version, host, startedAt, decision,
      hasDirect: nodes.includes('DIRECT'), waiters: 0, complete: false };
    this.measurements.set(domain, batch);
    all.then((delays) => {
      batch.delays = delays;
      if (batch.entry) this.finishInitialDelays(domain, batch);
    }).catch((e) => {
      this.log.warn(`[probe] ${domain}：${e.message}`);
    }).finally(() => {
      batch.complete = true;
      this.cleanupAssignment(domain, batch);
    });
    return batch;
  }

  isCurrent(domain, batch) {
    return this.measurements.get(domain) === batch && this.groups.version === batch.version && !isExcluded(this.cfg, domain);
  }

  releaseAssignment(domain, batch) {
    batch.waiters--;
    this.cleanupAssignment(domain, batch);
  }

  cleanupAssignment(domain, batch) {
    if (batch.complete && batch.waiters === 0 && this.measurements.get(domain) === batch) {
      this.measurements.delete(domain);
    }
  }

  confirmAssignment(domain, batch, best, port) {
    if (!this.isCurrent(domain, batch) || this.paused || this.store.get(domain) || this.groups.portOf(best.node) !== port) return;
    const now = Date.now();
    const entry = {
      domain,
      node: best.node,
      delay: best.delay,
      state: this.cfg.autoLock ? 'locked' : 'auto',
      delays: best.delays,
      sampleHost: batch.host,
      createdAt: now,
      testedAt: now,
      testedWithDirect: batch.hasDirect && Object.hasOwn(best.delays, 'DIRECT'),
      lastSeen: now,
      hits: 1,
    };
    batch.entry = entry;
    this.store.set(entry);
    this.failCache.delete(domain);
    this.rules.schedule();
    this.stats.assigned++;
    this.event('assign', `${domain} → ${best.node}（${best.delay}ms，等待 ${now - batch.startedAt}ms）`);
    if (batch.delays) this.finishInitialDelays(domain, batch);
  }

  finishInitialDelays(domain, batch) {
    const cur = this.store.get(domain);
    if (cur !== batch.entry || !this.isCurrent(domain, batch)) return;
    const delays = batch.delays;
    cur.delays = delays;
    cur.testedWithDirect = batch.hasDirect;
    const best = pickBest(delays);
    if (typeof delays[cur.node] === 'number') cur.delay = delays[cur.node];
    if (!this.paused && cur.state === 'auto' && best && best.node !== cur.node && this.shouldSwitch(cur.delay, best.delay)) {
      this.event('switch', `${domain}：${cur.node} → ${best.node}（${cur.delay}ms → ${best.delay}ms）`);
      cur.node = best.node;
      cur.delay = best.delay;
      this.rules.schedule();
    }
    this.store.save();
  }

  shouldSwitch(curDelay, newDelay) {
    if (typeof newDelay !== 'number') return false;
    if (typeof curDelay !== 'number') return true; // 当前节点已不通
    return newDelay < curDelay * (1 - this.cfg.switchThreshold) && curDelay - newDelay >= this.cfg.switchMinDiffMs;
  }

  /** 完整重测一个域名；manual=true 时锁定条目也会测，但不会自动改节点 */
  async retest(domain, manual = false) {
    const active = this.measurements.get(domain);
    if (active && !manual) return;
    const e = this.store.get(domain);
    if (!e) throw new Error('条目不存在');
    if (isExcluded(this.cfg, domain)) throw new Error('域名已排除，请先在接入设置中解除排除');
    const nodes = this.groups.autoNodes();
    if (!nodes.length) throw new Error('没有可用节点（扩展脚本未生效？）');
    if (active?.kind === 'manual' && active.entry === e && this.isCurrent(domain, active)) return active.result;
    const batch = { kind: manual ? 'manual' : 'background', entry: e, version: this.groups.version };
    this.measurements.set(domain, batch);
    try {
      batch.result = this.finishRetest(domain, batch, nodes, manual);
      return await batch.result;
    } finally {
      if (this.measurements.get(domain) === batch) this.measurements.delete(domain);
    }
  }

  async finishRetest(domain, batch, nodes, manual) {
    const e = batch.entry;
    const candidates = manual && !nodes.includes('DIRECT') ? [...nodes, 'DIRECT'] : nodes;
    const { all } = this.prober.probe(e.sampleHost || domain, 443, candidates, false);
    const delays = await all;
    const cur = this.store.get(domain);
    if (cur !== e || !this.isCurrent(domain, batch)) {
      if (manual) throw new Error('条目或代理组已变更，请重新测速');
      return;
    }
    cur.delays = delays;
    cur.testedAt = Date.now();
    cur.testedWithDirect = nodes.includes('DIRECT');
    cur.delay = typeof delays[cur.node] === 'number' ? delays[cur.node] : null;
    // 旧脚本尚未加载直连入站时，手动测出的 DIRECT 只作为对照。
    const b = pickBest(Object.fromEntries(nodes.map((node) => [node, delays[node]])));
    const allowSwitch = b && (manual ? !nodes.includes(cur.node) || b.delay < (cur.delay ?? Infinity)
      : !this.paused && this.shouldSwitch(cur.delay, b.delay));
    if (cur.state === 'auto' && b && b.node !== cur.node && allowSwitch) {
      this.event('switch', `${domain}：${cur.node} → ${b.node}（${cur.delay ?? '超时'} → ${b.delay}ms，${manual ? '手动重测' : '定期复测'}）`);
      cur.node = b.node;
      cur.delay = b.delay;
      this.rules.schedule();
    }
    this.store.save();
    return cur;
  }

  /** 定期复测近期活跃的自动条目，并补测旧记录新增的直连候选 */
  async retestCycle(limit = 5) {
    if (this.retesting || this.paused || !this.groups.installed) return;
    this.retesting = true;
    try {
      const now = Date.now();
      const hasDirect = Boolean(this.groups.portOf('DIRECT'));
      const due = this.store
        .list()
        .filter(
          (e) =>
            e.state === 'auto' &&
            !this.measurements.has(e.domain) &&
            !isExcluded(this.cfg, e.domain) &&
            this.groups.portOf(e.node) &&
            ((hasDirect && !e.testedWithDirect) || now - (e.testedAt || 0) > this.cfg.retestHours * 3600e3) &&
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
        this.measurements.delete(e.domain);
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
    this.measurements.delete(domain);
    e.state = state;
    this.store.save();
    this.event(state === 'locked' ? 'lock' : 'unlock', `${domain}：${state === 'locked' ? '已锁定' : '已解锁'}（${e.node}）`);
    return e;
  }

  lockAll() {
    let count = 0;
    for (const e of this.store.list()) {
      if (e.state !== 'auto' || !this.groups.portOf(e.node) || isExcluded(this.cfg, e.domain)) continue;
      this.measurements.delete(e.domain);
      e.state = 'locked';
      count++;
    }
    if (count) this.store.save();
    this.event('lock', `批量锁定 ${count} 个条目`);
    return count;
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
    this.measurements.delete(domain);
    this.store.set(e);
    this.failCache.delete(domain);
    this.rules.schedule();
    this.event('manual', `${domain} → ${node}（手动${lock ? '，已锁定' : ''}）`);
    return e;
  }

  remove(domain) {
    this.measurements.delete(domain);
    const ok = this.store.delete(domain);
    if (ok) {
      this.rules.schedule();
      this.event('delete', `${domain}：已删除，下次访问将重新测速`);
    }
    return ok;
  }
}

module.exports = { Engine };
