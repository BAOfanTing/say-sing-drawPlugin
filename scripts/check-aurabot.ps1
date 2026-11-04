# 给 aurabot（dsh-aurabot-qq）接本机网关时用的一条命令自检。
#
#   powershell -ExecutionPolicy Bypass -File scripts\check-aurabot.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\check-aurabot.ps1 -SkipDraw
#
# 做四件事：验令牌 → 看看报哪些 model/音色 → 念一句 → （可选）出一张图，
# 最后把能直接粘进 aurabot 配置的 JSON 打出来。

param(
  [string]$Base = 'http://127.0.0.1:8899',
  [string]$Token = '',
  [string]$SayText = '爸爸我回来啦，今天想吃炸鸡',
  [switch]$SkipDraw,
  [switch]$SkipSay
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot

function Step($name) { Write-Host "`n=== $name ===" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Bad($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }

# 没给令牌就从 gateway/config.json 里读
if (-not $Token) {
  $cfgPath = Join-Path $here 'gateway\config.json'
  if (Test-Path $cfgPath) {
    $Token = (Get-Content $cfgPath -Raw | ConvertFrom-Json).token
    if ($Token) { Ok "从 gateway\config.json 读到令牌" }
  }
}
if (-not $Token) { throw '没有令牌：用 -Token 传，或在 gateway\config.json 里填 token' }

$headers = @{ Authorization = "Bearer $Token" }

Step '1/4 /health（免鉴权）'
try {
  $h = Invoke-RestMethod -Uri "$Base/health" -TimeoutSec 15
  Ok "engine=$($h.engine) say=$($h.say) 画图=$($h.models.draw) 任务=$($h.jobs)"
  if ($h.engine -eq 'none') { Bad '换声引擎是 none：翻唱会失败（config.voice.engine = command 并填命令）' }
  if ($h.say -eq 'none') { Bad '说话引擎是 none：/v1/audio/speech 只会唱歌（config.say.engine = breeze）' }
} catch {
  Bad "网关没起来或地址不对：$($_.Exception.Message)"
  throw
}

Step '2/4 /v1/models（宿主面板要填的 model 名）'
try {
  $m = Invoke-RestMethod -Uri "$Base/v1/models" -Headers $headers -TimeoutSec 15
  foreach ($d in $m.data) { Ok "$($d.kind)`t$($d.id)" }
  if ($m.voices -and $m.voices.Count) { Ok "TTS 音色：$(($m.voices | ForEach-Object { $_.id }) -join ', ')" }
  if ($m.singVoices -and $m.singVoices.Count) { Ok "换声音色：$($m.singVoices -join ', ')" }
} catch {
  Bad "取模型清单失败：$($_.Exception.Message)"
}

if (-not $SkipSay) {
  Step '3/4 念一句（/v1/audio/speech）'
  $body = @{ model = 'breeze-tts-2'; input = $SayText; voice = 'hanser'; response_format = 'mp3' } | ConvertTo-Json -Compress
  $out = Join-Path $env:TEMP ("aurabot-say-" + [guid]::NewGuid().ToString('N') + ".mp3")
  try {
    Invoke-WebRequest -Uri "$Base/v1/audio/speech" -Method Post -Headers $headers `
      -ContentType 'application/json' -Body $body -OutFile $out -TimeoutSec 180 | Out-Null
    $kb = [math]::Round((Get-Item $out).Length / 1KB, 1)
    if ($kb -lt 1) { Bad "音频只有 $kb KB，多半失败了" } else { Ok "合成成功：$kb KB → $out" }
  } catch {
    Bad "合成失败：$($_.Exception.Message)"
  }
} else { Step '3/4 念一句（已跳过）' }

if (-not $SkipDraw) {
  Step '4/4 出一张图（/v1/images/generations）'
  $drawBody = @{ model = 'qwen-image'; prompt = '蓝白配色的小鲸鱼，Q 版，白色背景'; size = '1024x1024'; n = 1; response_format = 'b64_json' } | ConvertTo-Json -Compress
  try {
    $r = Invoke-RestMethod -Uri "$Base/v1/images/generations" -Method Post -Headers $headers `
      -ContentType 'application/json' -Body $drawBody -TimeoutSec 600
    $b64 = $r.data[0].b64_json
    if (-not $b64) { Bad '返回里没有 b64_json（看看网关日志的 [draw] 行）' }
    else {
      $png = Join-Path $env:TEMP ("aurabot-draw-" + [guid]::NewGuid().ToString('N') + ".png")
      [IO.File]::WriteAllBytes($png, [Convert]::FromBase64String($b64))
      Ok "出图成功：$([math]::Round((Get-Item $png).Length / 1KB, 1)) KB → $png"
    }
  } catch {
    Bad "出图失败：$($_.Exception.Message)（本机出图服务没起？看 /health 的 models.draw）"
  }
} else { Step '4/4 出一张图（已跳过）' }

Step '粘进 aurabot 的配置（~/.dsh/plugins-data/aurabot/config.json）'
$snippet = [ordered]@{
  voice = [ordered]@{
    enabled = $true
    engine  = 'openai'
    openai  = [ordered]@{
      baseUrl = "$Base/v1"; apiKey = $Token; model = 'breeze-tts-2'; voice = 'hanser'
      format = 'mp3'; speed = 1; timeoutMs = 120000; sampleRate = 24000
    }
    autoChance = 0.2
    autoMaxChars = 80
  }
  song = [ordered]@{
    enabled = $true; gatewayUrl = $Base; gatewayToken = $Token; gatewayTimeoutMs = 900000; maxVoiceSec = 120
  }
  imageGen = [ordered]@{
    enabled = $true; provider = 'openai'; baseUrl = "$Base/v1"; apiKey = $Token; model = 'qwen-image'; size = '1024x1024'
  }
}
$snippet | ConvertTo-Json -Depth 6
Write-Host "`n提示：改完 config.json 重启 DSH 生效；aurabot 面板「语音」页也能看到引擎。" -ForegroundColor DarkGray
