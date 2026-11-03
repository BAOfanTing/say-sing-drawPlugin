# 调优与踩坑笔记

这份文件放"为什么这么设、当初踩过什么"，README 只留结论。
如果你只是想让它跑起来，看 [README](../README.md) 和 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) 就够了。

---

## 一、唱歌时长：四道闸

一条语音条能唱多久，取决于**四道闸里最小的那个**。改时长只改一道没用，这是最容易踩的坑。

| # | 闸 | 代码位置 | 默认 |
|---|---|---|---|
| ① | 插件设置「语音条唱多久」 | 插件设置页 → `voiceSeconds` → 通过 `POST /admin/voice-seconds` 推给网关 | **0（整首）** |
| ② | 语音条通道硬上限 | `gateway/lib/app.mjs`：`cap = config.voiceMessageMaxSeconds` | 600 |
| ③ | 单次换声任务上限（语音条受它管） | `gateway/lib/app.mjs`：`runSingJob` 里 `Math.min(config.maxSeconds, …)` | 600 |
| ④ | 宿主 TTS 请求超时 | `tts.timeoutMs`（宿主 config.json） | 600000（**需手动调**，宿主出厂默认只有 120000） |

生效值链路：

```
插件设置 → /admin/voice-seconds → runtimeVoiceSeconds
        → wanted = body.maxSeconds || runtimeVoiceSeconds || voiceMessageDefaultSeconds
        → maxSeconds = min(cap=②, wanted)
        → job.maxSeconds = min(③, maxSeconds)          ← ③ 常常是最后拍板的那个
        → run.py --max-seconds <job.maxSeconds>
```

### 怎么确认现在到底是多少

```bash
curl -s http://127.0.0.1:8899/health | python -m json.tool
```

```json
{ "voiceSeconds": 0, "voiceFullSong": true, "voiceMaxSeconds": 600, "jobMaxSeconds": 600 }
```

- `voiceSeconds` —— 当前生效值（`0` = 整首，配合 `voiceFullSong: true` 看）
- `voiceMaxSeconds` —— ② 的取值（插件推大了会被它夹住）
- `jobMaxSeconds` —— ③ 的取值（**最常见的元凶**）

### 实测耗时（RTX 3080 10G / Windows，Hanser 模型）

| 成品长度 | 端到端 | 结论 |
|---|---|---|
| 45 秒 | **12 秒** | 单段换声（常驻进程，模型不重载） |
| 90 秒 | **约 15 秒** | 切 3 段 |
| 120 秒 | **约 17 秒** | 切 4 段 |
| 180 秒 | **约 20 秒** | 切 6 段 |
| **整首 3:54（234 秒）** | **22 秒** | 切成 8 段；模型常驻，整首歌一次加载都没有 |
| **整首 4:21（261 秒）** | **约 25 秒** | 9 段；**QQ 侧已实测可正常收播** |

### 长音频怎么处理：分段换声（且模型只加载一次）

RVC 是整段一次性推理，显存和耗时都随长度超线性涨（曾经 180 秒就 OOM、240 秒跑十几分钟不返回）。
所以 `run.py` 对长音频自动改成**切片 → 逐段换声 → 拼回一整条**：

```
人声 234 秒
  ├─ ffmpeg segment muxer 切成 8 段（每段 30 秒，reset_timestamps 保证每段从 0 开始）
  ├─ 把整个目录交给 infer.cli（**一次** get_vc() 加载模型，内部循环处理所有段）
  ├─ 批处理失败才退回逐段调用，并且只补跑缺产物的那几段
  ├─ 全部成功后用 concat filter 拼回一条（重编码，避免容器差异）
  └─ 再和**完整**伴奏混音（伴奏不切，保证衔接处没有断点）
```

> **模型只加载一次**：`infer.cli` 支持目录批处理（`collect_jobs`），它只 `get_vc()` 一次再循环
> 处理每个文件。早期版本是"每段起一个进程"，等于每段重付一次模型加载（约 8 秒）——
> 这才是段越小越慢的原因，而不是推理本身。

#### 段长怎么选（200 秒音频实测，批处理 + 显存峰值）

| 段长 | 耗时 | 显存峰值 |
|---|---|---|
| 20 秒 | 33 秒 | 6.3 G |
| **30 秒** | **33 秒** | **5.6 G** |
| 45 秒 | 35 秒 | 9.1 G |
| 75 秒 | 114 秒 | 9.8 G |
| 120 秒 | 252 秒 | 9.8 G |

结论：RVC 对**长输入是超线性的**，所以短段反而更快、更省显存；30 秒是快与少的平衡点
（再小拼接点变多、音质衔接风险上升）。整首端到端采样峰值约 9.9 G，主要是**人声分离**那一步占的。

为什么这样更快：每段都在显存安全区（峰值 ~8.5G），闸可以照常开着（0.9），
不会触发"放开闸吃满显卡 → 掉速 → OOM"的连锁反应。实测 234 秒从"不可用"变成 **85 秒**。

相关参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `run.py --segment-seconds` | **30** | 每段长度；0 = 不分段。⚠️ `run.py` **自己的默认是 75**，正常跑都会被网关按 30 覆盖 |
| `run.py --segment-retries` | 1 | 单段失败重试次数（失败只重跑那一段） |
| `gateway/config.json` → `voice.segmentSeconds` | **30** | 上面那个值的配置来源，通过 `{segmentSeconds}` 占位符传下去 |

什么时候会分段：显式"整首"（`--max-seconds 0`）、或人声超过「`segmentSeconds` + 5 秒」、或量不出时长。
留 5 秒余量是为了避免最后切出个几秒的尾巴（模型只加载一次，切段的固定开销已经很小）。
默认 30 秒段 → 阈值 35 秒；调段长阈值会跟着变。

进度上报：`run.py` 会打印 `[seg] 2/4 完成`，网关把 stderr 里这些行转成 job 进度
（0.6→0.8 区间），插件轮询就能看到"换声 3/8 段"。

> 另外踩过两次大坑，现在都有保护：
> ① 父进程被杀后，`python -m infer.cli` 会变成孤儿继续霸占 GPU（实测空转 9 小时）；
>    `run()` 超时改成 `taskkill /T` 收整棵树。
> ② 重写 `run()` 时漏了 `cwd=RVC_DIR`，`-m infer.cli` 直接秒退（找不到 infer 包）。

时间主要花在：人声分离（BS-Roformer，RTF≈0.1）+ RVC 换声（含音高提取与索引检索）+ 两次模型加载。

### 另外两条物理限制

- QQ 语音条自身的时长上限：**实测 4:21（261 秒）的整首能正常收播**，还没试到被拒的长度；网关侧硬上限是 `voiceMessageMaxSeconds = 600`（10 分钟）。
- 宿主对 `/v1/audio/speech` 的响应上限 **4MB**：96kbps 单声道约 5.7 分钟，更长的歌网关会自动降到 64kbps 再发（约 8.7 分钟），仍超就会被宿主拒收。

---

## 常驻换声（模型只加载一次，跨请求复用）

`run.py --serve` 起一个长驻进程，网关通过 stdin/stdout 的 NDJSON 跟它说话：

```
网关 ──{"id":1,"input":..,"output":..,"voice":"hanser",..}──► run.py --serve
     ◄─{"id":1,"event":"seg","done":2,"total":8}────────────  进度
     ◄─{"id":1,"ok":true,"seconds":12.3}───────────────────  结果
```

- 模型按音色缓存，**切音色才重新 `get_vc()`**
- 空闲 `voice.serveIdleMs`（默认 10 分钟）自动关掉，把显存还回去
- 任何异常（进程挂了、模块缺失、超时）都**自动退回"每次起进程"**的老路，不会整单失败
- 关掉常驻：把 `voice.serveCommand` 留空

收益（RTX 3080）：

| 场景 | 每次起进程 | 常驻 |
|---|---|---|
| 说一句话（5 秒音频 + 换声） | 14 秒 | **3 秒**（首句 12 秒） |
| 唱 45 秒 | 27 秒 | **12 秒** |
| 唱整首 3:54 | 85 秒 | **22 秒** |

⚠️ 常驻会一直占着约 1.5-2 GB 显存；整首时分离模型（pymss）是另一个进程，
两者叠加峰值约 9 GB。显存吃紧就把 `serveIdleMs` 调小，让它更快退出。

## 二、显存

换声是全 GPU 的活。3080 10G 上实测峰值约 9.4G（分离与换声是先后两个子进程，峰值取大的那个）。

为了不把卡占满，`sing-model/run.py` 默认给两个重活子进程都上了闸：

```
--gpu-fraction 0.85            # 默认，最多用 85%（≈8.7G）
```

实现方式：`sing-model/gpu_cap/sitecustomize.py` 被塞进子进程的 `PYTHONPATH`，Python 启动时会自动
import 它并调用 `torch.cuda.set_per_process_memory_fraction(0.85, 0)` —— **不需要改 RVC 任何代码**。
同时设了 `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` 来压碎片。

- 想更低：`--gpu-fraction 0.75`
- 阈值太低会 OOM，任务会如实失败（不会假装成功）；调不上去就退回默认
- 想彻底不用显卡：`voice.engine=none`（但那就不叫换声了，只是搬运音源）

---

## 三、历史踩坑（现象 → 根因 → 修法）

这些都已经修好了，列在这避免以后重新踩。

| 现象 | 根因 | 修法 |
|---|---|---|
| 点歌永远只出 30.02 秒 | 当年接过 Apple 的 30 秒试听段当兜底；网易云 VIP 曲取不到音频时立刻退回试听 | **直接删掉试听源**，只留网易云 + 本地目录；VIP 曲现在明确报"需要 VIP"并引导扫码登录 |
| 插件里填 240，实际只唱 180 | ③ `config.maxSeconds` 是 180，`runSingJob` 用 `Math.min` 把它夹回去了 | ③ 提到 600（现在是默认值）；`/health` 报出 `jobMaxSeconds` 便于核对 |
| 显存闸"加了但没效果" | 只写了 `sitecustomize.py` 和常量，`--gpu-fraction` 参数没定义、`run()` 也没传 → 等于没接线 | CLI 参数 + 传参补齐（分离、换声两处都传） |
| 180 秒的歌跑了一半报"等太久" | 截止时间写成 `min(maxSeconds, cap) + 150000`，把"秒"直接加到"毫秒"上，实际只等了 150 秒 | 改成 `秒 × 1000 + 300000`（留 5 分钟余量） |
| 网关进程莫名退出 | `/login/*` 写在全局 try 之外，网易云接口一抖动就是未捕获的 Promise 拒绝 | 单独 try/catch，返回 502 而不是崩进程 |
| 控制台「扫码登录」报"令牌不对" | 用了 `?token=` 打开页面 —— 登录接口和页面都不再接受查询参数里的令牌 | 页面改成 `/login#token=<令牌>`（`#` 后面的部分不发给服务器），接口只认 `x-gateway-token` / `Authorization: Bearer` |
| 插件 import 二维码库报 `does not provide an export named 'default'` | 仓库 `package.json` 是 `type=module`，UMD 的 `.js` 被当 ESM 解析 | 改名 `qrcode.cjs` + `createRequire` |
| 机器人说"才一秒"，但语音条显示 1'30" | 宿主按 `Math.round(text.length / 4)` 估时长，「唱：夜曲」4 个字 → 1 秒 | 网关回 `x-audio-seconds` 真实时长，宿主优先用它（宿主侧改动见 `qq-agent-plus` 仓库 `feat/tts-audio-seconds` 分支） |
| `fetch failed`（约 50% 概率） | 服务器只有 IPv6 无出口 + Node Happy Eyeballs 默认 250ms 尝试超时 | 宿主 `NODE_OPTIONS=--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=5000`（实测 12/12 通过） |
| Cloudflare 隧道隔几小时就 530 | 快速隧道是匿名隧道，Cloudflare 明说无可用性保证；建隧接口也会超时 | 备用专线：`ssh -R` + nginx TLS（8898），地址永不变；语音条通道直接走 `https://127.0.0.1:8898/v1` |
| 服务器访问自己的公网 IP:8898 超时 | 华为云安全组/NAT 不回环，`curl https://<公网IP>:8898` 从服务器自己发出会 000 | 宿主侧改用 `https://127.0.0.1:8898/v1`；插件侧禁用内网地址，只能走公网隧道 |
| 宿主报「语音合成结果过大（>4MB）」 | 手动起网关时 PATH 里没有 ffmpeg，转码静默跳过，把 6.87MB 的 WAV 直接发出去（`transcode: auto` 的降级分支） | `audio.mjs` 改为自己找 ffmpeg（环境变量 → 仓库自带 `sing-model/bin` → PATH）；`/v1/audio/speech` 出口再兜一道：不是 mp3 或 >3.5MB 就现转（96k，仍大用 64k） |
| 时长报 0 / 又变成「才一秒」 | ffprobe 不在 PATH，`probeSeconds` 返回 0，`min(maxSeconds, 0)` 把时长清零 | 探不到时用请求时长兜底，不再报 0 |
| `upload_group_file ENOENT` | OneBot 跑在容器里，看不到宿主的插件媒体目录 | `scripts/bridge-container-paths.sh`（宿主建软链 + 容器内 `ln -sfn /app/data /opt/qq-agent/data`） |
| `unable to get local issuer certificate` | CA 被重建过，但服务器证书还是旧 CA 签的 | 重新签：`bash reissue-server-cert.sh <IP>`；宿主 `NODE_EXTRA_CA_CERTS=/opt/qq-agent/tls/ca.crt` |

---

## 四、改完配置后的验收清单

改时长/显存/通道后，按这个顺序确认，比在群里盲试快得多：

1. 网关自检：`curl -s http://127.0.0.1:8899/health` → `ok:true`，三个秒数符合预期
2. 隧道自检：`bash scripts/check-lines.sh`（需要先 scp 到服务器）→ 隧道口 200、8898 200
3. 真链路：宿主控制台的 TTS「试听」按钮，输入 `唱：歌名` → 能听到声音就说明全链路通
4. 群里实测：`用语音唱一首X` → 看语音条时长、机器人报的秒数、有没有声音
5. 出问题先看网关日志：每个请求一行 `[req] · POST /v1/audio/speech → 200 (24207ms)`；
   有这行说明请求到了并成功，没有这行说明是传输问题（隧道/超时/鉴权）

## 意图识别：为什么"裸短词"默认不当歌名

宿主把"说话"也走 `/v1/audio/speech`，如果沿用旧的兜底规则（≤20 字、无标点、无空格 → 当歌名），
模型的口头禅会被当成歌名去搜歌开唱 —— 实测「好的」「嗯嗯」「收到」全部命中。

所以兜底规则改成 **`intent.bareTitle`，默认 false**：只有明确写了「唱：X」「点歌 X」这类指令才唱，
其余一律按说话处理。确实需要"只丢一个歌名"的老行为时，把 `intent.bareTitle` 设成 `true`。
