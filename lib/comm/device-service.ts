/** 设备命令服务：前端三层封装的中间层（invoke 薄封装） */
import { invoke } from '@tauri-apps/api/core';
import type { BoardSide, DeviceState, LogEntry } from './types';

// ============ 连接管理（A/B 双板独立） ============

export async function connect(side: BoardSide, ip: string, port: number): Promise<void> {
  return invoke('device_connect', { side, ip, port });
}

export async function disconnect(side: BoardSide): Promise<void> {
  return invoke('device_disconnect', { side });
}

export async function getState(side: BoardSide): Promise<DeviceState> {
  return invoke('device_get_state', { side });
}

/** 启动时读取两块板状态 */
export async function getBoardStates(): Promise<{ a: DeviceState; b: DeviceState }> {
  return invoke('device_get_board_states');
}

/** 急停（免等待直发，两块板同时下发） */
export async function estop(): Promise<void> {
  return invoke('device_estop');
}

export async function infoGet(side: BoardSide): Promise<Record<string, unknown>> {
  return invoke('device_info_get', { side });
}

export async function sendRaw(side: BoardSide, command: string): Promise<void> {
  return invoke('device_send_raw', { side, command });
}

export async function getDebugLog(): Promise<LogEntry[]> {
  return invoke('device_get_debug_log');
}

// ============ 调试 ============

export async function debugSet(side: BoardSide, on: boolean): Promise<void> {
  return invoke('debug_set', { side, on });
}

/** 明文模式切换（特殊编排，按板） */
export async function plainModeSet(side: BoardSide, enable: boolean): Promise<void> {
  return invoke('plain_mode_set', { side, enable });
}

// ============ SET 参数（全局参数同时下发两块板） ============

export async function setReport(hz: number): Promise<void> {
  return invoke('set_report', { hz });
}

export async function setLevelMethod(method: number): Promise<void> {
  return invoke('set_level_method', { method });
}

export async function setPushPulsesPerMm(v: number): Promise<void> {
  return invoke('set_push_pulses_per_mm', { v });
}

export async function setPushFeed(v: number): Promise<void> {
  return invoke('set_push_feed', { v });
}

export async function setLevelSpeed(v: number): Promise<void> {
  return invoke('set_level_speed', { v });
}

export async function setLevelTol(v: number): Promise<void> {
  return invoke('set_level_tol', { v });
}

export async function setLevelRatio(v: number): Promise<void> {
  return invoke('set_level_ratio', { v });
}

/** 清除指定板的 MSH 软件零点 */
export async function setMshZeroClear(side: BoardSide): Promise<void> {
  return invoke('set_msh_zero_clear', { side });
}

/** 运行时修改板侧（写 NVS） */
export async function setBoardSide(side: BoardSide, newSide: BoardSide): Promise<void> {
  return invoke('set_board_side', { side, newSide });
}

/** 读取固件参数 */
export async function getParams(side: BoardSide): Promise<Record<string, string>> {
  return invoke('get_params', { side });
}

/** 扫描 Modbus 从站（结果以通信日志行返回） */
export async function scanModbus(side: BoardSide, start: number, end: number): Promise<void> {
  return invoke('scan_modbus', { side, start, end });
}

/** 故障复位（ESTOP 后恢复入口；不传 side 则两块板都复位） */
export async function resetFault(side?: BoardSide): Promise<void> {
  return invoke('reset_fault', { side: side ?? null });
}

// ============ NET 网络配置（按板） ============

export async function netGetcfg(side: BoardSide): Promise<{ ssid: string; pass: string }> {
  return invoke('net_getcfg', { side });
}

export async function netSetcfg(
  side: BoardSide,
  oldPass: string,
  newSsid: string,
  newPass: string
): Promise<void> {
  return invoke('net_setcfg', { side, oldPass, newSsid, newPass });
}

export async function netReset(side: BoardSide, pass: string): Promise<void> {
  return invoke('net_reset', { side, pass });
}

// ============ PEDAL 踏板 ============

export async function pedalSelect(side: 'A' | 'B' | 'NONE'): Promise<void> {
  return invoke('pedal_select', { side });
}

export async function pedalStart(side: BoardSide): Promise<void> {
  return invoke('pedal_start', { side });
}

export async function pedalStop(side: BoardSide): Promise<void> {
  return invoke('pedal_stop', { side });
}

/** 兼容旧协议：两侧同时开始自动流程 */
export async function pedalTestStart(): Promise<void> {
  return invoke('pedal_test_start');
}

/** 兼容旧协议：两侧同时停止自动流程 */
export async function pedalTestStop(): Promise<void> {
  return invoke('pedal_test_stop');
}

export async function pedalSetload(side: BoardSide, load: number): Promise<void> {
  return invoke('pedal_setload', { side, load });
}

export async function pedalLevel(side: BoardSide): Promise<void> {
  return invoke('pedal_level', { side });
}

export async function pedalPushStart(side: BoardSide): Promise<void> {
  return invoke('pedal_push_start', { side });
}

export async function pedalPushStop(side: BoardSide): Promise<void> {
  return invoke('pedal_push_stop', { side });
}

export async function pedalSet(side: BoardSide, key: string, value: string): Promise<void> {
  return invoke('pedal_set', { side, key, value });
}

export async function pedalZero(side?: BoardSide): Promise<void> {
  return invoke('pedal_zero', { side: side ?? null });
}

export async function pedalClear(side?: BoardSide): Promise<void> {
  return invoke('pedal_clear', { side: side ?? null });
}

export async function pedalRecord(side?: BoardSide): Promise<void> {
  return invoke('pedal_record', { side: side ?? null });
}

// ============ MOTOR 电机（轴名决定板侧） ============

export type MotorAxis = 'A' | 'B' | 'PUSH_A' | 'PUSH_B';

export async function motorEnable(): Promise<void> {
  return invoke('motor_enable');
}

export async function motorDisable(): Promise<void> {
  return invoke('motor_disable');
}

export async function motorStopAll(): Promise<void> {
  return invoke('motor_stop_all');
}

export async function motorMove(axis: MotorAxis, pos: number, feed?: number): Promise<void> {
  return invoke('motor_move', { axis, pos, feed: feed ?? null });
}

export async function motorMoveabs(axis: MotorAxis, pos: number, feed?: number): Promise<void> {
  return invoke('motor_moveabs', { axis, pos, feed: feed ?? null });
}

export async function motorHome(axis: MotorAxis): Promise<void> {
  return invoke('motor_home', { axis });
}

export async function motorStop(axis: MotorAxis): Promise<void> {
  return invoke('motor_stop', { axis });
}

export async function motorZero(axis: MotorAxis): Promise<void> {
  return invoke('motor_zero', { axis });
}

// ============ STEER 转盘测试 ============

export async function steerStart(): Promise<void> {
  return invoke('steer_start');
}

export async function steerStop(): Promise<void> {
  return invoke('steer_stop');
}
