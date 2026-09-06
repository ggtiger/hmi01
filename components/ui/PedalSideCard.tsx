'use client'

import IndustrialCard from './IndustrialCard'
import Button from './Button'
import { fmtNum } from '@/lib/comm/types'
import type { FlowPhase, SideParams } from '@/lib/store/pedal-store'

interface PedalSideCardProps {
  side: 'A' | 'B'
  /** 当前是否为选中侧（未选中置灰） */
  active: boolean
  phase: FlowPhase
  params: SideParams
  /** 遥测切片 */
  tiltX: number | null
  tiltY: number | null
  laser: number | null
  pedalPos: number | null
  angCor: number | null
  onParamChange: (key: keyof SideParams, value: string) => void
  onStart: () => void
  onStop: () => void
  onPushStart: () => void
  onPushStop: () => void
  onLevel: () => void
  onZero: () => void
  onRecord: () => void
  busy?: string | null
}

const PHASE_TEXT: Record<FlowPhase, { text: string; cls: string }> = {
  idle: { text: '待机', cls: 'bg-slate-100 text-slate-600' },
  leveling: { text: '调平中', cls: 'bg-amber-100 text-amber-700 animate-pulse' },
  pushing: { text: '推出中', cls: 'bg-sky-100 text-sky-700 animate-pulse' },
  stable: { text: '已稳定', cls: 'bg-emerald-100 text-emerald-700' },
}

function ParamInput({
  label,
  value,
  onChange,
  disabled,
  unit,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  unit: string
  placeholder?: string
}) {
  return (
    <div className="flex-1 min-w-[100px]">
      <label className="font-label-sm text-on-surface-variant">{label}</label>
      <div className="flex items-center mt-0.5">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          inputMode="decimal"
          className="w-full px-2 py-1.5 rounded-l-lg border border-outline-variant monospaced-data text-body-md focus:outline-none focus:border-primary disabled:bg-surface-container disabled:text-outline"
        />
        <span className="px-2 py-1.5 rounded-r-lg border border-l-0 border-outline-variant bg-surface-container-low font-label-sm text-on-surface-variant">
          {unit}
        </span>
      </div>
    </div>
  )
}

/** 单侧踏板卡片：参数 + 启停 + 推杆 + 调平 + 记录 */
export default function PedalSideCard(p: PedalSideCardProps) {
  const phase = PHASE_TEXT[p.phase]
  const dis = !p.active

  return (
    <IndustrialCard
      title={`${p.side} 侧踏板`}
      headerBg={p.side === 'A' ? 'bg-sky-50' : 'bg-violet-50'}
      borderLeftColor={p.side === 'A' ? '#0284c7' : '#7c3aed'}
      headerRight={
        <div className="flex items-center gap-3">
          <span className={`px-2.5 py-1 rounded-full font-label-bold text-label-sm ${phase.cls}`}>
            {phase.text}
          </span>
          {!p.active && (
            <span className="font-label-sm text-outline">未选中（置灰）</span>
          )}
        </div>
      }
      className={dis ? 'opacity-60 pointer-events-none select-none' : ''}
    >
      <div className="p-4 space-y-3">
        {/* 实时数据 */}
        <div className="grid grid-cols-4 gap-3 rounded-lg bg-surface-container-low px-3 py-2">
          <div>
            <div className="font-label-sm text-on-surface-variant">倾角 X</div>
            <div className="monospaced-data font-label-bold">{fmtNum(p.tiltX, 3)}°</div>
          </div>
          <div>
            <div className="font-label-sm text-on-surface-variant">倾角 Y</div>
            <div className="monospaced-data font-label-bold">{fmtNum(p.tiltY, 3)}°</div>
          </div>
          <div>
            <div className="font-label-sm text-on-surface-variant">激光</div>
            <div className="monospaced-data font-label-bold">{fmtNum(p.laser, 1)}mm</div>
          </div>
          <div>
            <div className="font-label-sm text-on-surface-variant">推杆位置</div>
            <div className="monospaced-data font-label-bold">{fmtNum(p.pedalPos, 0)}</div>
            <div className="font-label-sm text-outline">校正角 {fmtNum(p.angCor, 2)}°</div>
          </div>
        </div>

        {/* 参数 */}
        <div className="flex gap-3">
          <ParamInput
            label="推出距离 PUSH_DIST"
            value={p.params.pushDist}
            onChange={(v) => p.onParamChange('pushDist', v)}
            disabled={dis}
            unit="mm"
            placeholder="0-500"
          />
          <ParamInput
            label="角度补偿 ANGLE_COMP"
            value={p.params.angleComp}
            onChange={(v) => p.onParamChange('angleComp', v)}
            disabled={dis}
            unit="°"
          />
          <ParamInput
            label="终末高度 END_H"
            value={p.params.endH}
            onChange={(v) => p.onParamChange('endH', v)}
            disabled={dis}
            unit="mm"
          />
        </div>

        {/* 操作按钮 */}
        <div className="grid grid-cols-4 gap-2">
          {p.phase === 'idle' ? (
            <Button onClick={p.onStart} disabled={dis} icon="play_arrow" className="justify-center">
              START
            </Button>
          ) : (
            <Button variant="critical" onClick={p.onStop} disabled={dis} icon="stop" className="justify-center">
              STOP
            </Button>
          )}
          {p.phase === 'pushing' ? (
            <Button variant="critical" onClick={p.onPushStop} disabled={dis} icon="swipe_down" className="justify-center">
              PUSH 停
            </Button>
          ) : (
            <Button onClick={p.onPushStart} disabled={dis} icon="swipe_up" className="justify-center">
              PUSH 启动
            </Button>
          )}
          <Button variant="ghost" onClick={p.onLevel} disabled={dis} icon="straighten" className="justify-center">
            调平
          </Button>
          <div className="grid grid-cols-3 gap-1">
            <Button variant="ghost" onClick={p.onZero} disabled={dis} className="justify-center !px-1" >
              清零
            </Button>
            <Button variant="ghost" onClick={p.onRecord} disabled={dis} className="justify-center !px-1">
              记录
            </Button>
            <Button variant="ghost" onClick={() => {}} disabled className="justify-center !px-1 opacity-0 pointer-events-none">
              -
            </Button>
          </div>
        </div>
        {p.busy && (
          <div className="font-label-sm text-amber-700 bg-amber-50 rounded px-2 py-1">{p.busy}</div>
        )}
      </div>
    </IndustrialCard>
  )
}
