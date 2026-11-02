# 更新日志

按版本倒序。每个版本一节，标题格式 `## [x.y.z] - 日期`（发布工作流按这个标题抽取对应版本，
拼进 GitHub Release 正文，所以**标题格式别改**）。

---

## [未发布]

### 变更

- **仓库改名**：`qq-agent-plus-singPlugin` → **`say-sing-drawPlugin`**（覆盖 说话 / 唱歌 / 画图 三条能力）。
  插件 `id` 保持 `sing` —— 改 id 等于变成新插件，已装用户的设置、凭据、成品目录都会丢。
- 新增 [docs/DRAW.md](docs/DRAW.md)：本地画图方案（宿主直连 OpenAI 兼容 `/images/generations`，
  不给插件加工具）、10 GB 显存的账、GPU 仲裁设计。**代码接入中**，模型选型待定。

---

## [1.0.5] - 2026-11-02

### 新增

- **说话引擎 `auto`（现在是默认）**：云端优先，云端不可用（网络/额度/5xx/404）自动回落本机，
  两条链路都不会让「说话」整单失败。实测云端 2-4 秒/句，回落本地 10-15 秒/句。
- **多 Key 轮换**：`say.breezeKeys` 可以配备用 Key，主 Key 报 401/402/403/429 时自动换下一个重试
  （400/422 这类请求本身的问题不换，避免掩盖 bug）。
- **插件端自动领每日额度**：新增设置组「云端额度」（账号邮箱 + 密码 + 自动领取开关）与工具
  `breeze_claim`。插件每小时幂等领一次（20 小时一轮，+400），不需要再去网页控制台点。
  原理：签到接口认会话 Cookie，而该站邮箱密码走自家服务器（`email_auth_mode=server`），
  **全程不经过 Google**。
- **本地音区守门**：本地模型对不同文本会随机落在高/低音区（实测同一句换个 seed 能从 266 Hz
  跳到 380 Hz，MFCC 相似度仍 0.98 —— 换的是音区不是嗓子）。现在合成后测基频，不在
  `registerMin..registerMax`（默认 330-385 Hz）就换 seed 重生成，只对 ≤12 秒的音频重试。

### 修复

- **说话会杀掉正在跑的歌**：`resumeLocalSay` 为腾显存会 `voice.shutdown()`，而说话不走 GPU 队列，
  队列里正在换声的歌会被直接弄死。加了 `activeSingJobs` 互斥：唱歌期间不碰换声常驻。
- **`auto` 模式的本地兜底根本起不来**：`resumeLocalSay` 判断 `engine !== 'breeze-local'` 时直接返回。
  现在改成「云端失败 → 准备本地 → 重试一次」。
- **口头禅被当成歌名**：兜底规则（≤20 字、无标点、无空格 → 当歌名）会让模型回一句「好的」「收到」
  就去网易云搜歌开唱；句中规则也只认「唱」一个字（「我会唱歌」→「歌」、「你想听我唱歌吗」→「歌吗」）。
  现在兜底规则收进 `intent.bareTitle`（默认关），句中规则只认明确的点歌动词或带冒号的「唱：X」。
- **`voiceSeconds = 0`（整首）推不出去**：`if (!seconds || …)` 把 0 拦掉了，连带
  `lastSyncedVoiceSeconds` 初值 0 也会跳过首次推送。
- **清空 Breeze Key 无法撤销**：`/say/config` 支持 `replace: true`（完整覆盖，空值 = 清除），
  插件作为唯一真相源永远带 replace；网关丢了 `runtime.json` 也会被下次推送纠正。
- **`/say/status` 徽标在「在线/离线」之间横跳**：连通性缓存只存了 `false`，命中缓存时跳过 fetch
  直接走到 `return online: true`。现在状态码一起缓存，离线判断挪到缓存分支之外。
- **TTS 静默截断**：`say.maxChars` 超长时后半段被丢掉、调用方无感知 → 现在响应带
  `x-truncated` / `x-max-chars` 头并写警告日志。
- **清理与 TTL 打架**：`/admin/prune` 原来按自然日零点删，23:59 唱完的歌 00:01 就被删，
  而插件可能正好那时来下载（404）→ 改成按**文件年龄**（新配置 `filesPruneMinAgeHours`，默认 8 小时）。
- **网易云扫码登录**：两个请求加 8 秒超时（原来卡住就挂死）；失败/过期的 unikey 也会清理，
  并定期清掉 10 分钟前的会话。
- **进度日志刷屏**：`waitForJob` 用 `job !== last` 比较对象恒为真，每 2 秒刷一条 → 改成比较
  `state|progress|message`。
- **探针把 Breeze 刷爆**：每次 `/say/status` 都会请求 `/v1/models` → 加 60 秒缓存。

### 安全

- **删除 `netease_login` 工具**：它会把 `<网关>/login?token=<网关令牌>` 作为工具结果交给模型，
  模型很可能原样发到群里 —— 而那个 token 拥有 `/admin/*`、`/say/config`、`/files` 的全部权限。
  `login`（扫码）已覆盖同样功能，且 chat 通道给的是网易云 unikey（不含网关令牌）。
- **`/login/*` 不再接受 `?token=`**：URL 查询参数会留在浏览器历史、隧道日志与 Referer 里。
  页面改读 `location.hash`，用法 `/login#token=<令牌>`；接口只认 `x-gateway-token` / `Bearer`。

### 变更 / 破坏性调整

- `/say/config` 新增 `replace` 字段（见上）。
- `/say/status` 新增 `mode: "cloud" | "local"`，去掉从前的 `cloudFallback`。
- `/health` 的 `say` 取值现在是 `auto | breeze | breeze-local | none`。
- `maxSeconds` 三道闸统一：群文件路径受插件工具 300 秒超时限制，插件侧上限 **280 秒**；
  想唱整首用语音条（`voiceSeconds`，最长 600 秒）。
- 删除 `say.voice` / `say.rate` / `say.volume`（SAPI 时代死字段，解析了但没人用）。
- `gateway/config.example.json` 的 `source.type` 从非法的 `itunes` 改为 `netease`
  （`config.mjs` 只认 `netease` / `local`，非法值会静默回落）。

### 文档

- `docs/PROTOCOL.md`：补上 `/admin/voice-seconds`、`/admin/prune`、`/login/*` 三组端点
  （漏掉它们，照契约重写的后端会让插件的秒数推送/零点清理/扫码登录全部哑掉）；
  `/say/config` 的 replace 语义、轮询预算 280 秒、`/health` 与 `/say/status` 示例全部对齐实现。
- `docs/INSTALL.md`：普通文本不再返回 400（只有 `say.engine=none` 才 400）、超时统一 600000、
  默认值/枚举/清理配置项修正、删掉 SAPI 残留行、用例数 32→41、工具数 4→7、版本号 v1.0.4、
  torch 轮子 `2.7.1-cp312` → `2.9.1-cp311`。
- `docs/SPEAK.md`：合并两节重复的「让网关托管」；`pitchMaxShift` 收敛为一个口径；
  权重体积统一为「权重 7.2 GB / 运行占 7.9 GB」。
- `docs/QUICKSTART.md` / `docs/TUNNEL.md` / `README.md`：整首耗时标注口径
  （22 秒 = 换声常驻稳态，43 秒 = 端到端含冷启动）；Python 版本统一 3.11。
- `docs/TUNING.md`：扫码登录那行的原因/修法列修正；补「为什么裸短词默认不当歌名」。

---

## [1.0.4] - 2026-10-31

### 新增

- **本地 Breeze TTS**：说话可以完全本地跑（`say.engine = breeze-local`），按需加载、闲置 60 秒自动退出，
  说完把 8.2 GB 显存还回去（实测 70 秒后从 8.3 GB 掉回 1.6 GB）。
- **一键脚本**：`scripts/start-all.ps1`（环境检查 → 权重检查 → 配置引导 → 起网关 → 起隧道 → 打印地址与令牌）、
  `run-gateway-forever.ps1`、`run-tunnel-local.ps1`、`sync-host-url.ps1`。
- **音高归一**：把每句基频拉齐到目标 Hz，并保留共振峰（`formant=preserved`），
  解决"同一句话每次音色都不一样"。
- 基线音色：官方「大肥鱼（迷糊版）」样本裁剪为 4.7 秒参考音频 + 官方文稿，支持克隆。

### 修复

- 本地模型的日志/编码问题：`.ps1` 必须存成 UTF-8 **带 BOM**，否则中文乱码 + ParseError。
- 网关自己拉起 python 并由 node 轮询 `/health`（用 PowerShell 的 `Invoke-WebRequest` 会被宿主沙箱挡住，
  实测白等 360 秒）。
- `run-tunnel-local.ps1` 的参数 `$Host` 撞 PowerShell 只读自动变量 → 改名 `-SshHost`。
- 网关/隧道改为计划任务托管，不再随会话 job 一起被杀。
- `probeSeconds` 在没装 ffprobe 时回退解析 `ffmpeg -i` 的 Duration 行。

### 文档

- 新增 `docs/QUICKSTART.md`（三步上手）、`docs/ENV.md`（环境）、`docs/SPEAK.md`（说话）、
  `docs/TUNNEL.md`、`docs/TUNING.md`、`docs/TROUBLESHOOTING.md`、`docs/PROTOCOL.md`。
- `requirements.txt` 合并成一份（说话 + 唱歌共用一个环境）。

---

## [1.0.3] - 2026-10-31

### 新增

- **说话改用 Breeze TTS 2 云端**：3-6 秒/句，音色绝对稳定，不占显存。
- 插件设置里填 Breeze API Key 与音色 id，插件页显示后端在线状态与余额。
- 音色列表工具 `say_voices`、状态工具 `say_status`。

### 移除

- Windows SAPI 与 Edge TTS 两套实现（前者机械、后者要另装 Python 环境且音色固定）。
- "TTS 之后再换声"那条路径。

---

## [1.0.2] - 2026-10-30

### 新增

- **神经语音（说话能力）**：非点歌的文本走 TTS 读出来。
- **常驻换声**：整首 82 秒 → 22 秒。

### 修复

- 语音条通道缺 ffmpeg 时会发出 6.87 MB WAV 被宿主拒收。

---

## [1.0.1] - 2026-10-30

### 新增

- **分段换声**：整首歌能唱了（超过「段长+5 秒」自动切 30 秒一段，整批只加载一次模型，
  失败只补跑缺的段，最后拼回整条）。

### 修复

- 时长被 job 级上限夹住（设 240 只唱 180 的根因）。
- 显存闸真正接上（`--gpu-fraction`）。
- `/v1/audio/speech` 回 `x-audio-seconds` 真实时长。
- 孤儿进程与 `cwd` 两个致命 bug。

---

## [1.0.0] - 2026-10-29

### 新增

- 点歌 → 搜歌（网易云）→ 换声（本机 RVC）→ 发语音条/群文件的完整链路。
- 控制台扫码登录网易云；群文件开关（默认关，只发语音条）。
- 显存闸：不让换声把显卡占满。

---

## 更早

1.0.0 之前是仓库搭建阶段（插件骨架、本机换声网关、GitHub Actions 打包与发布），未单独发版。
