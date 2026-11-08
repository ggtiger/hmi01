# 转盘测试导出 Excel（记录值 + 实时曲线双 Sheet）

> 日期：2026-11-08
> 现象/背景：转盘测试原导出为单文件 CSV，只含历史记录表；用户需要同时导出实时曲线数据，并分为两个 Sheet
> 提交：本次提交

## 一、实现要点

- 新增 `lib/export-excel.ts`：通用多 Sheet 导出工具（SheetJS `xlsx`）
  - **Tauri 桌面**：`plugin-dialog.save` 选路径 → `XLSX.write(array)` → `invoke('save_file_content')` 写盘（复用既有 Rust 命令，避免 WebView 下载限制）
  - **浏览器**：`XLSX.writeFile` 触发下载
  - `xlsx` 采用动态 `import()`，不进入首屏 bundle（steering-test First Load 225 kB 未增长明显）
  - 数值 `null` 统一转 `--`，数值列保留 3 位小数
- 转盘测试页导出按钮改为「导出 Excel」，生成两个 Sheet：
  1. **记录值**：序号 / 时间 / 记录项 / 值 / 单位（历史记录表）
  2. **实时曲线**：时间 / 倾角 X / 倾角 Y / 自由转角（趋势缓冲 MAX_TREND=100 点）
- 按钮禁用条件改为「记录与趋势均无数据」

## 二、验证

- `npx tsc --noEmit` 零错误；`next build` 11/11
- 桌面：导出弹出保存对话框，生成的 .xlsx 含两个 Sheet，数值列为数字类型（可在 Excel 中直接计算/绘图）

## 三、关联

- 依赖：`xlsx@0.18.5`（新装）
- 关联：37300d0（转盘测试重构）、a215186（峰值记录写入历史表）
