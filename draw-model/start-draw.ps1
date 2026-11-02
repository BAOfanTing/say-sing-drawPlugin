# 启动本地出图服务（Qwen-Image-2.1-Turbo，纯 diffusers）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File draw\start-draw.ps1
#   powershell -ExecutionPolicy Bypass -File draw\start-draw.ps1 -IdleSeconds 0     # 常驻不退
#
# 需要先有 draw-model\weights\ 下的权重（见 draw\README.md 的下载清单）。

param(
  [int]$Port = 7880,
  [int]$IdleSeconds = 180,
  [string]$Token = '',
  [string]$Python = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path   # 就是 draw-model\

# venv 优先（里面有 diffusers / transformers / bitsandbytes），退回 sing 环境
if (-not $Python) {
  $venvPy = Join-Path $here '.venv\Scripts\python.exe'
  if (Test-Path $venvPy) { $Python = $venvPy }
  else { $Python = 'E:\APP\Anaconda\envs\sing\python.exe' }
}

$weights = Join-Path $here 'weights'
if (-not (Test-Path $weights)) {
  Write-Host "✗ 权重目录不存在：$weights" -ForegroundColor Red
  Write-Host "  先按 draw\README.md 的清单下载" -ForegroundColor Yellow
  exit 1
}

# 缺 TURBO 的主体权重就直接说清楚，别等第一张图才报错
$need = @(
  'turbo-dit\transformer\diffusion_pytorch_model-00001-of-00002.safetensors',
  'turbo-vae\vae\diffusion_pytorch_model.safetensors',
  'text_encoders\model-00001-of-00002.safetensors'
)
$missing = $need | Where-Object { -not (Test-Path (Join-Path $weights $_)) }
if ($missing) {
  Write-Host "⚠ 还缺这些权重（服务仍会启动，但第一次出图会失败）：" -ForegroundColor Yellow
  $missing | ForEach-Object { Write-Host "    $_" }
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
