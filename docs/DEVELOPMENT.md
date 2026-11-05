# 开发与测试

## 分支约定（三个分支，别乱合）

这个仓库同时服务两个宿主，**宿主适配的改动不能串门**。所以分三层：

| 分支 | 是什么 | 谁用 |
|---|---|---|
| `core` | **宿主无关的公共基线**：`gateway/`、`draw-model/`、`say-model/`、`sing-model/`、`scripts/` 公共脚本、公共 docs / test | 不直接发布，只当基线 |
| `main` | `core` + **qq-agent-plus 插件层**（`plugin/sing/`、宿主菜单与 README 安装说明） | qq-agent-plus 宿主；发版出包的也是它 |
| `dsh-aurabot-qq` | `core` + **aurabot 适配层**（`GET /v1/models`、`docs/AURABOT.md`、`scripts/check-aurabot.ps1`、`test/aurabot-contract.test.mjs`） | dsh-aurabot-qq 宿主（DSH 插件，不走 `plugin/`） |

**改东西之前先问一句：这条改动跟宿主有关吗？**

- 跟宿主无关（说话/唱歌/画图本体、网关行为、协议字段、公共文档）→ 提交到 **`core`**，
  然后两个宿主分支各 `git merge core` 一次：
  ```bash
  git checkout core && git commit ...        # 公共改动
  git checkout main && git merge core        # qq-agent-plus 拿到
  git checkout dsh-aurabot-qq && git merge core   # aurabot 拿到
  ```
- 只对某个宿主有意义（插件层、某个宿主的模型清单口、接入手册、自检脚本）→ **只提交到那个宿主分支**，
  永远不要往 `core` 合。
- 在宿主分支上顺手牵到的公共修复，记得回头单独提一次到 `core`（用 `git cherry-pick -x <sha>`），
  否则另一个宿主永远拿不到。

`main` 与 `dsh-aurabot-qq` 之间**不要互相 merge**，只能通过 `core` 中转。

## 测试

```bash
node --test            # 55 个用例（5 个文件）：插件纯函数 / 网关队列 / 网关路由 / 情绪预设 / 真协议集成
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
| `ci.yml` | push 到 main / PR / 手动 | 清单自检（`scripts/check-manifest.mjs`）+ 5 个测试文件 |
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

1. 在 `CHANGELOG.md` 顶部加一节 `## [x.y.z] - 日期`（**标题格式别改**，发布工作流按它抽取正文）
2. 同步版本号：`package.json`、`plugin/sing/plugin.json`、`gateway/lib/app.mjs` 的 `VERSION`
3. `git tag vx.y.z && git push origin main --tags` —— 工作流会跑测试、用宿主的打包器真装一遍、
   建 Release（正文 = CHANGELOG 该节 + 安装说明 + compare 链接）、挂上 `.tar.gz` 与 `index-entry.json`

> 想先看正文长什么样：`node scripts/release-notes.mjs x.y.z --sha256 <hex>`
