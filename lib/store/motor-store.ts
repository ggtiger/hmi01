import { create } from 'zustand'
import type { MotorAxis } from '../comm/device-service'

export const MOTOR_AXES: MotorAxis[] = ['A', 'B', 'PUSH_A', 'PUSH_B']

export const AXIS_LABELS: Record<MotorAxis, string> = {
  A: 'A 角度校正',
  B: 'B 角度校正',
  PUSH_A: 'A 推杆',
  PUSH_B: 'B 推杆',
}

interface MotorStore {
  /** 当前选中轴 Tab */
  axis: MotorAxis
  setAxis: (axis: MotorAxis) => void

  /** MOVE 目标位置 */
  targetPos: string
  setTargetPos: (v: string) => void

  /** 进给速度（MSH: °/s；PUSH: RPM） */
  feed: string
  setFeed: (v: string) => void
}

export const useMotorStore = create<MotorStore>((set) => ({
  axis: 'A',
  setAxis: (axis) => set({ axis }),
  targetPos: '0',
  setTargetPos: (v) => set({ targetPos: v }),
  feed: '',
  setFeed: (v) => set({ feed: v }),
}))
