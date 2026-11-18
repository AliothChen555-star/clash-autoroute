'use strict';
// 主入口：启动 Hook（SOCKS5 首连拦截）、本地控制面板、系统托盘与后台同步循环
const { load: loadConfig, save: saveConfig, DATA_DIR } = require('./config');
const { createLogger } = require('./logger');
const { Mihomo } = require('./mihomo');
const { Store } = require('./store');
const { Groups } = require('./groups');
const { RuleWriter } = require('./rules');
const { Prober } = require('./prober');
const { Engine } = require('./engine');
const { startHook } = require('./hook');
const { startPanel } = require('./panel');
const { startTray } = require('./tray');
const { prepareGroup, readRuntimeConfig, __autoroute_members } = require('./verge-script');

async function startApp(customCfg) {
  const cfg = customCfg || loadConfig();
  if (process.argv.includes('--no-tray')) cfg.tray = false;

  const log = createLogger(DATA_DIR);
  const api = new Mihomo(cfg);
  const store = new Store(DATA_DIR);
  const groups = new Groups(cfg, api, log);
  const rules = new RuleWriter(cfg, api, store, groups, log);
  const prober = new Prober(cfg, api);
  const engine = new Engine({ cfg, api, store, groups, rules, prober, log });

  // 首次若未指定 targetGroup，自动探测第一个非 GLOBAL 的代理组并预生成规则文件
  try {
    if (!cfg.targetGroup) {
      const candidates = readRuntimeConfig(cfg)?.['proxy-groups'] || [];
      const target = candidates.find((g) => g?.name && g.name !== 'GLOBAL' && !g.name.startsWith('AutoRoute-') && __autoroute_members(g).length);
      if (target) {
        cfg.targetGroup = target.name;
        if (!customCfg) saveConfig(cfg);
        log.info(`[init] 自动选择默认目标代理组：${cfg.targetGroup}`);
      }
    }
    if (cfg.targetGroup) prepareGroup(cfg, rules);
  } catch (e) {
    log.warn(`[init] 预建规则文件失败：${e.message}；可在面板中重新写入脚本`);
  }

  await groups.refresh();
  if (groups.installed) await rules.flush(true).catch((e) => log.warn(`[init] ${e.message}`));

  const hook = await startHook(cfg, engine, log);
  const ctx = { cfg, api, store, groups, rules, prober, engine, log, shutdown };
  const panel = await startPanel(ctx);
  const tray = startTray(cfg, log);

  // 定时任务：同步节点映射、统计连接命中、定期复测与过期清理
  let syncing = false;
  const tSync = setInterval(async () => {
    if (syncing) return;
    syncing = true;
    try {
      const changed = await groups.refresh();
      if (groups.ok && (changed || (rules.lastError && !rules.running))) {
        rules.flush(changed).catch((e) => log.warn(`[sync] ${e.message}`));
      }
      await engine.watchConnections();
    } catch (e) {
      log.warn(`[sync] ${e.message}`);
    } finally {
      syncing = false;
    }
  }, 6000);

  const tMaint = setInterval(() => {
    engine.expire();
    engine.retestCycle().catch(() => {});
  }, 60000);

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    log.info('[main] 正在保存状态并退出...');
    clearInterval(tSync);
    clearInterval(tMaint);
    tray.stop();
    try {
      store.flush();
    } catch {
      /* ignore */
    }
    hook.server.close();
    panel.close();
    log.close();
    if (!customCfg) process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return ctx;
}

if (require.main === module) {
  startApp().catch((e) => {
    console.error('[fatal]', e);
    process.exit(1);
  });
}

module.exports = { startApp };
