/** 设备完整状态（与 Rust DeviceState 对应，snake_case 镜像） */

/** 遥测数据：null 表示 nan（传感器故障 / 未选中侧） */
export interface TelemetryData {
  t: number;
  tilt_x: number | null;
  tilt_y: number | null;
  pedal_a_tilt_x: number | null;
  pedal_a_tilt_y: number | null;
  pedal_b_tilt_x: number | null;
  pedal_b_tilt_y: number | null;
  laser_a: number | null;
  laser_b: number | null;
  pedal_a: number | null;
  pedal_b: number | null;
  ang_cor_a: number | null;
  ang_cor_b: number | null;
  steer_x: number | null;
  steer_y: number | null;
  sensor: 'OK' | 'NG' | string;
  state: 'IDLE' | 'PEDAL_RUN' | 'STEER_RUN' | 'FAULT' | string;
  pedal_select: 'NONE' | 'A' | 'B' | string;
}

export interface DeviceInfo {
  fw: string;
  hw: string;
  uptime: number;
  ssid: string;
}

export interface DeviceState {
  is_connected: boolean;
  plain_mode: boolean;
  device_id: string;
  fw_version: string;
  info: DeviceInfo | null;
  telemetry: TelemetryData;
  last_error: string | null;
}

/** DEBUG 事件行（Rust DebugEvent，pedal-event 事件负载） */
export interface DebugEvent {
  kind: 'LEVELED' | 'STABLE' | 'PUSH_STOPPED' | 'LEVEL_DONE' | 'LEVEL_ABORT' | 'RAW' | string;
  side: 'A' | 'B' | null;
  comp: number | null;
  reason: string | null;
  raw: string;
}

/** ABORT reason 中文说明 */
export const ABORT_REASON_TEXT: Record<string, string> = {
  TILT_TIMEOUT: '倾角仪连续读取失败',
  MOTOR_TIMEOUT: '电机响应失败（步数上限）',
  STEP_TIMEOUT: '调平步数用尽仍未进入死区',
  TILT_NOT_ENABLED: '倾角仪硬件未启用',
  HOME_TIMEOUT: '回原点超时（原点/限位开关故障或报警）',
  HOME_NOT_SUPPORTED: '驱动器不支持回零/无原点开关',
  PUSH_START_FAIL: '回零完成后启动推出失败',
  PUSH_NOT_ENABLED: '推杆电机硬件未启用',
  MANUAL_OVERRIDE: '流程中手动操作该侧电机',
  SELECT_CHANGED: '流程中切换选中侧',
  PEDAL_STOP: '该侧测试停止',
  STOPPED: '全局停止（急停/断连）',
};

export function abortReasonText(reason: string | null | undefined): string {
  if (!reason) return '';
  return ABORT_REASON_TEXT[reason] ?? reason;
}

/** 调试日志条目 */
export interface LogEntry {
  timestamp: string;
  direction: 'TX' | 'RX' | 'SYS' | string;
  content: string;
}

/** 默认状态 */
export const DEFAULT_DEVICE_STATE: DeviceState = {
  is_connected: false,
  plain_mode: false,
  device_id: '',
  fw_version: '',
  info: null,
  telemetry: {
    t: 0,
    tilt_x: null,
    tilt_y: null,
    pedal_a_tilt_x: null,
    pedal_a_tilt_y: null,
    pedal_b_tilt_x: null,
    pedal_b_tilt_y: null,
    laser_a: null,
    laser_b: null,
    pedal_a: null,
    pedal_b: null,
    ang_cor_a: null,
    ang_cor_b: null,
    steer_x: null,
    steer_y: null,
    sensor: 'OK',
    state: 'IDLE',
    pedal_select: 'NONE',
  },
  last_error: null,
};

/** 数值显示：null → "--" */
export function fmtNum(v: number | null | undefined, digits = 2, unit = ''): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '--';
  return `${v.toFixed(digits)}${unit}`;
}

/** 脉冲 → mm（脉冲当量默认 320） */
export function pulsesToMm(pulses: number | null, pulsesPerMm = 320): number | null {
  if (pulses === null || pulses === undefined) return null;
  return pulses / pulsesPerMm;
}

// ===== 四通道 BLE 模块（力值 ×2 / 转向角 / 二路开关） =====

export type ForceChannel = 'A' | 'B' | 'STEER' | 'SWITCH' | 'TORQUE';

export const FORCE_CHANNEL_LABELS: Record<ForceChannel, string> = {
  A: '模块 A（踏板 A 加载力）',
  B: '模块 B（踏板 B 加载力）',
  STEER: '倾角模块（转盘 X/Y）',
  SWITCH: '二路开关（加载控制）',
  TORQUE: '转向力（转盘力值）',
};

/** 力值数据（与 Rust ScaleData 对应，camelCase） */
export interface ForceData {
  /** 设备回传重量原始值（单位 N） */
  weightRaw: number;
  /** 由 N 反算的克数 */
  weightG: number;
  /** 力值（N） */
  weightN: number;
  adCode: number;
  status: number;
  timestamp: number;
}

/** 转向角倾角数据（Modbus RTU 读角度，IEEE754） */
export interface AngleData {
  angleX: number;
  angleY: number;
}

/** BLE 设备扫描结果 */
export interface ForceDeviceInfo {
  /** 平台设备标识（macOS 为 CoreBluetooth UUID，连接用；address 在 macOS 全零） */
  id: string;
  name: string;
  address: string;
  rssi: number | null;
}

/** 单通道状态（与 Rust ForceChannelState 对应） */
export interface ForceChannelState {
  isConnected: boolean;
  deviceName: string;
  deviceAddress: string;
  latest: ForceData | null;
  maxN: number;
  /** STEER 通道：最新倾角 */
  latestAngle: AngleData | null;
  /** SWITCH 通道：开关状态 */
  switchState: SwitchState | null;
}

/** force-data 事件负载 */
export interface ForceDataEvent {
  channel: ForceChannel;
  data: ForceData;
}

/** force-connection-changed 事件负载 */
export interface ForceConnectionEvent {
  channel: ForceChannel;
  state: ForceChannelState;
}

export const DEFAULT_FORCE_STATE: ForceChannelState = {
  isConnected: false,
  deviceName: '',
  deviceAddress: '',
  latest: null,
  maxN: 0,
  latestAngle: null,
  switchState: null,
};

// ===== 二路开关模块（SWITCH 通道，EE 协议） =====

/** 开关状态（单路） */
export interface SwitchState {
  relay: number;
  immediate: boolean;
  on: boolean;
  delaySecs: number;
}
