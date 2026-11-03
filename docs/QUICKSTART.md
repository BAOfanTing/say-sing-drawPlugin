# 三步跑起来（+ 可选的画图一步）

前提：源码已有、Python 环境装好（`conda activate say-sing`）、Breeze 权重放进 `say-model/weights/breeze-tts-2/`。

---

## ① 装依赖（一条命令）

```powershell
python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

> **唱歌必须要 torch**（RVC 换声），所以别为了省事跳过大件。只想跑唱歌+云端说话的话，可以从 `requirements.txt` 里删掉 `triton-windows` / `qwen-tts` / `transformers` 三行（见 [ENV.md](ENV.md)）。
> 国内下 torch 那个 2.67 GB 轮子慢，文件头有手动下载的做法。

---

## ② 一键启动（一条命令）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1
```

它自己会做完这些事：

| 步骤 | 说明 |
|---|---|
| 找 node / python | 找不到会直接告诉你 |
| 体检权重 | 跑 `say-model/check-ckpt.py`，缺文件会点名 |
| 生成配置 | `gateway/config.json` 不存在就从示例生成，**自动填随机令牌 + python 路径 + 权重路径** |
| 起网关 | 首次前台跑（Ctrl+C 停）；代码没报错就对了 |
| 起隧道 | 起 `cloudflared` 快速隧道，等它给出 https 地址 |
| 打印下一步 | 隧道地址、网关令牌、服务器上要跑的两条命令，直接复制 |

想常驻（关终端也不停）加 `-Detach`；暂时不要隧道加 `-NoTunnel`。

没装 cloudflared？脚本会给你这条命令：

```powershell
curl.exe -L -o tools\cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
```

---

## ③ 指过去 + 试

**一条命令**（在你电脑上跑，脚本会自己读隧道地址和令牌，再 ssh 到服务器改配置）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-host-url.ps1 -SshHost root@<你的服务器IP>
```

它做完三件事：把新隧道地址写进插件 `gatewayUrl`、写进宿主 `tts.baseUrl`、并跑一次真链路自检。

> 想手动改也行（服务器上）：
> ```bash
> bash /opt/qq-agent/set-gateway-url.sh https://<隧道地址> <网关令牌>
> bash /opt/qq-agent/set-tts-url.sh     https://<隧道地址>/v1
> ```

然后在控制台 → 插件 → 说话·唱歌·画图里确认「网关地址」「网关令牌」已填好。
走云端说话的话，再到「说话（Breeze 云端）」填 API Key 与音色 id。

群里试两句：

- `说句话` → 收到**语音条**（不是文字回退）
- `用语音唱一首夜曲` → 20-40 秒后收到整首

---

## ④ 画图（可选，加一条命令）

想让机器人自己画图（本机 Qwen-Image-2.1-Turbo，1024² / 8 步约 **25 秒/张**、峰值显存 7.24 GB）：

```powershell
# 1) 下权重（约 21 GB，逐文件直链见 draw-model/README.md 的「权重清单与下载地址」）
#    DiT 13.25 GB + 文本编码器 7.17 GB + VAE 0.63 GB，全放 draw-model\weights\

# 2) 起出图服务（7880，闲置 3 分钟自动卸载；常驻加 -IdleSeconds 0）
powershell -ExecutionPolicy Bypass -File draw-model\start-draw.ps1

# 3) 自检
curl.exe http://127.0.0.1:7880/health
# → {"ok":true,"loaded":false,...}   loaded=false 表示还没加载（第一张图时才加载）
```

控制台 → **图片生成**：

| 字段 | 填什么 |
|---|---|
| 允许机器人画图 | 打开 |
| 服务地址 | `https://<你的服务器IP>:8898/v1`（走网关，带 GPU 仲裁） |
| 模型 | `qwen-image-2.1-turbo`（本地服务不看这个字段） |
| API Key | 网关令牌 |

> 控制台跑在服务器上，`127.0.0.1:7880` 指的是服务器自己、够不到你电脑上的出图服务；
> 想直连自检就在你电脑上跑 `curl.exe http://127.0.0.1:7880/health`。

然后在群里说「画一张 蓝色长发的小鲸鱼娘在海边」，收到图就通了。

> 用 `scripts\start-all.ps1` 的话，只要 `draw-model\weights\turbo-dit\transformer\` 里有分片，
> **出图服务会自动一起拉起来**，不需要单独跑第 2 步（`-NoDraw` 可关）。

# 到此就完了。下面是备注

## 隧道地址变了怎么办

Cloudflare 快速隧道每次重启都会换地址。变了就跑一遍：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-host-url.ps1 -SshHost root@<IP>
```

它从 `logs\cloudflared.log` 里读最新地址并同步到服务器，不用手抄。

嫌麻烦就改用 **ssh -R 专线**（地址永不变、无 100 秒上限），见 [TUNNEL.md](TUNNEL.md)「备用专线」。
快速隧道能跑通单首歌（整首 3:54 端到端约 43 秒，含冷启动；换声常驻后约 22 秒），但**冷启动 + 排队 + 超长歌可能越过 100 秒上限**（→ 524）。要稳定就把语音条切到 8898 专线；插件的「网关地址」继续用隧道没问题（它只发短请求）。
> `sync-host-url.ps1` 默认就把这两件事分开：插件 → 隧道，语音条 → `https://<服务器IP>:8898/v1`。

## 想改配置

`gateway/config.json`（已在 `.gitignore`，不会进版本库）：

| 字段 | 作用 |
|---|---|
| `token` | 网关令牌，插件里要填同一个 |
| `say.engine` | **`auto`（默认：云端优先、失败落本地）** / `breeze`（只云端）/ `breeze-local`（只本地）/ `none` |
| `say.instructions` | 本地音色的文字描述，如「清亮通透的少女音，软糯但不嗲」 |
| `say.refAudio` + `refText` | 想克隆具体音色时填参考 wav 及其文稿（必须一字不差） |
| `say.breezeKey` / `voiceId` | 云端用；也可以在插件设置里填（插件会推到网关） |
| `say.registerMin` / `registerMax` / `registerRetries` | 本地音区守门：合成后测基频，不在 330-385 Hz 就换 seed 重生成（最多 2 次，仅对 ≤12 秒音频） |
| `say.localIdleMs` | 本地模型闲置多久退出，默认 `60000`（1 分钟）；`0` = 常驻不退 |
| `say.splitSentences` / `maxSegmentChars` | 长回复是否按句切开分别合成（**默认关**）：开会更快拉平音高，但一条消息里音色会变，不建议 |
| `say.pitchTarget` / `pitchMaxShift` | 音区微调：目标 Hz（**默认 `0` = 关**，常用 `355`）与最大改动半音数（**默认 3**）。只做小幅微调，超出就不动 —— 长文本那种 4-6 半音的偏差强行抬会明显走味，靠 `say.registerMin/Max` 换 seed 解决 |
| `voice.defaultVoice` | 唱歌音色，即 `sing-model/weights` 里 `.pth` 的文件名 |

改完重启：`schtasks /End /TN QQAgentSingGateway` → `schtasks /Run /TN QQAgentSingGateway`
（前台模式就直接 Ctrl+C 再跑一次）

## 自检

```powershell
curl http://127.0.0.1:8899/health
curl -H "authorization: Bearer <令牌>" http://127.0.0.1:8899/say/status
curl -X POST -H "authorization: Bearer <令牌>" -H "content-type: application/json" -d '{"input":"测试一句话"}' http://127.0.0.1:8899/v1/audio/speech -o t.mp3
curl -X POST -H "authorization: Bearer <令牌>" -H "content-type: application/json" -d '{"input":"唱：夜曲","maxSeconds":30}' http://127.0.0.1:8899/v1/audio/speech -o s.mp3
```

## 常见报错

| 报错 | 原因 |
|---|---|
| `No module named 'triton'` | 没装 `triton-windows==3.5.1.post24` |
| `torch.cuda.is_available() == False` | 装成 PyPI 的 CPU 版 torch，按 ① 重装 |
| `Template 'ref_clone_tata' does not define a negative prompt but cfg_scale=4.0` | 参考克隆不支持 CFG；网关已自动压到 1 |
| 宿主报 `HTTP 524` | 通道太慢（极少见），改用 ssh -R 专线 |
| 宿主报 `上传文件失败 ENOENT` | 容器内 `/app/data` 与 `/opt/qq-agent/data` 没打通，见 [INSTALL.md](INSTALL.md) |
| 插件说「说话后端离线」 | 网关没开 / 令牌不对 / Breeze Key 无效，先跑四条自检 |
