'use strict';
// 竞速测速：并发测所有节点到目标域名的延迟，最先成功者 + 短暂宽限后即做决定

class Semaphore {
  constructor(n) {
    this.n = n;
    this.q = [];
  }

  async run(fn) {
    if (this.n > 0) this.n--;
    else await new Promise((r) => this.q.push(r));
    try {
      return await fn();
    } finally {
      const next = this.q.shift();
      if (next) next();
      else this.n++;
    }
  }
}

function pickBest(delays) {
  let best = null;
  for (const [node, d] of Object.entries(delays)) {
    if (typeof d === 'number' && (!best || d < best.delay)) best = { node, delay: d };
  }
  return best;
}

function probeUrl(host, port) {
  // 80 用 http；其余端口一律以 https://host/ 近似线路延迟
  return Number(port) === 80 ? `http://${host}/` : `https://${host}/`;
}

class Prober {
  constructor(cfg, api) {
    this.cfg = cfg;
    this.api = api;
    this.sem = new Semaphore(cfg.maxConcurrentProbes);
    this.count = 0;
  }

  /**
   * @returns {{decision: Promise<{node,delay,delays}|null>, all: Promise<object>}}
   *  decision：竞速模式下尽早给出；all：全部节点测完后的完整延迟表
   */
  probe(host, port, nodes, race = true) {
    this.count++;
    const url = probeUrl(host, port);
    const timeout = this.cfg.probeTimeoutMs;
    const delays = {};
    let pending = nodes.length;
    let settled = false;
    let graceTimer = null;
    let resolveDecision;
    const decision = new Promise((r) => (resolveDecision = r));
    const decide = () => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      const best = pickBest(delays);
      resolveDecision(best ? { ...best, delays: { ...delays } } : null);
    };
    if (!nodes.length) decide();
    const tasks = nodes.map((node) =>
      this.sem
        .run(() => this.api.delay(node, url, timeout))
        .then((d) => {
          delays[node] = d;
        })
        .catch(() => {
          delays[node] = null;
        })
        .finally(() => {
          pending--;
          if (race && !graceTimer && !settled && typeof delays[node] === 'number') {
            graceTimer = setTimeout(decide, this.cfg.raceGraceMs);
          }
          if (pending === 0) decide();
        }),
    );
    const all = Promise.all(tasks).then(() => ({ ...delays }));
    return { decision, all };
  }
}

module.exports = { Prober, pickBest, probeUrl };
