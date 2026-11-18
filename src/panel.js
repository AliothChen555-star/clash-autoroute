'use strict';
// 本地面板 + 管理 API（仅监听 127.0.0.1）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ROOT, DATA_DIR, save: saveConfig } = require('./config');
const { cleanDomain, mainDomain, isExcluded } = require('./domain');
const exporter = require('./exporter');
const vergeScript = require('./verge-script');
const autostart = require('./autostart');

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/panel.css', ['panel.css', 'text/css']],
  ['/panel.js', ['panel.js', 'text/javascript']],
]);

async function readBody(req) {
  const maxSize = 64 * 1024;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= maxSize) chunks.push(chunk);
  }
  if (size > maxSize) throw Object.assign(new Error('请求内容过长'), { status: 413 });
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
    return value;
  } catch {
    throw Object.assign(new Error('请求内容应为 JSON 对象'), { status: 400 });
  }
}

function startPanel(ctx) {
  const { cfg, engine, groups, store, rules, api, log } = ctx;
  const backupDir = path.join(DATA_DIR, 'backup');
  const publicConfig = () => ({ ...cfg, secret: undefined });

  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    const data = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      ...extra,
    });
    res.end(data);
  };

  function status() {
    const list = store.list();
    const installed = vergeScript.installedConfig(cfg);
    const scriptMatches = Boolean(installed && groups.installed && (installed.revision
      ? installed.revision === groups.revision
      : !groups.revision && installed.targetGroup === cfg.targetGroup));
    const eligible = list.filter((e) => !isExcluded(cfg, e.domain));
    return {
      paused: engine.paused,
      controller: api.describe(),
      controllerOk: groups.ok,
      controllerError: groups.lastError,
      mode: groups.mode,
      targetGroup: cfg.targetGroup,
      scriptGroup: installed?.targetGroup || null,
      scriptFileInstalled: Boolean(installed),
      scriptActive: groups.installed,
      scriptMatches,
      fallbackTarget: groups.fallbackTarget,
      fallbackNow: groups.fallbackNow,
      fallbackRuleActive: groups.fallbackRuleActive,
      ruleError: rules.lastError,
      ruleSyncing: Boolean(rules.running),
      nodes: [...groups.mapping].map(([name, port]) => ({ name, port })),
      counts: {
        total: list.length,
        locked: list.filter((e) => e.state === 'locked').length,
        auto: list.filter((e) => e.state === 'auto').length,
        invalid: eligible.filter((e) => !groups.portOf(e.node)).length,
        excluded: list.length - eligible.length,
        lockable: eligible.filter((e) => e.state === 'auto' && groups.portOf(e.node)).length,
        lockedForExport: eligible.filter((e) => e.state === 'locked').length,
      },
      stats: engine.stats,
      autostart: autostart.isEnabled(),
      autoLock: cfg.autoLock,
      events: engine.events.slice(0, 80),
    };
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const m = req.method;

    if (m === 'GET' && assets.has(p)) {
      const [file, type] = assets.get(p);
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'web', file)), `${type}; charset=utf-8`);
    }
    if (m === 'GET' && p === '/api/status') return send(res, 200, status());
    if (m === 'GET' && p === '/api/entries') {
      const list = store.list().map((e) => ({ ...e, valid: !!groups.portOf(e.node), excluded: isExcluded(cfg, e.domain) }));
      return send(res, 200, list);
    }
    if (m === 'POST' && p === '/api/entries') {
      const b = await readBody(req);
      const d = cleanDomain(b.domain);
      if (!d) return send(res, 400, { error: '域名格式不正确' });
      const domain = mainDomain(d) || d;
      if (store.get(domain)) return send(res, 409, { error: `${domain} 已有分配，请在该域名的详情里修改出口。` });
      return send(res, 200, engine.setNode(domain, b.node, b.lock !== false));
    }
    let mm = /^\/api\/entries\/([^/]+)(?:\/(lock|unlock|retest|node))?$/.exec(p);
    if (mm) {
      const domain = decodeURIComponent(mm[1]);
      const act = mm[2];
      if (m === 'DELETE' && !act) return send(res, 200, { ok: engine.remove(domain) });
      if (m === 'POST' && act === 'lock') return send(res, 200, engine.setState(domain, 'locked'));
      if (m === 'POST' && act === 'unlock') return send(res, 200, engine.setState(domain, 'auto'));
      if (m === 'POST' && act === 'retest') return send(res, 200, await engine.retest(domain, true));
      if (m === 'POST' && act === 'node') {
        const b = await readBody(req);
        return send(res, 200, engine.setNode(domain, b.node, b.lock !== false));
      }
    }
    if (m === 'POST' && p === '/api/lock-all') {
      let n = 0;
      for (const e of store.list()) {
        if (e.state === 'auto' && groups.portOf(e.node) && !isExcluded(cfg, e.domain)) {
          e.state = 'locked';
          n++;
        }
      }
      store.save();
      engine.event('lock', `批量锁定 ${n} 个条目`);
      return send(res, 200, { locked: n });
    }
    if (m === 'POST' && p === '/api/pause') {
      engine.paused = true;
      engine.event('pause', '已暂停自动分配（新域名走原出口，已有分配照常生效）');
      return send(res, 200, { paused: true });
    }
    if (m === 'POST' && p === '/api/resume') {
      engine.paused = false;
      engine.event('resume', '已恢复自动分配');
      return send(res, 200, { paused: false });
    }
    if (m === 'GET' && p === '/api/export') {
      const r = exporter.buildExport(cfg, store.list(), groups.fallbackTarget);
      return send(res, 200, r.yaml, 'text/yaml; charset=utf-8', {
        'Content-Disposition': `attachment; filename="autoroute-rules.yaml"`,
        'X-Autoroute-Skipped': r.counts.skipped,
      });
    }
    if (m === 'POST' && p === '/api/export/save') {
      const r = exporter.saveExport(cfg, DATA_DIR, store.list(), groups.fallbackTarget);
      engine.event('export', `已导出：原有 ${r.counts.original} 条 + 锁定 ${r.counts.locked} 条，跳过 ${r.counts.skipped} 条 → ${r.path}`);
      return send(res, 200, { path: r.path, counts: r.counts });
    }
    if (m === 'GET' && p === '/api/groups') {
      const runtimeGroups = vergeScript.readRuntimeConfig(cfg)?.['proxy-groups'] || [];
      const candidates = new Map(runtimeGroups.map((g) => [g?.name, vergeScript.__autoroute_members(g).length]));
      const list = (await groups.listGroups()).map((g) => ({ ...g, candidateCount: candidates.get(g.name) || 0 }));
      return send(res, 200, list);
    }
    if (m === 'GET' && p === '/api/config') return send(res, 200, publicConfig());
    if (m === 'POST' && p === '/api/config') {
      const b = await readBody(req);
      const allowed = ['targetGroup', 'autoLock', 'probeTimeoutMs', 'switchThreshold', 'retestHours', 'expireDays'];
      const next = { ...cfg };
      for (const key of allowed) if (Object.hasOwn(b, key)) next[key] = b[key];
      if (Object.hasOwn(b, 'exclude')) {
        if (!Array.isArray(b.exclude) || b.exclude.some((d) => typeof d !== 'string' || !cleanDomain(d))) {
          return send(res, 400, { error: '排除列表请输入域名，例如 example.com。' });
        }
        next.exclude = [...new Set(b.exclude.map((domain) => mainDomain(cleanDomain(domain))))];
      }
      saveConfig(next);
      Object.assign(cfg, next);
      if (Object.hasOwn(b, 'exclude')) rules.schedule();
      engine.event('config', '设置已保存');
      return send(res, 200, publicConfig());
    }
    if (m === 'GET' && p === '/api/verge-script') {
      let members;
      try {
        members = vergeScript.runtimeMembers(cfg);
      } catch {
        // 等 Clash 应用订阅后再读取实际成员，路径和基础预览仍可展示。
      }
      return send(res, 200, {
        file: vergeScript.globalScriptFile(cfg),
        installed: Boolean(vergeScript.installedConfig(cfg)),
        block: vergeScript.renderBlock(cfg, members),
      });
    }
    if (m === 'POST' && p === '/api/verge-script/install') {
      const body = await readBody(req);
      const targetGroup = body.targetGroup ?? cfg.targetGroup;
      if (typeof targetGroup !== 'string' || !targetGroup) return send(res, 400, { error: '请选择目标代理组。' });
      const next = { ...cfg, targetGroup };
      const r = vergeScript.install(next, backupDir, rules);
      if (targetGroup !== cfg.targetGroup) {
        saveConfig(next);
        cfg.targetGroup = targetGroup;
      }
      engine.event('script', `扩展脚本已写入 ${r.file}（原文件备份：${r.backup}）`);
      return send(res, 200, r);
    }
    if (m === 'POST' && p === '/api/verge-script/uninstall') {
      const r = vergeScript.uninstall(cfg, backupDir);
      engine.event('script', `扩展脚本已移除：${r.file}`);
      return send(res, 200, r);
    }
    if (m === 'POST' && p === '/api/autostart') {
      const b = await readBody(req);
      if (b.enable) autostart.enable();
      else autostart.disable();
      return send(res, 200, { autostart: autostart.isEnabled() });
    }
    if (m === 'POST' && p === '/api/refresh') {
      const changed = await groups.refresh();
      if (groups.ok && groups.installed && (changed || rules.lastError) && !rules.running) {
        await rules.flush(changed);
      }
      return send(res, 200, status());
    }
    if (m === 'POST' && p === '/api/quit') {
      send(res, 200, { ok: true });
      setTimeout(() => ctx.shutdown(), 100);
      return undefined;
    }
    return send(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    const { host, origin } = req.headers;
    const port = req.socket.localPort;
    const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (port === 80) localHosts.push('127.0.0.1', 'localhost');
    if (!localHosts.includes(host) || (origin && origin !== `http://${host}`)) {
      return send(res, 403, { error: '请从本机面板地址访问。' });
    }
    route(req, res).catch((e) => {
      log.warn(`[panel] ${req.method} ${req.url}：${e.message}`);
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.panelPort, '127.0.0.1', () => {
      server.removeListener('error', reject);
      log.info(`[panel] 面板 http://127.0.0.1:${cfg.panelPort}/`);
      resolve(server);
    });
  });
}

module.exports = { startPanel };
