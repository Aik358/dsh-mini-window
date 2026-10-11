<#
.SYNOPSIS
  启动 DSH Companion（悬浮球 + 独立小窗）。

.DESCRIPTION
  为什么需要这个脚本而不是直接双击 electron.exe：
  本机 DSH 的子进程 shell 会设置 ELECTRON_RUN_AS_NODE=1。该变量会让
  electron.exe 退化成纯 Node 解释器，Electron API 全部不可用。脚本先清掉
  这个变量，再启动，避免"启动即闪退且报错难懂"。

.EXAMPLE
  .\start.ps1
  .\start.ps1 -Origin http://127.0.0.1:19387
#>
param(
  [string]$Origin = 'http://127.0.0.1:19387'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1) 清除 Electron-as-Node 污染（关键）
if (Test-Path Env:\ELECTRON_RUN_AS_NODE) {
  Write-Host '清除 ELECTRON_RUN_AS_NODE（否则 Electron 会退化为 Node）' -ForegroundColor DarkYellow
  Remove-Item Env:\ELECTRON_RUN_AS_NODE -Force
}

# 2) 定位 electron.exe
$exe = Join-Path $here 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) {
  Write-Error "未找到 Electron 运行时: $exe`n请先在 $here 执行: npm install electron"
  exit 1
}

# 3) 自检：确认是真 Electron
$ver = & $exe --version 2>&1
if ($ver -notmatch '^v\d+\.') {
  Write-Error "Electron 自检失败，输出: $ver"
  exit 1
}

Write-Host "DSH Companion 启动中（Electron $ver，目标 $Origin）" -ForegroundColor Cyan

# 4) 启动（不等待，脱离当前控制台）
$env:DSH_ORIGIN = $Origin
Start-Process -FilePath $exe -ArgumentList $here -WindowStyle Hidden

Write-Host '已启动。悬浮球出现在屏幕右侧中部；单击打开小窗，拖动可移动，松手自动吸附边缘。' -ForegroundColor Green
Write-Host "退出：右键任务栏托盘图标 → 退出" -ForegroundColor DarkGray
