# 看门狗：每 5 分钟检查三个后端，挂了就重启对应计划任务。
#
# 为什么需要：宿主机看到的 502 通常是"隧道活着但本地 8899 挂了"，或"隧道断了但任务没重连"。
# 这个脚本把两种情况都兜住，并把结果写进 logs/watchdog.log。
#
# 注册（一次性）：
#   schtasks /Create /TN "QQAgentWatchdog" /SC MINUTE /MO 5 /RL HIGHEST /F ^
#     /TR "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File <仓库路径>\scripts\watchdog.ps1"

param(
  [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
)

$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $RepoRoot 'logs\watchdog.log'
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
function Write-Log([string]$msg) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null
  Add-Content -LiteralPath $log -Value "[$stamp] $msg" -Encoding utf8
}

function Test-Url([string]$url, [int]$timeoutSec = 6, [switch]$insecure) {
  $args = @('-s', '-m', "$timeoutSec", '-o', 'NUL', '-w', '%{http_code}')
  if ($insecure) { $args = @('-k') + $args }
  $code = & curl.exe @args $url 2>$null
  return ($code -eq '200')
}

# ── 1) 本地网关 8899 ─────────────────────────────────────
if (-not (Test-Url 'http://127.0.0.1:8899/health')) {
  Write-Log '网关 8899 不通 → 重启 QQAgentSingGateway'
  schtasks.exe /Run /TN 'QQAgentSingGateway' | Out-Null
  Start-Sleep -Seconds 12
  if (Test-Url 'http://127.0.0.1:8899/health') { Write-Log '  ✓ 网关已恢复' }
  else { Write-Log '  ✗ 网关仍未恢复，需要人工看 logs\gateway.log' }
}

# ── 2) 反向隧道（ssh 进程）──────────────────────────────
$ssh = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" |
  Where-Object { $_.CommandLine -match '124\.71\.186\.144|-R 127\.0\.0\.1:8898' }
if (-not $ssh) {
  Write-Log '隧道 ssh 进程不存在 → 重启 QQAgentSingTunnel'
  schtasks.exe /Run /TN 'QQAgentSingTunnel' | Out-Null
  Start-Sleep -Seconds 10
  if (Test-Url 'https://127.0.0.1:8898/health' -insecure) { Write-Log '  ✓ 隧道已恢复' }
  else { Write-Log '  ✗ 隧道仍未恢复' }
}

# ── 3) 出图服务 7880（可选，挂了才拉起）────────────────
if (-not (Test-Url 'http://127.0.0.1:7880/health')) {
  $drawTask = schtasks.exe /Query /TN 'QQAgentDrawService' 2>$null
  if ($drawTask) {
    Write-Log '出图服务 7880 不通 → 重启 QQAgentDrawService'
    schtasks.exe /Run /TN 'QQAgentDrawService' | Out-Null
    Start-Sleep -Seconds 10
    if (Test-Url 'http://127.0.0.1:7880/health') { Write-Log '  ✓ 出图服务已恢复' }
    else { Write-Log '  ✗ 出图服务仍未恢复' }
  }
}

# 只在"有动作"时写日志；正常时不刷屏（下面这行只在你手动加 -Verbose 时输出）
if ($PSBoundParameters.ContainsKey('Verbose')) {
  Write-Log ('检查完成：网关/隧道/出图 ' + (@(
      (Test-Url 'http://127.0.0.1:8899/health'),
      [bool]$ssh,
      (Test-Url 'http://127.0.0.1:7880/health')) -join ' / '))
}
