# draw-model/ —— 本地出图服务（Qwen-Image-2.1-Turbo）

给宿主「图片生成」用的本地服务：**OpenAI 兼容**的 `POST /v1/images/generations`，
纯 Python（diffusers），不依赖 ComfyUI。

> 为什么不用 ComfyUI、为什么 GGUF 不行、10 GB 显存的账 —— 见 [../docs/DRAW.md](../docs/DRAW.md)。

## 它长什么样

```
宿主控制台「图片生成 → 服务地址」
        │  POST /v1/images/generations  { model, prompt, n, size }
        ▼
网关 8899（可选，带 GPU 仲裁 + 复用网关令牌）
        │  透传
        ▼
server.py 127.0.0.1:7880  ← 本目录（draw-model/）
        │  懒加载 + 闲置退出
        ▼
Qwen-Image-2.1-Turbo（nf4 4bit，约 4 GB 显存）+ Qwen3-VL-8B 文本编码器（4bit）
```

## 权重清单与下载地址（约 21 GB，全部放 `draw-model/weights/`）

> huggingface.co 在本机**直连被墙**（DNS 污染 + TLS 阻断），下面全部用 **ModelScope**。
> ModelScope 单线程约 1.4-2 MB/s；支持 Range/断点续传，用 IDM/aria2 多线程会快不少。

### ① DiT —— Qwen-Image-2.1-Turbo（13.25 GB，出图本体）

| 文件 | 大小 | 直链 |
|---|---|---|
| `transformer/diffusion_pytorch_model-00001-of-00002.safetensors` | 9.28 GB | https://modelscope.cn/models/Qwen/Qwen-Image-2.1-Turbo/resolve/master/transformer/diffusion_pytorch_model-00001-of-00002.safetensors |
| `transformer/diffusion_pytorch_model-00002-of-00002.safetensors` | 3.97 GB | https://modelscope.cn/models/Qwen/Qwen-Image-2.1-Turbo/resolve/master/transformer/diffusion_pytorch_model-00002-of-00002.safetensors |
| `transformer/config.json` + `diffusion_pytorch_model.safetensors.index.json` | 30 KB | https://modelscope.cn/models/Qwen/Qwen-Image-2.1-Turbo/resolve/master/transformer/config.json |

### ② VAE（0.63 GB）

| 文件 | 大小 | 直链 |
|---|---|---|
| `vae/diffusion_pytorch_model.safetensors` | 0.63 GB | https://modelscope.cn/models/Qwen/Qwen-Image-2.1-Turbo/resolve/master/vae/diffusion_pytorch_model.safetensors |
| `vae/config.json` | 2 KB | https://modelscope.cn/models/Qwen/Qwen-Image-2.1-Turbo/resolve/master/vae/config.json |

### ③ 文本编码器 —— Qwen3-VL-8B 4bit（7.17 GB）

> 2.1 的文本编码器是 **Qwen3-VL-8B**（不是 2.5-VL-7B）。这里用 unsloth 的 bnb-4bit 版（加载时量化，显存约 5 GB）。

| 文件 | 大小 | 直链 |
|---|---|---|
| `model-00001-of-00002.safetensors` | 4.64 GB | https://modelscope.cn/models/unsloth/Qwen3-VL-8B-Instruct-unsloth-bnb-4bit/resolve/master/model-00001-of-00002.safetensors |
| `model-00002-of-00002.safetensors` | 2.53 GB | https://modelscope.cn/models/unsloth/Qwen3-VL-8B-Instruct-unsloth-bnb-4bit/resolve/master/model-00002-of-00002.safetensors |
| `config.json` / `tokenizer*` / `chat_template.jinja` | ~12 MB | https://modelscope.cn/models/unsloth/Qwen3-VL-8B-Instruct-unsloth-bnb-4bit/resolve/master/config.json |

### ④ 配置与分词器（~15 MB，不含权重）

`model_index.json`、`scheduler/scheduler_config.json`、`processor/*`（tokenizer.json 11 MB、vocab、merges 等）。

```powershell
& $ms download --model Qwen/Qwen-Image-2.1-Turbo --include '*.json' '*.jinja' '*.txt' `
    --exclude '*.safetensors' '*.bin' --local-dir "$w\turbo-config"
```

### ⑤ 可选：Fusal 动漫风格 LoRA（0.63 GB）

让画风偏动漫。它配套的文本编码器是「heretic（去审核）」版，作者说训练时用的就是那个；
只想加风格、不追求 1:1 复现的话，用上面的官方 TE 也能跑。

| 文件 | 大小 | 直链 |
|---|---|---|
| `loras/fusal-qwen-image-2.1-turbo-e6-preview-r128.safetensors`（Turbo 8 步） | 0.63 GB | https://hf-mirror.com/MicksHF/Qwen-Image-2.1-Anime-Fusal/resolve/main/loras/fusal-qwen-image-2.1-turbo-e6-preview-r128.safetensors |
| `loras/fusal-qwen-image-2.1-v2-exact-r80.safetensors`（基座 25-40 步） | 0.39 GB | https://hf-mirror.com/MicksHF/Qwen-Image-2.1-Anime-Fusal/resolve/main/loras/fusal-qwen-image-2.1-v2-exact-r80.safetensors |

> 两条 LoRA **不能混用、不能叠加**，强度从 0.7 起。

### 一键下载（按目录落位）

```powershell
$ms = 'E:\APP\Anaconda\Scripts\modelscope.exe'
$w  = '<仓库路径>\draw-model\weights'

# 配置/分词器
& $ms download --model Qwen/Qwen-Image-2.1-Turbo --include '*.json' '*.jinja' '*.txt' `
    --exclude '*.safetensors' '*.bin' --local-dir "$w\turbo-config"
# VAE
& $ms download --model Qwen/Qwen-Image-2.1-Turbo 'vae/diffusion_pytorch_model.safetensors' --local-dir "$w\turbo-vae"
# DiT（最久，13.25 GB）
& $ms download --model Qwen/Qwen-Image-2.1-Turbo `
    'transformer/diffusion_pytorch_model-00001-of-00002.safetensors' `
    'transformer/diffusion_pytorch_model-00002-of-00002.safetensors' --local-dir "$w\turbo-dit"
# 文本编码器（7.17 GB）
& $ms download --model unsloth/Qwen3-VL-8B-Instruct-unsloth-bnb-4bit --local-dir "$w\text_encoders"
```

下完把 DiT 分片和 config 放到 `weights/turbo-dit/transformer/`、VAE 放到 `weights/turbo-vae/vae/`，
`start-draw.ps1` 会自己检查缺哪些。

## 环境（独立 venv，别污染唱歌/说话那套）

```powershell
$py = 'E:\APP\Anaconda\envs\say-sing\python.exe'   # 复用它的 torch 2.9.1+cu128
& $py -m venv --system-site-packages <仓库路径>\draw-model\.venv
$vpy = '<仓库路径>\draw-model\.venv\Scripts\python.exe'

# diffusers 必须新（清华镜像的 0.29.2 没有 QwenImage21Pipeline）→ 用腾讯镜像
& $vpy -m pip install -i https://mirrors.cloud.tencent.com/pypi/simple -U diffusers==0.42.1
& $vpy -m pip install -i https://mirrors.cloud.tencent.com/pypi/simple -U "huggingface_hub>=1.32,<3" transformers bitsandbytes accelerate gguf
# Qwen3-VL 处理器需要 torchvision（必须匹配 torch 版本）
& $vpy -m pip install --no-deps --index-url https://download.pytorch.org/whl/cu128 torchvision==0.24.1
```

## 启动

```powershell
powershell -ExecutionPolicy Bypass -File draw-model\start-draw.ps1
# 常驻不退： -IdleSeconds 0
# 换端口：   -Port 7880
# 加鉴权：   -Token <随机串>   （网关的 draw.token 要填同一个）
```

自检：

```powershell
curl.exe http://127.0.0.1:7880/health
# {"ok":true,"loaded":false,"renders":0,"vramGB":0.0,"idleSeconds":180,"lastError":""}
```

## 出图

```powershell
curl.exe -X POST http://127.0.0.1:7880/v1/images/generations `
  -H 'content-type: application/json' `
  -d '{"prompt":"蓝白配色的小鲸鱼娘，海边礁石，逆光","size":"1024x1024"}'
# → {"created":…, "data":[{"b64_json":"…"}]}
```

或者走网关（推荐，带 GPU 仲裁）：

```powershell
curl.exe -X POST http://127.0.0.1:8899/v1/images/generations `
  -H "authorization: Bearer <网关令牌>" -H 'content-type: application/json' `
  -d '{"prompt":"一只橘猫坐在窗台","size":"1024x1024"}'
```

## 接进宿主（机器人真的会画图）

控制台 → **图片生成**：

| 字段 | 填什么 |
|---|---|
| 服务地址 | `https://<你的公网入口>/v1`（走网关）或 `http://127.0.0.1:7880/v1`（同机直连） |
| 模型 | `qwen-image-2.1-turbo`（随便填，本地服务不看这个字段） |
| API Key | 网关令牌（走网关时）或 `draw.token` |

之后群里说「画一张 ……」就会走宿主自己的生图 → 发图链路（私聊也能发）。

## 参数说明

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DRAW_PORT` | 7880 | 监听端口（只绑 127.0.0.1） |
| `DRAW_TOKEN` | 空 | 留空不校验；填了就要 `Authorization: Bearer` |
| `DRAW_IDLE_SECONDS` | 180 | 闲置多久卸载模型（0 = 常驻） |
| `DRAW_SIZE` | 1024 | 默认边长（请求里 `size` 可覆盖） |
| `DRAW_STEPS` | 空 | 留空用 Turbo 官方的 `sample_sigmas`（8 个断点）；填数字则覆盖 |
| `DRAW_WEIGHTS` | `<仓库>/draw-model/weights` | 权重目录 |

## 已知限制

- **单请求串行**：同一时刻只出一张（10 GB 卡不能并发）。
- **首次出图慢**：要先把 13 GB 权重读进来并量化，实测取决于磁盘；之后每张按 8 步算。
- **和唱歌/说话互斥**：走网关时会自动排队并让出显存；直连 7880 不排队，自己注意别和唱歌同时跑。
- 许可：模型继承 **Qwen Research License**，自用没问题，商用需自行确认。
