<p align="center">
  <img src="assets/icon.png" width="120" height="120" alt="say-sing-drawPlugin">
</p>

<h1 align="center">say-sing-drawPlugin</h1>

<p align="center">
  <a href="https://github.com/BAOfanTing/say-sing-drawPlugin/actions/workflows/ci.yml"><img src="https://github.com/BAOfanTing/say-sing-drawPlugin/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/BAOfanTing/say-sing-drawPlugin/releases"><img src="https://github.com/BAOfanTing/say-sing-drawPlugin/releases/badge.svg" alt="release"></a>
  <img src="https://img.shields.io/badge/node-%E9%9B%B6%E4%BE%9D%E8%B5%96-brightgreen" alt="zero-dep">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
</p>

<p align="center"><em>说话 · 点歌换声 · 本地画图 —— 给 qq-agent-plus 的多媒体插件</em></p>

给 [qq-agent-plus](https://github.com/sakurawwwxh/qq-agent-plus) 的多媒体插件，一个仓库覆盖三条能力：

| 能力 | 状态 | 说明 |
|---|---|---|
| **说话**（TTS） | ✅ 已上线 | 机器人用 Breeze TTS 2 说话：云端优先（3-6 秒/句），本地兜底（8.2 GB 显存，闲置自退） |
| **唱歌**（换声） | ✅ 已上线 | 群里说「用语音唱一首 X」，用你自己训练的 RVC 音色翻唱，发 QQ 语音条 |
| **画图**（本地扩散模型） | 🚧 接入中 | 本地跑 Qwen 图像模型，宿主直接走 OpenAI 兼容的 `/images/generations` —— 方案与前置条件见 [docs/DRAW.md](docs/DRAW.md) |

> 插件 id 仍叫 `sing`（历史原因）：改 id 等于变成新插件，已装用户的设置、凭据、
> 成品目录都会丢，所以仓库名扩了、id 不动。

> ⚠️ **前提**：换声模型（RVC）和网关都跑在**你自己的电脑**上（本仓库的 `gateway/` 与 `sing-model/`）。
> 服务器只做转发、不装模型；电脑没开时机器人只会提示「后端离线」。

![image-20261030100547632](https://gitee.com/baofanting/image/raw/master/image/20261030100547692.png)

![image-20261030100609669](https://gitee.com/baofanting/image/raw/master/image/20261030100609713.png)

## 听一下

| 效果 | 怎么来的 | 试听 |
|---|---|---|
| **说话 · 本地** | 本地 Breeze TTS 2，音色由一句文字描述生成（`清亮通透的少女音，软糯但不嗲`） | [▶ 2-say-local.mp3](assets/samples/2-say-local.mp3) |
| **说话 · 云端** | 云端 Breeze，预置音色「大肥鱼（迷糊版）」 | [▶ 1-say-cloud.mp3](assets/samples/1-say-cloud.mp3) |

## 它怎么工作

宿主只给插件 `send.text` / `send.file`，**插件自己没有发语音条的能力** —— 语音条只能借宿主的
TTS 通道（`send_voice` → `POST {tts.baseUrl}/v1/audio/speech`）。既然那条通道指向本网关，
机器人平时的语音回复也一并由网关负责，所以这里有**两条路**：

```
QQ 群 ──► 宿主(服务器) ──► 插件 sing ──────────────┐
                                                   ▼
                          你的电脑：网关 :8899 ─┬─► 点歌意图 → 搜歌 → 人声分离 → RVC 换声 → 混音
                                                │        （全程本地，音频不上传）
                                                └─► 普通文本 → 说话：Breeze 云端 / 本机 Breeze
                                                         （本地模型按需加载，闲置 1 分钟退出）
                                                   │
        宿主 send_voice ◄── /v1/audio/speech ◄─────┘
```

| 通道 | 触发方式 | 产出 | 走哪条路 |
|---|---|---|---|
| **唱歌 · 语音条**（默认） | 「用语音唱一首 X」 | QQ 语音气泡 | 本机 RVC 换声；默认唱**整首**（实测 4:21 完整歌能收播），整首 3:54 常驻换声约 22 秒（冷启动端到端约 43 秒） |
| **唱歌 · 群文件** | 「点歌唱一首 X」 | mp3 文件 | 同上，但要先在插件设置里打开「允许发群文件」；工具超时 300 秒 |
| **说话** | 机器人自己想说话（任何非点歌内容） | QQ 语音气泡 | Breeze TTS 2：云端 3-6 秒/句，或本机 11-16 秒/句（8.2 GB 显存，闲置自退） |
| **画图** | 🚧 接入中 | QQ 图片 | 本机扩散模型 → 网关暴露 OpenAI 兼容 `/images/generations` → 宿主控制台「图片生成」直连；不占插件通道（插件只能发群文件，私聊发图走宿主） |

判定规则很简单：**文本里能认出点歌意图（`唱：歌名` / `点歌唱…` / 句中触发）就走换声，其余当说话。**
说话失败会退回文字，不影响唱这条主链路。

## 快速开始

```powershell
# ① 装依赖（说话+唱歌一份清单）
python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

# ② 一条命令起网关 + 隧道（自动体检权重、生成配置、打印隧道地址和令牌）
powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1

# ③ 把隧道地址同步到服务器（插件 + 语音条通道一次改完）
powershell -ExecutionPolicy Bypass -File scripts\sync-host-url.ps1 -SshHost root@<你的服务器IP>
```

细节、自检、常见报错见 **[docs/QUICKSTART.md](docs/QUICKSTART.md)**（三步）。


五步，详细命令在 **[docs/INSTALL.md](docs/INSTALL.md)**：

1. **电脑端**：Python 3.11 环境 + RVC 资产（hubert/rmvpe/分离模型）+ 你的 `.pth` 音色 — [1](docs/INSTALL.md)
2. **电脑端**：`gateway/config.json` 填令牌、音色、换声命令 — [2](docs/INSTALL.md)
3. **电脑端**：起网关 `start-gateway.bat`，起隧道 `start-tunnel.bat` — [3](docs/INSTALL.md)
4. **服务器端**：`plugin/sing` 放进 `data/plugins/`，控制台启用并填网关地址 + 令牌 — [4](docs/INSTALL.md)
5. **语音条通道**：宿主 TTS 指向 `<网关地址>/v1` — [5](docs/INSTALL.md)

跑通后群里直接用：

```
用语音唱一首夜曲      # 语音条（默认只走这条）
点歌唱一首夜曲        # 群文件（要先打开「允许发群文件」）
网易云怎么登录        # 想唱 VIP 曲原唱：控制台插件页点「扫码登录」扫一下
```

## 实测数据

RTX 3080 10G / Windows / v1.0.5：

| 环节 | 耗时 |
|---|---|
| 网易云搜歌 | < 1 秒 |
| 人声分离（BS-Roformer 368） | 30 秒歌约 3-6 秒（RTF 0.10） |
| RVC 换声（hanser，30 秒片段） | 约 4 秒（另加 6-8 秒模型加载） |
| **端到端（点歌 → 群里收到）** | **12 秒**（45 秒成品）/ **22 秒**（整首 3:54，常驻换声；冷启动约 43 秒） |
| QQ 语音条时长实测 | **4:21（261 秒）的整首能正常收播**；网关侧上限 600 秒，更长的还没试到上限 |
| **说话（云端 Breeze）** | 3-6 秒/句（不占显存） |
| **说话（本地 Breeze）** | 11-16 秒/句（5 秒音频，RTF≈3）；闲置 1 分钟后自动退出，之后再说话要 35 秒重新加载 |
| GPU 显存峰值 | 唱歌常驻约 2.4 GB、整首端到端约 9 GB；本地说话 8.2 GB（闲置即退，不和唱歌抢） |

首次点歌会慢十几秒（要加载换声模型）；之后常驻，重复点歌直接复用。

## 插件设置

控制台 → 插件 → 点歌唱歌：

| 设置 | 默认 | 说明 |
|---|---|---|
| 网关地址 `gatewayUrl` | — | 网关的公网 https 地址 |
| 备用网关地址 `gatewayUrlFallback` | 空 | 主地址连不上时自动切换（记住 2 分钟） |
| 网关令牌 `apiToken` | — | 与网关 `config.json` 的 `token` 一致（加密保存） |
| 默认音色 `defaultVoice` | 空 | 网关配置里的音色名；空=用网关默认 |
| 允许发群文件 `allowFileOutput` | **关** | 关着只用语音条；开启后模型才可能用群文件发 mp3 |
| 语音条唱多久 `voiceSeconds` | **0 = 整首** | 也可填 5-600 秒；改完自动推给网关，重启也保留 |
| 群文件唱多久 `maxSeconds` | 60 | 秒（上限 600）；仅「允许发群文件」打开时生效 |

网关侧配置（`gateway/config.json`）见 [docs/INSTALL.md](docs/INSTALL.md) 与 [docs/TUNING.md](docs/TUNING.md)。

## 说话（TTS）

宿主的 `send_voice` 指向本网关后，机器人"说话"也会打到这里：非点歌文本交给 `say` 引擎读出来。

两种跑法，改一行配置就能切：

默认 `say.engine = "auto"`：**云端优先**（快、音色绝对稳定），云端不可用时自动回落本机（免费、离线）。

| | 云端（auto 的首选） | 本地（auto 的兜底） |
|---|---|---|
| 一句耗时 | **3-6 秒** | 10-15 秒（eager） |
| 显存 | 0 | 8.2 GB，**说话时才加载、闲置 1 分钟自动退出** |
| 音色 | 50 个预置，插件里选 | 参考音频克隆，或一句文字描述设计 |
| 成本 | 按字符扣额度 | 免费 |

云端：API Key 与音色在**插件设置**里填（「说话（Breeze 云端）」分组），插件页会显示后端在线与余额。
填上 Breeze 账号邮箱密码（「云端额度」分组）后，插件会**每小时自动领一次每日 400 额度**，不用再去控制台点。
本地：权重 7.2 GB 放 `say-model/weights/breeze-tts-2/`，环境见 **[docs/ENV.md](docs/ENV.md)**。

**情绪**：模型在台词前写 `【生气】`/`【撒娇】`/`【温柔】`…，网关就按预设换语气（标记不会念出来），
音色仍是同一个 voice_id —— 实测音色相似度 0.986-0.990，语速差 1.6 字/秒、响度差 5 dB。
原理、三条铁律（别写性别/必须 speaker boost/别传 guidance）与自建预设见 **[docs/SPEAK.md](docs/SPEAK.md#情绪按情境换语气2026-11-02-上线)**。

音色列表、计费、本地部署、排错全部见 **[docs/SPEAK.md](docs/SPEAK.md)**。

## 已知限制

1. **一次只跑一个换声任务**：RVC 吃显存，网关串行排队（故意的）。
2. **首次点歌慢**：要加载换声模型（10 秒上下）；之后常驻复用，重复点歌直接开跑。
3. **本地说话和唱歌抢显存**：10 GB 卡上不能同时驻留 8.2 GB + 2.4 GB，网关会自动让位（唱歌前停本地 TTS，说话前再拉回）。云端说话（`say.engine = "breeze"`）没这个问题。
4. **本地说话闲置会退出**：默认 1 分钟后释放显存，之后再说话要重新加载（约 35 秒/句）；`say.localIdleMs = 0` 可改为常驻。
5. **VIP 曲需要登录**：没登录态取不到原唱时会先找同曲可播版本，都不行就明确提示扫码登录。
6. **版权自负**：`.pth` 音色权重、翻唱成品、Breeze 云端额度的使用范围请自行确认（Breeze 免费版**禁止商用**）。
7. **长歌会分段换声**：超过「段长+5 秒」自动切成 **30 秒**一段，整个批次只加载一次模型（`infer.cli` 的目录批处理），失败只补跑缺的那几段，最后拼回整条。整首 3:54 约 22 秒（常驻；冷启动端到端约 43 秒）。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | **三步跑起来**：装依赖 → 一键脚本（体检+配置+网关+隧道）→ 填地址验收 |
| [docs/INSTALL.md](docs/INSTALL.md) | 完整安装：RVC 资产、网关配置、隧道、服务器、容器桥接、网易云登录 |
| [docs/TUNNEL.md](docs/TUNNEL.md) | 把本机网关暴露成 https：Cloudflare 快速隧道（推荐）/ ssh -R 专线（可选） |
| [docs/SPEAK.md](docs/SPEAK.md) | 说话：云端 Breeze / 本地权重、音色描述与参考克隆、音高归一、插件配置、排错 |
| [docs/ENV.md](docs/ENV.md) | 运行环境：一套 conda 环境同时跑说话+唱歌（torch cu128 / triton / RVC 依赖） |
| [docs/TUNING.md](docs/TUNING.md) | 唱歌时长四道闸、常驻换声、显存、历史踩坑、验收清单 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 运行期报错：说话没声音、宿主 524、文件 ENOENT、只有原声没换声、超时 |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | 插件 ↔ 网关 HTTP 契约（想用别的语言重写后端看这个） |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 本地跑测试、代码结构 |
| [CHANGELOG.md](CHANGELOG.md) | 每个版本做了什么（Release 正文就从这里抽） |
| [docs/DRAW.md](docs/DRAW.md) | 本地画图：方案、显存账、接入步骤（接入中） |

## License

MIT。模型、音源、音色的许可与版权请自行确认。
