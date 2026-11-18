'use strict';
// 导出：原有规则（去掉插件注入部分） + 已锁定的分配结果，生成独立的 rules YAML
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { isExcluded } = require('./domain');
const { readRuntimeConfig } = require('./verge-script');

function isInjected(rule) {
  if (typeof rule !== 'string') return false;
  if (/^\s*RULE-SET\s*,\s*autoroute-p\d+(?:-[a-f0-9]{16})?\s*,/.test(rule)) return true;
  return rule.split(',').slice(1).some((p) => p.trim().startsWith('AutoRoute-'));
}

/**
 * @param cfg 插件配置
 * @param entries 分配条目
 * @param fallbackTarget 运行时读到的原 MATCH 出口（兜底用）
 */
function buildExport(cfg, entries, fallbackTarget) {
  const conf = readRuntimeConfig(cfg);
  const rawRules = Array.isArray(conf.rules) ? conf.rules : [];
  const groups = conf['proxy-groups'] || [];
  const fbGroup = groups.find((g) => g && g.name === 'AutoRoute-Fallback');
  const origMatch = (fbGroup && fbGroup.proxies && fbGroup.proxies[1]) || fallbackTarget || null;

  const rules = [];
  const trailing = [];
  let matchRule = null;
  let foundMatch = false;
  for (const r of rawRules) {
    if (!foundMatch && typeof r === 'string' && /^\s*MATCH\s*,/.test(r)) {
      foundMatch = true;
      matchRule = isInjected(r) ? (origMatch ? `MATCH,${origMatch}` : null) : r;
      continue;
    }
    if (isInjected(r)) continue;
    (foundMatch ? trailing : rules).push(r);
  }
  if (!matchRule && origMatch) matchRule = `MATCH,${origMatch}`;

  const locked = entries.filter((e) => e.state === 'locked' && !isExcluded(cfg, e.domain))
    .sort((a, b) => a.domain.localeCompare(b.domain));
  const available = new Set(['DIRECT', 'GLOBAL', ...(conf.proxies || []).map((proxy) => proxy?.name),
    ...groups.map((group) => group?.name)]);
  const skipped = [];
  const added = [];
  for (const e of locked) {
    if (typeof e.node !== 'string' || !available.has(e.node) || e.node.startsWith('AutoRoute-') || e.node.includes(',')) {
      skipped.push(e);
      continue;
    }
    added.push(`DOMAIN-SUFFIX,${e.domain},${e.node}`);
  }

  const providers = {};
  for (const [k, v] of Object.entries(conf['rule-providers'] || {})) {
    if (!k.startsWith('autoroute-')) providers[k] = v;
  }

  const out = {};
  if (Object.keys(providers).length) out['rule-providers'] = providers;
  out.rules = [...rules, ...added, ...(matchRule ? [matchRule] : []), ...trailing];

  const original = rules.length + trailing.length;
  const header = [
    `# 由 clash-autoroute 导出于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `# 原有规则 ${original} 条 + 已锁定的自动分配 ${added.length} 条${matchRule ? ' + MATCH' : ''}`,
    ...(skipped.length ? [`# 跳过出口已不存在或名称不可用于规则的域名：${skipped.map((e) => e.domain).join(', ')}`] : []),
    '',
  ].join('\n');
  const yaml = header + YAML.stringify(out, { lineWidth: 0 });
  return { yaml, counts: { original, locked: added.length, skipped: skipped.length } };
}

function saveExport(cfg, dataDir, entries, fallbackTarget) {
  const r = buildExport(cfg, entries, fallbackTarget);
  const dir = path.join(dataDir, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `rules-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.yaml`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, r.yaml, 'utf8');
  return { ...r, path: file };
}

module.exports = { buildExport, saveExport, isInjected };
