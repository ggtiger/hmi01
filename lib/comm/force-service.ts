/** 三通道 BLE 力值服务（invoke 薄封装） */
import { invoke } from '@tauri-apps/api/core';
import type { ForceChannel, ForceChannelState, ForceDeviceInfo } from './types';

export async function forceScan(): Promise<ForceDeviceInfo[]> {
  return invoke('force_scan');
}

export async function forceConnect(channel: ForceChannel, address: string): Promise<void> {
  return invoke('force_connect', { channel, address });
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
