# 本地启动 Breeze TTS 2（Windows 原生，eager 模式）
#
# 为什么是 eager：--fast-* 要走 Inductor 编译 CUDA graph，需要 MSVC Build Tools + CUDA 12 toolkit；
# 本机只有 CUDA 11.2 且没装 MSVC，所以先用 eager（显存约 7.7 GB，速度慢些但能跑）。
# 将来装好工具链，把 $Fast 改成 $true 即可用上加速路径。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File say-model\start-local.ps1
#   powershell -ExecutionPolicy Bypass -File say-model\start-local.ps1 -Port 7861 -Fast
param(
    [int]$Port = 7860,
    [string]$HostAddr = '127.0.0.1',
    [switch]$Fast,
    [string]$Python = '',
    [string]$ModelDir = ''
)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
if (-not $ModelDir) { $ModelDir = Join-Path $repo 'weights\breeze-tts-2' }
$logDir = Join-Path $repo 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not $Python) {
    $cfgPath = Join-Path (Split-Path -Parent $repo) 'gateway\config.json'
    if (Test-Path $cfgPath) {
        try {
            $cfg = Get-Content $cfgPath -Raw -Encoding utf8 | ConvertFrom-Json
            if ($cfg.say.localPython -and (Test-Path $cfg.say.localPython)) { $Python = $cfg.say.localPython }
        } catch {}
    }
}
if (-not $Python) {
    $cands = @(
        (Join-Path $repo '.venv\Scripts\python.exe'),
        'E:\APP\Anaconda\envs\sing\python.exe',
        'C:\ProgramData\Anaconda3\envs\say-sing\python.exe'
    )
    foreach ($envName in @('say-sing', 'sing', 'breeze')) {
        $base = (Get-Command conda -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($base) {
            $basePath = if ($base.Path) { $base.Path } elseif ($base.Source) { $base.Source } else { $base.Definition }
            if ($basePath -and (Test-Path $basePath)) {
                $p1 = Split-Path -Parent $basePath
                if ($p1) {
                    $condaRoot = Split-Path -Parent $p1
                    if ($condaRoot) { $cands += (Join-Path $condaRoot "envs\$envName\python.exe") }
                }
            }
        }
    }
    $Python = ($cands | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1)
}
if (-not $Python) {
    $pyCmd = (Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($pyCmd) { $Python = if ($pyCmd.Path) { $pyCmd.Path } else { $pyCmd.Source } }
}

if (-not (Test-Path (Join-Path $ModelDir 'config.json'))) {
    Write-Host "✗ 权重目录不对：$ModelDir" -ForegroundColor Red
    Write-Host "  先跑体检：$Python $repo\check-ckpt.py" -ForegroundColor Yellow
    exit 1
}
if (-not (Test-Path $Python)) {
    Write-Host "✗ 找不到 Python：$Python" -ForegroundColor Red
    exit 1
}

$env:PYTHONPATH = $repo
$env:PYTHONIOENCODING = 'utf-8'
# Windows 下静态 CUDA launcher 会把 64 位指针塞进 ctypes.c_long 报 OverflowError
$env:TORCHINDUCTOR_USE_STATIC_CUDA_LAUNCHER = '0'
$env:TORCHINDUCTOR_CACHE_DIR = Join-Path $env:LOCALAPPDATA 'breeze-inductor'

# 只有一个进程能用显卡跑 TTS；先清掉残留
$pidFile = Join-Path $logDir 'breeze-local.pid'
if (Test-Path $pidFile) {
    $old = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($old) { Stop-Process -Id $old -Force -ErrorAction SilentlyContinue }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "name='python.exe'" |
    Where-Object { $_.CommandLine -like '*breeze_infer.api*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

$args = @('-m', 'breeze_infer.api', $ModelDir, '--host', $HostAddr, '--port', "$Port")
if ($Fast) {
    $args += @('--max-seq-len', '1024', '--fast-depth-decoder', '--fast-codec', '--fast-backbone-decode')
}

$outLog = Join-Path $logDir 'breeze-local.log'
$errLog = Join-Path $logDir 'breeze-local.err.log'
Write-Host "启动本地 Breeze（$(if ($Fast) { 'fast' } else { 'eager' })）→ http://${HostAddr}:${Port}" -ForegroundColor Cyan
Write-Host "  权重：$ModelDir"
Write-Host "  日志：$outLog"

$proc = Start-Process -FilePath $Python -ArgumentList $args -WorkingDirectory $repo `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
$proc.Id | Set-Content $pidFile

# 等它把 7 GB 权重读进显存（第一次要 1-3 分钟）
for ($i = 0; $i -lt 180; $i++) {
    Start-Sleep -Seconds 2
    if ($proc.HasExited) {
        Write-Host "✗ 进程退出了（code=$($proc.ExitCode)）" -ForegroundColor Red
        Get-Content $errLog -Tail 30 -ErrorAction SilentlyContinue
        exit 1
    }
    try {
        $r = Invoke-WebRequest -Uri "http://${HostAddr}:${Port}/health" -TimeoutSec 3 -UseBasicParsing
        if ($r.StatusCode -eq 200) {
            Write-Host "✓ 就绪（$($i * 2) 秒）" -ForegroundColor Green
            Write-Host $r.Content
            exit 0
        }
    } catch { }
}
Write-Host "✗ 等待就绪超时，看 $errLog" -ForegroundColor Red
exit 1
