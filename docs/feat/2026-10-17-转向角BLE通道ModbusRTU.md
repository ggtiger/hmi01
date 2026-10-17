# 转向角 BLE 通道接入（Modbus RTU 倾角传感器）

> 日期：2026-10-17
> 现象/背景：转向角（STEER）通道实际接的是高精度倾角传感器（啄为传感），经 WCH BLE 串口透传模块连接，用 Modbus RTU 协议问答式读取 X/Y 轴角度（非 0xAA 力值帧）
> 提交：本次提交

## 一、背景与方案

用户澄清链路（WCHBLEWxJsLib 文档 + 商品页协议图）：
- 三个 BLE 模块均为 WCH 串口透传方案；A/B 力值模块发 0xAA 帧（scale_protocol 不变）
- **STEER 转向角模块：Modbus RTU**（之前误按 68/77 自定义协议实现，用户纠正）
- 问答式：上位机轮询发送读命令，应答经 BLE 通知异步返回

协议（厂商文档向量）：
- 发送：`01 03 00 01 00 04 15 C9`（地址 01 / 功能码 03 / 寄存器 0x0001 / 4 寄存器 / CRC16 低前）
- 应答：`01 03 08 C0 05 4F DF 3F BE 14 7B 74 78`（X=0xC0054FDF=-2.083°，Y=0x3FBE147B=+1.485°）
- IEEE754 32 位浮点大端，CRC16/MODBUS（初始 0xFFFF、多项式 0xA001、低字节在前）

## 二、实现要点

- `tilt_protocol.rs`（重写）：`build_read_angle_command()` + `parse_angle_stream()` 透传流解析——滑动查找 `[01 03 08]` 特征头 + CRC 校验 + 大端 f32；处理分帧（BLE MTU 分包）、夹带（WCH 模块自身配置帧 88 07…）、粘包；6 个单测全部用厂商文档向量
- `bluetooth.rs`：
  - `ForceChannelState` 加 `latest_angle`；`SteerAngleEvent` 事件
  - notification_loop 分流：STEER → rx_buf 缓冲 + Modbus 流解析（emit `steer-angle-data`，100ms 节流）；A/B → 0xAA 帧
  - `steer_polling_loop`：连接成功后 10Hz 轮询写读命令（写带 2s 超时，连续失败 5 次自停并通知前端）
- 前端：`use-force` 订阅 `steer-angle-data` → `states.STEER.latestAngle`；转盘页方向盘 X/Y/趋势/峰值跟踪/快照记录统一走 `dispSteerX/Y`（BLE 倾角优先，TCP 遥测兜底），标注角度来源

## 三、验证

- `cargo test` 23/23（含文档向量：发送命令 CRC、应答解析 -2.083/+1.485、分帧、夹带噪声、CRC 拒绝、零角度）
- `tsc` 零错误；`next build` 11/11
- 真机验证：蓝牙连接稳定后（用户已确认），转盘页应显示 X/Y 角度 10Hz 刷新、趋势曲线滚动

## 四、教训与关联

- **先确认协议再写解析**：本次先按商品页"68/77 协议"实现了 BCD 解析，用户纠正为 Modbus RTU 后重写——两次都应以厂商文档向量做单测（好在向量测试让重写后的正确性验证很快）
- WCH 透传流不是干净的帧流：分帧/粘包/夹带模块自身配置帧都需要处理，流式解析（特征头滑动查找 + CRC 门卫）比"单次通知单帧"假设健壮
- 关联：99f4056（BLE 模块）、dce1ab0（连接稳定性修复）
