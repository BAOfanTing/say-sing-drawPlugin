# 插件 ↔ 网关 HTTP 契约（v1）

想自己实现后端（比如直接接 RVC WebUI、接商业 API、接你家里的另一台机器），只需要满足这份契约。
插件侧的所有请求都会带 `Authorization: Bearer <token>`（除非网关令牌留空）。

- 基础地址：插件设置里的「网关地址」，例如 `https://sing.example.com`（**必须 https**，不带结尾斜杠）
- 编码：`application/json; charset=utf-8`
- 错误约定：非 2xx 一律返回 `{ "ok": false, "message": "给人看的一句话" }`

## GET /health

**免鉴权**（方便排查隧道通不通），只暴露"在不在、什么引擎"：

```json
{ "ok": true, "version": "1.0.5",
  "engine": "command", "say": "auto", "voiceConfigured": true, "voices": ["hanser"],
  "source": "netease", "transcode": "auto", "jobs": 0,
  "voiceSeconds": 0, "voiceFullSong": true, "voiceMaxSeconds": 600, "jobMaxSeconds": 600 }
```

- `engine` / `voices` —— 换声引擎与可用音色（`engine: "none"` 表示没接换声，只能搬运音源）
- `say` —— 说话引擎，四选一：`auto`（云端优先、失败落本地，默认）/ `breeze`（只云端）/
  `breeze-local`（只本地权重）/ `none`（关掉，普通文本返回 400）
- `voiceSeconds` —— 语音条当前生效时长（`0` + `voiceFullSong: true` = 整首）
- `voiceMaxSeconds` / `jobMaxSeconds` —— 两道上限，插件推的值会被它们夹住

## GET /search?q=<关键词>&limit=5

```json
{ "ok": true, "items": [
  { "id": "1440833098", "title": "孤勇者", "artist": "陈奕迅",
    "durationSec": 256, "source": "netease" }
] }
```

`id` 由网关自定义（netease 用歌曲 id，local 用文件名）；空结果是 `items: []`，不是错误。

## POST /sing

```json
{ "song": "孤勇者 陈奕迅", "voice": "me", "maxSeconds": 60, "id": "(可选)直接指定条目" }
```

立刻返回 202，**不阻塞**：

```json
{ "ok": true, "jobId": "9f2c1a4b7d0e3f68", "state": "queued", "engine": "command" }
```

## GET /jobs/<jobId>

```json
{ "ok": true, "jobId": "9f2c...", "state": "running", "progress": 0.35,
  "title": "孤勇者", "artist": "陈奕迅", "engine": "command", "voice": "me",
  "audioUrl": "", "bytes": 0, "seconds": 0, "message": "换声" }
```

- `state`：`queued` / `running` / `done` / `failed`（插件只认这四个，其他值按 `failed` 处理）
- 完成时：`state: done`，`audioUrl` 给**相对或绝对**地址都行（相对地址按网关地址拼）
- 失败时：`ok: false`，带 `message` 或 `error`；插件会把这句话原样转给模型

```json
{ "ok": true, "state": "done", "progress": 1, "audioUrl": "/files/out-9f2c.mp3",
  "bytes": 812345, "seconds": 60, "title": "孤勇者", "artist": "陈奕迅", "engine": "command" }
```

## GET /files/<name>

返回音频字节（`audio/mpeg` / `audio/wav` / `audio/mp4`…）。插件用它把成品下载到自己的
`plugin-data/sing/media/`，再用 `cap.send.file` 发到群里。

> 注：这条「发群文件」的路**插件已经不用**了 —— 唱歌只走 `/v1/audio/speech` 语音条。
> 下面这几个异步接口保留给其它客户端 / 调试用。

- 文件保留 `filesTtlHours` 小时（默认 24），过期的会被网关自己清掉；
- 生命周期：插件下载完就可以删了，网关不依赖"插件一定来下载"。

## POST /v1/audio/speech

**给宿主用的**（不是给插件用的）：宿主的 `send_voice` 工具把文字发过来，要一段音频字节。
所以这个端点同时承担两件事：

| 输入 | 行为 | 响应 |
|---|---|---|
| 含点歌意图（`唱：歌名`、`点歌唱…`、句中触发） | 走换声流水线（同步等成品，整首会自动分段） | 音频字节 + `x-audio-seconds` |
| 其它文本 | 走 `say` 引擎（Breeze 云端 / 本机 Breeze） | 音频字节 + `x-audio-seconds` |

```http
POST /v1/audio/speech
Authorization: Bearer <token>
Content-Type: application/json

{ "input": "唱：夜曲", "voice": "hanser", "maxSeconds": 0 }
```

响应头里的 `x-audio-seconds` 是**真实时长**：宿主默认是按字数估（4 字 → 1 秒），
拿到这个头就会显示真实值（否则 90 秒的翻唱会被说成"才一秒"）。

**请求是同步的**（几十秒起步）：别把它放在 100 秒就掐的通道后面（Cloudflare 快速隧道会回 524），语音条应走本机专线或 named tunnel（见 docs/TUNNEL.md）。

失败语义：换声失败 → 500 + 人能读的原因；`say.engine = none` 且不是点歌 → 400（宿主会退回文字）。

## 为什么要异步

宿主给插件工具的超时默认 3 分钟。整首 4 分钟的歌分段换声（每段 30 秒、模型只加载一次）在 3080 上约 22 秒（换声常驻时），
冷启动会多十几秒，CPU 上可能好几分钟 —— 同步接口会让调用方卡在超时上，还看不到进度。
所以：**提交拿 jobId → 每 1-2 秒问一次 → 完成再下载**。插件工具超时 300 秒、预留 20 秒收尾，
即轮询到 `300s - 20s = 280s` 主动放弃并回一句"歌太长或电脑在忙"，而不是让宿主硬杀进程。

## GET /say/status ・ GET /say/voices ・ POST /say/config

插件页的「说话后端在线」和音色列表靠这三个口：

```json
// GET /say/status
{ "ok": true, "engine": "breeze", "online": true, "hasKey": true, "hasVoice": true,
  "voiceId": "voc_xxx", "model": "breeze-tts-2", "balance": 1796.0,
  "note": "", "mode": "cloud",                 // mode: cloud | local（auto 模式下实际走哪条）
  "localRunning": false, "idleMs": 60000 }

// GET /say/voices  → { "ok": true, "items": [ { "id": "voc_xxx", "name": "大肥鱼（迷糊版）" } ] }
// POST /say/config → { "apiKey": "brz_…", "voiceId": "voc_xxx", "replace": true }
//   带 replace:true 时按"完整覆盖"处理：空字符串 = 清除该项（插件永远带 replace，
//   因为它把自己当作唯一真相源）；不带 replace 时只更新非空项。
```

`online` 的语义是「**能不能服务**」：本地模型闲置退出后进程不在，但只要 python 与权重路径配好，
仍然报 `online: true` 并附 `note`。`balance` 只有云端才有值。

## POST /admin/voice-seconds ・ POST /admin/prune ・ /login/*

这三组不在「唱歌 / 说话」主链路上，但插件依赖它们 —— 重写后端时漏掉，插件的
「语音条秒数推送」「零点清理」「扫码登录」会全部哑掉。

```json
// POST /admin/voice-seconds   { "seconds": 30 }        ← 0 = 整首
// → { "ok": true, "seconds": 30 }

// POST /admin/prune           {}                        ← 清理旧成品
// → { "ok": true, "removed": 3 }
//   只删「超过 filesPruneMinAgeHours（默认 8 小时）」的成品。别按自然日零点删：
//   23:59 唱完的歌会在 00:01 被删，而插件可能正好那时来下载（404）。

// GET  /login                扫码页面（静态 HTML，本身不需要令牌）
// POST /login/start          → { "ok": true, "key": "…", "loginUrl": "https://music.163.com/login?codekey=…" }
// GET  /login/status?key=…   → { "ok": true, "state": "waiting | scanned | expired | ok", … }
// POST /login/logout         → 清掉已存的网易云 Cookie
```

## POST /v1/images/generations（画图，透传）

画图不在网关里跑（网关是 Node，模型是 Python + diffusers），网关只做**透传 + GPU 仲裁**：

```json
// 请求（OpenAI 兼容）
POST /v1/images/generations
{ "model": "qwen-image-2.1-turbo", "prompt": "…", "n": 1, "size": "1024x1024" }

// 响应
{ "created": 1793630507, "data": [ { "b64_json": "iVBORw0KGgo…" } ] }
```

网关做的事：

1. 先把本地 TTS 让出显存（它占 8 GB，和画图不可能共存）；
2. 唱歌任务在跑就排队等它结束（串行队列最多 1 个）；
3. 转发到 `draw.url`（默认 `http://127.0.0.1:7880`），带 `draw.token`（如果配了）；
4. 原样返回上游的状态码与响应体。

`size` 只取 `宽x高` 的宽（如 `1024x1024` → 1024）；`steps` 可选，不传就用 Turbo 官方的
`sample_sigmas`（8 个断点）。**首张较慢**（要加载 13 GB 权重并做 nf4 量化），之后每张约 25 秒。

> 宿主控制台的「图片生成 → 服务地址」填 `https://<公网入口>/v1` 即可（它自己拼 `/images/generations`）。
> 单独部署的出图服务（`draw-model/server.py`）实现同一套接口，也可以直连。

`/login/*` **只认请求头**（`x-gateway-token` 或 `Authorization: Bearer`），不接受 `?token=`
（URL 查询参数会留在浏览器历史、隧道日志与 Referer 里）；扫码页面自己从 `location.hash` 取令牌。
