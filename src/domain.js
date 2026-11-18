'use strict';
// 主域名提取（公共后缀列表）
const net = require('net');
const { domainToASCII } = require('node:url');
const { getDomain } = require('tldts');

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

/** a.cdn.example.co.uk -> example.co.uk；IP / 单标签主机返回 null */
function mainDomain(host) {
  const h = normalizeHost(host);
  if (!h || net.isIP(h) || !h.includes('.')) return null;
  return getDomain(h, { allowPrivateDomains: false }) || h;
}

/** domain 是否等于 suffix 或是其子域 */
function underSuffix(domain, suffix) {
  const s = normalizeHost(suffix).replace(/^\+\./, '').replace(/^\*\./, '');
  return domain === s || domain.endsWith(`.${s}`);
}

/** 校验并规范化手动输入的域名 */
function cleanDomain(input) {
  const stripped = normalizeHost(input).replace(/^(?:\+|\*)\./, '');
  if (!stripped || /[:/\\@#?\s]/.test(stripped)) return null;
  const h = domainToASCII(stripped);
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!h.includes('.') || h.length > 253 || net.isIP(h) || !h.split('.').every((part) => label.test(part))) return null;
  return h;
}

function isExcluded(cfg, domain) {
  return (cfg.exclude || []).some((suffix) => underSuffix(domain, suffix));
}

module.exports = { mainDomain, underSuffix, cleanDomain, normalizeHost, isExcluded };
