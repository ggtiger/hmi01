/** 设备命令服务：前端三层封装的中间层（invoke 薄封装） */
import { invoke } from '@tauri-apps/api/core';
import type { DeviceState, LogEntry } from './types';

// ============ 连接管理 ============

export async function connect(ip: string, port: number): Promise<void> {
  return invoke('device_connect', { ip, port });
}

export async function disconnect(): Promise<void> {
  return invoke('device_disconnect');
}

export async function getState(): Promise<DeviceState> {
  return invoke('device_get_state');
}

/** 急停（免等待直发） */
export async function estop(): Promise<void> {
  return invoke('device_estop');
}

export async function infoGet(): Promise<Record<string, unknown>> {
  return invoke('device_info_get');
}

export async function sendRaw(command: string): Promise<void> {
  return invoke('device_send_raw', { command });
}

export async function getDebugLog(): Promise<LogEntry[]> {
  return invoke('device_get_debug_log');
}

// ============ 调试 ============

export async function debugSet(on: boolean): Promise<void> {
  return invoke('debug_set', { on });
}

/** 明文模式切换（特殊编排） */
export async function plainModeSet(enable: boolean): Promise<void> {
  return invoke('plain_mode_set', { enable });
}

// ============ SET 参数 ============

export async function setReport(hz: number): Promise<void> {
  return invoke('set_report', { hz });
}

export async function setPushPulsesPerMm(v: number): Promise<void> {
  return invoke('set_push_pulses_per_mm', { v });
}

export async function setLevelRatio(v: number): Promise<void> {
  return invoke('set_level_ratio', { v });
}

// ============ NET 网络配置 ============

export async function netGetcfg(): Promise<{ ssid: string; pass: string }> {
  return invoke('net_getcfg');
}

export async function netSetcfg(oldPass: string, newSsid: string, newPass: string): Promise<void> {
  return invoke('net_setcfg', { oldPass, newSsid, newPass });
}

export async function netReset(pass: string): Promise<void> {
  return invoke('net_reset', { pass });
}

// ============ PEDAL 踏板 ============

export async function pedalSelect(side: 'A' | 'B' | 'NONE'): Promise<void> {
  return invoke('pedal_select', { side });
}

export async function pedalStart(side: 'A' | 'B'): Promise<void> {
  return invoke('pedal_start', { side });
}

export async function pedalStop(side: 'A' | 'B'): Promise<void> {
  return invoke('pedal_stop', { side });
}

export async function pedalSetload(side: 'A' | 'B', load: number): Promise<void> {
  return invoke('pedal_setload', { side, load });
}

export async function pedalLevel(side: 'A' | 'B'): Promise<void> {
  return invoke('pedal_level', { side });
}

export async function pedalPushStart(side: 'A' | 'B'): Promise<void> {
  return invoke('pedal_push_start', { side });
}

export async function pedalPushStop(side: 'A' | 'B'): Promise<void> {
  return invoke('pedal_push_stop', { side });
}

export async function pedalSet(side: 'A' | 'B', key: string, value: string): Promise<void> {
  return invoke('pedal_set', { side, key, value });
}

export async function pedalZero(side?: 'A' | 'B'): Promise<void> {
  return invoke('pedal_zero', { side: side ?? null });
}

export async function pedalClear(side?: 'A' | 'B'): Promise<void> {
  return invoke('pedal_clear', { side: side ?? null });
}

export async function pedalRecord(side?: 'A' | 'B'): Promise<void> {
  return invoke('pedal_record', { side: side ?? null });
}

// ============ MOTOR 电机 ============

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
