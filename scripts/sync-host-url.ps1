# 把隧道地址同步到服务器（插件 gatewayUrl → 隧道；宿主 tts.baseUrl → 建议专线）
#
# Cloudflare 快速隧道每次重启都会换地址，这个脚本省得你手动抄：
#   1. 从 logs\cloudflared.log 里读出最新的 https://xxx.trycloudflare.com
#   2. 通过 ssh 在服务器上跑 set-gateway-url.sh（插件地址）和 set-tts-url.sh（语音条通道）
#
# ⚠️ 为什么两件事分开：
#   插件只发短请求（搜索/起任务/查状态），走快速隧道完全没问题；
#   但**语音条通道是宿主同步等音频**（几秒到一分半），快速隧道约 100 秒会回 524。
#   所以默认把 tts 指向专线 `https://<服务器IP>:8898/v1`（ssh -R 反向隧道，没有 100 秒上限）。
#
# 用法：
#   # 推荐：插件走隧道，语音条走 8898 专线（自动从 -SshHost 里取 IP）
#   powershell -ExecutionPolicy Bypass -File scripts\sync-host-url.ps1 -SshHost root@<服务器IP>
#
#   # 只想把两者都指到隧道（临时/没配专线时；语音条可能 524）
#   powershell -ExecutionPolicy Bypass -File scripts\sync-host-url.ps1 -SshHost root@<IP> -TtsUrl tunnel
param(
    [Parameter(Mandatory = $true)][string]$SshHost,
    [string]$Key = "$env:USERPROFILE\.ssh\dsh_ed25519_stats",
    [string]$Url = '',
    [string]$Token = '',
    # 空 = 自动推导 https://<SshHost 里的IP>:8898/v1；填 tunnel = 与插件同地址；也可直接给完整地址
    [string]$TtsUrl = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

# 1. 拿插件地址（快速隧道）
if (-not $Url) {
    $log = Join-Path $repo 'logs\cloudflared.log'
    if (-not (Test-Path $log)) {
        throw "找不到 $log —— 先用 scripts\start-all.ps1 起隧道，或用 -Url 直接指定"
    }
    $Url = (Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches |
        ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } |
        Select-Object -Unique | Select-Object -Last 1)
    if (-not $Url) { throw "日志里没有隧道地址，隧道可能没起来（看 $log）" }
}
Write-Host "插件地址（隧道）：$Url" -ForegroundColor Cyan

# 2. 拿令牌（从 gateway\config.json）
if (-not $Token) {
    $cfg = Join-Path $repo 'gateway\config.json'
    if (-not (Test-Path $cfg)) { throw "找不到 $cfg —— 先跑 scripts\start-all.ps1 生成配置" }
    $Token = (Get-Content $cfg -Raw -Encoding utf8 | ConvertFrom-Json).token
}
if (-not $Token) { throw 'gateway\config.json 里的 token 是空的，先在配置里设一个' }

# 3. 定语音条地址
if (-not $TtsUrl) {
    $hostPart = ($SshHost -split '@')[-1]
    if ($hostPart -match '^\d+\.\d+\.\d+\.\d+$') {
        $TtsUrl = "https://$hostPart`:8898/v1"
    } else {
        $TtsUrl = "$Url/v1"
        Write-Host '⚠ 从 -SshHost 看不出服务器 IP，语音条也指向隧道了 —— 长音频可能 524。' -ForegroundColor Yellow
        Write-Host '  建议显式传 -TtsUrl https://<服务器IP>:8898/v1（专线配法见 docs/TUNNEL.md）' -ForegroundColor Yellow
    }
} elseif ($TtsUrl -eq 'tunnel') {
    $TtsUrl = "$Url/v1"
    Write-Host '⚠ 语音条指向快速隧道：短语音没问题，长歌（>80 秒）可能 524。' -ForegroundColor Yellow
} elseif ($TtsUrl -notmatch '/v1$') {
    $TtsUrl = "$TtsUrl/v1"
}
Write-Host "语音条地址：$TtsUrl" -ForegroundColor Cyan

# 4. 到服务器上改
$ssh = (Get-Command ssh.exe -ErrorAction SilentlyContinue).Source
if (-not $ssh) { throw '找不到 ssh.exe' }

$cmd = "bash /opt/qq-agent/set-gateway-url.sh $Url $Token && bash /opt/qq-agent/set-tts-url.sh $TtsUrl"
Write-Host "▶ 同步到 $SshHost" -ForegroundColor Cyan
& $ssh -i $Key -o ConnectTimeout=15 -o BatchMode=yes $SshHost $cmd
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ 同步失败（退出码 $LASTEXITCODE）。检查 ssh 免密、服务器上的 set-*.sh 是否存在" -ForegroundColor Red
    exit 1
}
Write-Host '✓ 已同步：插件 → 隧道；宿主 tts → 上面对应的语音条地址' -ForegroundColor Green
Write-Host '  接着在控制台 → 插件 → 点歌唱歌，点一次「检测登录」确认显示「说话后端在线」' -ForegroundColor Cyan
