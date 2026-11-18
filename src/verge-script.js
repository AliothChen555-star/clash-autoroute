'use strict';
// 生成 / 安装 Clash Verge Rev 全局扩展脚本
const fs = require('fs');
const path = require('path');
const { createHash } = require('node:crypto');
const YAML = require('yaml');

const BEGIN = '// ==AutoRoute== begin（由 clash-autoroute 生成，请勿手动修改本段）';
const END = '// ==AutoRoute== end';

// ---- 以下函数会被原样嵌入 Verge 扩展脚本（保持 ES5 写法）----
function __autoroute_fnv(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h;
}

function __autoroute_ports(names, base, range) {
  var sorted = names.slice().sort();
  var used = {};
  var out = Object.create(null);
  for (var i = 0; i < sorted.length; i++) {
    var slot = __autoroute_fnv(sorted[i]) % range;
    var n = 0;
    while (used[slot] && n < range) {
      slot = (slot + 1) % range;
      n++;
    }
    used[slot] = true;
    out[sorted[i]] = base + slot;
  }
  return out;
}

function __autoroute_members(group) {
  var skip = ['REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'];
  var members = [];
  var src = group && Array.isArray(group.proxies) ? group.proxies : [];
  for (var i = 0; i < src.length; i++) {
    var name = src[i];
    if (typeof name !== 'string' || !name || skip.indexOf(name) >= 0 || name.indexOf('AutoRoute-') === 0 || name.indexOf(',') >= 0) continue;
    if (members.indexOf(name) < 0) members.push(name);
  }
  return members;
}

function __autoroute_revision(config) {
  return __autoroute_fnv(JSON.stringify(config)).toString(16);
}

function __autoroute_apply(config) {
  var C = __AUTOROUTE_CFG;
  if (!config || !C.targetGroup) return config;
  var groups = config['proxy-groups'] || [];
  var target = null;
  for (var i = 0; i < groups.length; i++) if (groups[i] && groups[i].name === C.targetGroup) target = groups[i];
  if (!target) {
    console.log('[AutoRoute] 未找到代理组: ' + C.targetGroup);
    return config;
  }
  var members = __autoroute_members(target);
  if (!members.length) {
    console.log('[AutoRoute] 代理组没有可用的显式成员: ' + C.targetGroup);
    return config;
  }
  if (C.members && JSON.stringify(members.slice().sort()) !== JSON.stringify(C.members)) {
    console.log('[AutoRoute] 代理组成员已变更，请在面板重新写入扩展脚本: ' + C.targetGroup);
    return config;
  }
  if (members.length > C.listenerRange) {
    console.log('[AutoRoute] 代理组成员数超过可用端口数: ' + C.targetGroup);
    return config;
  }
  var ports = __autoroute_ports(members, C.listenerBase + 1, C.listenerRange);
  var udpGroup = 'AutoRoute-UDP-' + __autoroute_revision(C);

  // 去掉已注入的内容（保证幂等）
  var isOurs = function (name) {
    return typeof name === 'string' && (name.indexOf('AutoRoute-') === 0 || name.indexOf('autoroute-') === 0);
  };
  var keepRule = function (r) {
    if (typeof r !== 'string') return true;
    if (/^\s*RULE-SET\s*,\s*autoroute-p\d+(?:-[a-f0-9]{16})?\s*,/.test(r)) return false;
    var parts = r.split(',');
    for (var k = 1; k < parts.length; k++) if (parts[k].trim().indexOf('AutoRoute-') === 0) return false;
    return true;
  };
  var raw = config.rules || [];
  var matchAt = -1;
  var orig = null;
  for (var m = 0; m < raw.length; m++) {
    if (typeof raw[m] === 'string' && /^\s*MATCH\s*,/.test(raw[m])) {
      matchAt = m;
      if (keepRule(raw[m])) orig = raw[m].split(',')[1].trim();
      break;
    }
  }
  var rules = (matchAt < 0 ? raw : raw.slice(0, matchAt)).filter(keepRule);
  var trailing = matchAt < 0 ? [] : raw.slice(matchAt + 1).filter(keepRule);
  if (!orig) {
    for (var g = 0; g < groups.length; g++) if (groups[g].name === 'AutoRoute-Fallback') orig = groups[g].proxies[1];
  }
  if (!orig) orig = 'DIRECT';

  config.proxies = (config.proxies || []).filter(function (p) { return !(p && isOurs(p.name)); });
  config.proxies.push({ name: 'AutoRoute-Hook', type: 'socks5', server: '127.0.0.1', port: C.hookPort, udp: false });

  groups = groups.filter(function (x) { return !(x && isOurs(x.name)); });
  groups.push({ name: 'AutoRoute-Fallback', type: 'fallback', proxies: ['AutoRoute-Hook', orig], url: C.healthUrl, interval: 10, timeout: 2000, lazy: false });
  groups.push({ name: 'AutoRoute-QUIC', type: 'select', proxies: ['REJECT'], hidden: true });
  groups.push({ name: udpGroup, type: 'select', proxies: [orig], hidden: true });
  config['proxy-groups'] = groups;

  var listeners = (config.listeners || []).filter(function (l) { return !(l && isOurs(l.name)); });
  listeners.push({ name: 'autoroute-fallback', type: 'socks', listen: '127.0.0.1', port: C.listenerBase, udp: false, proxy: orig });
  var providers = config['rule-providers'] || {};
  for (var key in providers) if (providers.hasOwnProperty(key) && key.indexOf('autoroute-') === 0) delete providers[key];
  var added = [];
  for (var q = 0; q < members.length; q++) {
    var node = members[q];
    var port = ports[node];
    var pname = C.providers ? C.providers[port] : 'autoroute-p' + port;
    listeners.push({ name: pname, type: 'socks', listen: '127.0.0.1', port: port, udp: false, proxy: node });
    providers[pname] = { type: 'file', behavior: 'domain', format: 'text', path: C.ruleDir + '/' + pname.slice('autoroute-'.length) + '.list' };
    added.push('RULE-SET,' + pname + ',' + node);
  }
  config.listeners = listeners;
  config['rule-providers'] = providers;

  // 顺序：用户规则 → 自动分配规则集 → 未分配域名的 QUIC 拒绝（逼回 TCP）→ 其他 UDP 走原出口 → MATCH 交给插件
  added.push('AND,((NETWORK,udp),(DST-PORT,443)),AutoRoute-QUIC');
  added.push('NETWORK,udp,' + udpGroup);
  added.push('MATCH,AutoRoute-Fallback');
  config.rules = rules.concat(added, trailing);
  return config;
}
// ---- 嵌入函数结束 ----

function providerNames(cfg, members) {
  const ports = __autoroute_ports(members, cfg.listenerBase + 1, cfg.listenerRange);
  return Object.fromEntries(Object.entries(ports).map(([node, port]) => {
    const key = createHash('sha256').update(node).digest('hex').slice(0, 16);
    return [port, `autoroute-p${port}-${key}`];
  }));
}

function renderBlock(cfg, members) {
  const C = {
    targetGroup: cfg.targetGroup,
    hookPort: cfg.hookPort,
    listenerBase: cfg.listenerBase,
    listenerRange: cfg.listenerRange,
    healthUrl: cfg.healthUrl,
    ruleDir: './autoroute',
  };
  if (members) {
    C.members = members.slice().sort();
    C.providers = providerNames(cfg, members);
  }
  return [
    BEGIN,
    `// 配置版本 ${__autoroute_revision(C)}`,
    `var __AUTOROUTE_CFG = ${JSON.stringify(C)};`,
    __autoroute_fnv.toString(),
    __autoroute_ports.toString(),
    __autoroute_members.toString(),
    __autoroute_revision.toString(),
    __autoroute_apply.toString(),
    'function main(config, profileName) {',
    "  if (typeof __autoroute_user_main === 'function') config = __autoroute_user_main(config, profileName);",
    '  return __autoroute_apply(config);',
    '}',
    END,
    '',
  ].join('\n');
}

function globalScriptFile(cfg) {
  const dir = path.join(cfg.vergeHome, 'profiles');
  let file = 'Script.js';
  try {
    const p = YAML.parse(fs.readFileSync(path.join(cfg.vergeHome, 'profiles.yaml'), 'utf8'));
    const item = (p.items || []).find((i) => i.uid === 'Script' && i.type === 'script');
    if (item && item.file) file = item.file;
  } catch {
    /* 使用默认文件名 */
  }
  return path.join(dir, file);
}

function stripBlock(src) {
  const a = src.indexOf(BEGIN);
  const b = src.indexOf(END);
  if (a >= 0 && b > a) src = src.slice(0, a) + src.slice(b + END.length);
  src = src.replace(/function\s+__autoroute_user_main\s*\(/, 'function main(');
  src = src.replace(/\b(const|let|var)\s+__autoroute_user_main\s*=/, '$1 main =');
  return src.replace(/\s+$/, '') + '\n';
}

function installedConfig(cfg) {
  try {
    const src = fs.readFileSync(globalScriptFile(cfg), 'utf8');
    const start = src.indexOf(BEGIN);
    if (start < 0) return null;
    const block = src.slice(start);
    const revision = /^\/\/ 配置版本 ([a-f0-9]+)$/m.exec(block)?.[1] || null;
    const definition = /^var __AUTOROUTE_CFG = (.+);$/m.exec(block)?.[1];
    return { revision, targetGroup: definition ? JSON.parse(definition).targetGroup : null };
  } catch {
    return null;
  }
}

function readRuntimeConfig(cfg) {
  const file = path.join(cfg.vergeHome, 'clash-verge.yaml');
  if (!fs.existsSync(file)) throw new Error(`找不到 Verge 运行配置：${file}。请先在 Clash Verge 应用一个订阅。`);
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

function runtimeMembers(cfg) {
  const group = (readRuntimeConfig(cfg)?.['proxy-groups'] || []).find((g) => g?.name === cfg.targetGroup);
  return __autoroute_members(group);
}

function prepareGroup(cfg, rules) {
  if (!cfg.targetGroup) throw new Error('请先设置目标代理组');
  const members = runtimeMembers(cfg);
  if (!members.length) throw new Error('所选代理组没有可用的显式成员，请选择在 proxies 列表中列出成员的组。');
  const { listenerBase, listenerRange } = cfg;
  if (!Number.isInteger(listenerBase) || listenerBase < 1 || !Number.isInteger(listenerRange)
    || listenerRange < members.length || listenerBase + listenerRange > 65535) {
    throw new Error('节点专用端口范围无效，或可用端口少于组内成员。请检查 listenerBase 和 listenerRange。');
  }
  rules.ensureFiles(Object.values(providerNames(cfg, members)));
  return members;
}

function install(cfg, backupDir, rules) {
  const members = prepareGroup(cfg, rules);
  const file = globalScriptFile(cfg);
  let src = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `${path.basename(file)}.${Date.now()}.bak`);
  fs.writeFileSync(backup, src, 'utf8');
  src = stripBlock(src);
  // 保留用户原有的 main：改名后由我们的 main 先调用
  if (/function\s+main\s*\(/.test(src)) src = src.replace(/function\s+main\s*\(/, 'function __autoroute_user_main(');
  else if (/\b(const|let|var)\s+main\s*=/.test(src)) src = src.replace(/\b(const|let|var)\s+main\s*=/, '$1 __autoroute_user_main =');
  fs.writeFileSync(file, `${src.trim() ? `${src.trim()}\n\n` : ''}${renderBlock(cfg, members)}`, 'utf8');
  return { file, backup };
}

function uninstall(cfg, backupDir) {
  const file = globalScriptFile(cfg);
  if (!fs.existsSync(file)) return { file };
  const src = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `${path.basename(file)}.${Date.now()}.bak`);
  fs.writeFileSync(backup, src, 'utf8');
  fs.writeFileSync(file, stripBlock(src), 'utf8');
  return { file, backup };
}

module.exports = {
  renderBlock,
  install,
  uninstall,
  installedConfig,
  globalScriptFile,
  readRuntimeConfig,
  runtimeMembers,
  prepareGroup,
  __autoroute_members,
  __autoroute_apply,
  __autoroute_ports,
  __autoroute_fnv,
};
