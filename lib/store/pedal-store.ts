import { create } from 'zustand'
import type { DebugEvent, TelemetryData } from '../comm/types'
import { useSettingsStore } from './settings-store'

export type PedalSide = 'A' | 'B'
export type SideSelection = 'A' | 'B' | 'NONE'
export type FlowPhase = 'idle' | 'leveling' | 'pushing' | 'stable'

/** 单侧踏板可编辑参数 */
export interface SideParams {
  pushDist: string      // 推出距离 mm（0-500）
  angleComp: string     // 角度补偿 °
  endH: string          // 终末高度 mm
}

/** 记录点（RECORD 抓取的遥测快照） */
export interface MeasurePoint {
  index: number
  timestamp: string
  side: SideSelection
  tilt_x: number | null
  tilt_y: number | null
  laser: number | null
  pedal_pos: number | null   // mm
  ang_cor: number | null
  angle_comp: number | null
}

/** 趋势点 */
export interface TrendPoint {
  t: number        // 遥测 t (ms)
  label: string
  tilt_y: number | null
  tilt_x: number | null
  pedal_mm: number | null
}

const MAX_TREND = 100
const MAX_EVENTS = 100

interface SideState {
  phase: FlowPhase
  params: SideParams
}

interface PedalStore {
  // 选中侧（与设备同步）
  side: SideSelection
  setSide: (side: SideSelection) => void

  // 每侧流程阶段 + 参数
  sides: Record<PedalSide, SideState>
  setPhase: (side: PedalSide, phase: FlowPhase) => void
  setParam: (side: PedalSide, key: keyof SideParams, value: string) => void

  // DEBUG 事件时间线
  events: DebugEvent[]
  pushEvent: (ev: DebugEvent) => void
  clearEvents: () => void

  // 趋势数据（选中侧）
  trend: TrendPoint[]
  pushTrend: (t: TelemetryData) => void
  clearTrend: () => void

  // 记录点
  records: MeasurePoint[]
  addRecord: (p: Omit<MeasurePoint, 'index'>) => void
  removeRecord: (index: number) => void
  clearRecords: () => void
}

function defaultSide(): SideState {
  return {
    phase: 'idle',
    params: { pushDist: '25.0', angleComp: '0', endH: '' },
  }
}

export const usePedalStore = create<PedalStore>((set) => ({
  side: 'NONE',
  setSide: (side) => set({ side }),

  sides: { A: defaultSide(), B: defaultSide() },
  setPhase: (side, phase) =>
    set((s) => ({ sides: { ...s.sides, [side]: { ...s.sides[side], phase } } })),
  setParam: (side, key, value) =>
    set((s) => ({
      sides: {
        ...s.sides,
        [side]: { ...s.sides[side], params: { ...s.sides[side].params, [key]: value } },
      },
    })),

  events: [],
  pushEvent: (ev) =>
    set((s) => {
      const events = [...s.events, ev]
      return { events: events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events }
    }),
  clearEvents: () => set({ events: [] }),

  trend: [],
  pushTrend: (t) =>
    set((s) => {
      // 取选中侧数据；NONE 侧取公用倾角
      const isA = s.side !== 'B'
      const tiltY = s.side === 'NONE' ? t.tilt_y : isA ? t.pedal_a_tilt_y : t.pedal_b_tilt_y
      const tiltX = s.side === 'NONE' ? t.tilt_x : isA ? t.pedal_a_tilt_x : t.pedal_b_tilt_x
      const pedal = isA ? t.pedal_a : t.pedal_b
      const now = new Date()
      const label = `${now.getMinutes().toString().padStart(2, '0')}:${now
        .getSeconds()
        .toString()
        .padStart(2, '0')}`
      const point: TrendPoint = {
        t: t.t,
        label,
        tilt_y: tiltY,
        tilt_x: tiltX,
        // 脉冲当量取设置页可配置值（协议 §2.6 SET PUSH_PULSES_PER_MM）
        pedal_mm:
          pedal === null
            ? null
            : pedal / (Number(useSettingsStore.getState().pulsesPerMm) || 320),
      }
      const trend = [...s.trend, point]
      return { trend: trend.length > MAX_TREND ? trend.slice(-MAX_TREND) : trend }
    }),
  clearTrend: () => set({ trend: [] }),

  records: [],
  addRecord: (p) =>
    set((s) => ({
      records: [...s.records, { ...p, index: s.records.length + 1 }],
    })),
  removeRecord: (index) =>
    set((s) => ({
      records: s.records
        .filter((r) => r.index !== index)
        .map((r, i) => ({ ...r, index: i + 1 })),
    })),
  clearRecords: () => set({ records: [] }),
}))
