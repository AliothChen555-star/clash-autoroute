'use strict';
// mihomo 外部控制 API 客户端：优先通过 Clash Verge 的命名管道访问
const http = require('http');
const fs = require('fs');

const PIPE_DIR = '\\\\.\\pipe\\';

class Mihomo {
  constructor(cfg) {
    this.cfg = cfg;
    this.pipe = null;
  }

  findPipe() {
    try {
      const names = fs.readdirSync(PIPE_DIR).filter((n) => /^verge-mihomo/i.test(n));
      if (!names.length) return null;
      // 服务模式的管道名带 production，优先
      names.sort((a, b) => Number(/production/i.test(b)) - Number(/production/i.test(a)));
      return PIPE_DIR + names[0];
    } catch {
      return null;
    }
  }

  target() {
    const c = this.cfg.controller;
    if (c && c !== 'auto') {
      const u = new URL(c.includes('://') ? c : `http://${c}`);
      return { host: u.hostname, port: Number(u.port) || 80 };
    }
    if (!this.pipe) this.pipe = this.findPipe();
    if (!this.pipe) throw new Error('找不到 Clash Verge 内核的控制管道（verge-mihomo*），请确认 Clash Verge 正在运行');
    return { socketPath: this.pipe };
  }

  describe() {
    const c = this.cfg.controller;
    if (c && c !== 'auto') return c;
    return this.pipe || this.findPipe() || '（未找到命名管道）';
  }

  request(method, path, body, timeout = 8000) {
    return new Promise((resolve, reject) => {
      let t;
      try {
        t = this.target();
      } catch (e) {
        reject(e);
        return;
      }
      const headers = {};
      if (this.cfg.secret) headers.Authorization = `Bearer ${this.cfg.secret}`;
      let data;
      if (body !== undefined) {
        data = Buffer.from(JSON.stringify(body));
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = data.length;
      }
      const req = http.request({ ...t, method, path, headers, agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const s = Buffer.concat(chunks).toString('utf8');
          let j = null;
          try {
            j = s ? JSON.parse(s) : null;
          } catch {
            j = null;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
          else {
            const e = new Error((j && j.message) || `HTTP ${res.statusCode}`);
            e.status = res.statusCode;
            reject(e);
          }
        });
        res.on('error', reject);
      });
      req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
      req.on('error', (e) => {
        if (['ENOENT', 'ECONNREFUSED', 'EPIPE', 'ECONNRESET'].includes(e.code)) this.pipe = null;
        reject(e);
      });
      if (data) req.write(data);
      req.end();
    });
  }

  get(path, timeout) {
    return this.request('GET', path, undefined, timeout);
  }

  /** 经指定节点访问 url 的延迟（ms），失败抛错 */
  async delay(node, url, timeout) {
    const p = `/proxies/${encodeURIComponent(node)}/delay?url=${encodeURIComponent(url)}&timeout=${timeout}`;
    const j = await this.get(p, timeout + 3000);
    if (j && typeof j.delay === 'number' && j.delay > 0) return j.delay;
    throw new Error('无有效延迟');
  }

  refreshRuleProvider(name) {
    return this.request('PUT', `/providers/rules/${encodeURIComponent(name)}`, undefined, 10000);
  }
}

module.exports = { Mihomo };
