# Tauri WebView 中 window.confirm 报错（dialog.confirm not allowed）

> 日期：2026-11-08
> 现象：点击「恢复出厂」后报错 `dialog.confirm not allowed. Command not found`，操作无法继续
> 提交：本次提交

## 一、根因

Tauri 2 的 WebView 会把 `window.confirm()` 桥接到 dialog 插件的 `confirm` 命令，而当前 `capabilities/default.json` 只授权了 `dialog:default` + `dialog:allow-save`，未包含 `confirm` 权限 → 命令被拒绝（Command not found）。

## 二、修复

不使用系统对话框，改为**行内二次确认**（纯前端状态，无权限依赖）：

- 设置页「恢复出厂」：点击后按钮区域变为「确认恢复出厂？[确认][取消]」，确认后才执行命令
- 记录页删除记录：同样改为行内「确认删除？[确认][取消]」

## 三、验证

- `tsc` 零错误；`next build` 11/11
- 恢复出厂 → 显示行内确认 → 确认后发送 Modbus 0x00FE 命令

## 四、教训

- Tauri WebView 中的 `window.alert/confirm/prompt` 不是浏览器原生实现，依赖 dialog 插件权限；桌面项目统一使用行内确认 UI，避免权限配置与平台差异
