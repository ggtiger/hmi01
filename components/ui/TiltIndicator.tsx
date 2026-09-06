'use client'

import { fmtNum } from '@/lib/comm/types'

interface TiltIndicatorProps {
  tiltX: number | null
  tiltY: number | null
  label?: string
  /** 死区半径（°），气泡在死区内显示绿色 */
  deadZone?: number
}

/**
 * 双轴倾角气泡可视化
 * 圆盘代表水平面，气泡位置表示倾角（量程 ±2°）
 */
export default function TiltIndicator({ tiltX, tiltY, label, deadZone = 0.05 }: TiltIndicatorProps) {
  const RANGE = 2.0 // 显示量程 ±2°

  const valid = tiltX !== null && tiltY !== null
  // clamp 到 [-RANGE, RANGE]
  const x = valid ? Math.max(-RANGE, Math.min(RANGE, tiltX)) : 0
  const y = valid ? Math.max(-RANGE, Math.min(RANGE, tiltY)) : 0
  // 归一化到 0~1（注意屏幕 Y 向下）
  const px = 50 + (x / RANGE) * 40
  const py = 50 - (y / RANGE) * 40
  const inDeadZone = valid && Math.abs(tiltX!) <= deadZone && Math.abs(tiltY!) <= deadZone

  return (
    <div className="flex flex-col items-center gap-2 select-none">
      <div className="relative w-36 h-36 rounded-full bg-gradient-to-b from-slate-50 to-slate-200 border-2 border-outline-variant overflow-hidden">
        {/* 同心刻度环 */}
        <div className="absolute inset-4 rounded-full border border-dashed border-outline-variant opacity-60" />
        <div className="absolute inset-9 rounded-full border border-dashed border-outline-variant opacity-60" />
        {/* 十字准线 */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-outline-variant opacity-50" />
        <div className="absolute top-1/2 left-0 right-0 h-px bg-outline-variant opacity-50" />
        {/* 死区中心圆 */}
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-200 opacity-50"
          style={{ width: `${(deadZone / RANGE) * 80}%`, height: `${(deadZone / RANGE) * 80}%` }}
        />
        {/* 气泡 */}
        <div
          className={`absolute w-5 h-5 rounded-full -translate-x-1/2 -translate-y-1/2 transition-all duration-100 shadow-md ${
            !valid ? 'bg-gray-400' : inDeadZone ? 'bg-emerald-500 shadow-emerald-300' : 'bg-amber-500 shadow-amber-300'
          }`}
          style={{ left: `${valid ? px : 50}%`, top: `${valid ? py : 50}%` }}
        />
      </div>
      <div className="text-center">
        {label && <div className="font-label-bold text-label-sm text-on-surface-variant">{label}</div>}
        <div className="font-label-sm monospaced-data text-on-surface">
          X {fmtNum(tiltX, 3)}° · Y {fmtNum(tiltY, 3)}°
        </div>
      </div>
    </div>
  )
}
