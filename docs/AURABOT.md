# 接 aurabot（DSH 插件 dsh-aurabot-qq）

这个网关本来只服务 qq-agent-plus。要给 [dsh-aurabot-qq](https://github.com/aureth-labs/dsh-aurabot-qq) 用，
**不用改网关代码**——三条能力都已经是 OpenAI / HTTP 形状，aurabot 那边填几个配置就能接：

```
说话  aurabot voice.engine = openai   →  POST http://127.0.0.1:8899/v1/audio/speech
翻唱  aurabot song.gatewayUrl         →  POST http://127.0.0.1:8899/sing  +  GET /jobs/<id>
画图  aurabot imageGen.provider=openai →  POST http://127.0.0.1:8899/v1/images/generations
```

前提：网关在跑（`node gateway/server.mjs`，默认只监听 127.0.0.1:8899），
`config.json` 里的 `token` 就是下面配置里的 `apiKey` / `gatewayToken`。

## 1. 说话（TTS）

aurabot `~/.dsh/plugins-data/aurabot/config.json` 里加：

```json
{
  "voice": {
    "enabled": true,
    "engine": "openai",
    "openai": {
      "baseUrl": "http://127.0.0.1:8899/v1",
      "apiKey": "<网关 token>",
      "model": "breeze-tts-2",
      "voice": "hanser",
      "format": "mp3",
      "speed": 1,
      "timeoutMs": 120000,
      "sampleRate": 24000
    },
    "autoChance": 0.2,
    "autoMaxChars": 80
  }
}
```

- 网关按 `say.engine` 自己决定云端 Breeze 还是本机模型，aurabot 只发文字、收音频。
- `voice` 字段网关不强制（说话用不到音色名），填着方便面板显示。
- 想拿"能给哪些 model / 音色"，问网关：`GET /v1/models`（要 Bearer 令牌，见下）。
- 网关挂了不会整轮哑掉：aurabot 会先降级到 edge-tts，再退到 Windows 语音。

## 2. 翻唱（RVC 换声）

```json
{
  "song": {
    "enabled": true,
    "gatewayUrl": "http://127.0.0.1:8899",
    "gatewayToken": "<网关 token>",
    "gatewayTimeoutMs": 900000,
    "maxVoiceSec": 120
  }
}
```

- 填了 `gatewayUrl` 就走网关：它自己搜歌 → 分离 → 换声 → 混音，aurabot 只等成品下回来发语音条，
  **本机不需要装 RVC 环境**（面板「翻唱」页会显示"点歌走远端网关"）。
- 流程：`POST /sing {song, voice, maxSeconds}` → `202 {jobId}` → 轮询 `GET /jobs/<jobId>` 到 `state=done` →
  下载 `audioUrl`（`/files/xxx.mp3`）→ 当语音条发出。
- 失败（没人声 / 超时 / 401）会回一句"唱不了…"，不会静默。

## 3. 画图

```json
{
  "imageGen": {
    "enabled": true,
    "provider": "openai",
    "baseUrl": "http://127.0.0.1:8899/v1",
    "apiKey": "<网关 token>",
    "model": "qwen-image",
    "size": "1024x1024"
  }
}
```

网关把 `/v1/images/generations` 原样转给本机出图服务（默认 127.0.0.1:7880），
返回 OpenAI 形状的 `{ created, data: [{ b64_json }] }`，aurabot 直接能用。

## 4. 自检

```powershell
# 令牌在 gateway/config.json 的 token 字段
powershell -ExecutionPolicy Bypass -File scripts\check-aurabot.ps1
```

脚本会依次验：`/health` → `/v1/models` → 念一句（`/v1/audio/speech`）→ 出一张 64 字以内的图（可选，`-SkipDraw`），
最后把可以直接粘进 aurabot 配置的 JSON 打出来。

## 常见问题

| 现象 | 原因 |
|---|---|
| aurabot 日志 `HTTP 401` | `apiKey` / `gatewayToken` 和网关 `config.json` 的 `token` 不一致 |
| `没填 OpenAI 兼容 TTS 地址` | `voice.engine` 设成了 `openai` 但 `voice.openai.baseUrl` 空着 |
| 说话 500 / `画图后端不可用` | 网关在，但本机模型没起（看 `/health` 的 `models` 字段） |
| 翻唱一直 running | 本机显卡被占（三个租户共用槽位），等前一个任务做完 |

## 相关提交

- 网关侧：`my-branch`/`dsh-aurabot-qq` 分支新增 `GET /v1/models`（宿主面板拿 model 名与音色清单）+ 契约测试
  `test/aurabot-contract.test.mjs`。
