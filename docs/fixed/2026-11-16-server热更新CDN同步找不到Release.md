# server 热更新 CDN 同步找不到 Release

> 日期：2026-11-16
> 分支：`main` / `feat/v6-system`

## 现象

`server-v0.1.2` 的 Server Release 在 CDN 同步步骤失败：

```text
gh release download server-v0.1.2 --pattern server-*.tar.gz
release not found
```

## 原因

server-only 发布使用 `server-v*` 作为版本 tag，但资产实际上传在最近的 `v*` 应用 Release 下，不会创建 `server-v0.1.2` Release。

`publish-server-update.mjs` 已经正确解析了最近应用 Release，但 `sync-cdn.mjs` 仍直接使用 `GITHUB_REF_NAME`，导致去找不存在的 `server-v0.1.2` Release。

## 修复

`sync-cdn.mjs --mode server` 现在会自动查询最近一个已发布的 `v*` 应用 Release 作为资产下载/回写目标；`server-v*` tag 只用于版本号，不再被当作 Release tag。

## 验证

重新执行 server 发布后确认 CDN `latest.json` 的 `serverVersion` 和 server 资产 URL。
