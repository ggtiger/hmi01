import { create } from 'zustand'

interface SettingsStore {
  /** 遥测上报频率 Hz（1-50） */
  reportHz: string
  /** 推杆脉冲当量（10-10000） */
  pulsesPerMm: string
  /** 调平传动比（0.01-100） */
  levelRatio: string
  setReportHz: (v: string) => void
  setPulsesPerMm: (v: string) => void
  setLevelRatio: (v: string) => void
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  reportHz: '10',
  pulsesPerMm: '320',
  levelRatio: '1.0',
  setReportHz: (v) => set({ reportHz: v }),
  setPulsesPerMm: (v) => set({ pulsesPerMm: v }),
  setLevelRatio: (v) => set({ levelRatio: v }),
}))
