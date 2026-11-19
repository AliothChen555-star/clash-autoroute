'use strict';
// 最小 SOCKS5 实现：服务端只解析握手与 CONNECT 请求，客户端用于把连接交给 mihomo 的专用 listener
const net = require('net');

function reply(rep) {
  return Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

function ipv6FromBuf(b) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(i).toString(16));
  return parts.join(':');
}

/**
 * 解析入站 SOCKS5 请求，完成后回调 onRequest(sock, {cmd, host, port, rest})
 * （此时 socket 已暂停，尚未回复请求结果）
 */
function acceptSocks(sock, onRequest) {
  let buf = Buffer.alloc(0);
  let stage = 0;
  const fail = () => sock.destroy();
  const onData = (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (stage === 0) {
      if (buf.length < 2) return;
      if (buf[0] !== 0x05) return fail();
      const n = buf[1];
      if (buf.length < 2 + n) return;
      const methods = buf.subarray(2, 2 + n);
      if (!methods.includes(0x00)) {
        sock.end(Buffer.from([0x05, 0xff]));
        return;
      }
      sock.write(Buffer.from([0x05, 0x00]));
      buf = buf.subarray(2 + n);
      stage = 1;
    }
    if (stage === 1) {
      if (buf.length < 5) return;
      if (buf[0] !== 0x05) return fail();
      const cmd = buf[1];
      const atyp = buf[3];
      let host;
      let off;
      if (atyp === 0x01) {
        if (buf.length < 10) return;
        host = Array.from(buf.subarray(4, 8)).join('.');
        off = 8;
      } else if (atyp === 0x03) {
        const l = buf[4];
        if (buf.length < 5 + l + 2) return;
        host = buf.subarray(5, 5 + l).toString('utf8');
        off = 5 + l;
      } else if (atyp === 0x04) {
        if (buf.length < 22) return;
        host = ipv6FromBuf(buf.subarray(4, 20));
        off = 20;
      } else {
        sock.end(reply(0x08));
        return;
      }
      const port = buf.readUInt16BE(off);
      const rest = buf.subarray(off + 2);
      stage = 2;
      sock.removeListener('data', onData);
      sock.pause();
      onRequest(sock, { cmd, host, port, rest });
    }
  };
  sock.on('data', onData);
}

/** 通过本机 SOCKS5（mihomo listener）建立到 host:port 的连接 */
function socksConnect(proxyPort, host, port, timeout = 10000, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const s = net.connect({ host: '127.0.0.1', port: proxyPort });
    s.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let stage = 0;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      s.removeListener('data', onData);
      if (err) {
        s.destroy();
        reject(err);
      } else {
        resolve(s);
      }
    };
    const onAbort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error('socks 超时')), timeout);
    signal?.addEventListener('abort', onAbort, { once: true });
    s.once('connect', () => s.write(Buffer.from([0x05, 0x01, 0x00])));
    s.on('error', (e) => finish(e));
    s.on('close', () => finish(new Error('socks 连接被关闭')));
    const onData = (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return finish(new Error('socks 认证被拒绝'));
        buf = buf.subarray(2);
        stage = 1;
        let addr;
        const ipType = net.isIP(host);
        if (ipType === 4) addr = Buffer.from([0x01, ...host.split('.').map(Number)]);
        else if (ipType === 6) {
          const full = expandV6(host);
          const b = Buffer.alloc(17);
          b[0] = 0x04;
          full.forEach((h, i) => b.writeUInt16BE(h, 1 + i * 2));
          addr = b;
        } else {
          const h = Buffer.from(host, 'utf8');
          addr = Buffer.concat([Buffer.from([0x03, h.length]), h]);
        }
        const p = Buffer.alloc(2);
        p.writeUInt16BE(port);
        s.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, p]));
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        const atyp = buf[3];
        const need = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : 7 + buf[4];
        if (buf.length < need) return;
        if (buf[1] !== 0x00) return finish(new Error(`socks 请求失败(${buf[1]})`));
        const rest = buf.subarray(need);
        s.pause(); // 交给调用方 pipe 前不能丢数据
        s.removeAllListeners('close');
        s.removeAllListeners('error');
        finish(null);
        if (rest.length) s.unshift(rest);
      }
    };
    s.on('data', onData);
  });
}

function expandV6(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? new Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => parseInt(x || '0', 16));
}

module.exports = { acceptSocks, socksConnect, reply };
