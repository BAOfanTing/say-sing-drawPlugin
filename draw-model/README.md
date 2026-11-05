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

## 角色一致性（图生图）：说「画大肥鱼」就自动带参考图

角色固定在 `refs/` 里，**三种形态各一张图 + 一套画风模板**（见 [refs/README.md](refs/README.md)）：

| 触发词 | 参考图 | 形态 |
|---|---|---|
| `小鲸鱼` | `dfy-small.png` | Q 版 chibi |
| `大鲸鱼娘` | `dfy-large.png` | 正常比例少女 |
| `真人鲸鱼` | `dfy-people.png` | 真人化（写实摄影） |

映射最长触发词优先（`大鲸鱼娘` 不会被 `鲸鱼娘` 吃掉）；改词/加形态用 `DRAW_REF_MAP` 环境变量，不用改代码。
**prompt 命中触发词**（默认 `大肥鱼 / 鲸鱼娘 / 鲸鱼妹妹 / 小鲸鱼 / 蓝色鲸鱼 / deepseek娘 / 画自己 …`）
就走图生图，否则还是原来的纯文生图 —— 调用方（宿主/网关）一行都不用改，宿主那条链路本来就只发 prompt：

```powershell
# 命中触发词 → 图生图，宽高按参考图比例自动算
curl.exe -X POST http://127.0.0.1:7880/v1/images/generations `
  -H 'content-type: application/json' `
  -d '{"prompt":"蓝色大肥鱼 站在海边礁石上看夕阳"}'

# 宽高分开给（这次要竖图）
curl.exe -X POST http://127.0.0.1:7880/v1/images/generations `
  -H 'content-type: application/json' `
  -d '{"prompt":"蓝色大肥鱼 在咖啡厅喝奶茶","size":"768x1024"}'

# 指定参考图 / 强制文生图
curl.exe -X POST http://127.0.0.1:7880/v1/images/generations `
  -H 'content-type: application/json' `
  -d '{"prompt":"蓝色大肥鱼 在看书","ref":"dfy-fullbody.png"}'
curl.exe -X POST http://127.0.0.1:7880/v1/images/generations `
  -H 'content-type: application/json' `
  -d '{"prompt":"蓝色大肥鱼 在看书","ref":"none"}'
```

细节：

- **角色描述前缀**由 `DRAW_CHAR_TEMPLATE` 拼在 prompt 前面（发色、女仆装、围裙刺绣、鳍状耳、鲸鱼尾）：
  参考图负责“长得像”，模板负责“每次都不跑偏”；
- 参考图以 `image=[PIL]` 传给管线（Qwen3-VL 视觉槽 + VAE latent 前缀），**没有 strength 旋钮**，
  构图会很贴近参考图 —— 想换姿势/换景就在 prompt 里把差异写清楚，或换一张构图接近的参考图；
- `size` 给 "1024" 或 "1024x1024" 时按参考图比例铺满 `size²` 的面积，不会被压成方图；
- `ref` 只认 `refs/` 目录里的 png/jpg/webp，做了 basename + 目录边界检查（防 `../` 穿越）。

### 实测（RTX 3080 10 GB，8 步）

| 场景 | 分辨率 | 耗时 |
|---|---|---|
| 文生图 | 1024² | 20-25 s（老路径，没变） |
| 图生图 | 640×928（按参考图比例，面积压到 768²） | **62 s**、峰值显存 **9.01 GB** ← 现在的默认 |
| 图生图 | 面积按 1024² 铺（`DRAW_IMG2IMG_SIZE=0`） | 采样 184 s 后 VAE 解码 >900 s 不返回 ❌ |
| 图生图（显存被别的程序占着） | 768×1024 | **805 s** ← 掉进 Windows 共享内存 |

> 图生图比文生图多吃一块：视觉塔激活 + 条件图的 VAE latent。**浏览器/编辑器/游戏占着显存时，
> 峰值会翻过 10 GB 掉进共享内存**（同一张图 805 s vs 71 s）。所以：
> ① 默认把图生图面积压到 768²（见 `DRAW_IMG2IMG_SIZE`）；② 开 VAE 分块解码压掉最后那道尖峰
> （峰值 11.43 → 9.01 GB）；③ 跑图前把吃显存的程序关掉。
>
> ⚠️ **同一进程只能画一张**：新进程的第一张稳定 61~62 秒，但同一进程里的第二张（含「卸载→重载」
> 之后那次）三次实测都超过 240 秒不返回（机器全程醒着）。所以默认 `DRAW_EXIT_AFTER_RENDER=1`：
> 画完就退出，下次由网关按需拉起，多花 ~25 秒换掉卡死。实测真实链路连画 3 张：95.1s / 94.7s / 95.9s。

### 拿聊天里那张图当参考（别人发图说「照这张画」）

请求体多一个 `image` 字段就行，服务自己解：

```bash
curl -s -X POST http://127.0.0.1:7880/v1/images/generations \
  -H 'content-type: application/json' \
  -d '{"prompt":"把这张改成水彩插画风，人物坐在窗边看书",
       "size":"1024x1024",
       "image":"data:image/jpeg;base64,…（宿主缩到长边 1024 再传）"}'
```

- `image` 收 `data:image/…;base64,…` 或裸 base64，默认上限 16 MB（`DRAW_IMAGE_MAX_BYTES`）；
  进来先按 `DRAW_REF_MAX_SIDE`（768）缩一遍，视觉 token 才不会爆。
- **垫一句指令再交给模型**（`DRAW_CHAT_TEMPLATE`）：这个管线的 `image` 是「条件图 latent 前置」，
  没有 denoising 强度可调，提示词不明确时它会**几乎照抄**参考图 —— 实测只写「改成厚涂插画、雨天街角」
  出来还是原图那张。所以默认前缀是「以参考图中的人物形象为准（长相、发型、服装一致），按要求重新画一张，
  背景/姿势/画风都可以按描述变化」。加了之后同一条提示词就真的换成雨天街角 + 透明伞 + 厚涂质感了。
  想让大肥鱼的形象强加上去，就把它设成和 `DRAW_CHAR_TEMPLATE` 一样；设空串 = 只用用户原话。
- 输出面积照样压到 768²（图生图那条限制），比例跟参考图走 —— 竖图进、竖图出。
- 实测：参考图 dfy-large.png（881 KB）+「改成水彩插画风、窗边看书」→ 640×928 / **62.7 秒** / 峰值 8.96 GB。
- 网关这条路由的请求体上限是 24 MB（其它接口仍是 8 KB），超了回 **413 参考图太大**，不会报成「后端挂了」。

### 踩坑：一加参考图就报 `FP4 quantization state not initialized`

纯文生图正常，一带 `image=` 就崩在 Qwen3-VL 的视觉 merger 上，最终是 bitsandbytes
`fix_4bit_weight_quant_state_from_module` 里的 `assert module.weight.shape[1] == 1` 失败。

真因：**`model.visual.merger` 和 3 个 `deepstack_merger_list.*` 下的 8 个 `linear_fc1/fc2`
用 4bit 加载后其实没被量化**（权重还是 bf16 的 `(out, in)`、`quant_state` 为 `None`），
但类名已经是 `Linear4bit`。文生图不碰视觉塔所以一直没暴露。
修法在 `server.py` 的 `_fix_unquantized_4bit()`：加载后把这 8 层换回 bf16 的 `nn.Linear`
（合计约 170M 参数、0.34 GB，几乎不亏）。

> 顺手排除的两个“看起来像元凶”的：**不是** accelerate 的 `model_cpu_offload`（关掉钩子照样炸），
> 也**不是** `llm_int8_skip_modules=["visual"]` 能解决的（这个版本的 transformers 不按它跳过）。

## 接进宿主（机器人真的会画图）

控制台 → **图片生成**：

| 字段 | 填什么 |
|---|---|
| 服务地址 | `https://<你的公网入口>/v1`（走网关；控制台在服务器上，`127.0.0.1:7880` 够不到你电脑） |
| 模型 | `qwen-image-2.1-turbo`（随便填，本地服务不看这个字段） |
| API Key | 网关令牌（走网关时）或 `draw.token` |

之后群里说「画一张 ……」就会走宿主自己的生图 → 发图链路（私聊也能发）。

## 参数说明

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DRAW_PORT` | 7880 | 监听端口（只绑 127.0.0.1） |
| `DRAW_TOKEN` | 空 | 留空不校验；填了就要 `Authorization: Bearer` |
| `DRAW_IDLE_SECONDS` | 60 | 闲置多久卸载模型（按需：出完一分钟就退，显存立刻还回去；0 = 常驻） |
| `DRAW_KEEP_WARM` | 0 | 1 = 画完不卸载、留热管线复用。**10 GB 卡别开**：保热时第 1 张 79s → 第 2 张 129s 起不来 |
| `DRAW_EXIT_AFTER_RENDER` | 1 | 1 = 画完一张就让进程退出，下次由网关按需拉起。同进程第二张实测 240 秒不返回，见上面实测表 |
| `DRAW_SIZE` | 1024 | 默认边长（请求里 `size` 可覆盖） |
| `DRAW_STEPS` | 空 | 留空用 Turbo 官方的 `sample_sigmas`（8 个断点）；填数字则覆盖 |
| `DRAW_WEIGHTS` | `<仓库>/draw-model/weights` | 权重目录 |
| `DRAW_REFS` | `<本目录>/refs` | 角色参考图目录（只认这里的 png/jpg/webp） |
| `DRAW_IMG2IMG` | 1 | 0 = 关掉触发词图生图，全部走文生图 |
| `DRAW_IMG2IMG_SIZE` | 768 | **图生图按这个边长算面积上限**（0 = 不压，跟 `DRAW_SIZE` 一样）。1024² 面积的图生图在 10 GB 卡上出不来 |
| `DRAW_TRIGGERS` | `大肥鱼,鲸鱼娘,鲸鱼妹妹,小鲸鱼,蓝色鲸鱼,deepseek娘,画自己,画个自己,画一只自己` | 通用触发词（用 `default.txt` 那张 + 默认模板） |
| `DRAW_REF_MAP` | 内置三形态 | 触发词 → 参考图（可带专属模板）的 JSON，如 `{"小鲸鱼":"dfy-small.png"}` |
| `DRAW_REF` | 空 | 固定用哪张参考图；留空按 `refs/default.txt`，再退到目录里第一张 |
| `DRAW_REF_MAX_SIDE` | 768 | 参考图送进视觉塔前的最长边（调小省显存/更快） |
| `DRAW_CHAR_TEMPLATE` | 内置那段 | 固定角色描述前缀，留空用内置 |
| `DRAW_CHAT_TEMPLATE` | 内置那句指令 | 请求体带 `image`（别人发来的那张图）时垫在前面的指令，默认「以参考图里的人物形象为准…按要求重新画一张，背景/姿势/画风都可以变」。设空串 = 只按用户这句话改（实测那样容易几乎照抄原图） |
| `DRAW_IMAGE_MAX_BYTES` | 16777216 | `image` 字段解码后的上限（16 MB），超了回 400 |
| `DRAW_TE_ON_GPU` | 0 | 兜底开关：仍撞 FP4 报错时把文本编码器临时按到卡上（+约 5 GB 显存） |
| `DRAW_VAE_TILING` | 1 | 1 = VAE 分块解码，把解码尖峰摊平（峰值 11.43 → 9.01 GB）。0 = 关掉（万一某张图出现拼缝） |
| `DRAW_REQUEST_TIMEOUT` | 240 | 单张最多等多久（秒），超时回 504 并把管线标记待卸载；0 = 不限（实测一张 45~62 秒，留 4 倍余量） |
| `DRAW_LOG` | `<本目录>/logs/service.log` | 日志文件（用调度任务起的进程抓不到控制台输出） |

## 出图卡死/网关崩溃时看这里（2026-11-03 事故复盘）

现象：群里让它画图，**十几分钟没反应**，`/health` 连不上。

1. **出图服务先被拖死**：显存被别的程序占着时，这张图掉进 Windows 共享内存，
   一张要十几分钟，期间线程全被钉在推理里；
2. **然后网关跟着崩**：`/v1/images/generations` 那段 `await fetch(draw)` 抛错后没人接住，
   变成未捕获拒绝 → **整个 Node 进程退出**（`gateway.log` 里能看到 `网关退出（code=1）` + 连续重启），
   宿主那边就完全没回应，唱歌/说话也一起哑掉。

两条都已修：

| 位置 | 改动 |
|---|---|
| `gateway/lib/app.mjs` | 画图路由整段包 try/catch → 出图服务挂了只回 **502 `画图后端不可用：…`**，网关不再跟着死（实测：停掉出图服务后 POST 回 502，`/health` 正常） |
| `draw-model/server.py` | ① 推理放后台线程 + `DRAW_REQUEST_TIMEOUT`（默认 240s）超时回 **504**，HTTP 层不再被钉死；② 超时后标记 `tainted`，下次请求先卸载重载管线；③ 日志写 `logs/service.log`（带 traceback + 峰值显存 + 分阶段计时）；④ 参考图默认缩到 768 省显存；⑤ 图生图面积压到 768²、VAE 分块解码；⑥ **画完一张就退出**（`DRAW_EXIT_AFTER_RENDER`）—— 同进程第二张实测 240 秒不返回 |

排查顺序：`logs/service.log` → `gateway/gateway-run/gateway.log` → `nvidia-smi`

> 日志里现在会写 `用时 62.4s＝采样+解码 62.3s + PNG 0.1s，峰值显存 9.01 GB / 10.00 GB`：
> 峰值一旦接近或超过物理显存，就是又要掉进共享内存了 —— 先把浏览器/编辑器/游戏关掉。
> 注意：**机器休眠期间计时会把挂起时间也算进去**，看到“用时 36721 秒”这种数字先确认是不是合过盖。

## 已知限制

- **单请求串行**：同一时刻只出一张（10 GB 卡不能并发）。
- **首次出图慢**：要先把 13 GB 权重读进来并量化，实测取决于磁盘；之后每张按 8 步算。
- **图生图更吃显存**：比文生图多 1-3 GB（视觉塔 + 条件图 latent），见上面实测表。
- **和唱歌/说话互斥**：走网关时会自动排队并让出显存；直连 7880 不排队，自己注意别和唱歌同时跑。
- 许可：模型继承 **Qwen Research License**，自用没问题，商用需自行确认；
  `refs/` 里的参考图是民间二创/表情包，自用可以，公开发布请自行确认授权。
