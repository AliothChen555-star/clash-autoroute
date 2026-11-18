'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const YAML = require('yaml');
const { DEFAULTS } = require('../src/config');
const { Engine } = require('../src/engine');
const { buildExport } = require('../src/exporter');
const { Groups } = require('../src/groups');
const { RuleWriter } = require('../src/rules');
const { Store } = require('../src/store');
const { install, renderBlock } = require('../src/verge-script');

const log = { info() {}, warn() {}, error() {} };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoroute-regression-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('安装为新选中的代理组预建实际引用的规则文件', (t) => {
  const dir = tempDir(t);
  const cfg = { ...DEFAULTS, targetGroup: 'Manual', vergeHome: dir };
  const profile = {
    'proxy-groups': [
      { name: 'Old', type: 'select', proxies: ['A'] },
      { name: 'Manual', type: 'select', proxies: ['B', 'REJECT'], use: ['feed'] },
    ],
    rules: ['MATCH,Old'],
  };
  fs.mkdirSync(path.join(dir, 'profiles'));
  fs.writeFileSync(path.join(dir, 'clash-verge.yaml'), YAML.stringify(profile));
  const rules = new RuleWriter(cfg, null, null, null, log);

  const { file } = install(cfg, path.join(dir, 'backup'), rules);
  const applied = vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmain(profile)', { profile });
  const providers = Object.values(applied['rule-providers']);
  assert.equal(providers.length, 1, '只为显式成员 B 创建规则集');
  const providerFile = path.resolve(dir, providers[0].path);
  assert(fs.existsSync(providerFile), '重新应用订阅前规则文件应已存在');
  assert.match(fs.readFileSync(providerFile, 'utf8'), /autoroute-placeholder\.invalid/);
});

test('只含动态 provider 的代理组不会覆盖原扩展脚本', (t) => {
  const dir = tempDir(t);
  const cfg = { ...DEFAULTS, targetGroup: 'Provider', vergeHome: dir };
  fs.mkdirSync(path.join(dir, 'profiles'));
  const script = path.join(dir, 'profiles', 'Script.js');
  const original = 'function main(config) { return config; }\n';
  fs.writeFileSync(script, original);
  fs.writeFileSync(path.join(dir, 'clash-verge.yaml'), YAML.stringify({
    'proxy-groups': [{ name: 'Provider', type: 'select', use: ['feed'] }],
  }));
  assert.throws(() => install(cfg, path.join(dir, 'backup'), new RuleWriter(cfg, null, null, null, log)),
    /显式成员/);
  assert.equal(fs.readFileSync(script, 'utf8'), original);
});

test('同名代理组换成员时不引用未预建的规则文件，重写脚本会更新版本', (t) => {
  const dir = tempDir(t);
  const cfg = { ...DEFAULTS, targetGroup: 'Selected', vergeHome: dir };
  const profile = {
    'proxy-groups': [{ name: 'Selected', type: 'select', proxies: ['A'] }],
    rules: ['MATCH,DIRECT'],
  };
  const runtimeFile = path.join(dir, 'clash-verge.yaml');
  const rules = new RuleWriter(cfg, null, null, null, log);
  fs.mkdirSync(path.join(dir, 'profiles'));
  fs.writeFileSync(runtimeFile, YAML.stringify(profile));
  const { file } = install(cfg, path.join(dir, 'backup'), rules);
  const previousScript = fs.readFileSync(file, 'utf8');
  profile['proxy-groups'][0].proxies = ['B'];
  const next = vm.runInNewContext(previousScript + '\nmain(profile)', { profile: structuredClone(profile) });
  assert.deepEqual([...next.rules], ['MATCH,DIRECT']);

  fs.writeFileSync(runtimeFile, YAML.stringify(profile));
  install(cfg, path.join(dir, 'backup'), rules);
  const currentScript = fs.readFileSync(file, 'utf8');
  const applied = vm.runInNewContext(currentScript + '\nmain(profile)', { profile: structuredClone(profile) });
  assert(applied.rules.some((rule) => rule.startsWith('RULE-SET,autoroute-') && rule.endsWith(',B')));
  assert.notEqual(currentScript.match(/配置版本 ([a-f0-9]+)/)[1], previousScript.match(/配置版本 ([a-f0-9]+)/)[1]);
});

test('选到同一端口的新出口不会继承旧出口的规则内容', (t) => {
  const dir = tempDir(t);
  const cfg = { ...DEFAULTS, targetGroup: 'Selected', vergeHome: dir, listenerRange: 1 };
  const profile = { 'proxy-groups': [{ name: 'Selected', type: 'select', proxies: ['A'] }], rules: ['MATCH,DIRECT'] };
  const rules = new RuleWriter(cfg, null, null, null, log);
  fs.mkdirSync(path.join(dir, 'profiles'));
  function installFor(node) {
    profile['proxy-groups'][0].proxies = [node];
    fs.writeFileSync(path.join(dir, 'clash-verge.yaml'), YAML.stringify(profile));
    const { file } = install(cfg, path.join(dir, 'backup'), rules);
    const applied = vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmain(profile)', { profile: structuredClone(profile) });
    return path.resolve(dir, Object.values(applied['rule-providers'])[0].path);
  }
  const first = installFor('A');
  fs.appendFileSync(first, '+.only-on-a.example\n');
  const next = installFor('B');
  assert.notEqual(first, next);
  assert.doesNotMatch(fs.readFileSync(next, 'utf8'), /only-on-a\.example/);
});

test('内核状态能区分已加载的脚本版本和全局模式', async () => {
  const cfg = { ...DEFAULTS, targetGroup: 'New' };
  function apply(group) {
    const profile = {
      'proxy-groups': ['Old', 'New'].map((name) => ({ name, type: 'select', proxies: ['A'] })),
      rules: ['MATCH,DIRECT'],
    };
    return vm.runInNewContext(renderBlock({ ...cfg, targetGroup: group }) + '\nmain(profile)', { profile });
  }
  let applied = apply('Old');
  const api = {
    async get(endpoint) {
      if (endpoint === '/configs') return { mode: 'global' };
      if (endpoint === '/proxies/AutoRoute-Fallback') return { all: ['AutoRoute-Hook', 'DIRECT'], now: 'DIRECT' };
      return { rules: applied.rules.map((rule) => {
        const [type, payload, proxy] = rule.split(',');
        return {
          type: ({ 'RULE-SET': 'RuleSet', NETWORK: 'Network', MATCH: 'Match' })[type] || type,
          payload,
          proxy: type === 'MATCH' ? payload : proxy,
        };
      }) };
    },
  };
  const groups = new Groups(cfg, api, log);
  await groups.refresh();
  const oldRevision = groups.revision;
  assert.equal(groups.mode, 'global');
  assert.equal(groups.fallbackNow, 'DIRECT');
  assert.equal(groups.fallbackRuleActive, true);
  assert(oldRevision);
  applied = apply('New');
  await groups.refresh();
  assert.notEqual(groups.revision, oldRevision, '成员相同的两个组也应可区分');
  applied.rules.unshift('MATCH,DIRECT');
  await groups.refresh();
  assert.equal(groups.fallbackRuleActive, false, '前面的 MATCH 覆盖了插件兜底');
});

test('注入与导出尊重首条 MATCH 的位置和出口', (t) => {
  const dir = tempDir(t);
  const cfg = { ...DEFAULTS, targetGroup: 'Selected', vergeHome: dir };
  const profile = {
    proxies: [{ name: 'A' }],
    'proxy-groups': [{ name: 'Selected', type: 'select', proxies: ['A'] }],
    rules: ['DOMAIN,first.example,A', 'MATCH,DIRECT', 'DOMAIN,last.example,A', 'MATCH,Selected'],
  };
  const block = renderBlock(cfg);
  const apply = (config) => vm.runInNewContext(block + '\nmain(profile)', { profile: config });
  const first = apply(structuredClone(profile));
  assert.equal(first['proxy-groups'].find((group) => group.name === 'AutoRoute-Fallback').proxies[1], 'DIRECT');
  const match = first.rules.indexOf('MATCH,AutoRoute-Fallback');
  assert.deepEqual(first.rules.slice(match + 1), profile.rules.slice(2));
  assert.deepEqual(apply(structuredClone(first)).rules, first.rules);

  fs.writeFileSync(path.join(dir, 'clash-verge.yaml'), YAML.stringify(first));
  const { rules } = YAML.parse(buildExport(cfg, [{ domain: 'extra.example', node: 'A', state: 'locked' }]).yaml);
  assert.deepEqual(rules, ['DOMAIN,first.example,A', 'DOMAIN-SUFFIX,extra.example,A',
    'MATCH,DIRECT', 'DOMAIN,last.example,A', 'MATCH,Selected']);
});

test('规则刷新失败后即使磁盘内容没变也会重试', async (t) => {
  const cfg = { ...DEFAULTS, vergeHome: tempDir(t) };
  const entries = [{ domain: 'example.com', node: 'A' }];
  const providerCalls = [];
  const api = {
    async refreshRuleProvider(name) {
      providerCalls.push(name);
      if (providerCalls.length === 1) throw new Error('内核暂时不可用');
    },
  };
  const groups = new Groups(cfg, api, log);
  groups.mapping.set('A', 7901);
  const writer = new RuleWriter(cfg, api, { list: () => entries }, groups, log);

  await writer.flush();
  await writer.flush();
  assert.deepEqual(providerCalls, ['autoroute-p7901', 'autoroute-p7901']);
  assert.match(fs.readFileSync(path.join(cfg.vergeHome, 'autoroute', 'p7901.list'), 'utf8'), /\+\.example\.com/);
});

test('已分配域名加入排除后停止下发和导出规则，保留锁定记录', async (t) => {
  const dir = tempDir(t);
  const cfg = { ...DEFAULTS, vergeHome: dir, exclude: ['example.com'] };
  const list = [{ domain: 'example.com', node: 'A', state: 'locked' }];
  const api = { async refreshRuleProvider() {} };
  const groups = new Groups(cfg, api, log);
  groups.mapping.set('A', 7901);
  const writer = new RuleWriter(cfg, api, { list: () => list }, groups, log);
  fs.writeFileSync(path.join(dir, 'clash-verge.yaml'), 'proxies: [{name: A}]\nrules: ["MATCH,DIRECT"]\n');

  await writer.flush();
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'autoroute', 'p7901.list'), 'utf8'), /\+\.example\.com/);
  assert.doesNotMatch(buildExport(cfg, list).yaml, /DOMAIN-SUFFIX,example\.com/);
  assert.equal(list[0].state, 'locked');
});

test('导出略过当前配置中已不存在的出口，保留仍可引用的锁定出口', (t) => {
  const dir = tempDir(t);
  const cfg = { ...DEFAULTS, vergeHome: dir };
  fs.writeFileSync(path.join(dir, 'clash-verge.yaml'), YAML.stringify({
    proxies: [{ name: 'A' }],
    'proxy-groups': [{ name: 'Group', type: 'select', proxies: ['A'] }],
    rules: ['MATCH,Group'],
  }));
  const result = buildExport(cfg, [
    { domain: 'missing.example', node: 'Retired', state: 'locked' },
    { domain: 'group.example', node: 'Group', state: 'locked' },
    { domain: 'proxy.example', node: 'A', state: 'locked' },
    { domain: 'direct.example', node: 'DIRECT', state: 'locked' },
  ]);
  const { rules } = YAML.parse(result.yaml);
  assert.deepEqual(rules, [
    'DOMAIN-SUFFIX,direct.example,DIRECT',
    'DOMAIN-SUFFIX,group.example,Group',
    'DOMAIN-SUFFIX,proxy.example,A',
    'MATCH,Group',
  ]);
  assert.equal(result.counts.skipped, 1);
});

test('首连测速返回时保留用户刚刚手动锁定的出口', async (t) => {
  const dir = tempDir(t);
  const cfg = { ...DEFAULTS, vergeHome: dir };
  const store = new Store(dir);
  t.after(() => { if (store.timer) clearTimeout(store.timer); });
  const groups = new Groups(cfg, null, log);
  groups.mapping = new Map([['A', 7901], ['B', 7902]]);
  let finishProbe;
  const decision = new Promise((resolve) => { finishProbe = resolve; });
  const prober = { probe: () => ({ decision, all: decision.then((best) => best.delays) }) };
  const engine = new Engine({ cfg, groups, store, rules: { schedule() {} }, prober, log });

  const routing = engine.route('example.com', 443);
  engine.setNode('example.com', 'B');
  finishProbe({ node: 'A', delay: 35, delays: { A: 35, B: 80 } });
  assert.equal((await routing).node, 'B');
  assert.equal(store.get('example.com').state, 'locked');
});
