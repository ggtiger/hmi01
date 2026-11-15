# Windows 发布与更新（全量 / 增量）

本项目采用和 SSTS 相同的双通道更新：

- **全量更新**：Tauri updater，下载 NSIS 安装包更新整个桌面应用
- **增量更新**：server 热更新，文件级 patch 覆盖 `server/` 目录；无匹配 patch 时回退 server 全量包

当前只构建 **Windows x64**，不构建 macOS/Linux。发布通过 GitHub Releases 完成。

## 一、一次性配置

### 1. Git 仓库

当前发布仓库：

```text
https://github.com/ggtiger/hmi01
```

工作流中的所有下载 URL 都基于 `${{ github.repository }}` 生成。客户端更新默认使用公开 GitHub Release 资产；**如果仓库是私有的，未认证的 `curl` 无法下载更新包**，需要改用 CDN 或额外下载鉴权。

### 2. 生成 updater 签名密钥

签名密钥已在当前工作机生成并配置到 GitHub：

- 私钥：`~/.tauri/xdesin-hmi.key`
- 公钥：`~/.tauri/xdesin-hmi.key.pub`
- 密码：`~/.tauri/xdesin-hmi.key.password`

> 请立即备份以上文件。私钥和密码丢失后无法再签名更新包；不要提交到仓库。

如需重新生成：

```bash
npx tauri signer generate -w ~/.tauri/xdesin-hmi.key
```

### 3. GitHub Secrets

当前仓库已配置：

| Secret | 状态 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | 已配置 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 已配置 |
| `TAURI_UPDATER_PUBKEY` | 已配置 |

CI 会把 updater 公钥和 GitHub 更新端点写入发布构建配置。

## 二、发布 Windows 全量版本

先同步版本号：

```bash
npm run release:version -- 0.2.0 app
```

提交并打 tag：

```bash
git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "🔖 release: v0.2.0"
git tag v0.2.0
git push origin feat/v6-system --follow-tags
```

推送 `v*` tag 后会自动执行 `.github/workflows/release.yml`：

1. 从 tag 同步 app / server 版本
2. 构建 Windows NSIS 安装包
3. 生成 Tauri updater 产物和 `latest.json`
4. 构建 server 全量包 `server-<version>.tar.gz`
5. 对最近 3 个旧版本生成 `server-patch-<old>-<new>.tar.gz`
6. 更新 `latest.json` 的 `serverVersion` / `serverDeltas` / `serverFullUrl`
7. 发布 GitHub Release

Release 中会包含：

- `*.exe`：Windows 全量安装包
- `*.nsis.zip` + `*.sig`：Tauri 全量自动更新产物
- `latest.json`：全量更新与 server 更新清单
- `server-<version>.tar.gz`：server 全量兜底包
- `server-patch-<old>-<new>.tar.gz`：server 增量包

首次发布没有旧版本 server 包，因此只有全量 server 包；从第二个版本开始生成增量。

## 三、只发布 server 热更新

仅修改 Next.js server / 页面代码、不修改 Rust/Tauri 外壳时，使用 server-only 发布：

```bash
npm run release:version -- 0.2.1 server
git add package.json package-lock.json
git commit -m "🔖 release: server v0.2.1"
git tag server-v0.2.1
git push origin feat/v6-system --follow-tags
```

`.github/workflows/server-release.yml` 会：

- 构建 Windows server bundle
- 生成 `server-0.2.1.tar.gz`
- 生成最多 3 个旧版本的文件级 patch
- 找到最近一个已发布的 `v*` 应用 Release
- 更新该 Release 的 `latest.json`
- 上传 server 全量包和增量包

**不会重新构建 Windows 安装包，也不会修改 app 版本**，客户端通过 server 热更新通道升级。

## 四、本地打包（可选）

Windows 本地构建需要 Node 22、Rust 和 Tauri CLI：

```powershell
$env:GITHUB_REPOSITORY = "owner/repo"
$env:TAURI_UPDATER_PUBKEY = "<公钥内容>"
$env:NEXT_PUBLIC_GITHUB_REPO = "owner/repo"
$env:TAURI_SIGNING_PRIVATE_KEY = "<私钥内容>"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<密码>"

npm run release:configure
npm run release:windows
```

`src-tauri/tauri.release.conf.json` 是 CI 生成的临时发布配置，已被 `.gitignore` 忽略。

## 五、更新链路说明

- 客户端启动时先检查 `latest.json`
- `version` 更新：走 Tauri updater 全量安装
- `serverVersion` 更新：
  - 有匹配的 Windows 增量包 → 下载 patch，校验 SHA-256 后热更新
  - 无匹配增量或下载校验失败 → 下载 `serverFullUrl` 全量包
  - 更新后由 Rust 备份、应用、校验、重启 server 并刷新 WebView

Windows 补丁和全量包都只针对 `windows-x86_64`；不再生成其他平台条目。
