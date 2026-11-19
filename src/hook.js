'use strict';
// AutoRoute-Hook：mihomo 把未命中规则的连接以 SOCKS5 交给这里
const net = require('net');
const { acceptSocks, socksConnect, reply } = require('./socks');
const { healthHost } = require('./config');

const LOCAL_HANDSHAKE_TIMEOUT_MS = 500;

function startHook(cfg, engine, log) {
  const hHost = healthHost(cfg);
  let active = 0;

  const server = net.createServer((sock) => {
    active++;
    sock.setNoDelay(true);
    sock.on('error', () => {});
    sock.on('close', () => active--);
    sock.setTimeout(30000, () => sock.destroy());
    acceptSocks(sock, (s, req) => {
      s.setTimeout(0);
      if (req.cmd !== 0x01) {
        s.end(reply(0x07)); // 只支持 CONNECT（UDP 由规则另行处理）
        return;
      }
      const host = String(req.host).toLowerCase();
      if (host === hHost) {
        answerHealth(s, req.rest);
        return;
      }
      handle(s, host, req.port, req.rest).catch((e) => {
        log.warn(`[hook] ${host}:${req.port} 处理异常：${e.message}`);
        s.destroy();
      });
    });
  });

  async function handle(s, host, port, rest) {
    const abort = new AbortController();
    const onClose = () => abort.abort();
    s.once('close', onClose);
    try {
      const route = await engine.route(host, port, abort.signal);
      if (!route) return;
      await forward(s, route, host, port, rest, abort.signal);
    } finally {
      s.removeListener('close', onClose);
    }
  }

  async function connect(route, host, port, signal) {
    const timeout = route.finish || route.port === cfg.listenerBase ? LOCAL_HANDSHAKE_TIMEOUT_MS : undefined;
    try {
      const socket = await socksConnect(route.port, host, port, timeout, signal);
      return socket.destroyed ? null : socket;
    } catch (e) {
      if (!signal.aborted) log.warn(`[hook] ${host}:${port} 经 ${route.node || '原出口'}(端口 ${route.port}) 连接失败：${e.message}`);
      return null;
    }
  }

  async function forward(s, route, host, port, rest, signal) {
    let up;
    try {
      if (!s.destroyed) up = await connect(route, host, port, signal);
    } finally {
      route.finish?.(Boolean(up && !s.destroyed));
    }
    if (!up && route.finish && !s.destroyed && route.port !== cfg.listenerBase) {
      up = await connect(engine.fallback('首选握手失败'), host, port, signal);
    }
    if (s.destroyed) {
      up?.destroy();
      return;
    }
    if (!up) {
      s.end(reply(0x05));
      return;
    }
    up.on('error', () => s.destroy());
    s.on('error', () => up.destroy());
    up.on('close', () => s.destroy());
    s.on('close', () => up.destroy());
    s.write(reply(0x00));
    if (rest && rest.length) up.write(rest);
    s.pipe(up);
    up.pipe(s);
    s.resume();
  }

  function answerHealth(s, rest) {
    s.write(reply(0x00));
    let buf = rest && rest.length ? rest : Buffer.alloc(0);
    const tryAnswer = () => {
      if (buf.includes('\r\n\r\n')) {
        s.end('HTTP/1.1 204 No Content\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return true;
      }
      return false;
    };
    if (tryAnswer()) return;
    s.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      tryAnswer();
    });
    s.resume();
    s.setTimeout(5000, () => s.destroy());
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.hookPort, '127.0.0.1', () => {
      server.removeListener('error', reject);
      server.on('error', (e) => log.error(`[hook] ${e.message}`));
      log.info(`[hook] SOCKS5 监听 127.0.0.1:${cfg.hookPort}`);
      resolve({ server, active: () => active });
    });
  });
}

module.exports = { startHook };
