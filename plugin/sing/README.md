> **网易云登录**：在控制台插件页点「扫码登录」，用手机**网易云 App** 扫码即可（二维码由本插件本地生成，不上传任何数据）。
> 面板标题里出现的「B 站」是宿主界面的固定文案，不影响登录；也可以直接打开 `<网关地址>/login#token=<网关令牌>` 扫码。
# 点歌唱歌（v1.0.5）

> ⚠️ 本插件只是薄客户端：**换声模型和网关必须在你自己的电脑上跑**（同一仓库的 `gateway/` + `sing-model/`）。服务器不装模型；本机没开时只会回「后端离线」。

群里说一句「唱一首 XXX」，机器人用你自己电脑上的换声模型翻唱，成品**默认以语音条发出来**
（「发语音条」是默认通道；「发群文件」要手动打开 `allowFileOutput`，这两条走不同的宿主接口）。

- 插件 id：`sing` · `apiVersion: 2` · 入口 `index.mjs`
- 宿主要求：qq-agent-plus ≥ `0.9.10`（用到 `cap.media.download` / `cap.send.file` / `secrets` / 工具级 `timeoutMs`）
- 零依赖：不 import 宿主内部模块，不在使用者机器上跑 npm

## 能做什么

- **点歌翻唱**：群里 @机器人说「唱一首孤勇者」，几十秒后收到一段用目标音色唱的音频文件
- **说话**：任何非点歌的语音请求都会变成语音条（Breeze TTS 2，云端 50 个音色或本地自定义音色）
- **先试听再点**：不确定点哪首时让它先搜（返回歌名/歌手/时长），确认了再唱
- **后端离线时说得清**：你电脑关机或隧道断了，它会直说"后端不在"，不影响群里正常聊天

## 群里怎么问

- 「唱一首孤勇者」
- 「先搜一下 孤勇者 有哪些版本」（只搜不出声）
- 「点歌后端还活着吗？」（查网关与可用音色）
- 「有哪些说话音色？」（列出 Breeze 云端音色，支持按名字过滤）
- 「你现在能说话吗 / 额度还剩多少？」（查说话后端状态与余额）

触发方式跟着 qq-agent 的常规规则走：群里一般需要 @机器人 或命中触发词。

## 它需要什么权限（装之前请看完）

| 能力 | 为什么需要 |
|---|---|
| `tools` | 给模型七个工具 |
| `http` | 调你自己的点歌网关（宿主**强制禁内网**，所以网关必须是公网 https） |
| `media` | 把换声成品下载到 `plugin-data/sing/media/`（宿主规定：插件只能发这个目录里的文件） |
| `send` | 用 `cap.send.file` 把成品发到群（**只支持群聊**） |
| `config` / `secrets` | 读设置、加密保存网关令牌 |
| `log` | 把点歌进度写进宿主日志（统一前缀与脱敏） |

插件**不写任何外部账号数据**、不发文字消息、不调模型，所以没有 `approval` / `quota` 声明。

## 七个工具

| 工具（模型看到的全名） | 参数 | 行为 |
|---|---|---|
| `sing__sing_song` | `song`（必填）、`voice`、`maxSeconds` | 点歌 → 等换声 → 下载 → 发群文件；只支持群聊 |
| `sing__sing_search` | `keyword`（必填） | 只搜不出声，返回 5 条候选 |
| `sing__sing_status` | 无 | 查网关在不在、有哪些音色 |
| `sing__say_status` | 无 | 查「说话」后端：在线、音色、剩余额度 |
| `sing__say_voices` | `keyword`（可选） | 列说话音色，支持按名字过滤 |
| `sing__breeze_claim` | 无 | 领 Breeze 每日额度（+400）并报余额 |
| `sing__login` | `action` | 网易云扫码登录（控制台徽标用这个；原 `netease_login` 已删 —— 它会把网关令牌拼进 URL 交给模型） |

工具级超时：`sing_song` 300 秒（内部轮询到 280 秒主动放弃），其余 20-30 秒。整首 4 分钟的歌约 22 秒（换声常驻时）。

## 设置项

| 键 | 类型 | 说明 |
|---|---|---|
| `gatewayUrl` | text | 网关地址，`https://…`，不带结尾斜杠。**必须是有公网域名的 https**（宿主禁止插件访问 `127.0.0.1`） |
| `apiToken` | secret | 与网关 `config.json` 的 `token` 一致；宿主用 AES-256-GCM 加密落盘，不回显明文 |
| `breezeKey` | secret | 走云端说话时填（`brz_…`）；加密保存，不回显。填完插件会推给网关并落盘 |
| `breezeVoiceId` | text | 云端音色 id，如 `voc_8yud7hz7c9q2`；不知道就让机器人「列出说话音色」 |
| `breezeEmail` | text | Breeze 账号邮箱（用于自动领每日额度） |
| `breezePassword` | secret | Breeze 账号密码；只用来调官网登录接口换会话，加密存宿主 |
| `breezeAutoClaim` | boolean | 每小时自动领一次每日额度（幂等），默认开 |
| `defaultVoice` | text | 唱歌音色名，留空用网关默认值 |
| `maxSeconds` | number | 单次换声上限，默认 60，范围 **5-280**（群文件路径受插件工具 300 秒超时限制） |
| `voiceSeconds` | number | 语音条秒数，0 = 整首（默认） |
| `pollIntervalMs` | number | 轮询间隔，默认 2000（1-10 秒） |
| `allowInsecureHttp` | boolean | 仅调试用；内网地址照样会被宿主拦住 |

## 安装

```bash
# 手工：拷目录
cp -r plugin/sing "$DATA_DIR/plugins/sing"

# 或者走宿主自己的打包 + 安装器（推荐）
node <qq-agent-plus>/scripts/plugin-pack.mjs ./plugin/sing \
  --base-url https://github.com/BAOfanTing/say-sing-drawPlugin --tag v1.0.5
node <qq-agent-plus>/src/ops.js plugins install sing-1.0.5.tar.gz
```

装完在控制台「插件」页确认信任（首次加载会提示它要联网、能发文件），再去设置里填网关地址。

## 本地调试

```bash
# 用宿主的假宿主跑真协议（--http-mock 可以钉住网关响应，不必真起网关）
node <qq-agent-plus>/scripts/plugin-dev.mjs . --call sing_status

# 本仓库自带的真协议集成测试（这个测试文件自己扮演宿主）
cd ../.. && node --test test/plugin-protocol.test.mjs
```

## 失败时会发生什么

| 情况 | 结果 |
|---|---|
| 网关没起来 / 隧道断了 | 「网关返回失败：…」，模型会告诉用户后端离线；**文字聊天不受影响** |
| 令牌不对 | 「网关拒绝了请求：令牌不对…」 |
| 换声失败（显存不够、模型路径错） | 网关返回 `failed` + 原因，插件原样转给模型 |
| 等了 280 秒还没好 | 「等换声超时…把 maxSeconds 调小再试」，不等宿主硬杀进程 |
| 在私聊里点歌 | 直接拒绝并说明"只能群聊"（宿主 `send.file` 的限制） |
| 网关给了无法识别的任务状态 | 按失败处理并说明原因，绝不假装在跑 |
