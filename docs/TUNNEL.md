# 把本机网关暴露成 https

> **先用方案一（Cloudflare 快速隧道）**：零成本、自动证书、一条命令。
> 它能跑通单首歌（整首 3:54 端到端约 **43 秒**，含冷启动；换声常驻后约 22 秒），但有个硬约束：
> **源站超过约 100 秒没响应，Cloudflare 就回 `524`** —— 每次起进程整首约 85 秒，再赶上冷启动、
> 排队或更长的歌就可能越线。
>
> | 通道 | 走哪 | 原因 |
> |---|---|---|
> | 插件（`/sing`、`/jobs`、`/files`、`/login`） | 快速隧道可以 | 都是短请求（202 + 轮询 + 下载） |
> | 宿主语音条（`/v1/audio/speech`） | **建议 8898 专线**（ssh -R + nginx TLS）或 named tunnel | 宿主同步等音频，几十秒起步，越线就 524 |
>
> 语音条走 `https://127.0.0.1:8898/v1` 还有个好处：不经第三方、地址永不变。配置见文末「备用专线」一节。

**为什么不能直接填 `http://127.0.0.1:8899`：** 宿主给插件的联网能力写死了 `allowPrivate: false`
（见 qq-agent-plus `src/plugins/capabilities.js` 里 `cap.http.request` / `cap.media.download` 的调用），
`localhost`、`127.0.0.1`、`192.168.x.x`、`10.x.x.x` 一律 `禁止访问内网/本机地址`。
这不是插件的选择，改不了 —— 所以网关必须有一个**公网域名 + https**。

好消息是：三种做法都不需要家里有公网 IP。

## Cloudflare 快速隧道（推荐，免费、自动证书）

不用手动起 —— `scripts\start-all.ps1` 会自动拉起隧道并打印地址；地址变了用
`scripts\sync-host-url.ps1 -SshHost root@<IP>` 一条命令同步到服务器。手工起也行：

```bash
# 一次性安装：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://127.0.0.1:8899
```

输出里会有一行：

```
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at:                                          |
|  https://random-words-here.trycloudflare.com                                               |
+--------------------------------------------------------------------------------------------+
```

把这个地址填进插件设置即可。**注意：**
- 快速隧道（`--url` 不带登录）每次重启地址都会变 → 适合先试；要固定域名用
  `cloudflared tunnel login` + `cloudflared tunnel create sing` + 本地 `config.yml` 绑一个自己的子域；
- 隧道是公网可达的，**token 一定要设**（`gateway/config.json` 的 `token`，插件里填同一个值）。

固定域名的 `config.yml` 长这样：

```yaml
tunnel: sing
credentials-file: C:\Users\你\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: sing.example.com
    service: http://127.0.0.1:8899
  - service: http_status:404
```

## 开机自启（Windows）

> 别用"后台任务"式启动（关掉终端就没了）。用**计划任务**，两个脚本都自带重连/重启循环：

```powershell
schtasks /Create /TN "QQAgentSingGateway" /TR "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File \"<仓库>\scripts\run-gateway-forever.ps1\"" /SC ONLOGON /RL HIGHEST /F
schtasks /Create /TN "QQAgentSingTunnel"  /TR "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File \"<仓库>\scripts\run-tunnel-local.ps1\" -SshHost root@<你的服务器IP>" /SC ONLOGON /RL HIGHEST /F
schtasks /Run /TN "QQAgentSingGateway"; schtasks /Run /TN "QQAgentSingTunnel"
```

> `run-tunnel-local.ps1` 的参数叫 **`-SshHost`**（不能叫 `$Host`：那是 PowerShell 的只读自动变量，
> 一传就报 `VariableNotWritable`，2026-10-31 踩过）。

旧的写法（固定域名版本）：

两个计划任务，登录时触发、失败重试：

```powershell
# 网关
schtasks /create /tn "SingGateway" /tr "node <仓库路径>\gateway\server.mjs" /sc onlogon /rl highest
# 隧道（固定域名版本）
schtasks /create /tn "SingTunnel"  /tr "cloudflared tunnel run sing" /sc onlogon /rl highest
```

Linux 用 systemd user 服务（和你跑 qq-agent 的方式一致）：

```ini
# ~/.config/systemd/user/sing-gateway.service
[Unit]
Description=Sing gateway
[Service]
ExecStart=/usr/bin/node /opt/sing/gateway/server.mjs
Restart=always
[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now sing-gateway
loginctl enable-linger "$USER"
```

## 排查

| 现象 | 先查什么 |
|---|---|
| 插件说「网关返回失败：HTTP 502」 | 隧道进程活着但网关没起来 → 本机 `curl http://127.0.0.1:8899/health` |
| 插件说「禁止访问内网/本机地址」 | 网关地址填成了 `http://127.0.0.1:...` 或内网 IP，换成 https 域名 |
| 插件说「令牌不对」 | 插件设置里的「网关令牌」与 `config.json` 的 `token` 不一致 |
| 隧道地址每次重启都变 | 用的是快速隧道，改固定域名方案 |

---

## 备用专线：ssh -R + nginx TLS（地址永不变，没有 100 秒上限）

快速隧道（`trycloudflare.com`）是 Cloudflare 明说"无可用性保证"的免费通道，偶发抖动。
如果受够了，可以改走**你自己服务器的反向隧道 + nginx TLS**：

```
你的电脑 ──ssh -R──► <你的服务器IP>:127.0.0.1:8899 ──nginx TLS(8898)──► 宿主
```

优点：不经过第三方、延迟毫秒级、不受 IPv6/Happy Eyeballs 影响。
代价：要先在安全组放行 **8898**，并且宿主进程要信任本机自签 CA。

**启用**

```bash
# 服务器（各一次）
bash install-nginx-tls.sh                 # 生成 CA/证书 + 8898 站点（当前是 .disabled）
mv /etc/nginx/conf.d/sing-gateway.conf.disabled /etc/nginx/conf.d/sing-gateway.conf
nginx -t && systemctl reload nginx
```

```powershell
# 你电脑
powershell -ExecutionPolicy Bypass -File scripts/run-tunnel-local.ps1 -SshHost root@<你的服务器IP>
```

```bash
# 服务器：把两条通道都指过去
# 实测：插件（跑在服务器宿主里）也能直接访问 https://<公网IP>:8898，
# 所以 gatewayUrl 和 tts.baseUrl 可以同时指向这条线，完全不用 Cloudflare。
# 适合"快速隧道地址老变、懒得每次改"的情况；代价是要在服务器上装证书 + 放行 8898 端口。
bash set-gateway-url.sh https://<你的服务器IP>:8898 <网关令牌>
bash set-tts-url.sh     https://<你的服务器IP>:8898/v1
```

**切回 Cloudflare**

```bash
bash set-gateway-url.sh https://<你的>.trycloudflare.com <网关令牌>
bash set-tts-url.sh     https://<你的>.trycloudflare.com/v1
mv /etc/nginx/conf.d/sing-gateway.conf /etc/nginx/conf.d/sing-gateway.conf.disabled
nginx -t && systemctl reload nginx
```

> 宿主的 `NODE_EXTRA_CA_CERTS=/opt/qq-agent/tls/ca.crt` 一直留着没坏处（只影响自签那几条链路）。
> 证书链坏了（CA 重建过）就跑 `bash reissue-server-cert.sh`。

## 看门狗：后端 502 / 掉线自愈

宿主机看到 **502** 通常不是"电脑关了"，而是两种情况之一：

| 现象 | 原因 | 看门狗怎么处理 |
|---|---|---|
| 502 但电脑在跑 | 隧道活着，**本地网关 8899 挂了** | 重启 `QQAgentSingGateway` 任务 |
| 502 且电脑在跑 | **ssh 反向隧道断了** | 重启 `QQAgentSingTunnel` 任务 |
| 画图报错 | 出图服务 7880 没起来 | 重启 `QQAgentDrawService` 任务 |

一键注册（每 5 分钟检查一次，只在挂了时才动手）：

```powershell
schtasks /Create /TN "QQAgentWatchdog" /SC MINUTE /MO 5 /RL HIGHEST /F ^
  /TR "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File <仓库路径>\scripts\watchdog.ps1"
```

日志在 `logs/watchdog.log`，**只有发生重启时才写**，平时不会刷屏。

> 画图那行（`QQAgentDrawService`）要先注册这个任务看门狗才会管；没注册它会自动跳过，
> `start-all.ps1` 则会用隐藏进程临时拉起：
>
> ```powershell
> schtasks /Create /TN "QQAgentDrawService" /SC ONLOGON /RL HIGHEST /F ^
>   /TR "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File <仓库路径>\draw-model\start-draw.ps1"
> ```

> 注意：手动 `schtasks /Run /TN QQAgentSingTunnel` 时如果隧道已经连着，会因为远端端口占用而
> `ExitOnForwardFailure` 退出、5 秒后重连——中间会有十几秒 502。要重启就先确认没有 ssh 进程。

