'use strict';
// Windows 托盘图标：使用内置 PowerShell + System.Windows.Forms.NotifyIcon（零第三方依赖）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const PS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$panelUrl = $args[0]
$apiPort = $args[1]
$exportDir = $args[2]

function New-CircleIcon([System.Drawing.Color]$color) {
  $bmp = New-Object System.Drawing.Bitmap(16, 16)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush($color)
  $g.FillEllipse($brush, 1, 1, 13, 13)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 1.6)
  $g.DrawLine($pen, 4, 9, 7, 11)
  $g.DrawLine($pen, 7, 11, 12, 5)
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$iconRun = New-CircleIcon ([System.Drawing.Color]::FromArgb(16, 185, 129))
$iconPause = New-CircleIcon ([System.Drawing.Color]::FromArgb(245, 158, 11))

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $iconRun
$notify.Text = "Clash AutoRoute (运行中)"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miOpen = $menu.Items.Add("打开控制面板")
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
$miOpen.Add_Click({ Start-Process $panelUrl })

$miStatus = $menu.Items.Add("状态：运行中")
$miStatus.Enabled = $false

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miToggle = $menu.Items.Add("暂停自动分配")
$miToggle.Add_Click({
  try {
    if ($script:paused) {
      Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$apiPort/api/resume" | Out-Null
    } else {
      Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$apiPort/api/pause" | Out-Null
    }
    Update-TrayStatus
  } catch {}
})

$miLockAll = $menu.Items.Add("一键锁定当前所有自动结果")
$miLockAll.Add_Click({
  try {
    $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$apiPort/api/lock-all"
    $notify.ShowBalloonTip(2000, "Clash AutoRoute", "已锁定 $($r.locked) 个域名出口", [System.Windows.Forms.ToolTipIcon]::Info)
    Update-TrayStatus
  } catch {}
})

$miExport = $menu.Items.Add("导出规则 YAML（原有+已锁定）")
$miExport.Add_Click({
  try {
    $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$apiPort/api/export/save"
    $notify.ShowBalloonTip(2500, "导出成功", "已保存至：$($r.path)", [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Process "explorer.exe" "/select,\`"$($r.path)\`""
  } catch {
    [System.Windows.Forms.MessageBox]::Show("导出失败：$($_.Exception.Message)", "Clash AutoRoute")
  }
})

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miQuit = $menu.Items.Add("退出 Clash AutoRoute")
$miQuit.Add_Click({
  try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$apiPort/api/quit" | Out-Null } catch {}
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu
$notify.Add_DoubleClick({ Start-Process $panelUrl })

$script:paused = $false
function Update-TrayStatus {
  try {
    $s = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$apiPort/api/status" -TimeoutSec 2
    $script:paused = [bool]$s.paused
    $c = $s.counts
    if ($script:paused) {
      $notify.Icon = $iconPause
      $miStatus.Text = "状态：已暂停 | 共 $($c.total) (锁定 $($c.locked))"
      $miToggle.Text = "恢复自动分配"
      $notify.Text = "Clash AutoRoute [已暂停] 共 $($c.total) / 锁定 $($c.locked)"
    } else {
      $notify.Icon = $iconRun
      $miStatus.Text = "状态：运行中 | 共 $($c.total) (锁定 $($c.locked))"
      $miToggle.Text = "暂停自动分配"
      $notify.Text = "Clash AutoRoute [运行中] 共 $($c.total) / 锁定 $($c.locked)"
    }
  } catch {
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.Add_Tick({ Update-TrayStatus })
$timer.Start()

[System.Windows.Forms.Application]::Run()
`;

function startTray(cfg, log, onExit) {
  if (!cfg.tray || process.platform !== 'win32') return { stop: () => {} };
  const psFile = path.join(DATA_DIR, 'tray-helper.ps1');
  // PowerShell 5.1 要求带 UTF-8 BOM 才能正确识别中文字符
  fs.writeFileSync(psFile, '\ufeff' + PS_SCRIPT, 'utf8');
  const panelUrl = `http://127.0.0.1:${cfg.panelPort}/`;
  const exportDir = path.join(DATA_DIR, 'exports');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NoLogo', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-STA', '-File', psFile, panelUrl, String(cfg.panelPort), exportDir],
    { windowsHide: true, stdio: 'ignore' },
  );
  child.on('error', (e) => log.warn(`[tray] 托盘启动失败：${e.message}`));
  child.on('exit', () => {
    if (onExit) onExit();
  });
  log.info('[tray] 系统托盘图标已启动（双击图标打开控制面板）');
  return {
    stop: () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

module.exports = { startTray };
