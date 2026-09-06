'use client'

import IndustrialCard from './IndustrialCard'
import Button from './Button'
import { fmtNum } from '@/lib/comm/types'
import type { MotorAxis } from '@/lib/comm/device-service'
import { AXIS_LABELS } from '@/lib/store/motor-store'

interface MotorAxisPanelProps {
  axis: MotorAxis
  /** 当前位置（MSH: °；PUSH: mm） */
  position: number | null
  unit: string
  targetPos: string
  feed: string
  onTargetPosChange: (v: string) => void
  onFeedChange: (v: string) => void
  onMove: () => void
  onMoveabs: () => void
  onHome: () => void
  onStop: () => void
  onZero: () => void
}

/** 单轴控制面板 */
export default function MotorAxisPanel(p: MotorAxisPanelProps) {
  const isPush = p.axis.startsWith('PUSH')

  return (
    <IndustrialCard
      title={`${AXIS_LABELS[p.axis]}（${p.axis}）`}
      headerRight={
        <div className="flex items-baseline gap-1">
          <span className="font-label-sm text-on-surface-variant">当前位置</span>
          <span className="monospaced-data text-headline-md font-bold text-primary">
            {fmtNum(p.position, 3)}
          </span>
          <span className="font-label-sm text-on-surface-variant">{p.unit}</span>
        </div>
      }
    >
      <div className="p-4 space-y-3">
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="font-label-sm text-on-surface-variant">
              {isPush ? '目标行程（相对，负值收回）' : '目标角度（绝对位置）'}
            </label>
            <div className="flex items-center mt-0.5">
              <input
                value={p.targetPos}
                onChange={(e) => p.onTargetPosChange(e.target.value)}
                inputMode="decimal"
                placeholder={isPush ? 'mm' : '°'}
                className="w-full px-3 py-2 rounded-l-lg border border-outline-variant monospaced-data text-body-md focus:outline-none focus:border-primary"
              />
              <span className="px-2 py-2 rounded-r-lg border border-l-0 border-outline-variant bg-surface-container-low font-label-sm text-on-surface-variant">
                {p.unit}
              </span>
            </div>
          </div>
          <div className="w-32">
            <label className="font-label-sm text-on-surface-variant">
              进给 F（{isPush ? 'RPM' : '°/s'}）
            </label>
            <input
              value={p.feed}
              onChange={(e) => p.onFeedChange(e.target.value)}
              inputMode="decimal"
              placeholder={isPush ? '默认 60' : '不限速'}
              className="mt-0.5 w-full px-3 py-2 rounded-lg border border-outline-variant monospaced-data text-body-md focus:outline-none focus:border-primary"
            />
          </div>
        </div>

        <div className="grid grid-cols-5 gap-2">
          <Button onClick={p.onMove} icon="arrow_outward" className="justify-center">
            MOVE
          </Button>
          <Button onClick={p.onMoveabs} disabled={!isPush} className="justify-center">
            MOVEABS
          </Button>
          <Button variant="ghost" onClick={p.onHome} icon="home" className="justify-center">
            回零
          </Button>
          <Button variant="critical" onClick={p.onStop} icon="stop" className="justify-center">
            停止
          </Button>
          <Button variant="ghost" onClick={p.onZero} icon="exposure_zero" className="justify-center">
            置零
          </Button>
        </div>
        {!isPush && (
          <div className="font-label-sm text-outline">MOVEABS 仅 PUSH 轴支持；MSH 轴 MOVE 即绝对定位</div>
        )}
      </div>
    </IndustrialCard>
  )
}
