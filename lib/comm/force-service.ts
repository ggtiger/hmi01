/** 三通道 BLE 力值服务（invoke 薄封装） */
import { invoke } from '@tauri-apps/api/core';
import type { ForceChannel, ForceChannelState, ForceDeviceInfo } from './types';

export async function forceScan(): Promise<ForceDeviceInfo[]> {
  return invoke('force_scan');
}

export async function forceConnect(channel: ForceChannel, deviceId: string): Promise<void> {
  return invoke('force_connect', { channel, deviceId });
}

export async function forceDisconnect(channel: ForceChannel): Promise<void> {
  return invoke('force_disconnect', { channel });
}

/** 零点校准（清零） */
export async function forceZero(channel: ForceChannel): Promise<void> {
  return invoke('force_zero', { channel });
}

/** 砝码标定（校准） */
export async function forceCalibrate(channel: ForceChannel, weight: number): Promise<void> {
  return invoke('force_calibrate', { channel, weight });
}

/** 重置会话最大力值 */
export async function forceResetMax(channel: ForceChannel): Promise<void> {
  return invoke('force_reset_max', { channel });
}

export async function forceGetState(): Promise<Record<string, ForceChannelState>> {
  return invoke('force_get_state');
}

// ============ 手动调试 ============

/** 手动发送原始 hex 数据（如 "03 03 00 01 00 04 15 C9"） */
export async function forceSendRaw(channel: ForceChannel, hex: string): Promise<void> {
  return invoke('force_send_raw', { channel, hex });
}

/** 开关原始数据监视（每帧通知原始 hex 全量上报） */
export async function forceRawMonitor(channel: ForceChannel, on: boolean): Promise<void> {
  return invoke('force_raw_monitor', { channel, on });
}

/** 二路开关控制：action = on | off | momentary | query | delay_on | delay_off */
export async function forceSwitchControl(
  relay: 1 | 2,
  action: 'on' | 'off' | 'momentary' | 'query' | 'delay_on' | 'delay_off',
  seconds?: number
): Promise<void> {
  return invoke('force_switch_control', { relay, action, seconds: seconds ?? null });
}
