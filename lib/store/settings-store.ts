import { create } from 'zustand'

const COEF_KEY = 'xdesin-force-coefficients'

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

/** 读取通道校正系数（非法值回退 1） */
export function forceCoefficient(coefs: Record<string, string>, channel: string): number {
  const n = Number(coefs[channel])
  return Number.isFinite(n) && n > 0 ? n : 1
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
  setReportHz: (v: string) => void
  setPulsesPerMm: (v: string) => void
  setLevelRatio: (v: string) => void
  setForceCoefficient: (channel: string, v: string) => void
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  reportHz: '10',
  pulsesPerMm: '320',
  levelRatio: '1.0',
  forceCoefficients: loadCoefficients(),
  setReportHz: (v) => set({ reportHz: v }),
  setPulsesPerMm: (v) => set({ pulsesPerMm: v }),
  setLevelRatio: (v) => set({ levelRatio: v }),
  setForceCoefficient: (channel, v) => {
    const next = { ...get().forceCoefficients, [channel]: v }
    saveCoefficients(next)
    set({ forceCoefficients: next })
  },
}))
