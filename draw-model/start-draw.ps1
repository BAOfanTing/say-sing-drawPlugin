# 启动本地出图服务（Qwen-Image-2.1-Turbo，纯 diffusers）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File draw-model\start-draw.ps1
#   powershell -ExecutionPolicy Bypass -File draw-model\start-draw.ps1 -IdleSeconds 0  # 常驻不退
#
# 需要先有 draw-model\weights\ 下的权重（见 draw-model\README.md 的下载清单）。

param(
  [int]$Port = 7880,
  [int]$IdleSeconds = 60,
  [string]$Token = '',
  [string]$Python = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path   # 就是 draw-model\

# venv 优先（里面有 diffusers / transformers / bitsandbytes），退回 sing/say-sing 环境
if (-not $Python) {
  $venvPy = Join-Path $here '.venv\Scripts\python.exe'
  if (Test-Path $venvPy) {
    $Python = $venvPy
  } else {
    $cands = @(
      'E:\APP\Anaconda\envs\sing\python.exe',
      'C:\ProgramData\Anaconda3\envs\say-sing\python.exe'
    )
    foreach ($envName in @('sing', 'say-sing', 'breeze')) {
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
    if (-not $Python) {
      $pyCmd = (Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1)
      if ($pyCmd) { $Python = if ($pyCmd.Path) { $pyCmd.Path } else { $pyCmd.Source } }
    }
  }
}

$weights = Join-Path $here 'weights'
if (-not (Test-Path $weights)) {
  Write-Host "✗ 权重目录不存在：$weights" -ForegroundColor Red
  Write-Host "  先按 draw-model\README.md 的清单下载" -ForegroundColor Yellow
  exit 1
}

# 缺 TURBO 的主体权重就直接说清楚，别等第一张图才报错
$need = @(
  'turbo-dit\transformer\diffusion_pytorch_model-00001-of-00002.safetensors',
  'turbo-dit\transformer\diffusion_pytorch_model-00002-of-00002.safetensors',
  'turbo-vae\vae\diffusion_pytorch_model.safetensors',
  'text_encoders\model-00001-of-00002.safetensors',
  'text_encoders\model-00002-of-00002.safetensors'
)
$missing = @()
$corrupted = @()
foreach ($item in $need) {
  $target = Join-Path $weights $item
  if (-not (Test-Path $target)) {
    $missing += $item
  } elseif ((Get-Item $target).Length -lt 1048576) {
    $corrupted += $item
  }
}
if ($missing) {
  Write-Host "⚠ 还缺这些权重（第一次出图会失败）：" -ForegroundColor Yellow
  $missing | ForEach-Object { Write-Host "    $_" }
}
if ($corrupted) {
  Write-Host "✗ 以下权重文件大小异常（0 字节或下载未完成，会导致加载报错 502）：" -ForegroundColor Red
  $corrupted | ForEach-Object {
    $sz = [math]::Round((Get-Item (Join-Path $weights $_)).Length / 1MB, 2)
    Write-Host "    $_  ($sz MB)" -ForegroundColor Red
  }
  Write-Host "  请删除上述异常文件并按 draw-model\README.md 重新下载完整权重" -ForegroundColor Yellow
}

$env:DRAW_PORT = "$Port"
$env:DRAW_IDLE_SECONDS = "$IdleSeconds"
$env:DRAW_WEIGHTS = $weights
if ($Token) { $env:DRAW_TOKEN = $Token } else { Remove-Item Env:\DRAW_TOKEN -ErrorAction SilentlyContinue }
$env:PYTHONIOENCODING = 'utf-8'
# HF 直连被墙：强制离线，只读本地文件
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:NODE_OPTIONS = '--dns-result-order=ipv4first'   # 网关侧同样需要，这里只是为了保持一致

Write-Host "Python : $Python"
Write-Host "权重   : $weights"
Write-Host "监听   : http://127.0.0.1:$Port  (闲置退出 ${IdleSeconds}s)"
Write-Host ""

& $Python (Join-Path $here 'server.py')
