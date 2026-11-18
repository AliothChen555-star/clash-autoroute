'use strict';
// 开机自启：在「启动」文件夹放一个隐藏窗口运行的 vbs
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');

const FILE = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'clash-autoroute.vbs');

function isEnabled() {
  return fs.existsSync(FILE);
}

function enable() {
  const node = process.execPath;
  const entry = path.join(ROOT, 'src', 'index.js');
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${ROOT}"`,
    `sh.Run """${node}"" ""${entry}""", 0, False`,
    '',
  ].join('\r\n');
  // UTF-16LE + BOM，路径含中文也能正确执行
  fs.writeFileSync(FILE, `\ufeff${vbs}`, 'utf16le');
}

function disable() {
  if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
}

module.exports = { isEnabled, enable, disable, FILE };
