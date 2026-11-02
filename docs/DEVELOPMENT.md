# 开发与测试

```bash
node --test            # 52 个用例（5 个文件）：插件纯函数 / 网关队列 / 网关路由 / 情绪预设 / 真协议集成
node gateway/server.mjs

# 宿主侧的验证工具（在 qq-agent-plus 仓库里跑）
node scripts/plugin-validate.mjs <本仓库>/plugin/sing
node scripts/plugin-dev.mjs <本仓库>/plugin/sing --call sing_status
```

契约见 [PROTOCOL.md](PROTOCOL.md)；想换后端（Python/Go 都行）要实现同一套接口 —— 注意别漏 `/say/*`、`/admin/*`、`/login/*`，漏了插件那几块功能会静默失效。

## 发布

两个工作流都放在 `.github/workflows/`：

| 工作流 | 触发 | 干什么 |
|---|---|---|
| `ci.yml` | push 到 main / PR / 手动 | 清单自检（`scripts/check-manifest.mjs`）+ 4 个测试文件 |
| `release.yml` | 推 `v*` 标签 / 手动（填版本号） | 拉宿主打包器 → 打包并**真装一次**自测 → 建 Release 挂包 |

### 发一个版本（推荐：打标签）

```bash
git tag v1.2.3 && git push origin v1.2.3
```

### 手动跑（Actions 页面 → release → Run workflow）

填 `version`（如 `1.2.3`），`tag` 留空会自动用 `v<version>`，可选标预发布。

### 本地先打好包看一眼

```bash
node /path/to/qq-agent-plus/scripts/plugin-pack.mjs plugin/sing \
  --out dist --author BAofanTing \
  --homepage https://github.com/BAOfanTing/say-sing-drawPlugin \
  --tag v1.2.3 --min-version 0.9.10 --tags "点歌,唱歌,语音"
```

产出 `dist/sing-<版本>.tar.gz`（宿主用 ustar 格式，可复现），以及可直接粘进索引的 JSON。

### 上架到官方索引

```bash
gh repo clone sakurawwwxh/qq-agent-plugins
node /path/to/qq-agent-plus/scripts/plugin-publish.mjs plugin/sing \
  --index-repo ../qq-agent-plugins --author BAofanTing \
  --homepage https://github.com/BAOfanTing/say-sing-drawPlugin --tags 点歌,唱歌,语音
# 确认无误后加 --push，再按提示 gh release upload packages plugins/packages/sing-<版本>.tar.gz
```

## 发版

1. 提交信息写规范点（`feat:` / `fix:` 开头）——发布正文按提交历史自动分组生成
2. 同步版本号：`package.json`、`plugin/sing/plugin.json`、`gateway/lib/app.mjs` 的 `VERSION`
3. `git tag vx.y.z && git push origin main --tags` —— 工作流会跑测试、用宿主的打包器真装一遍、
   建 Release（正文 = 提交列表 + 安装说明 + compare 链接）、挂上 `.tar.gz` 与 `index-entry.json`

> 想先看正文长什么样：`node scripts/release-notes.mjs x.y.z --sha256 <hex>`
