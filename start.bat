@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 Clash AutoRoute 后台服务与托盘...
echo 控制面板地址：http://127.0.0.1:7898/
start "" "http://127.0.0.1:7898/"
node src\index.js
pause
