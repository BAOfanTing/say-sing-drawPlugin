# 本地画图（Qwen-Image-2.1-Turbo）· 已上线

> 状态：**已上线**（`draw-model/` + 网关透传 + GPU 仲裁）。实测 RTX 3080 10G：
> 1024×1024 / 8 步 **约 25 秒/张**，峰值显存 7.24 GB。
> 这一页写清"为什么这么接、代价是什么、踩过哪些坑"，免得照着别的教程装完才发现 10 GB 显存跑不动。

## 一句话结论

**不要给插件加画图工具**。宿主本来就支持 OpenAI 兼容的生图服务
（`POST {服务地址}/images/generations`，见宿主 `src/llm/image-gen.js`），
所以正确做法是：**让本地模型服务说这个协议，然后在控制台把「图片生成」指过去**。

## 已经落地的实现

| 位置 | 内容 |
|---|---|
| `draw-model/server.py` | 本地出图服务：OpenAI 兼容 `POST /v1/images/generations` + `GET /health`；**懒加载**、**单请求串行**、**画完一张就退出**（`DRAW_EXIT_AFTER_RENDER`，退出后由网关按需拉起）、可选 Bearer 鉴权。图生图面积压到 768²、VAE 分块解码 |
| `draw-model/start-draw.ps1` | 一键启动（自动挑 venv、检查权重缺哪些、强制 HF 离线） |
| `draw-model/README.md` | 权重清单 + 下载命令 + 环境安装 + 接进宿主的四步 |
| `gateway` 的 `/v1/images/generations` | 透传到 `draw.url`；**先让本地 TTS 让出显存**，唱歌在跑就排队（5 分钟上限），复用网关令牌 |
| `gateway/config.json` 的 `draw` 段 | `{ url, token, timeoutMs }` |

宿主侧只改一个地方：控制台 → 图片生成 → 服务地址填 `https://<公网入口>/v1`。

## 实测踩到的坑（重要，别再踩）

1. **GGUF 不能用**：`unsloth/Qwen-Image-2.1-Turbo-GGUF` 是给 ComfyUI 导的，`norm_out` 是 4096×4096 的线性层，
   而 diffusers 的 `QwenImage21Transformer2DModel` 期望 1 维 RMSNorm → 运行时报
   `size of tensor a (4096) must match tensor b (8192)`。**纯 Python 路线必须用官方 bf16 safetensors + 加载时量化**。
2. **huggingface.co 全封**：DNS 污染（解析到 Twitter/Dropbox 的 IP）+ TLS 层阻断（换真实 IP 也是 0.24s RST）。
   只能走 ModelScope（约 1.4-2 MB/s）或 hf-mirror（更慢）。
3. **diffusers 版本**：清华 PyPI 镜像停在 0.29.2（没有 `QwenImage21Pipeline`）→ 用腾讯镜像 0.42.1。
4. **依赖连环**：diffusers 0.42 要 `huggingface_hub>=1.32`，而 transformers 4.57 要 `<1.0` → 必须一起升级；
   `Qwen3VLProcessor` 需要 **torchvision**（且版本要匹配 torch 2.9.1 → 0.24.1）；
   `from_single_file` 默认会去 huggingface.co 拉 config → 必须显式传本地 `config=` 并设 `HF_HUB_OFFLINE=1`。
5. **pipeline 参数名**：是 `true_cfg_scale`（不是 `guidance_scale`）。
6. **Turbo 的调度**：`model_index.json` 里有 `sample_sigmas`（8 个断点 ≈ 7 步），
   直接传 `num_inference_steps` 会走默认调度、质量打折 → 要显式传 `sigmas`。

## 为什么不走插件

| 原因 | 说明 |
|---|---|
| 插件发不了图 | 插件连文件都发不了（`media` / `send` 能力已随「发群文件」一起删掉）；宿主自己的生图->发图链路不受这个限制，私聊群聊都能发 |
| 宿主已有完整逻辑 | 生图 → 配话 → 发图/存表情包 → 计费与审计，插件重写一遍只会更差 |
| 少一份代码 | 网关只要多一个 `/v1/images/generations` 透传路由 + GPU 仲裁 |

插件侧将来最多加一个 `draw_status`（展示后端在线 / 队列长度），和现在的 `say_status` 同构。

## 显存账（先看这一节再决定要不要装）

RTX 3080 只有 **10 GB**，而这个仓库已经有两个吃显存的租户：

| 租户 | 占用 | 何时 |
|---|---|---|
| RVC 换声（唱歌） | 2.4 GB 常驻 | 唱歌期间（闲置会被收掉） |
| 本地 Breeze TTS（说话） | 8.2 GB | 说话期间，闲置 60 秒自退 |
| **本地画图** | DiT nf4 ≈ 4 GB + 文本编码器 4bit ≈ 5 GB（编码完可释放） | 只在出图期间 |

Qwen-Image 是 20B 的 MMDiT，不同精度的量级：

| 精度 | 权重大概 | 10 GB 卡 |
|---|---|---|
| bf16 | ~40 GB | ❌ 不可能 |
| fp8 | ~20 GB | ❌ 除非靠 CPU offload（极慢） |
| GGUF Q4 | ~12 GB | ⚠️ 需要分块 offload，预计 **1-3 分钟/张**（待实测） |

> 如果换成本量级更小的图像模型（比如 6-8B 级别的），10 GB 的体验会好很多 ——
> 选型已定：**Qwen-Image-2.1-Turbo**（DiT ≈6.6B，8 步蒸馏版），实测见下节。

## 必须做的一件事：GPU 仲裁

现在唱 / 说 已经有过一次教训：说话为了腾显存会 `voice.shutdown()`，把队列里正在跑的歌弄死。
加画图等于第三个租户，必须有一把**统一的 GPU 锁**：

```
唱歌（队列，串行）  ─┐
说话（按需加载）    ─┼─► GPU 仲裁器：同一时刻只允许一个租户持有
画图（按需加载）    ─┘     · 拿不到锁就排队（不抢占）
                          · 每个租户自己负责"闲置退出"
```

**已落地**（`gateway/lib/app.mjs` 的 `/v1/images/generations` 路由）：

1. 收到画图请求先 `yieldLocalSay()` —— 把本地 TTS（8.2 GB）收掉，显存让出来；
2. 若 `activeSingJobs > 0`（唱歌在跑）就每秒轮询等它结束（最多 5 分钟）；
3. 再透传给 `draw.url`；出图服务自己「懒加载 + 闲置退出」。**闲置退出后由网关按
   `draw.startCommand` 自动拉起**（不需要额外的看门狗进程，第一次画图会慢十几秒）。

实测效果：画图期间峰值 7.24 GB，出完回落到约 1.5 GB，能和唱歌/说话交替使用。

## 协议：本地服务必须实现什么

宿主请求（`src/llm/image-gen.js`）：

```
POST {你填的服务地址}/images/generations
{
  "model": "…",            // 宿主配置里的模型名，本地服务忽略或当预设名
  "prompt": "…",
  "n": 1,                  // 可选
  "size": "1024x1024"      // 可选
}
→ 200 { "data": [ { "b64_json": "…" } ] }     ← 首选（省一次下载）
   或 { "data": [ { "url": "https://…" } ] }
```

于是本地侧只要一个薄服务：收 prompt → 采样 → 存 png → 返回 b64_json。
**最终采用**：自己写 `draw-model/server.py`（diffusers 直连，见对面）。当年评估过的两条路：

1. ComfyUI + openai-api 节点：生态最省事、GGUF 支持好，但多一层依赖，且我们实测那份 GGUF
   和 diffusers 的张量布局不兼容（见上文踩坑 1）；
2. **`draw-model/server.py`（diffusers 直连）** ← 选了这条：和 `gateway/` 风格一致、
   能复用 GPU 仲裁、不用装 ComfyUI，代价是要自己处理 nf4 量化与 offload。

## 接入步骤（照着走一遍就能用）

1. 电脑端：在 `say-sing` 环境之上建一个 **venv**（`python -m venv --system-site-packages draw-model\.venv`）——
   复用它的 torch，但 diffusers/transformers 装在自己的目录里，互不干扰（实测：说话+唱歌共用 `say-sing`，
   画图单独 venv；三者的 transformers 版本冲突，无法塞进同一个环境）
2. 下权重到 `draw-model/weights/`（**不进 git**，`.gitignore` 已覆盖 `weights/`）
3. 起本地服务 → 自检 `curl -s http://127.0.0.1:7880/health`（返回 `{"ok":true,...}` 即可）
4. 网关加路由：`/v1/images/generations` 透传到本地服务，并接入 GPU 仲裁
5. 控制台 → 图片生成 → 服务地址填 `https://<你的公网入口>/v1`，模型名随便填一个
6. 群里说「画一张 ……」验证；网关日志里会多一行 `[draw] → … 200`，出图服务的 `/health` 里能看到 `loaded` / `renders` / `vramGB`。

## 实测结果（2026-11-02 + 2026-11-05 复测，RTX 3080 10G）

| 指标 | 数值 |
|---|---|
| 模型 | Qwen-Image-2.1-Turbo（DiT 13.25 GB → nf4 量化 ≈ 4 GB + Qwen3-VL-8B 4bit ≈ 5 GB） |
| 分辨率 / 步数 | 文生图 1024×1024 / 图生图 640×928（面积 768²）/ 8 步（官方 `sample_sigmas`） |
| **单张耗时（文生图）** | **25.6 秒**（1.6 s/it） |
| **单张耗时（图生图）** | **62 秒**（面积压到 768² + VAE 分块解码，峰值 9.01 GB） |
| 首次加载 | 20~36 秒（读 13 GB 权重 + nf4 量化） |
| 走网关端到端（宿主 → 网关 → 7880） | **95 秒/张**（连测 3 张：95.1 / 94.7 / 95.9） |

> ⚠️ **一张图一个进程**（`DRAW_EXIT_AFTER_RENDER=1`，2026-11-05 起默认）：
> 同一个进程里的第二张（含「卸载→重载」之后那次）三次实测都超过 240 秒不返回，机器全程醒着；
> 新进程的第一张稳定 61~62 秒。所以画完就退出，下次由网关按需拉起（+~25 秒）。
> 细节与排查过程见 [../draw-model/README.md](../draw-model/README.md) 的参数说明与实测表。

> 权重下载地址（ModelScope 直链）见 [../draw-model/README.md](../draw-model/README.md)。
