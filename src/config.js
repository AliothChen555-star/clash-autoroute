'use strict';
// 配置加载：data/config.json（首次运行自动生成）
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  // 参与竞速的代理组（其直接成员即候选节点）
  targetGroup: '',
  // 插件端口
  panelPort: 7898, // 本地面板
  hookPort: 7899, // mihomo 的 AutoRoute-Hook(socks5) 指向这里
  // mihomo 入站 listener：listenerBase = 原 MATCH 出口；listenerBase+1 起为各节点
  listenerBase: 7900,
  listenerRange: 999,
  // 内核控制：'auto' = 自动发现 Clash Verge 的命名管道；或 'http://127.0.0.1:9097'
  controller: 'auto',
  secret: '',
  // Clash Verge Rev 数据目录（mihomo home）
  vergeHome: path.join(process.env.APPDATA || '', 'io.github.clash-verge-rev.clash-verge-rev'),
  // fallback 组健康检查地址：插件会本地应答该主机，原出口则真实访问
  healthUrl: 'http://cp.cloudflare.com/generate_204',
  // 测速
  probeTimeoutMs: 3000,
  raceGraceMs: 60,
  maxConcurrentProbes: 48,
  // 自动迁移（防抖）：新节点需快 20% 且至少快 30ms
  switchThreshold: 0.2,
  switchMinDiffMs: 30,
  retestHours: 24,
  retestActiveDays: 7,
  expireDays: 30,
  failCacheMinutes: 10,
  // 测完是否直接锁定
  autoLock: false,
  // 永不自动分配的主域名
  exclude: [],
  // 是否启动托盘
  tray: true,
};

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let user = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      throw new Error(`配置文件解析失败：${CONFIG_FILE}：${e.message}`);
    }
  }
  const cfg = { ...DEFAULTS, ...user };
  if (!fs.existsSync(CONFIG_FILE)) save(cfg);
  return cfg;
}

function save(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = cfg[k];
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

function healthHost(cfg) {
  try {
    return new URL(cfg.healthUrl).hostname.toLowerCase();
  } catch {
    return 'cp.cloudflare.com';
  }
}

module.exports = { load, save, healthHost, DEFAULTS, ROOT, DATA_DIR, CONFIG_FILE };
