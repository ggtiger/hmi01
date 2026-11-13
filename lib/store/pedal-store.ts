import { create } from 'zustand'
import type { DebugEvent, TelemetryData } from '../comm/types'

export type PedalSide = 'A' | 'B'
export type SideSelection = 'A' | 'B' | 'NONE'
export type FlowPhase = 'idle' | 'leveling' | 'pushing' | 'stable'

/** 设计稿数据面板记录点类型 */
export type RecordPointKey =
  | 'startH'      // 起始高度
  | 'endH'        // 终末高度
  | 'heightDiff'  // 高度差
  | 'startDepth'  // 起始进深
  | 'endDepth'    // 终末进深
  | 'depthDiff'   // 进深差
  | 'processForce'// 进程力值

export const RECORD_POINT_LABELS: Record<RecordPointKey, string> = {
  startH: '起始高度',
  endH: '终末高度',
  heightDiff: '高度差',
  startDepth: '起始进深',
  endDepth: '终末进深',
  depthDiff: '进深差',
  processForce: '进程力值',
}

/** 通用记录点（设计稿「记录」按钮快照 + 稳定时遥测快照） */
export interface MeasurePoint {
  index: number
  timestamp: string
  side: SideSelection
  /** 记录类型：字段名（起始高度…）或「遥测快照」 */
  key: string
  value: number | null
  unit: string
  /** 遥测快照附带数据 */
  tilt_x?: number | null
  tilt_y?: number | null
  laser?: number | null
  pedal_pos?: number | null
  ang_cor?: number | null
}

/** 趋势点 */
export interface TrendPoint {
  t: number
  label: string
  tilt_y: number | null
  tilt_x: number | null
  pedal_mm: number | null
}

const MAX_TREND = 100
const MAX_EVENTS = 100

/** 单侧工作区参数 */
export interface SideParams {
  pushDist: string      // 推出距离 mm（0-500）
  angleComp: string     // 角度补偿 °
  startH: string        // 起始高度 mm（下发 START_H）
  endH: string          // 终末高度 mm（下发 END_H）
  setAngle: string      // 调平电机目标角度 °
  setLoad: string       // 加载力 N（0-500）
}

interface SideState {
  phase: FlowPhase
  params: SideParams
}

interface PedalStore {
  side: SideSelection
  setSide: (side: SideSelection) => void

  sides: Record<PedalSide, SideState>
  setPhase: (side: PedalSide, phase: FlowPhase) => void
  setParam: (side: PedalSide, key: keyof SideParams, value: string) => void

  events: DebugEvent[]
  pushEvent: (ev: DebugEvent) => void
  clearEvents: () => void

  trend: TrendPoint[]
  pushTrend: (t: TelemetryData) => void
  clearTrend: () => void

  records: MeasurePoint[]
  addRecord: (p: Omit<MeasurePoint, 'index'>) => void
  removeRecord: (index: number) => void
  clearRecords: () => void
}

function defaultSide(): SideState {
  return {
    phase: 'idle',
    params: {
      pushDist: '25.0',
      angleComp: '0',
      startH: '0',
      endH: '0',
      setAngle: '0',
      setLoad: '0',
    },
  }
}

export const usePedalStore = create<PedalStore>((set) => ({
  side: 'A',
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
        // 新固件 TELEMETRY.pedal_a/b 已按脉冲当量换算为 mm（协议 §14.1）
        pedal_mm: pedal,
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
