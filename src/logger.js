'use strict';
// 简单日志：控制台 + data/autoroute.log（超过 5MB 轮转一次）
const fs = require('fs');
const path = require('path');

function createLogger(dataDir) {
  const file = path.join(dataDir, 'autoroute.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
  } catch {
    /* ignore */
  }
  const stream = fs.createWriteStream(file, { flags: 'a' });
  const write = (level, msg) => {
    const line = `${new Date().toLocaleString('zh-CN', { hour12: false })} [${level}] ${msg}`;
    if (level === 'ERROR') console.error(line);
    else console.log(line);
    stream.write(`${line}\n`);
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    close: () => stream.end(),
  };
}

module.exports = { createLogger };
