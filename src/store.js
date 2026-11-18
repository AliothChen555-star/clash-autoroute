'use strict';
// 分配结果持久化：data/state.json
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'state.json');
    this.map = new Map();
    this.timer = null;
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const e of j.entries || []) if (e && e.domain && e.node) this.map.set(e.domain, e);
    } catch (e) {
      const bad = `${this.file}.broken-${Date.now()}`;
      fs.copyFileSync(this.file, bad);
      console.error(`[store] state.json 损坏，已备份到 ${bad}：${e.message}`);
    }
  }

  get(domain) {
    return this.map.get(domain);
  }

  set(entry) {
    this.map.set(entry.domain, entry);
    this.save();
  }

  delete(domain) {
    const ok = this.map.delete(domain);
    this.save();
    return ok;
  }

  list() {
    return [...this.map.values()];
  }

  /** 防抖写盘 */
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 800);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = `${this.file}.tmp`;
    const entries = this.list().sort((a, b) => a.domain.localeCompare(b.domain));
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 1), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
