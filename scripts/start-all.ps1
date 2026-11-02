# 一键跑起来：检查环境 → 体检权重 → 生成配置 → 起网关 →（有画图权重就）起出图服务 → 起隧道 → 打印地址
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1              # 说话+唱歌（有画图权重就自动带上）
#   powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1 -NoDraw     # 只要说话+唱歌
#   powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1 -Detach     # 计划任务常驻
#   powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1 -NoTunnel   # 只要本地网关
#
# 做了什么：
#   1. 找 node / python，缺哪个直接告诉你
#   2. gateway/config.json 不存在就从 config.example.json 生成，并自动填随机令牌、
#      python 路径、本地权重路径（本机情况自动探测，不用手改）
#   3. 有 Breeze 权重就跑 say-model\check-ckpt.py 体检
#   4. 起网关（前台或计划任务）
#   5. 有画图权重（draw-model\weights\turbo-dit）就顺手把出图服务拉起来（默认带，-NoDraw 关掉）
#   6. 起 cloudflared quick tunnel，等它给出 https 地址并打印
param(
    [switch]$Detach,
    [switch]$NoTunnel,
    [switch]$NoDraw,
    [string]$Python = '',
    [string]$Cloudflared = '',
    [int]$Port = 8899
)

$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
Write-Host "仓库：$repo" -ForegroundColor Cyan

# ── 1. 环境 ────────────────────────────────────────────────
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw '找不到 node.exe，请先装 Node.js 18+ 并加到 PATH' }
Write-Host ("✓ node " + (& $node -v)) -ForegroundColor Green

if (-not $Python) {
    # 常见位置 + conda 环境逐个试
    $cands = @(
        (Join-Path $env:USERPROFILE 'miniconda3\envs\say-sing\python.exe'),
        'E:\APP\Anaconda\envs\say-sing\python.exe',
        'C:\ProgramData\Anaconda3\envs\say-sing\python.exe'
    )
    foreach ($envName in @('say-sing', 'sing', 'breeze')) {
        $base = (Get-Command conda -ErrorAction SilentlyContinue)
        if ($base) {
            $condaRoot = Split-Path -Parent (Split-Path -Parent $base.Source)
            $cands += (Join-Path $condaRoot "envs\$envName\python.exe")
        }
    }
    $Python = ($cands | Where-Object { Test-Path $_ } | Select-Object -First 1)
    if (-not $Python) {
        $p = (Get-Command python -ErrorAction SilentlyContinue).Source
        if ($p) { $Python = $p }
    }
}
if (-not $Python -or -not (Test-Path $Python)) {
    throw '找不到 python.exe，用 -Python <路径> 指定（要装了 requirements.txt 的那个环境）'
}
Write-Host "✓ python $Python" -ForegroundColor Green
& $Python -c "import torch" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host '⚠ 这个 python 里没有 torch：本地说话/唱歌会失败；' -ForegroundColor Yellow
    Write-Host '  先按 docs\QUICKSTART.md 第 1 步装依赖：python -m pip install -r requirements.txt' -ForegroundColor Yellow
}

# ── 2. 配置 ────────────────────────────────────────────────
$cfgPath = Join-Path $repo 'gateway\config.json'
if (-not (Test-Path $cfgPath)) {
    $example = Join-Path $repo 'gateway\config.example.json'
    Copy-Item $example $cfgPath
    $cfg = Get-Content $cfgPath -Raw -Encoding utf8 | ConvertFrom-Json
    # 随机令牌
    $bytes = [byte[]]::new(24)
    ([System.Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($bytes)
    $cfg.token = ([Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', '').Substring(0, 32).ToLower()
    # 本机路径
    $cfg.say.localPython = $Python
    $cfg.say.localModelDir = (Join-Path $repo 'say-model\weights\breeze-tts-2')
    $cfg.say.localAppDir = (Join-Path $repo 'say-model')
    if ($cfg.voice) {
        $cfg.voice.command = "`"$Python`" `"$(Join-Path $repo 'sing-model\run.py')`" --input {input} --output {output} --voice {voice} --pitch {pitch} --max-seconds {maxSeconds} --segment-seconds {segmentSeconds} --gpu-fraction 0.9"
        $cfg.voice.serveCommand = "`"$Python`" `"$(Join-Path $repo 'sing-model\run.py')`" --serve"
    }
    $cfg | ConvertTo-Json -Depth 8 | Set-Content $cfgPath -Encoding utf8
    Write-Host "✓ 已生成 gateway\config.json（令牌已随机生成）" -ForegroundColor Green
} else {
    $cfg = Get-Content $cfgPath -Raw -Encoding utf8 | ConvertFrom-Json
    Write-Host '✓ 复用已有的 gateway\config.json' -ForegroundColor Green
}
$token = $cfg.token
if (-not $token) { Write-Host '⚠ config.token 是空的：网关将不做鉴权，公网暴露很危险' -ForegroundColor Yellow }

# ── 3. 权重体检 ────────────────────────────────────────────
$ckpt = Join-Path $repo 'say-model\weights\breeze-tts-2'
if ((Test-Path $ckpt) -and (Test-Path (Join-Path $repo 'say-model\check-ckpt.py'))) {
    & $Python (Join-Path $repo 'say-model\check-ckpt.py') $ckpt | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host '· 没找到本地 Breeze 权重：说话会走云端（需要插件里填 Breeze API Key）' -ForegroundColor Yellow
}

# ── 4. 网关 ────────────────────────────────────────────────
$health = $null
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
} catch { }
if ($health -and $health.ok) {
    Write-Host "✓ 网关已在运行（v$($health.version)，say=$($health.say)）" -ForegroundColor Green
} elseif ($Detach) {
    $taskName = 'QQAgentSingGateway'
    $action = "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$(Join-Path $repo 'scripts\run-gateway-forever.ps1')`""
    schtasks /Create /TN $taskName /TR $action /SC ONLOGON /RL HIGHEST /F | Out-Null
    schtasks /Run /TN $taskName | Out-Null
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 } catch { }
        if ($health.ok) { break }
    }
    if (-not $health.ok) { throw '网关没起来，看 gateway\gateway-run\gateway.log' }
    Write-Host "✓ 网关已常驻（计划任务 $taskName，v$($health.version)）" -ForegroundColor Green
} else {
    Write-Host '▶ 前台启动网关（Ctrl+C 停止；要常驻加 -Detach）' -ForegroundColor Cyan
    $env:PATH = "$(Join-Path $repo 'sing-model\bin');$env:PATH"
    & $node (Join-Path $repo 'gateway\server.mjs')
    return
}

# ── 5. Cloudflare 隧道 ────────────────────────────────────
if ($NoTunnel) {
    Write-Host "· 跳过隧道。本地地址：http://127.0.0.1:$Port" -ForegroundColor Yellow
} else {
    if (-not $Cloudflared) {
        $cfCands = @(
            (Join-Path $repo 'tools\cloudflared.exe'),
            (Join-Path (Split-Path -Parent $repo) 'tools\cloudflared.exe'),
            (Join-Path $env:USERPROFILE 'cloudflared.exe'),
            'C:\ProgramData\cloudflared\cloudflared.exe',
            (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
        )
        foreach ($c in $cfCands) {
            if ($c -and (Test-Path $c)) { $Cloudflared = $c; break }
        }
    }
    if (-not $Cloudflared) {
        Write-Host '⚠ 没找到 cloudflared.exe（放 tools\ 或加到 PATH）。' -ForegroundColor Yellow
        Write-Host '  下载（一条命令）：' -ForegroundColor Yellow
        Write-Host '    curl.exe -L -o tools\cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -ForegroundColor Yellow
        Write-Host "  本地网关仍可用：http://127.0.0.1:$Port" -ForegroundColor Yellow
    } else {
        $logDir = Join-Path $repo 'logs'
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        $cfLog = Join-Path $logDir 'cloudflared.log'
        if (Test-Path $cfLog) { Remove-Item $cfLog -Force }
        Get-CimInstance Win32_Process -Filter "name='cloudflared.exe'" |
            Where-Object { $_.CommandLine -like "*$Port*" } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        # Start-Process 会脱离当前会话的作业对象
        Start-Process -FilePath $Cloudflared -ArgumentList 'tunnel', '--url', "http://127.0.0.1:$Port", '--no-autoupdate' `
            -WindowStyle Hidden -RedirectStandardError $cfLog -RedirectStandardOutput (Join-Path $logDir 'cloudflared.out.log') | Out-Null
        $url = ''
        for ($i = 0; $i -lt 40; $i++) {
            Start-Sleep -Seconds 2
            if (Test-Path $cfLog) {
                $m = Select-String -Path $cfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches -ErrorAction SilentlyContinue |
                    ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } | Select-Object -First 1
                if ($m) { $url = $m; break }
            }
        }
        if ($url) {
            Write-Host ''
            Write-Host "✓ 隧道地址：$url" -ForegroundColor Green
            Write-Host '  下一步（在你自己电脑上跑，插件 → 隧道、语音条 → 8898 专线一次改完）：' -ForegroundColor Cyan
            Write-Host '    powershell -ExecutionPolicy Bypass -File scripts\sync-host-url.ps1 -SshHost root@<你的服务器IP>'
            Write-Host "    （脚本会：插件 gatewayUrl = $url；tts.baseUrl = https://<服务器IP>:8898/v1）" -ForegroundColor DarkGray
            Write-Host ''
            Write-Host "  网关令牌（填进插件「网关令牌」）：$token" -ForegroundColor Cyan
            Write-Host '  ⚠ 快速隧道地址每次重启都会变，变了就重跑上面两条命令（或改用 ssh -R 专线，见 docs\TUNNEL.md）' -ForegroundColor Yellow
        } else {
            Write-Host '⚠ 隧道没起来，看 logs\cloudflared.log；本地网关仍可用' -ForegroundColor Yellow
        }
    }

    # ── 画图服务（有权重才拉起来；-NoDraw 可关）────────────────
    if (-not $NoDraw) {
        $drawWeights = Join-Path $repo 'draw-model\weights\turbo-dit\transformer'
        $drawStart = Join-Path $repo 'draw-model\start-draw.ps1'
        $hasWeights = (Test-Path $drawWeights) -and
            (Get-ChildItem $drawWeights -Filter '*.safetensors' -ErrorAction SilentlyContinue | Select-Object -First 1)
        if (-not $hasWeights) {
            Write-Host ''
            Write-Host '· 没找到画图权重，跳过出图服务（想开画图见 draw-model\README.md 的下载地址表）' -ForegroundColor DarkGray
        } elseif (-not (Test-Path $drawStart)) {
            Write-Host '⚠ 有画图权重但没有 draw-model\start-draw.ps1' -ForegroundColor Yellow
        } else {
            Write-Host ''
            Write-Host '▶ 起出图服务（7880，闲置 5 分钟自动卸载）…' -ForegroundColor Cyan
            $task = schtasks.exe /Query /TN 'QQAgentDrawService' 2>$null
            if ($task) {
                schtasks.exe /Run /TN 'QQAgentDrawService' | Out-Null
            } else {
                Start-Process -FilePath 'powershell.exe' `
                    -ArgumentList @('-ExecutionPolicy', 'Bypass', '-NoProfile', '-WindowStyle', 'Hidden', '-File', $drawStart) `
                    -WindowStyle Hidden | Out-Null
            }
            $drawUp = $false
            for ($i = 0; $i -lt 20; $i++) {
                Start-Sleep -Seconds 2
                $code = & curl.exe -s -m 5 -o NUL -w '%{http_code}' 'http://127.0.0.1:7880/health' 2>$null
                if ($code -eq '200') { $drawUp = $true; break }
            }
            if ($drawUp) {
                Write-Host '✓ 出图服务已就绪：http://127.0.0.1:7880' -ForegroundColor Green
                Write-Host '  控制台 → 图片生成 → 服务地址填 <上面那个网关地址>/v1、模型随便填、API Key 填网关令牌' -ForegroundColor Cyan
                Write-Host '  （1024×1024 / 8 步约 25 秒/张，首张要加载 13 GB 权重）' -ForegroundColor DarkGray
            } else {
                Write-Host '⚠ 出图服务没起来，看 draw-model\logs\draw-service.err.log' -ForegroundColor Yellow
            }
        }
    }
}
