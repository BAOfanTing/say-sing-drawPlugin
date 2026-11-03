# 换声网关（跑在你自己电脑上）

零依赖 Node 服务：**搜歌 → 下载音源 → 换声 → 转码 → 出一个可下载的音频**。
插件只通过 HTTP 调它，所以网关在哪台机器上跑都行（只要有显卡够快）。

```bash
cp config.example.json config.json
node server.mjs                      # 默认 http://127.0.0.1:8899
curl -s http://127.0.0.1:8899/health # 自检
```

要求：Node.js ≥ 22.19。**ffmpeg 可选**（有就转 mp3 + 裁剪，没有就发原始格式 —— 不会假装转码成功）。

## 配置项（config.json）

| 键 | 说明 |
|---|---|
| `port` / `host` | 默认 `8899` / `127.0.0.1`。**不要改成 0.0.0.0**：对外暴露交给隧道 |
| `token` | 必须设。插件请求要带 `Authorization: Bearer <token>`；留空 = 任何能访问到端口的人都能点歌 |
| `source.type` | `netease`（网易云，中文曲库最全，默认）/ `local`（你自己的音频目录） |
| `source.neteaseCookie` | 网易云登录后的 Cookie（`MUSIC_U=…`）。**VIP 曲不填就取不到音频**：网关会先搜网易云，原唱拿不到就自动降级到同名的免费翻唱版，并在结果里注明；两者都拿不到才报错 |
| `source.localDir` | `local` 时必填，放 mp3/wav/flac/m4a/ogg/opus/aac |
| `source.limit` | 搜歌返回几条候选（1-20） |
| `voice.engine` | `none`（直出原音，只用来跑通链路）或 `command`（调你的换声脚本） |
| `voice.serveCommand` | 常驻换声命令（`python run.py --serve`），配了就不每个请求重载模型；留空 = 每次起进程 |
| `voice.serveIdleMs` | 常驻换声空闲多久退出（默认 600000 = 10 分钟） |
| `voice.command` | 命令行模板，见下一节 |
| `voice.timeoutMs` | 换声超时（默认 10 分钟） |
| `voice.pitch` | 变调半音（男声→女声 常填 +12，反之 -12；RVC 里叫 pitch） |
| `voice.outputExt` | 换声脚本产出的格式（`wav` / `mp3` / `flac` / `m4a`） |
| `voice.defaultVoice` | 音色名，插件设置留空时用它 |
| `say.engine` | `auto`（默认，云端优先 + 本地兜底）/ `breeze`（只云端）/ `breeze-local`（只本地）/ `none` |
| `say.instructions` | 本地音色的文字描述，如「清亮通透的少女音，软糯但不嗲」 |
| `say.refAudio` / `say.refText` | 参考克隆：3-10 秒干净人声 + 一字不差的文稿（留空 = 纯文字设计） |
| `say.cfgScale` | 指令遵循强度（参考克隆时会被压到 1，模板不支持 CFG） |
| `say.localPython` / `localModelDir` / `localAppDir` | 本地模型由网关自己起停时用 |
| `say.localIdleMs` | 本地模型闲置多久退出（默认 60000 = 1 分钟；0 = 常驻） |
| `say.splitSentences` / `maxSegmentChars` | 长文本按句切开分别合成再拼回（默认 **false**）：切句会把一次生成拆成多次，音色会变 |
| `say.pitchTarget` / `pitchMaxShift` | 音高归一：把每句基频拉到目标 Hz（0 = 关），最大改动半音数（默认 3；本地偶有飘 3+ 半音，建议 6） |
| `say.breezeKey` / `voiceId` | 云端 API Key 与音色 id（插件里填会推上来并落盘） |
| `draw.url` | 本地出图服务地址（默认 `http://127.0.0.1:7880`）；网关透传 `/v1/images/generations` 给它 |
| `draw.token` | 出图服务的 Bearer 令牌（留空 = 不校验；与网关令牌无关） |
| `draw.timeoutMs` | 出图超时（默认 600000 = 10 分钟；首次要加载 13 GB 权重） |
| `transcode` | `auto`（有 ffmpeg 就转 mp3 并裁到 maxSeconds）或 `never`（原样发） |
| `maxSeconds` | 成品最长秒数上限（5-600），插件传来的值会被它夹住 |
| `filesTtlHours` | 成品保留小时数（默认 24，到期自动删） |
| `dataDir` | 运行目录（`gateway-run/`：`files/` 成品、`tmp/` 中间文件） |

## 接你的换声模型（`voice.engine = "command"`）

网关不绑定任何具体模型 —— 它只负责"给你输入文件、等你写出输出文件"。

```json
"voice": {
  "engine": "command",
  "command": "python C:/rvc/infer_cli.py --input {input} --output {output} --model C:/rvc/models/me.pth --index C:/rvc/models/me.index --pitch {pitch}",
  "pitch": 0,
  "outputExt": "wav",
  "defaultVoice": "me",
  "timeoutMs": 900000
}
```

两种传参都支持，任选其一：

1. **占位符**：`{input}` `{output}` `{pitch}` `{voice}`（路径会自动加引号，含空格也安全）
2. **环境变量**：`SING_INPUT` / `SING_OUTPUT` / `SING_PITCH` / `SING_VOICE`

约定：命令退出码为 0 **且** `{output}` 存在非空才算成功，否则任务判 `failed` 并把 stderr 尾部
（最后 3 行、最多 400 字）回给模型 —— 显存不够、模型路径写错这类问题能直接看到原因。

### 常见后端怎么接

**RVC（Retrieval-based Voice Conversion）** —— 最容易出效果，需要 GPU：

```bash
# 方式 A：命令行推理（社区脚本参数各不相同，按你那份改）
python infer_cli.py -i {input} -o {output} -m me.pth -p {pitch}

# 方式 B：起 RVC WebUI 的 api.py，然后写个三行小脚本包一层（curl 上传 + 下载）
```

**so-vits-svc / GPT-SoVITS 的 SVC 分支** —— 同样是"输入音频 → 输出音频"，把命令换成它的推理脚本即可。

**要先做人声分离？** 在命令里串起来就行，网关不关心里面做了几步：

```
"command": "python uvr.py {input} {tmp} && python rvc.py {tmp} {output} --pitch {pitch}"
```

（`{tmp}` 不是内置占位符，这种多步流建议你自己写一个 `run.py`，在里面调 UVR + RVC，命令只写
`python run.py {input} {output}` —— 更好调试，也不受模板语法限制。）

### 时长 / 显存参考（RTX 3080 10G 实测口径）

| maxSeconds | 大约耗时（换声常驻） | 备注 |
|---|---|---|
| 30（试听一下效果） | 约 10 秒 | 只想快速看效果 |
| 45 | **12 秒** | 单段换声，模型不重载 |
| 90 | 约 15 秒 | 切 3 段 |
| 180 | 约 20 秒 | 切 6 段 |
| 整首 3:54 | **22 秒**（冷启动端到端约 43 秒；每次起进程约 85 秒） | 切成 8 段（每段 30 秒），模型只加载一次 |
| 说话（云端 Breeze） | 3-6 秒/句 | 非点歌文本走 `say` 引擎，云端不占显存 |
| 说话（本机 Breeze） | 11-16 秒/句；闲置后首句约 35 秒（要重新加载） | 8.2 GB 显存，闲置 1 分钟自动退出 |

CPU 也能跑，但通常是实时的 3-10 倍慢，只适合离线批量。

## 自己实现后端？

契约见 [../docs/PROTOCOL.md](../docs/PROTOCOL.md)（唱歌/说话/画图三条链路 + 管理面，一共十来组）。用 Python/Go 写都行，
只要形状对得上（`/health`、`/search`、`/sing`、`/jobs/:id`、`/files/:name`）。

## 测试

```bash
cd ..            # 仓库根目录
node --test      # 网关的队列 / 路由 / 失败路径都在里面，用假音源假换声跑，不联网不占显存
```
