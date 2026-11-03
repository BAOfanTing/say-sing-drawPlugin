# 安装与部署

完整安装步骤。只想先跑起来，看 [README](../README.md) 的「快速开始」即可。

> 只想照着做一遍？看 **[QUICKSTART.md](QUICKSTART.md)**（三步，含一键启动脚本）。环境与版本组合见 **[ENV.md](ENV.md)**。

## 关掉之后怎么重新起（手动启动速查）

**先试这一条**（自动做完体检 + 配置 + 网关 + 隧道）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1 -Detach
```

下面是手动版，四部分按顺序起。**任何一步没起，群里点歌都会失败**（会明确报"后端离线"或"网关连不上"）。

### ① 电脑端：起网关

```powershell
cd <仓库路径>
node gateway\server.mjs                       # 前台，能看每条 [req] 日志（推荐排错时用）
# 或双击 start-gateway.bat
# 或常驻：powershell -ExecutionPolicy Bypass -File scripts\run-gateway-forever.ps1
```

自检：

```powershell
curl http://127.0.0.1:8899/health
# 期望 ok:true、voiceConfigured:true、voices:[...]、voiceSeconds 符合预期
```

### ② 电脑端：把网关暴露成 https（二选一）

```powershell
# A. Cloudflare 快速隧道（域名每次变）
$env:CLOUDFLARED = "<仓库路径>\tools\cloudflared.exe"
start-tunnel.bat
# 输出里找 https://xxx-xxx-xxx.trycloudflare.com
```

```powershell
# B. 专线（地址永不变，需要服务器上 nginx 8898 站点已启用）
ssh -i "$env:USERPROFILE\.ssh\dsh_ed25519_stats" -N -o ExitOnForwardFailure=yes `
    -o ServerAliveInterval=30 -R 127.0.0.1:8899:127.0.0.1:8899 root@<服务器IP>
# 常驻版：powershell -ExecutionPolicy Bypass -File scripts\run-tunnel-local.ps1 -SshHost root@<服务器IP>
```

> 专线要在服务器上先启用站点：
> `mv /etc/nginx/conf.d/sing-gateway.conf.disabled /etc/nginx/conf.d/sing-gateway.conf && nginx -t && systemctl reload nginx`

### ③ 服务器端：把地址填给插件和宿主

```bash
bash /opt/qq-agent/set-gateway-url.sh https://<第 2 步的地址> <网关令牌>
bash /opt/qq-agent/set-tts-url.sh     https://<第 2 步的地址>/v1
```

脚本会自己回读并打 `/health` 自检。**注意两条通道能用的地址不一样**：

| 谁 | 用什么地址 | 原因 |
|---|---|---|
| 插件 | 必须是**公网**（Cloudflare 隧道） | 宿主 `cap.http` 禁用内网地址 |
| 宿主语音条 | `https://127.0.0.1:8898/v1`（专线）也可以用 | 服务器访问自己的公网 IP:8898 常被安全组挡 |

### ④ 验证

```bash
bash /opt/qq-agent/check-lines.sh      # 隧道口 / 8898 / 宿主 TTS 真链路
```

再在控制台 → 设置 → 语音回复 → 「试听」输入 `唱：歌名`，能听到声音就全通了。

---

| 章节 | 内容 |
|---|---|
| 0 | 目录结构 |
| 1（1.1-1.10） | **部署主体**：Python 环境 → RVC 资产 → 音色权重 → 网关配置 → 启动 → 暴露 https → 装插件 → 填设置 → 语音条通道 → 画图（可选） |
| 2 | 网易云扫码登录（VIP 曲原唱） |
| 3 | 服务器侧 IPv6 加固（一次性） |
| 4 | 发帖/写文档时的截图清单 |
| 5 | 开机自启用计划任务（Windows） |

> 最上面「关掉之后怎么重新起」是速查（起网关 → 暴露 https → 填地址 → 验证），和下面 1.x 是同一套东西的精简版。

---

## 0. 目录结构

```
plugin/sing/          qq-agent 插件本体（零依赖，可打包上架）
  plugin.json         manifest（apiVersion 2；能力 tools/schedule/log/config/secrets/http/media/send）
  index.mjs           协议接线 + 七个工具 + 每小时一次的零点清理/领额度触发
  lib.mjs             纯函数（地址校验、设置收敛、文件名白名单、任务状态机）
  vendor/qrcode.cjs   自带的 QR 库（控制台「扫码登录」用；.cjs 是因为仓库是 type=module）
gateway/              跑在你电脑上的网关（零依赖 Node）：唱歌 + 说话 + 画图透传
  server.mjs          入口；含每天 00:00 的成品清理排程
  lib/config.mjs      配置读写与校验
  lib/sources.mjs     音源：网易云 / 本地目录（含搜索排序打分）
  lib/voice.mjs       换声：none（直出）/ command（调你的 RVC 命令行）
  lib/app.mjs         路由 + 流水线（/health /search /sing /jobs /files /v1/audio/speech
                      /say/status /say/voices /say/config /admin/voice-seconds /admin/prune
                      /v1/images/generations /login*）
  lib/jobs.mjs        串行任务队列（带进度与 TTL）
  lib/emotions.mjs    说话情绪预设（标记 → 表演指令 + ffmpeg 滤镜）
  web/login.html      网易云扫码登录页（二维码在本地渲染，key 不出本机）
  web/qrcode.js       内置 QR 生成库（MIT，离线可用，不依赖任何 CDN）
sing-model/           唱歌：RVC 换声（weights 不入库）
  run.py              换声编排：裁剪 → 分离 → 换声 → 混伴奏（网关调的就是它）
  fetch-*.ps1         拉模型的脚本（分块/续传，国内镜像会断流）
  rvc/                新版 RVC 源码（入库）；rvc/assets/ 下的权重不入库，只保留空目录（.gitkeep）
say-model/            说话：Breeze TTS 2 本地推理（可选；weights/ 不入库）
  check-ckpt.py       权重体检（start-all.ps1 会调）
  start-local.ps1     手动起本地说话服务（调试用；平时由网关按需拉起）
draw-model/           画图：Qwen-Image-2.1-Turbo 本地出图（可选；weights/ 不入库）
  server.py           OpenAI 兼容 /v1/images/generations（懒加载 + 闲置 180 秒卸载）
  start-draw.ps1      一键启动（检查权重、强制 HF 离线）
scripts/
  start-all.ps1       一键：体检 + 生成配置 + 网关 + 隧道（有权重时连画图一起）
  sync-host-url.ps1   把地址同步到服务器（插件 → 隧道、语音条 → 8898 专线）
  run-gateway-forever.ps1 / run-tunnel-local.ps1  常驻脚本（计划任务用）
  watchdog.ps1        看门狗：8899 / 隧道 / 7880 不通就重启对应任务
start-gateway.bat / start-tunnel.bat  Windows 一键启动
docs/                 QUICKSTART / INSTALL / ENV / SPEAK / DRAW / TUNING / TUNNEL /
                      TROUBLESHOOTING / PROTOCOL / DEVELOPMENT
test/                 55 个用例（5 个文件，含"子进程跑插件、测试扮演宿主"的真协议测试）
```

---

## 1. 部署总览与电脑端

### 总览：四件事

1. 电脑上装 RVC 环境 + 网关 → 本机 `127.0.0.1:8899` 能点歌；
2. 把网关暴露成 **https**（宿主强制禁内网，`127.0.0.1` 填不进去）；
3. 服务器上装插件、填设置；
4. （可选）装本地出图后端 `draw-model/`，让机器人能画图。

### 1.1 电脑端：Python 环境（RVC）

环境（torch / triton / RVC 依赖）不在这里重复——照 **[ENV.md](ENV.md)** 装即可，
一条命令搞定，且说话与唱歌共用同一套环境。

要点只有两条：

```powershell
# torch 必须走 cu128 索引（PyPI 上是 CPU 版）
python -m pip install torch==2.9.1 torchaudio==2.9.1 --index-url https://download.pytorch.org/whl/cu128
# 其余依赖（含 triton 与 RVC 侧）
python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

ffmpeg 用 `imageio-ffmpeg` 自带的二进制即可（`say-model/bin/ffmpeg.exe` 就是它，网关会自动找）：

```powershell
python -m pip install imageio-ffmpeg
python -c "import imageio_ffmpeg,shutil,os;os.makedirs('sing-model/bin',exist_ok=True);shutil.copyfile(imageio_ffmpeg.get_ffmpeg_exe(),'sing-model/bin/ffmpeg.exe')"
```

### 1.2 电脑端：RVC 资产

放这些文件（路径写死在 RVC 里，别改结构）：

```
sing-model/rvc/assets/
├── hubert_base/            config.json / preprocessor_config.json / pytorch_model.bin
├── rmvpe/rmvpe.pt
├── pymss_weights/          人声分离模型（model_bs_roformer_ep_368_sdr_12.9628.ckpt）
├── weights/                你的音色 .pth（可分子目录）
└── indices/                对应的 .index
```

```bash
# hubert_base 与 rmvpe 来自 lj1995/VoiceConversionWebUI（国内可用 hf-mirror）
# 分离模型用 pymss 的下载器（走 ModelScope，很快）
conda run -n say-sing python -m pymss.cli download model_bs_roformer_ep_368_sdr_12.9628.ckpt \
  --model-dir rvc/assets/pymss_weights --source modelscope
# 下载后可能在 vocal/vocal_extraction/ 子目录里，把 .ckpt 和 .yaml 复制到 pymss_weights/ 根目录
```

大文件下不动时（国内镜像会断流），用仓库里的 `fetch-chunks.ps1`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File sing-model/fetch-chunks.ps1 `
  -Url "https://mirrors.nju.edu.cn/pytorch/whl/cu128/torch-2.9.1%2Bcu128-cp311-cp311-win_amd64.whl" `
  -Out "sing-model/downloads/torch-2.9.1+cu128-cp311-cp311-win_amd64.whl"
# 文件名里的 cp311 是 Python 版本：环境是 3.11 用 cp311，是 3.12 就换成 cp312
# （版本以 requirements.txt 为准：torch==2.9.1+cu128）
# 下完核对官方 sha256（PyTorch 索引页里有），不一致就重下
```

### 1.3 电脑端：放音色权重

```
sing-model/rvc/assets/weights/<音色名>.pth        ← 例如 hanser.pth、zhoushuyi/zhoujie.pth
sing-model/rvc/assets/indices/<音色名>.index      ← 有就放，相似度会明显提升
```

`run.py` 支持三种指法：文件名（`hanser`）、相对路径（`布洛尼亚/hanser`）、包含匹配（`hans`）。

```bash
# 单测一句，确认权重能被加载
conda run -n say-sing python sing-model/run.py --input 任意音频.mp3 --output out.wav --voice hanser --max-seconds 20
```

> ⚠️ 权重是**第三方角色模型**，用于他人都涉及肖像与授权问题；自己本地玩没问题，别把 `.pth` 提交到仓库（`.gitignore` 已排除）。

### 1.4 电脑端：网关配置

```bash
cd gateway
cp config.example.json config.json
# 把 token 改成一串随机字符（openssl rand -hex 24 / 网页随机串都行）
```

| 键 | 说明 |
|---|---|
| `token` | **必设**。插件与宿主都带 `Authorization: Bearer <token>` |
| `source.type` | `netease`（默认，中文曲库全）/ `local`（你自己的音频目录） |
| `source.neteaseCookie` | 网易云登录后的 `MUSIC_U=…`。**VIP 曲不填拿不到原唱**；不填会自动降级到同名免费翻唱版 |
| `source.localDir` | `local` 时必填 |
| `voice.engine` | `command`（真换声，用你的 RVC）/ `none`（直出原音，只用来验证链路） |
| `voice.command` | 换声命令，占位符 `{input}` `{output}` `{voice}` `{pitch}` `{maxSeconds}`；另有环境变量 `SING_INPUT` 等 |
| `voice.outputExt` | 换声产物格式（默认 `wav`） |
| `voice.defaultVoice` | 默认音色名（例如 `hanser`） |
| `outputArtist` | 群里显示的「演唱者」名字，默认 **小鲸鱼**（原唱信息只留在"原唱受限"说明里） |
| `transcode` | `auto`（有 ffmpeg 就转 mp3 并裁剪）/ `never` |
| `maxSeconds` | 单次换声任务上限（默认 **600** 秒，上限也被夹在 600）；语音条也受它管 |
| `voiceMessageMaxSeconds` | 语音条通道硬上限，默认 **600** 秒（插件推上来的值会被它夹紧） |
| `voiceMessageDefaultSeconds` | 语音条默认时长，默认 90 秒（插件没推值时用它；0 = 整首由插件设置决定） |
| `voice.segmentSeconds` | 长音频切段长度，默认 **30** 秒（整批只加载一次模型；设 0 = 不分段） |
| `voice.serveCommand` | 常驻换声命令（`"<rvc的python>" "<仓库>/sing-model/run.py" --serve`）；留空 = 每次起进程 |
| `voice.serveIdleMs` | 常驻进程空闲多久自动退出，默认 600000（10 分钟） |
| `voice.gpuFraction` | 常驻进程的显存上限比例，默认 0.9 |
| `say.engine` | `auto`（默认，云端优先 + 本地兜底）/ `breeze`（只云端）/ `breeze-local`（只本地权重）/ `none`（关掉，只说文字） |
| `say.breezeKey` / `say.voiceId` | Breeze API Key 与音色 id；**在插件设置里填更省事**（插件会推到网关） |
| `say.pitchTarget` / `say.pitchMaxShift` | 本地音区小幅归一（目标 Hz / 最多改几个半音）。**默认 `0`（关）/ `3`**；常用目标值 `355` |
| `say.registerMin` / `registerMax` / `registerRetries` | 本地音区守门：合成后测基频，不在 330-385 Hz 就换 seed 重生成（默认 2 次） |
| `filesTtlHours` | 成品保留小时数（默认 24） |
| `filesPruneMinAgeHours` | 清理只删**超过这么多小时**的成品（默认 8）。按文件年龄而不是自然日零点，避免 23:59 的歌 00:01 就没了 |

本机这套的实际配置（供对照）：

```json
{
  "port": 8899, "host": "127.0.0.1", "token": "<随机串>",
  "source": { "type": "netease", "localDir": "", "neteaseCookie": "", "limit": 5 },
  "voice": {
    "engine": "command",
    "command": "\"<conda路径>/envs/say-sing/python.exe\" \"<仓库路径>/sing-model/run.py\" --input {input} --output {output} --voice {voice} --pitch {pitch} --max-seconds {maxSeconds}",
    "timeoutMs": 900000, "pitch": 0, "outputExt": "wav", "defaultVoice": "hanser"
  },
  "transcode": "auto", "maxSeconds": 300, "voiceMessageMaxSeconds": 300, "voiceMessageDefaultSeconds": 180,
  "filesTtlHours": 24, "outputArtist": "小鲸鱼", "dataDir": "gateway-run"
}
```

### 1.5 电脑端：启动

```powershell
# 方式一：双击
start-gateway.bat

# 方式二：命令行（建议把 ffmpeg 与 conda 的 Scripts 放进 PATH）
node gateway/server.mjs
```

启动日志会打印音源、换声引擎、鉴权状态和**下次零点清理时间**。自检：

```bash
curl -s http://127.0.0.1:8899/health
# {"ok":true,"engine":"command","voiceConfigured":true,"voices":["hanser"],...}
```

### 1.6 暴露成 https（必须）

宿主给插件的联网能力写死 `allowPrivate:false`，`127.0.0.1`、`192.168.x.x` 一律拒绝。最省事：

```powershell
start-tunnel.bat
# 或手动：
cloudflared tunnel --url http://127.0.0.1:8899 --no-autoupdate
# 输出里形如 https://xxxx-yyyy.trycloudflare.com ← 这就是"网关地址"
```

**快速隧道的域名每次重启都变**，变了要去插件设置里改一次。要固定就用 named tunnel / frp，
见 [docs/TUNNEL.md](TUNNEL.md)。

### 1.7 服务器端：装插件

```bash
# 打包（ustar，宿主安装器认这个格式）
tar --format=ustar -czf /tmp/sing-0.1.0.tar.gz -C plugin sing

# 拷到服务器后解压到数据目录（插件目录独立于宿主源码，升级宿主不会被覆盖）
ssh <user>@<host>
sudo su -          # 插件目录属主是 qqagent
cd /opt/qq-agent/data && mkdir -p plugins
tar xzf /tmp/sing-0.1.0.tar.gz -C plugins
chown -R qqagent:qqagent plugins/sing
```

然后在控制台「插件」页刷新/重载，就能看到「说话·唱歌·画图」。

### 1.8 服务器端：填设置

控制台 → 插件 → 说话·唱歌·画图 → 设置：

| 字段 | 填什么 |
|---|---|
| 网关地址 | 隧道给的 `https://…`（不要带结尾斜杠） |
| 网关令牌 | 与 `gateway/config.json` 的 `token` 一致 |
| 默认音色 | 例如 `hanser` |
| 语音条唱多久 `voiceSeconds` | 0 = 整首；也可填 5-600 秒 |
| 任务轮询间隔 / 允许 http 网关 | 保持默认即可（后者仅调试用） |

也可以用控制台 API 批量写（脚本里就是这么做的）：

```bash
curl -X POST http://127.0.0.1:3210/api/plugins/settings \
  -H "x-console-token: $TOKEN" -H 'Host: 127.0.0.1:3210' -H 'content-type: application/json' \
  -d '{"id":"sing","values":{"gatewayUrl":"https://xxx.trycloudflare.com","apiToken":"<网关令牌>","defaultVoice":"hanser","maxSeconds":45}}'
```

最后在插件页**启用**它（`plugins.enabledIds` 里要有 `sing`）。

### 1.9 语音条通道：把宿主 TTS 指向网关

> ⚠️ **语音条通道建议走 8898 专线**（`https://<服务器IP>:8898/v1`，配法见 [TUNNEL.md](TUNNEL.md)
> 的「备用专线」一节）。原因：宿主是**同步等音频**（几秒到一分半），而快速隧道约 100 秒回 `524` ——
> 单首歌通常 43 秒跑得完，但冷启动 + 排队 + 超长歌就可能越线。
> 插件的「网关地址」继续用快速隧道没问题（它只发短请求）。

控制台 → 设置 → **语音回复 (TTS)**：

| 字段 | 填什么 |
|---|---|
| 允许机器人发语音 | **打开** |
| 服务预设 | 自定义 / 自建（OpenAI 兼容 `/audio/speech`） |
| 服务地址 | **推荐** `https://<服务器IP>:8898/v1`（专线）；也可以填 `https://<隧道域名>/v1`（短语音够用，长歌可能 524） |
| 模型 | 任意（网关不校验），建议填音色名 |
| 音色 (voice) | 音色名，例如 `hanser` |
| API Key | 网关令牌 |
| 语速 / 增益 | 1 / 0 |

再加一条配置（界面没有，直接写 config）：**超时调到 600000（10 分钟）**，否则整首歌会在宿主侧先超时。

```bash
curl -X POST http://127.0.0.1:3210/api/config \
  -H "x-console-token: $TOKEN" -H 'Host: 127.0.0.1:3210' -H 'content-type: application/json' \
  -d '{"tts":{"timeoutMs":600000}}'
```

网关对 `/v1/audio/speech` 的处理：

- 认出「唱：歌名」→ 跑唱歌流水线，返回音频字节
- **认不出（普通文本）→ 交给 TTS 读出来**（`say.engine` 为 `auto`/`breeze`/`breeze-local` 时）
- 只有 `say.engine = none` 时才返回 400，宿主退回发文字

> 注意：正因为普通文本也走这里，`intent.bareTitle` 默认关闭 —— 否则模型回一句「好的」
> 会被当成歌名去唱歌（见 TUNING.md）。

### 1.10 画图（可选，本地扩散模型）

想让机器人自己画图，再装一套出图后端（**纯 Python，不需要 ComfyUI**）：

```powershell
# 权重约 21 GB + 独立 venv，详见 draw-model/README.md 里的下载地址表
powershell -ExecutionPolicy Bypass -File draw-model\start-draw.ps1
```

然后控制台 → **图片生成**：

| 字段 | 填什么 |
|---|---|
| 服务地址 | `https://<你的公网入口>/v1`（走网关，带 GPU 仲裁） |
| 模型 | `qwen-image-2.1-turbo`（本地服务不看这个字段） |
| API Key | 网关令牌 |

实测（RTX 3080 10G）：1024×1024、8 步，**约 25 秒/张**，峰值显存 7.24 GB，出完自动回落到约 1.5 GB。
细节、踩坑与显存账见 **[DRAW.md](DRAW.md)**。

## 2. 网易云扫码登录（VIP 曲原唱）

不登录时：只能唱**免费曲**；VIP 曲会提示"需要 VIP"（以前会偷偷退回 30 秒试听，现在不会了）。

登录方式（不用手抄 Cookie）：

1. **控制台 → 插件 → 说话·唱歌·画图 → 「扫码登录」**（推荐，二维码直接显示在插件页里）
   或者打开 `https://<你的网关地址>/login#token=<网关令牌>`（本机：`http://127.0.0.1:8899/login#token=…`）
2. 用手机**网易云 App** 扫页面上的二维码
3. 手机上点「确认登录」，页面显示成功即可

网关会把 `MUSIC_U` 写回 `gateway/config.json` 的 `source.neteaseCookie`，立即生效、重启也在。
群里也可以让机器人走扫码：**「登录网易云」** → 它调 `login` 工具，控制台徽标里会出现二维码
（原来那个给链接的 `netease_login` 工具已删除 —— 它会把网关令牌拼进 URL 交给模型）。

> 二维码用的是网易云官方二维码登录接口，二维码在**本地**由内置库渲染，
> 登录 key 不会经过任何第三方服务。

---

---

## 3. 服务器侧 IPv6 加固（一次性）

服务器没有 IPv6 出口时，Node 的 fetch 会先试 AAAA，高峰期容易卡成 `fetch failed`：

```bash
mkdir -p ~qqagent/.config/systemd/user/qq-agent-linux.service.d
printf '[Service]\nEnvironment=NODE_OPTIONS=--dns-result-order=ipv4first\n' \
  > ~qqagent/.config/systemd/user/qq-agent-linux.service.d/ipv4first.conf
chown -R qqagent:qqagent ~qqagent/.config/systemd/user
su - qqagent -c 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user daemon-reload && systemctl --user restart qq-agent-linux'
```

---

## 4. 发帖/写文档时的截图清单

按这个顺序截，信息最全、也不暴露隐私：

| # | 位置 | 截什么 | 注意 |
|---|---|---|---|
| 1 | 控制台 → 插件 → 说话·唱歌·画图 | 插件卡片 + 「已启用」状态 + 七个工具名 | 别把「网关令牌」框截进去（截到也请打码） |
| 2 | 控制台 → 设置 → 语音回复 (TTS) | 服务地址 `…/v1`、模型/音色 `hanser`、超时 600000 | **API Key 打码**；域名可以打码成 `https://***.trycloudflare.com` |
| 3 | 网关的 `/login` 页面 | 二维码 + "请用网易云 App 扫一扫" | 二维码最好打码（扫了会用你的账号登录） |
| 4 | QQ 群里的实际效果 | 用户那句「用语音唱一首雨爱」+ 收到的语音条 | 群名/昵称打码；这条最能说明"能用" |
| 5 | 网关控制台窗口 | `点歌网关 v1.0.5 已启动` + `[req] · POST /v1/audio/speech → 200 (2s)` | 这条是"链路真的通了"的证据 |
| 6 | （可选）`sing-model` 目录 | 权重与模型文件摆位 | 别截图 `downloads/`（3GB 缓存，看着吓人） |

> 建议顺序：**2 → 1 → 4 → 3**（先看配置，再看群效果，最后看登录）。

---

## 5. 开机自启用计划任务（Windows）

网关和反向隧道都别用"后台任务"式启动（会话结束就没了），做成计划任务：

```powershell
# 网关（崩溃自动重启，脚本里自带循环）
schtasks /Create /TN "QQAgentSingGateway" /TR "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File \"<仓库>\scripts\run-gateway-forever.ps1\"" /SC ONLOGON /RL HIGHEST /F

# 反向隧道（同样自带重连循环；注意参数叫 -SshHost，不能叫 $Host）
schtasks /Create /TN "QQAgentSingTunnel" /TR "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File \"<仓库>\scripts\run-tunnel-local.ps1\" -SshHost root@<你的服务器IP>" /SC ONLOGON /RL HIGHEST /F

schtasks /Run /TN "QQAgentSingGateway"
schtasks /Run /TN "QQAgentSingTunnel"
```

> 想再省点心就加个看门狗（8899 / 隧道 / 7880 任一不通就自动重启对应任务），
> 注册命令见 [TUNNEL.md](TUNNEL.md) 的「看门狗」一节；画图服务的常驻任务也在那一节。

> 2026-10-31 踩过：`run-tunnel-local.ps1` 原来把参数叫 `$Host`，那是 PowerShell 的只读自动变量，
> 一传就报 "VariableNotWritable"，隧道根本起不来。现在改名为 `-SshHost`。

