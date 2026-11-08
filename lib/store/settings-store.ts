import { create } from 'zustand'
import type { ForceChannelState } from '@/lib/comm/types'

const COEF_KEY = 'xdesin-force-coefficients'
const AD_CAL_KEY = 'xdesin-force-ad-calibration'

/** 力值校正系数：key = ForceChannel，value = 系数字符串（默认 1） */
function loadCoefficients(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(COEF_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveCoefficients(coefs: Record<string, string>) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(COEF_KEY, JSON.stringify(coefs))
  } catch { /* 忽略存储异常 */ }
}

/** AD 内码标定：zeroAd = 空载零点 AD，nPerAd = 每 AD 内码对应的牛顿数 */
export interface AdCalibration {
  zeroAd: number
  nPerAd: number
}

function loadAdCalibration(): Record<string, AdCalibration> {
  if (typeof window === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(AD_CAL_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveAdCalibration(cal: Record<string, AdCalibration>) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(AD_CAL_KEY, JSON.stringify(cal))
  } catch { /* 忽略存储异常 */ }
}

/** 读取通道校正系数（非法值回退 1） */
export function forceCoefficient(coefs: Record<string, string>, channel: string): number {
  const n = Number(coefs[channel])
  return Number.isFinite(n) && n > 0 ? n : 1
}

/**
 * 计算通道力值（N）。
 *
 * 优先使用设备回传重量（mg → N，SSTS 方式）：weightN × 软件系数；
 * 设备重量无效（≈0）且有 AD 标定时，回退到 AD 内码换算：
 *   (adCode − zeroAd) × nPerAd × 系数
 */
export function channelForceN(
  st: ForceChannelState,
  channel: string,
  coefficients: Record<string, string>,
  adCalibration: Record<string, AdCalibration>
): number | null {
  if (!st.isConnected || !st.latest) return null
  const coef = forceCoefficient(coefficients, channel)
  // 设备重量字段有效（mg 换算后非零）→ SSTS 方式
  if (Math.abs(st.latest.weightN) >= 0.01) {
    return st.latest.weightN * coef
  }
  // 重量无效 → AD 内码标定兜底
  const cal = adCalibration[channel]
  if (cal && Number.isFinite(cal.nPerAd) && cal.nPerAd !== 0) {
    return (st.latest.adCode - cal.zeroAd) * cal.nPerAd * coef
  }
  return st.latest.weightN * coef
}

interface SettingsStore {
  /** 遥测上报频率 Hz（1-50） */
  reportHz: string
  /** 推杆脉冲当量（10-10000） */
  pulsesPerMm: string
  /** 调平传动比（0.01-100） */
  levelRatio: string
  /** 力值校正系数（按蓝牙通道，默认 1） */
  forceCoefficients: Record<string, string>
  /** 力值 AD 内码标定（按通道） */
  adCalibration: Record<string, AdCalibration>
  setReportHz: (v: string) => void
  setPulsesPerMm: (v: string) => void
  setLevelRatio: (v: string) => void
  setForceCoefficient: (channel: string, v: string) => void
  /** 记录空载零点 AD（保留已标定的 nPerAd） */
  setAdZero: (channel: string, zeroAd: number) => void
  /** 设置完整 AD 标定 */
  setAdCalibration: (channel: string, cal: AdCalibration) => void
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  reportHz: '10',
  pulsesPerMm: '320',
  levelRatio: '1.0',
  forceCoefficients: loadCoefficients(),
  adCalibration: loadAdCalibration(),
  setReportHz: (v) => set({ reportHz: v }),
  setPulsesPerMm: (v) => set({ pulsesPerMm: v }),
  setLevelRatio: (v) => set({ levelRatio: v }),
  setForceCoefficient: (channel, v) => {
    const next = { ...get().forceCoefficients, [channel]: v }
    saveCoefficients(next)
    set({ forceCoefficients: next })
  },
  setAdZero: (channel, zeroAd) => {
    const prev = get().adCalibration[channel]
    const next = {
      ...get().adCalibration,
      [channel]: { zeroAd, nPerAd: prev?.nPerAd ?? 0 },
    }
    saveAdCalibration(next)
    set({ adCalibration: next })
  },
  setAdCalibration: (channel, cal) => {
    const next = { ...get().adCalibration, [channel]: cal }
    saveAdCalibration(next)
    set({ adCalibration: next })
  },
}))
