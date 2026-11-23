<#
  网关守护：崩溃/退出后自动重启（Windows 没 systemd，用这个小循环顶上）。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts/run-gateway-forever.ps1
  建议做成"登录时启动"的计划任务（README「运维」一节有命令）。

  退出码 0 = 正常停止（Ctrl+C），不再重启；其它退出码一律 3 秒后重来。
#>
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw '找不到 node，请把 Node.js 加到 PATH' }

# 放宽地址族探测超时（避免 Happy Eyeballs 慢连导致偶发 fetch failed）
if (-not $env:NODE_OPTIONS) {
    $env:NODE_OPTIONS = '--network-family-autoselection-attempt-timeout=5000'
}

# 让 RVC 子进程能找到 ffmpeg（sing-model/bin 里那份）与 conda 的 Scripts
$ffmpegBin = Join-Path $here 'sing-model\bin'
if (Test-Path $ffmpegBin) { $env:PATH = "$ffmpegBin;$env:PATH" }

$log = Join-Path $here 'gateway\gateway-run\gateway.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

$attempt = 0
while ($true) {
  $attempt += 1
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  Add-Content -LiteralPath $log -Value "[$stamp] 启动网关（第 $attempt 次）" -Encoding utf8
  try {
    # 直接继承控制台输出，同时写日志：Tee 在 5.1 里对原生命令不可靠，所以用重定向 + 实时读
    & $node (Join-Path $here 'gateway\server.mjs') 2>&1 | ForEach-Object {
      $line = "[$((Get-Date).ToString('HH:mm:ss'))] $_"
      Write-Host $line
      Add-Content -LiteralPath $log -Value $line -Encoding utf8
    }
    $code = $LASTEXITCODE
  } catch {
    $code = 1
    Add-Content -LiteralPath $log -Value "[$stamp] 启动失败：$_" -Encoding utf8
  }
  if ($code -eq 0) {
    Add-Content -LiteralPath $log -Value "[$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] 网关正常退出，不再重启" -Encoding utf8
    break
  }
  Add-Content -LiteralPath $log -Value "[$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] 网关退出（code=$code），3 秒后重启" -Encoding utf8
  Start-Sleep -Seconds 3
}
