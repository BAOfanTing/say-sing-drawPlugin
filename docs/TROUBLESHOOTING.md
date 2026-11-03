# 排错

## 宿主报 `HTTP 524`（唱歌/说话时）

Cloudflare **快速隧道**对源站响应时间有约 100 秒限制。单首歌通常 43 秒能跑完，但冷启动 + 排队 + 超长歌**可能**越线 → 524（不是必然）。要稳定就把语音条切到 8898 专线。
换成本机专线即可：

```bash
bash /opt/qq-agent/set-tts-url.sh https://127.0.0.1:8898/v1
```

（专线的搭建见 [TUNNEL.md](TUNNEL.md) 的「备用专线」。插件的 gatewayUrl 不受影响。）

## 点歌成功但收到的是「音源原声」而不是翻唱

`gateway/config.json` 里 `voice.engine` 还是 `none`。改成 `command` 并配好 `voice.command`
（指向 `sing-model/run.py`），重启网关。

## 点歌很慢（> 2 分钟）或插件超时

- 检查 `maxSeconds`：`run.py` 会先裁剪再换声；整首会按 30 秒分段处理（整批只加载一次模型，失败只补跑缺的段），
- 检查是不是有旧任务还占着 GPU：`nvidia-smi`，必要时结束残留的 `python -m infer.cli`；
- 网关是串行的，第二个点歌会排队（这是故意的，换声并发只会互相拖慢）。

## 网易云搜到了但取不到音频

VIP 曲匿名拿不到直链。二选一：

- 在 `gateway/config.json` 的 `source.neteaseCookie` 填登录后的 `MUSIC_U=…`（有 VIP 就能取原唱）；
- 什么都不填也可以：网关会自动降级到同名的**免费翻唱版**，并在结果里注明「原唱源受限」。

## 语音条报 `fetch failed` / 机器人说"语音服务死了"

`fetch failed` 是 **网络层**失败（没连上网关），不是我们返回错误。按顺序排：

1. **网关是不是正在重启**：我改完代码重启的那 2-3 秒，请求会 `ECONNREFUSED`。
   用守护脚本跑（`scripts/run-gateway-forever.ps1`），改代码时挑没人用的时候。
2. **隧道还在不在**：`cloudflared` 进程、以及 `curl -s https://<域名>/health`。
   快速隧道（`trycloudflare.com`）是尽力而为的，Cloudflare 官方明说 "no uptime guarantee"；
   偶发抖动多试一次通常就好，要稳定就换固定域名（见 `docs/TUNNEL.md`）。
3. **服务器的 IPv6 / Happy Eyeballs**（最常见，实测失败率约 50%）：
   很多 Cloudflare 域名同时有 A 和 AAAA；这台服务器没有 IPv6 出口。
   Node 的 Happy Eyeballs「尝试超时」默认只有 **250ms**，而到 Cloudflare 边缘的 TCP 握手常常更久 ——
   于是连接被掐断去试 IPv6，最终报 `fetch failed`（cause: `ETIMEDOUT`，约 545ms 就返回）。

   修法（**两个参数都要，且值里有空格必须整体加引号**）：

   ```ini
   # ~/.config/systemd/user/qq-agent-linux.service.d/ipv4first.conf
   [Service]
   Environment="NODE_OPTIONS=--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=5000"
   ```

   ```bash
   chown -R qqagent:qqagent ~qqagent/.config/systemd/user
   su - qqagent -c 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user daemon-reload && systemctl --user restart qq-agent-linux'
   ```

   实测对照（各 8-12 次 fetch `/health`）：

   | 参数 | 成功率 |
   |---|---|
   | 默认 | 约 50% |
   | `--dns-result-order=ipv4first` 单独 | 约 80% |
   | **`ipv4first` + `attempt-timeout=5000`** | **12/12 全通** |
   | `ipv4first` + `--no-network-family-autoselection` | 0/8（反而更差，别用） |

   验证命令（直接从宿主进程读环境，比 `systemctl show` 准）：

   ```bash
   PID=$(su - qqagent -c 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user show qq-agent-linux -p MainPID' | cut -d= -f2)
   tr '\0' '\n' < /proc/$PID/environ | grep NODE_OPTIONS
   ```

   再验一次真链路（控制台「试听」按钮走的就是这个接口）：

   ```bash
   curl -s -X POST -H "x-console-token: $TOKEN" -H 'Host: 127.0.0.1:3210' -H 'content-type: application/json' \
     -d '{"text":"唱：雨爱"}' http://127.0.0.1:3210/api/tts/test -o /tmp/t.bin -w 'http=%{http_code} size=%{size_download}\n'
   # 期望：http=200，几十万字节
   ```
4. **看网关日志**：网关会对每个请求打一行
   `[req] · POST /v1/audio/speech → 200 (24207ms)` / `[req] ✗ … → 400 (12ms)`。
   有 req 行 = 请求到了，按状态码查；**没有 req 行 = 压根没到网关**，问题在 1/2/3。

## 隧道换了域名怎么办

（Cloudflare 快速隧道每次重启都会换地址）

快速隧道每次重启域名都变，要改**两处**（漏一处就会出现"点歌能用、语音条一直 fetch failed"）：

```bash
bash /opt/qq-agent/set-gateway-url.sh https://新域名.trycloudflare.com [网关令牌]
```

脚本会先自检 `/health`，再写插件的 `gatewayUrl` 和宿主 TTS 的 `baseUrl`，最后回读确认。

## 说话没声音 / 插件显示「说话后端离线」

按顺序查：

```powershell
# ① 网关活着吗
curl http://127.0.0.1:8899/health          # 看 "say" 字段是 auto / breeze / breeze-local / none

# ② 说话后端状态（云端看 balance，本地看 localRunning/idleMs）
curl -H "authorization: Bearer <网关令牌>" http://127.0.0.1:8899/say/status
```

| status 里的现象 | 原因 |
|---|---|
| `engine: "none"` | `say.engine` 设成了 none，改成 `breeze` 或 `breeze-local` |
| `online:false, note:"还没填 Breeze API Key"` | 云端缺 Key：插件设置里填，或直接写进 `config.json` |
| `note:"闲置中，说话时自动加载"` | **正常**，本地模型按需加载；发一句就会起来（约 35 秒） |
| `note:"Breeze 返回 401…"` | Key 不对/未激活；`xi-api-key` 的值要完整（带 `brz_` 前缀） |
| `note:"本地服务没起来…"` | 本地权重路径或 python 路径不对，检查 `say.localPython` / `localModelDir` |
| `balance` 很低或 0 | 云端额度用完，换本地或充值 |

> 说话失败时网关会退回"发文字"，不会让整条链路挂掉；日志里搜 `[say]` 能看到具体原因。
