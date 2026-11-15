# Windows 发布时 server tar 打包失败

> 日期：2026-11-15
> 分支：`feat/v6-system`

## 现象

Windows Release workflow 在 `Publish server full package and Windows deltas` 步骤失败：

```text
tar (child): Cannot connect to D: resolve failed
tar: D:\a\hmi01\hmi01\dist\server-0.1.0.tar.gz: Cannot write: Broken pipe
```

Windows 构建本身成功，失败发生在生成 server 全量包时。

## 原因

GitHub Windows runner 的 Git Bash 使用 GNU tar。Windows 绝对路径 `D:\...` 中的盘符冒号被 GNU tar 解释为远程主机分隔符，导致它尝试连接 `D:`。

## 修复

在 Windows 上为 tar 命令增加 `--force-local`，强制将路径按本地文件处理：

```js
const TAR_FLAGS = process.platform === 'win32' ? ['--force-local'] : []
```

`tarCreate` / `tarExtract` 均使用该参数；macOS/Linux 不受影响。

## 验证

- 本地 delta fixture 与真实 server bundle 的 patch 生成测试通过
- Windows Release 重新触发后 server tar / patch 上传应继续执行
