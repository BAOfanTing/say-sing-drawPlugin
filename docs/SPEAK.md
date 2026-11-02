# 说话（TTS）

宿主的 `send_voice` 指向本网关后，机器人**所有**语音请求都会打到 `/v1/audio/speech`：

| 输入 | 走什么 | 耗时（实测） |
|---|---|---|
| 含点歌意图（`唱：歌名`、`点歌唱…`、句中触发） | 换声唱歌（本机 GPU，整首自动分段） | 12 秒（45 秒成品）/ 22 秒（整首 3:54） |
| 其它文本 | **说话**：Breeze TTS 2 云端（`api.breeze.blue`） | **3-6 秒** |

唱歌那条路见 [TUNING.md](TUNING.md)。这里只讲"说话"。

## 为什么是 Breeze

| 模式（`say.engine`） | 走哪 | 一句耗时 | 占显存 | 成本 |
|---|---|---|---|---|
| **`auto`（默认）** | **云端优先**，云端不可用自动回落本机 | 3-6 秒 / 回落时 10-15 秒 | 云端 0，本地 8.2 G | 云端按字符计费 |
| `breeze` | 只走云端 | 3-6 秒 | 0 | 按字符计费 |
| `breeze-local` | 只走本机权重 | 10-15 秒 | 8.2 G（闲置 1 分钟退出） | 免费 |
| `none` | 关掉，只说文字 | — | — | — |

**默认 `auto`**：云端快且音色绝对稳定，额度/网络出问题时才用本地兜底，两条链路都不会让"说话"整单失败。

> 早期试过 Windows SAPI（机械、没法听）和 Edge TTS（要另装一套 Python 环境、音色固定），都已移除。

## 插件里配（推荐）

控制台 → 插件 → 点歌唱歌 → **「说话（Breeze 云端）」** 分组：

| 设置 | 说明 |
|---|---|
| **Breeze API Key** | `brz_xxxx`，在 Breeze 控制台 → API Keys 生成。加密保存在宿主，不回显明文 |
| **音色 id** | 如 `voc_8yud7hz7c9q2`（大肥鱼·迷糊版）。不知道 id 就群里问「列出说话音色」 |

填完立刻生效（插件把值推给网关 `POST /say/config`，网关落盘，重启也在）。

**插件页会显示后端状态**：点「检测登录」或让机器人跑一次，徽标会显示
「说话后端在线（额度 1362）」或「说话后端离线：API Key 不对」。

## 音色怎么查

```bash
# 网关侧（用网关令牌）
curl -H "authorization: Bearer <网关令牌>" https://<网关地址>/say/voices

# 或直连 Breeze
curl -H "xi-api-key: brz_xxx" https://api.breeze.blue/v1/voices
```

群里也可以直接问「**有哪些说话音色**」→ 机器人调 `say_voices`（支持按名字过滤）。

## 网关侧配置（`gateway/config.json`）

```json
"say": {
  "engine": "auto",                          // auto | breeze | breeze-local | none
  "breezeUrl": "https://api.breeze.blue",
  "breezeKey": "brz_xxxx",                   // 插件填过就以插件为准
  "voiceId": "voc_8yud7hz7c9q2",
  "breezeModel": "breeze-tts-2",
  "languageCode": "zh",
  "instructions": "",                        // 可选：语气/情绪/节奏，用中文写
  "guidanceScale": 4.0,                      // 可选：指令遵循强度
  "outputFormat": "mp3_24000_128",
  "maxChars": 800,                           // 超长截断（宿主本身只给 300 字左右）
  "timeoutMs": 120000
}
```

接口形状（官方 `openapi.json`，ElevenLabs 风格）：

```
POST {baseUrl}/v1/text-to-speech/{voiceId}?output_format=mp3_24000_128&delivery=sync
header: xi-api-key: <key>          ← 不是 Bearer
body:  { text, model_id, language_code?, instructions?, voice_settings: { guidance_scale } }
→ 200 audio/mpeg
```

## 网关给插件用的三个接口

| 接口 | 用途 |
|---|---|
| `GET /say/status` | `{ online, hasKey, hasVoice, voiceId, balance, note }` —— 插件页"后端在线"就是它 |
| `GET /say/voices` | 音色列表（转发 Breeze） |
| `POST /say/config` | `{ apiKey?, voiceId?, replace? }` 插件推配置上来；`replace: true` 表示完整覆盖（空值 = 清除该项） |


## 情绪：按情境换语气（2026-11-02 上线）

模型可以在台词最前面写一个情绪标记，网关剥掉标记（不会念出来）、换「表演指令」、合成后再加一道音频加工：

```
【生气】你再说一遍试试。
【撒娇】人家不想去嘛。
【温柔】别急，慢慢说。
```

| 标记 | id | 效果 |
|---|---|---|
| 默认 / 平静 | `neutral` | 不加任何东西，跟以前完全一样 |
| 撒娇 | `sajiao` | 拖慢、轻压、带点亮 |
| 生气 / 凶 / 发火 / 训人 | `angry` | 提速、重压、加低频和临场感 |
| 高兴 / 开心 | `happy` | 轻快、明亮 |
| 委屈 | `wronged` | 放慢、变轻（故意**不**压缩） |
| 温柔 | `gentle` | 放慢、柔化高频 |
| 不耐烦 / 烦躁 / 嫌弃 | `impatient` | 略快、略硬 |
| 惊讶 / 吃惊 | `surprise` | 略快、短促 |
| 兴奋 / 激动 | `excited` | 快、亮、有力 |
| 难过 / 伤心 / 失落 | `sad` | 放慢、闷一点 |

别名全表在 `gateway/lib/emotions.mjs` 的 `EMOTION_ALIASES`。`/v1/audio/speech` 也可以直接传 `emotion` 字段（等价，文字里的标记优先）。
关掉整条通道：`"say": { "emotionTag": false }`（回到"标记原样念"的老行为）。

### 三条铁律（都是实测踩出来的）

要「同一个嗓子换语气」，只靠 `instructions` 是**做不到**的 —— 云端会顺着描述重新设计音色：

| 做法 | 语速 | 音色相似度 vs 纯 voice_id |
|---|---|---|
| 纯 voice_id（两次） | 4.12 / 4.52 | **0.9885**（自然波动就是这个量级） |
| 写「低沉粗糙的男声，语气凶狠…」 | 5.14 | **0.7127 → 换人** |
| 同一句凶话再跑一次 | 5.68 | 0.8953（连自己都复现不出来） |
| 只加 `speed: 1.35`（合成阶段） | 6.47 | 0.9440 |
| **情绪短句 + `use_speaker_boost`** | 4.36 | **0.9918-0.9961** |

1. **情绪短句里绝不写性别、年龄、嗓子粗细**（"男声""沙哑""粗糙"都会重画音色）。
2. **必须带 `use_speaker_boost: true`**：它把结果往 voice_id 上贴，0.91~0.97 的漂移会被拉回 0.99。
3. **开了 boost 就别传 `guidance_scale`**：官方文档写明 `guidance_scale > 1` 时 boost 会被忽略；实测 guidance 8 直接掉到 0.8303。

另外：`[喊叫]` 这类 audio tag 是**非语音声音事件**（笑声/哭声/叹气/喊叫等 34 个，中文用方括号），不是情绪开关，实测对语气几乎没影响。

### 加工链路：instructions 管发声，ffmpeg 管响度

| 层 | 负责 | 手段 |
|---|---|---|
| 合成时 | 怎么发声（用力、拖长、起伏） | `instructions`（基础音色描述 + 情绪短句）+ `use_speaker_boost` |
| 合成后 | 多响、多快、多硬 | ffmpeg：`atempo` + `acompressor` + `equalizer` + `alimiter` |

几个刻意的取舍：

- **只用 `atempo`**（保音高的速度倍率），不用 `asetrate` / `rubberband=pitch=` —— 后者把音高一起移，等于换嗓子。
- **委屈/难过故意不压缩**：压缩会把"小声"抬上来，委屈感就没了。
- **合成阶段不传 `speed` 参数**：实测它会拉到 0.944；同样的提速用 `atempo` 做是 0.986。
- **滤镜失败不影响出语音**：没 ffmpeg 或滤镜写错就记一条 `[say] 情绪加工没跑成` 警告，发未加工的音频。

### 端到端实测（同一句话，走真网关 + 真 Breeze）

| 样本 | 语速(字/秒) | 停顿 | 响度 | 音色 vs 纯文本 |
|---|---|---|---|---|
| 纯文本 | 4.12 | 6 | -22.6 dB | 1.0000 |
| 纯文本（第二次 = 噪声基线） | 4.52 | 5 | -22.2 dB | 0.9885 |
| **【生气】** | **5.52** | **2** | **-19.8 dB** | 0.9863 |
| **【撒娇】** | 3.92 | 4 | **-24.8 dB** | 0.9904 |
| **【温柔】** | 4.46 | 6 | -23.8 dB | 0.9895 |

语速差 1.6 字/秒、响度差 5 dB，而音色全在自然波动里 —— 这就是"同一个嗓子、不同语气"。

### 自己加/改情绪

字段级覆盖，没给的沿用默认；`false` 表示删掉这个情绪：

```json
"say": {
  "emotions": {
    "angry": { "instructions": "语气很凶，正在训人。", "filter": "atempo=1.15,acompressor=threshold=-20dB:ratio=6:attack=4:release=100:makeup=2,alimiter=limit=0.95" },
    "growl": { "label": "低吼", "instructions": "语气低沉，像在低吼。", "filter": "atempo=0.98,equalizer=f=150:t=q:w=1:g=4,alimiter=limit=0.95" },
    "sad": false
  }
}
```

改完重启网关生效；`GET /say/status` 会带上 `emotionTag` 和当前可用的 `emotions` 列表。

### 让模型会用标记（人设提示词）

标记得由模型自己写，所以要在**宿主的机器人人设/系统提示词**里加一段（本仓库管不到宿主那段，这里给可直接粘的版本）：

```
你说语音时，可以在台词最前面加一个情绪标记，网关会按它调整语气（标记不会被念出来）。
可用：【撒娇】【生气】【高兴】【委屈】【温柔】【不耐烦】【惊讶】【兴奋】【难过】【平静】
按情境自己选，别每句都加：日常闲聊不用加，情绪明显时才加，一条消息只用一个。
例：【生气】你再说一遍试试。 / 【撒娇】人家不想去嘛。
```

不加照样能说话，只是每句都是默认语气。

### 音色一致性问题（同样配置，两句听着不像一个人）

实测结论：**音色（音质、共鸣位置）其实是稳的**（两句的 MFCC 相似度 0.99），
飘的是**音高**——同一音色每次合成的中位基频会差 **25-30 Hz（约 1 个半音）**，
听感上就像"换了个状态"。

| 现象 | 真实原因 |
|---|---|
| 两句听着像两个人 | 基频飘了 1 个半音左右，不是换了嗓子 |
| 文字描述模式尤其明显 | 设计模式的"嗓子"由 seed 决定，文本和 seed 一致时是稳定的；换 seed/换描述才会换嗓子 |
| 参考克隆也有一点 | 克隆锁定的是音色，音高仍由文本语调决定 |

**解决办法：音高归一**（`say.pitchTarget`）

```json
"say": { "pitchTarget": 355, "pitchMaxShift": 2.5 }
```

- 每句合成后测一次中位基频（`say-model/f0.py`），用 ffmpeg 的 `rubberband` 只改音高不改速度
- 拉到 `pitchTarget` 指定的 Hz，`pitchMaxShift` 限制最大改动（超过就不改，宁可不调也别跑调）
- 实测：三句原本 378 / 350 / 373 Hz（飘 28 Hz），归一到 **353.8 / 350.7 / 354.8 Hz**（差 4 Hz）
- 代价：每句多 1-2 秒（要跑一次基频检测 + 一次 ffmpeg）
- `pitchTarget: 0` = 关闭（默认）

### 本仓库的基准音色（大肥鱼·迷糊版）

用**文字描述**这只音色，不加参考音频 —— 实测这是本地最稳的一档：

```json
"say": {
  "engine": "breeze-local",
  "instructions": "清亮柔软、略带奶气的普通话少女音。",   // 官方描述，原样照抄
  "refAudio": "", "refText": "",
  "cfgScale": 4,
  "pitchTarget": 355,
  "pitchMaxShift": 6
}
```

实测四句：356.9 / 350.7 / 361.0 / 354.8 Hz，最大差 10 Hz。

三条踩过的经验：

| 试过 | 结果 |
|---|---|
| 描述 + 平台标签（Chinese / Animation / Female） | **更差**：两句音高差从 7.9 Hz 涨到 42-45 Hz。标签是平台元数据，不是设计提示词 |
| 参考音频克隆 | 音色能锁住，但每句要重新编码参考音频，慢 2 秒；且音高仍随文本飘 |
| 音高归一时用默认 `formant=shifted` | **会把共振峰一起移**，移调 3 个半音就像换了个人；必须 `formant=preserved` |

> 云端有 `voice_id`（design/clone → save 后音色绝对固定），但**本地权重没有这个概念**：
> `speaker` 只是提示词里的标记，参考音频是每次请求现编码的。

### 长回复：为什么默认**不**切句

一个消息要听起来是同一个人，关键不是音高，而是**音色必须来自同一次生成**：
文字描述模式下每次请求都会重新采样音色，所以"切句分别合成再拼起来"会让
一条语音条里前后像两个人（用户实测反馈，2026-11-01 确认）。

实测数据（同一段 47-61 字）：

| 做法 | 耗时 | 段间音高差 | 音色（身份） |
|---|---|---|---|
| **一次生成整段（默认）** | 12-90 秒 | 40-55 Hz（句间语调起伏） | ✅ 始终同一个人 |
| 切句分别生成再拼 | 57-78 秒 | 3-27 Hz（更好） | ❌ 每段是重新采样的嗓子 |

所以默认 `splitSentences: false`：宁可让音高随句子起伏（真人说话本来就起伏），
也不能中途换人。如果回复很长、又希望音高更平，可以自己打开：

```json
"say": { "splitSentences": true, "maxSegmentChars": 20 }
```

> 同一个设置下，两条**独立消息**之间的一致性很好：实测 F0 354.8 vs 353.8 Hz（差 1 Hz）、
> MFCC 相似 0.9887 —— 也就是说"一条消息一个嗓子、消息之间也基本一致"。

### 本地模型为什么会"换嗓子"（实测结论）

本机权重（eager 模式）有一堆反直觉的行为，2026-10-31 ~ 11-01 都实测过：

| 现象 | 实测 | 结论 |
|---|---|---|
| 同一文本两次生成 | 输出**逐字节相同**（SHA256 一致） | 生成是确定性的，不是随机抖动 |
| 不同文本的音区 | 8 字→266 Hz、11 字→374 Hz、23 字→255 Hz、6 字→398 Hz | **音区随文本"抽奖"，没有可预测的长度规律** |
| 换 seed | 同一句 266 / 312 / 380 Hz，但 MFCC 相似度仍 0.98 | 换 seed 只改音区，**不改嗓子** |
| 长文本（>15 秒） | 一路下滑，40-139 Hz | 长语音内部本来就漂，且稳定落在低音区 |
| 音区差 >50 Hz | 人耳判定"换人了" | 音区一致 = 听起来同一个人 |

对应的三个对策（都实现在网关里）：

```json
"say": {
  "pitchTarget": 355,             // 目标音区
  "pitchMaxShift": 2.5,           // 只做 ±2.5 半音内的微调；超出不碰（避免变调失真）
  "registerMin": 330,             // 合成后测基频，不在区间内…
  "registerMax": 385,
  "registerRetries": 2,           // …就换 seed 重生成（不碰音频，无痕迹）
  "registerRetryMaxSeconds": 12   // 只对 ≤12 秒的音频重试（长文本重试无用还慢 3 倍）
}
```

实测效果：8 字句 265.8 → **354.8 Hz**（守卫重试生效）、16/35 字 → 356.9 / 354.8 Hz。
还剩一个已知短板：**长文本（>15 秒）稳定停在 280-290 Hz**，和短句不同嗓子 ——
目前只能靠"回复别太长"规避，或等云端优先级生效。

### 额度和签到（插件里全自动）

- 计费：CJK 字符算 2 单位、其它算 1 单位，**10 单位 = 1 credit**。
- 余额 `GET /v1/balance` 能看到每笔 topup（1000 注册赠送 + 400 问卷奖励）。
- **开发者 API 里没有签到端点**（60 个都查过），签到在网页控制台；
  但网页接口用的是**自家服务器的邮箱密码登录**（`/api/config` 里 `email_auth_mode=server`），
  **不经过 Google**，所以在插件里就能自动领：

```json
// 插件设置 → 云端额度
"breezeEmail": "xxx@qq.com",
"breezePassword": "(secret)",      // 加密存宿主，不回显
"breezeAutoClaim": true
```

插件做的事（每小时醒一次，幂等）：

```
POST https://breezeblue.ai/api/auth/email/continue   {email,password} → 会话 Cookie（存宿主 storage）
POST https://breezeblue.ai/api/credits/daily-claim   {reward_tier:"discord"} → +400
```

- Cookie 失效（401）会自动重登一次；`discord` 档被拒会自动降级 `standard`（+100）
- 也可以手动触发：群里说「帮我领今天的额度」，或调工具 `breeze_claim`
- 插件 manifest 里已声明 `httpDomains: ["breezeblue.ai"]`

> 不想把密码交给插件？留空即可，只是额度得自己去控制台点。

## 计费与限制

实测约 **0.186 额度/字符**（36 字扣 6.7）。免费注册送 1400 额度 → 约 **250 句**短话。

免费版（`/v1/entitlements`）：

| 项 | 值 |
|---|---|
| 并发 | 2 |
| 可保存音色 | 5 |
| **商用** | `commercial_use_allowed: false` ← 官方许可仅研究/非商用 |

查余额：`curl -H "xi-api-key: brz_xxx" https://api.breeze.blue/v1/balance`


## 本地部署（`say.engine: "breeze-local"`）

不想花额度、或想离线跑，就把权重放本机。**权重 7.2 GB、运行占 7.9 GB 显存**（eager），
所以和唱歌的 RVC 常驻（~2 GB）**不能同时用**——好在网关会在本地失败时自动退回云端。

### 1. 准备权重

从 Hugging Face `BreezeBlue/breeze-tts-2` 下到 `say-model\weights\breeze-tts-2\`，**必须包含**：

```
config.json  generation_config.json  model.safetensors.index.json
model-00001-of-00002.safetensors  model-00002-of-00002.safetensors
tokenizer.json  tokenizer_config.json  special_tokens_map.json
audio_tokenizer\            ← 整个目录（缺它 load_runtime 直接报错）
   config.json  configuration.json  preprocessor_config.json  model.safetensors
```

合计约 **7.2 GB**。下完先体检：

```powershell
E:\APP\Anaconda\envs\sing\python.exe say-model\check-ckpt.py
```

全 ✓ 才算完整（`.crdownload` 半截文件会被点名）。

### 1.5 依赖（一次性）

本地说话要 GPU 侧依赖，且 **`triton` 不是可选项**——Breeze 的 `fast_streaming` 在 import
期就 `import triton`，缺了直接启动失败。完整清单与坑见 **[ENV.md](ENV.md)**，最短路径：

```powershell
python -m pip install torch==2.9.1 torchaudio==2.9.1 --index-url https://download.pytorch.org/whl/cu128
python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

### 2. 启动本地服务

```powershell
powershell -ExecutionPolicy Bypass -File say-model\start-local.ps1
# 装好 MSVC Build Tools + CUDA 12 之后可以加 -Fast（编译 CUDA graph，快约 3 倍）
```

- 默认 `http://127.0.0.1:7860`，进程与日志在 `say-model\logs\`
- 第一次要读 7 GB 权重进显存，1-3 分钟；`/health` 返回 `{"status":"loading"}` 时就还没好
- eager 模式**不需要** MSVC / CUDA toolkit（`--fast-*` 才要）

### 3. 切到本地

`gateway/config.json`：

```json
"say": {
  "engine": "breeze-local",
  "localUrl": "http://127.0.0.1:7860",
  "refAudio": "<参考音频路径>",   // 参考音频（克隆用；留空 = 纯语气设计）
  "refText": "参考音频里说的那段话的准确文字稿",
  "instructions": "语气亲切一点，语速稍慢",
  "cfgScale": 4.0,
  "localTimeoutMs": 180000
}
```

- 有 `refAudio` + `refText` → **克隆**那个音色（3-10 秒干净人声，无伴奏最好）
- 只有 `instructions` → **Voice Design**（纯文字描述造音色）
- 本地挂了且配了 `breezeKey` → 自动退回云端，日志里会写 `[say] 本地 Breeze 失败，退回云端`

### 3.5 让网关托管（推荐：按需加载 + 闲置退出）

不用自己开终端起 python —— 配好这几项，**网关会在需要时自己拉起/关掉**本地模型：

```json
"say": {
  "localPython": "<装了 torch 的 python>",
  "localModelDir": "<仓库路径>/say-model/weights/breeze-tts-2",
  "localAppDir": "<仓库路径>/say-model",
  "localIdleMs": 60000          // 闲置多久退出（毫秒）；0 = 常驻不退
}
```

`start-local.ps1` 只在你想手动调试时用；网关自己起的那份会把日志写到网关 stdout。

**闲置退出**：本地模型不会一直占着显卡 —— 闲置 `localIdleMs`（默认 60 秒）后自动退出，
把 8.2 GB 显存还回去（实测：说完一句，70 秒后显存从 8.3 GB 掉回 1.6 GB）。
代价是"闲置后第一句"要重新加载（约 8 秒加载 + 预热，实测 36 秒/句），之后回到 12-16 秒；
想常驻不退就把 `localIdleMs` 设成 `0`。

### 4. 和云端对比

| | 云端 | 本地（eager，实测） |
|---|---|---|
| 显存 | 0 | **7.9 GB** |
| 成本 | 0.186 额度/字符 | 0 |
| 首句 | 3-6 秒 | 首次 39 秒（含 8 秒加载 + 编译预热） |
| 稳态每句 | 3-6 秒 | **7-9 秒**（2-5 秒音频，RTF≈2-3） |
| 音色 | 50 个预置 | 任意参考音频 / 任意文字描述 |
| 许可 | 免费版禁商用 | 权重仅研究/非商用 |

> 想更快就装 MSVC Build Tools + CUDA 12 toolkit，然后用 `start-local.ps1 -Fast`（CUDA graph，约快 3 倍）。

### 和唱歌抢显存时怎么办（自动让位）

本地 TTS 常驻 7.9 GB，RVC 换声也要几个 GB —— 10 GB 卡上挤在一起，实测唱歌从 **10 秒变 51 秒**
（显存颠簸）。所以网关内置了让位调度（`say.localPython` / `say.localModelDir` 配好就生效）：

| 时刻 | 动作 |
|---|---|
| 收到唱歌任务 | 先 `taskkill` 本地 TTS 进程，显存还给换声 |
| 收到说话请求 | 先收掉换声常驻（闲着也占 2.4 GB），再拉起本地 TTS 并等 `/health` 通 |
| 显存不够 / 本地没起来 | 自动退回云端（配了 `breezeKey` 才生效） |

**代价（务必知道）**：每次切换都要重新读权重 + 预热，实测**约 30-40 秒**。
宿主真链路实测：说话 32 秒（含加载）→ 唱歌 41 秒（RVC 也是冷启动）→ 说话 40 秒（又要重载本地）。

所以：
- **经常又唱又说** → 说话用云端（0 显存，唱歌保持 22 秒，无切换开销）
- **只想省钱、能忍延迟** → 本地；把 `say.engine` 设成 `breeze-local`，切换开销就当它是"冷启动"
- 本地常驻期间（不切换）稳态是 **7-9 秒/句**

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `说话后端离线：API Key 不对` | `xi-api-key` 的值要完整（带 `brz_` 前缀）；确认 Key 没被禁用/撤销 |
| 机器人还是发文字 | 插件设置里 Key/音色填了没；再看网关日志里有没有 `[say] N 字 → M 秒` |
| `Breeze 返回 402/429` | 额度不足或撞频率限制 → 查 `/v1/balance` |
| 宿主报 `HTTP 524` | 语音条通道走了 Cloudflare 快速隧道（约 100 秒限制）→ 改本机 8898 专线，见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| `ModuleNotFoundError: No module named 'triton'` | 本地说话缺 triton-windows，见 [ENV.md](ENV.md) |
| 本地返回 500 `does not define a negative prompt but cfg_scale=4.0` | 参考克隆模式不支持 CFG，网关已自动压到 1；手调时别给 cfg>1 |
| 机器人唱不了歌 | 那是唱歌链路，看 [TUNING.md](TUNING.md) |

`/health` 里能看到当前引擎：`"say": "breeze"`。
