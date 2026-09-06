# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目简介

Xdesin 踏板总成测试台上位机：Tauri 2 桌面壳 + Next.js 15 standalone 作为 sidecar 进程，通过 WiFi TCP（上位机为 Client，设备 ESP32-S3 @ 192.168.4.1:10001）控制踏板测试台。

**协议唯一权威是 `docs/1.md`**（Xdesin 上下位通信协议）。任何涉及命令格式、应答规则、遥测字段、加密封装的改动，先查这份文档，不要凭记忆改。

## 常用命令

```bash
npm run dev          # 仅前端：next dev -p 3200（浏览器调试，无 Tauri 壳）
npm run tauri:dev    # 完整桌面应用开发（先 ensure-placeholders 再起 next dev）
npm run tauri:build  # 生产构建（beforeBuildCommand 自动跑 bundle-sidecar）
npm run lint         # next lint
npm run mock:device  # 启动 mock 设备模拟器（0.0.0.0:10001），上位机连接时 host 填 127.0.0.1
npm run start:prod   # 单独运行 standalone server 产物

cd src-tauri && cargo test                              # Rust 测试（含 crypto 与 Node 的对拍向量测试）
cd src-tauri && cargo test test_node_cross_vectors     # 运行单个测试
```

- `npm run tauri:bundle`（scripts/bundle-sidecar.js）：把 Next standalone 产物打包到 `src-tauri/server/`，`tauri:build` 会自动执行
- `npm run deploy:build`：生成可独立部署的 server tar.gz（`dist/xdesinhmi-server.tar.gz`）
- 无前端测试框架；Rust 侧 `cargo test` 是唯一的自动化测试

## 架构

### 进程模型（Tauri 壳 + Next sidecar）

WebView 里加载的不是打包的静态资源，而是 Rust 启动的 Node 子进程跑 Next standalone server：

- **开发模式**：连 `localhost:3200`（固定端口，`npm run dev` 起的）
- **生产模式**：`lib.rs` 的 `run_production_startup()` → 查找/下载 Node 运行时（缺 Node 时经 npmmirror 下载到 `{app_data_dir}/runtimes/`）→ `start_server_process()` 在随机空闲端口启动 `{resource_dir}/server/server.js` → 轮询端口就绪后导航主窗口
- 启动过程由独立 **splash 窗口**（自定义协议 `splashpage://`，HTML 编译期内嵌）展示进度；前端渲染完成后调用 `app_ready` 命令关闭 splash（15s 超时强制切换）
- Node 的 stderr 重定向到 `{app_data_dir}/xdesinhmi-startup.log`
- `XDESIN_REMOTE_URL` 环境变量可切换为连接远程已部署 server 的模式

### 设备通信链路（四层）

```
React 页面 (useDevice hook)
  → lib/comm/device-service.ts   invoke 薄封装
    → src-tauri/src/comm/commands.rs   #[tauri::command]
      → src-tauri/src/comm/state.rs    CommManager 编排
        → connection.rs (TCP) + crypto.rs (加密封装) + protocol.rs (命令/应答/遥测解析)
```

Rust comm 各文件职责：
- `crypto.rs`：帧 = `base64(nonce[2B BE] ‖ AES-128-CTR 密文 ‖ HMAC-MD5[16B]) + '\n'`；PSK `Xdesin0123456789`；IV = 14×0x00 + nonce 大端；nonce 每包 +1、重连归零；重放保护（nonce 回绕放行）。`test_node_cross_vectors` 与 `scripts/mock-device-server.js` 互为对拍
- `protocol.rs`：`Command` 枚举（to_frame 生成协议行）、`Reply` 解析、TELEMETRY/DEBUG 事件行解析
- `state.rs`：CommManager 核心。**关键并发设计**：① crypto 用 `tokio::sync::Mutex`，nonce 分配与 socket 写同临界区（保证 nonce 顺序 = 线序）；② `cmd_mutex` 串行化 send_and_wait（协议 §2.1：除 PING/ESTOP 外命令须串行）；③ `pending: HashMap<命令头, oneshot>` 按命令头匹配应答，超时清理防串包；④ 遥测 emit 节流 50ms（~20Hz）
- `heartbeat.rs`：5s PING，15s 无数据断开
- 明文调试模式（协议 §1.3）切换有特殊编排：PLAIN ON 收到 OK 后才翻转 `plain_mode`；PLAIN OFF 是明文发出后立即翻回加密

### Rust → 前端事件

| 事件 | 负载 | 用途 |
|---|---|---|
| `device-state-changed` | `DeviceState`（snake_case） | 全量状态含遥测 |
| `device-debug-log` | `LogEntry` | 通信收发日志（TX/RX/SYS） |
| `pedal-event` | `DebugEvent` | DEBUG 异步事件（LEVELED/STABLE/LEVEL_ABORT…） |

### 添加新设备命令的完整链路（缺一不可）

1. `protocol.rs`：`Command` 枚举加变体 + `to_frame()` 序列化 + `parse_reply()` 处理应答
2. `commands.rs`：新增 `#[tauri::command]`
3. `lib.rs`：`invoke_handler!` 列表注册
4. `lib/comm/device-service.ts`：invoke 封装
5. `lib/comm/use-device.ts`：actions 中注册（自动获得统一错误处理）

### 前端结构

- 状态管理 Zustand（`lib/store/`）：`app-store`（连接参数）、`pedal-store`、`motor-store`、`settings-store`、`updater-store`
- 页面（App Router）：`/`（连接+遥测+调试台）、`/pedal-test`、`/motor-debug`、`/records`、`/settings`、`/about`
- 遥测中设备上报 `nan` → Rust 转 `null` → TS 类型 `number | null` → UI 用 `fmtNum()` 显示 `--`，**不要把 null 当 0 处理**
- 测试记录存 SQLite（tauri-plugin-sql，`lib/db/test-records.ts`），仅在 Tauri 环境可用（`isTauri()` 判断）

### 更新机制

- delta 热更新（`delta.rs`）：只 patch `server/` 目录（Next 产物），重启 server 进程生效；全量更新走 tauri-plugin-updater
- `tauri.conf.json` 的 updater endpoints 和 pubkey 目前是占位，发布前需配置 minisign 密钥

## 关键约束与已知坑

- **tauri.conf.json `bundle.resources` 引用 `server/server.js` 等文件在 dev 模式也会校验存在**——占位文件由 `scripts/ensure-placeholders.js` 生成（`tauri:dev` 已自动跑）；占位目录里不能只放隐藏文件（`.gitkeep` 不匹配 `**/*` glob）。server 产物不入库（.gitignore）
- **Cargo.lock 锁定的版本组合不能随意升级**：tauri 2.10.3 + tauri-runtime-wry 2.11.4 会 E0308 编译失败，必须保持 SSTS 验证过的组合（tauri 2.10.0 + runtime-wry 2.10.0 + wry 0.54.4）
- Rust↔Node 跨语言加密对拍向量固化在 `crypto.rs::test_node_cross_vectors`，改 crypto 或 mock 模拟器后必须跑 `cargo test` 验证两端一致

## 提交规范（commit-record 流程，hook 强制）

提交信息风格：`✨ feat(scope): 中文描述` / `🐛 fix(scope): 中文描述`。

**包含代码改动的提交必须随带处理记录文档**（PreToolUse hook 会拦截）：
- bug 修复 → `docs/fixed/YYYY-MM-DD-<中文标题>.md`
- 新增功能 → `docs/feat/YYYY-MM-DD-<中文标题>.md`

用户明确不要记录时，提交信息里加 `[skip-record]` 可跳过检查。
