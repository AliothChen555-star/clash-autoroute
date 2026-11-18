'use strict';
// 集成与核心逻辑测试：验证主域名归并、扩展脚本幂等注入、SOCKS5 首连拦截与转发、规则写入与锁定导出
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const YAML = require('yaml');

const { mainDomain, underSuffix } = require('../src/domain');
const { __autoroute_apply, __autoroute_ports } = require('../src/verge-script');
const { buildExport } = require('../src/exporter');
const { startHook } = require('../src/hook');
const { socksConnect, acceptSocks, reply } = require('../src/socks');
const { DEFAULTS } = require('../src/config');

async function run() {
  console.log('1) 测试主域名归并（PSL）...');
  assert.strictEqual(mainDomain('a.b.cdn.example.co.uk'), 'example.co.uk');
  assert.strictEqual(mainDomain('sub.github.com'), 'github.com');
  assert.strictEqual(mainDomain('192.168.1.1'), null);
  assert.strictEqual(underSuffix('api.openai.com', '+.openai.com'), true);

  console.log('2) 测试 Verge 扩展脚本注入与幂等性...');
  global.__AUTOROUTE_CFG = {
    targetGroup: 'DEFAULT-FOREIGN',
    hookPort: 18899,
    listenerBase: 18900,
    listenerRange: 999,
    healthUrl: 'http://cp.cloudflare.com/generate_204',
    ruleDir: './autoroute',
  };
  const baseCfg = {
    proxies: [
      { name: 'HK-01', type: 'ss' },
      { name: 'US-01', type: 'ss' },
    ],
    'proxy-groups': [{ name: 'DEFAULT-FOREIGN', type: 'select', proxies: ['HK-01', 'US-01'] }],
    'rule-providers': { Custom: { type: 'inline', behavior: 'domain', payload: ['+.custom.com'] } },
    rules: ['RULE-SET,Custom,DIRECT', 'MATCH,DEFAULT-FOREIGN'],
  };
  const out1 = __autoroute_apply(JSON.parse(JSON.stringify(baseCfg)));
  const out2 = __autoroute_apply(JSON.parse(JSON.stringify(out1))); // 二次执行必须幂等
  assert.deepStrictEqual(out1, out2, '扩展脚本二次执行应完全幂等');
  assert(out1.rules.includes('AND,((NETWORK,udp),(DST-PORT,443)),AutoRoute-QUIC'), '应注入 QUIC 拒绝规则逼回 TCP');
  assert.strictEqual(out1.rules[out1.rules.length - 1], 'MATCH,AutoRoute-Fallback');

  console.log('3) 测试规则导出（保留原有规则 + 仅导出已锁定条目 + 还原 MATCH）...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoroute-test-'));
  fs.writeFileSync(path.join(tmpDir, 'clash-verge.yaml'), YAML.stringify(out1), 'utf8');
  const entries = [
    { domain: 'locked-site.com', node: 'HK-01', state: 'locked' },
    { domain: 'auto-site.com', node: 'US-01', state: 'auto' },
  ];
  const exp = buildExport({ ...DEFAULTS, vergeHome: tmpDir }, entries, 'DEFAULT-FOREIGN');
  assert(exp.yaml.includes('DOMAIN-SUFFIX,locked-site.com,HK-01'), '应包含已锁定域名');
  assert(!exp.yaml.includes('auto-site.com'), '不应导出未锁定的自动域名');
  assert(exp.yaml.includes('MATCH,DEFAULT-FOREIGN'), '应还原原 MATCH 目标');
  assert(!exp.yaml.includes('AutoRoute-Fallback'), '不应残留注入规则');

  console.log('4) 测试 SOCKS5 首连暂停 → 模拟测速决策 → 经指定节点转发...');
  // 模拟一个远端目标 HTTP 服务
  const echoSrv = net.createServer((s) => {
    s.on('data', (d) => s.end('ECHO:' + d.toString()));
  });
  await new Promise((r) => echoSrv.listen(0, '127.0.0.1', r));
  const echoPort = echoSrv.address().port;

  // 模拟 mihomo 的节点专用 SOCKS5 listener
  const fakeListener = net.createServer((sock) => {
    acceptSocks(sock, (s, req) => {
      const up = net.connect(echoPort, '127.0.0.1', () => {
        s.write(reply(0x00));
        if (req.rest && req.rest.length) up.write(req.rest);
        s.pipe(up);
        up.pipe(s);
        s.resume();
      });
    });
  });
  await new Promise((r) => fakeListener.listen(0, '127.0.0.1', r));
  const listenerPort = fakeListener.address().port;

  let routedHost = null;
  const fakeEngine = {
    async route(host) {
      routedHost = host;
      await new Promise((r) => setTimeout(r, 40)); // 模拟测速耗时
      return { port: listenerPort, node: 'HK-01', reason: '新分配' };
    },
  };
  const noopLog = { info: () => {}, warn: () => {}, error: () => {} };
  const hook = await startHook({ ...DEFAULTS, hookPort: 0 }, fakeEngine, noopLog);
  const hookPort = hook.server.address().port;

  const client = await socksConnect(hookPort, 'video.test-domain.co.uk', echoPort);
  client.write('HELLO');
  client.resume();
  const resp = await new Promise((r) => client.once('data', (d) => r(d.toString())));
  assert.strictEqual(routedHost, 'video.test-domain.co.uk');
  assert.strictEqual(resp, 'ECHO:HELLO');

  client.destroy();
  hook.server.close();
  fakeListener.close();
  echoSrv.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('✔ 全部测试通过！');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
