'use client'

import { memo } from 'react'
import { fmtNum } from '@/lib/comm/types'
import type { TelemetryData } from '@/lib/comm/types'
import type { PedalSide, SideParams } from '@/lib/store/pedal-store'
import { useT } from '@/lib/i18n'

/** 数据行：标签 + 值 + 可选操作按钮（玻璃行） */
function DataRow({
  label,
  value,
  unit,
  digits = 3,
  accent,
  actions,
}: {
  label: string
  value: number | null
  unit: string
  digits?: number
  accent?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="glass-row flex-1 min-w-0">
        <span className="k">
          {label} <em>{unit}</em>
        </span>
        <span className={`v ${accent ?? ''}`}>{fmtNum(value, digits)}</span>
      </div>
      {actions}
    </div>
  )
}

function MiniBtn({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="glass-btn !h-[34px] !px-2.5 !text-[12px] flex-shrink-0"
    >
      {children}
    </button>
  )
}

interface PedalDataPanelProps {
  side: PedalSide
  telemetry: TelemetryData
  params: SideParams
  /** 高度记录点现场值（mm） */
  fieldValues: {
    startH: number | null
    endH: number | null
  }
  pulsesPerMm: number
  connected: boolean
  busy: boolean
  /** BLE 力值（当前侧通道）：实时 / 会话最大 / 滑动平均（均匀力值） */
  forceLive: number | null
  forceMax: number | null
  avgForce: number | null
  onParamChange: (key: keyof SideParams, value: string) => void
  onZero: () => void
  onRecordField: (field: 'startH' | 'endH' | 'heightDiff' | 'force') => void
  onClearField: (field: 'startH' | 'endH') => void
  onMotorMove: () => void
  onLevel: () => void
  onPushStart: () => void
  onJog: (dir: 1 | -1) => void
  onSetLoadApply: () => void
  onPushDistApply: () => void
}

/**
 * 左侧数据面板（对齐《软件UI》PPT 踏板测试页）：
 * 倾角 → 垂直测距 → 起始/终末高度/高度差 → 实时/最大/均匀力值 → 电机控制部分
 */
function PedalDataPanelImpl(p: PedalDataPanelProps) {
  const tr = useT()
  const t = p.telemetry
  const isA = p.side === 'A'
  const tiltX = isA ? t.pedal_a_tilt_x : t.pedal_b_tilt_x
  const tiltY = isA ? t.pedal_a_tilt_y : t.pedal_b_tilt_y
  const laser = isA ? t.laser_a : t.laser_b

  const heightDiff =
    p.fieldValues.startH !== null && p.fieldValues.endH !== null
      ? p.fieldValues.endH - p.fieldValues.startH
      : null

  const dis = !p.connected || p.busy

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* 倾角 */}
      <div className="grid grid-cols-2 gap-2">
        <div className="glass-row">
          <span className="k">{tr('倾角 X')} <em>°</em></span>
          <span className="v">{fmtNum(tiltX, 3)}</span>
        </div>
        <div className="glass-row">
          <span className="k">{tr('倾角 Y')} <em>°</em></span>
          <span className="v">{fmtNum(tiltY, 3)}</span>
        </div>
      </div>

      {/* 垂直测距 */}
      <DataRow
        label={tr('垂直测距')}
        unit="mm"
        value={laser}
        actions={<MiniBtn onClick={p.onZero} disabled={dis}>{tr('清零')}</MiniBtn>}
      />

      {/* 高度记录区 */}
      <DataRow
        label={tr('起始高度')}
        unit="mm"
        value={p.fieldValues.startH}
        actions={
          <>
            <MiniBtn onClick={() => p.onRecordField('startH')} disabled={!p.connected}>{tr('记录')}</MiniBtn>
            <MiniBtn onClick={() => p.onClearField('startH')} disabled={!p.connected}>{tr('清除')}</MiniBtn>
          </>
        }
      />
      <DataRow
        label={tr('终末高度')}
        unit="mm"
        value={p.fieldValues.endH}
        actions={
          <>
            <MiniBtn onClick={() => p.onRecordField('endH')} disabled={!p.connected}>{tr('记录')}</MiniBtn>
            <MiniBtn onClick={() => p.onClearField('endH')} disabled={!p.connected}>{tr('清除')}</MiniBtn>
          </>
        }
      />
      <DataRow
        label={tr('高度差')}
        unit="mm"
        value={heightDiff}
        accent="cyan"
        actions={
          <>
            <MiniBtn onClick={() => p.onRecordField('heightDiff')} disabled={!p.connected}>{tr('记录')}</MiniBtn>
            <MiniBtn
              onClick={() => { p.onClearField('startH'); p.onClearField('endH') }}
              disabled={!p.connected}
            >
              {tr('清除')}
            </MiniBtn>
          </>
        }
      />

      {/* 力值 */}
      <DataRow
        label={tr('实时力值')}
        unit="N"
        value={p.forceLive}
        digits={2}
        accent="cyan"
        actions={
          <>
            <MiniBtn onClick={() => p.onRecordField('force')} disabled={!p.connected}>{tr('记录')}</MiniBtn>
            <MiniBtn disabled>{tr('清除')}</MiniBtn>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-2">
        <div className="glass-row">
          <span className="k">{tr('最大力值')} <em>N</em></span>
          <span className="v">{fmtNum(p.forceMax, 2)}</span>
        </div>
        <div className="glass-row">
          <span className="k">{tr('均匀力值')} <em>N</em></span>
          <span className="v">{fmtNum(p.avgForce, 2)}</span>
        </div>
      </div>

      {/* 电机控制部分 */}
      <div className="mt-auto border-t border-[rgba(15,80,120,0.08)] pt-2 flex flex-col gap-2">
        <div className="font-label-bold text-[11px] uppercase tracking-widest text-on-surface-variant">
          {tr('电机控制部分')}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-label-bold text-[12px] w-[68px] flex-shrink-0 text-slate-600">{tr('调平电机')}</span>
          <input
            className="ui-input w-16 !py-1.5 text-center"
            value={p.params.setAngle}
            onChange={(e) => p.onParamChange('setAngle', e.target.value)}
            inputMode="decimal"
            title={tr('目标角度 °')}
            placeholder="°"
          />
          <MiniBtn onClick={p.onMotorMove} disabled={dis}>{tr('启动')}</MiniBtn>
          <MiniBtn onClick={p.onLevel} disabled={dis}>{tr('调平补偿')}</MiniBtn>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-label-bold text-[12px] w-[68px] flex-shrink-0 text-slate-600">{tr('加载电机')}</span>
          <input
            className="ui-input w-14 !py-1.5 text-center"
            value={p.params.pushDist}
            onChange={(e) => p.onParamChange('pushDist', e.target.value)}
            onBlur={p.onPushDistApply}
            inputMode="decimal"
            title={tr('推出距离 mm')}
            placeholder="mm"
          />
          <input
            className="ui-input w-14 !py-1.5 text-center"
            value={p.params.setLoad}
            onChange={(e) => p.onParamChange('setLoad', e.target.value)}
            onBlur={p.onSetLoadApply}
            inputMode="decimal"
            title={tr('加载力 N（预留）')}
            placeholder="N"
          />
          <MiniBtn onClick={p.onPushStart} disabled={dis}>{tr('启动加载')}</MiniBtn>
          <MiniBtn onClick={() => p.onJog(1)} disabled={dis}>+</MiniBtn>
          <MiniBtn onClick={() => p.onJog(-1)} disabled={dis}>-</MiniBtn>
        </div>
      </div>
    </div>
  )
}

const PedalDataPanel = memo(PedalDataPanelImpl)
export default PedalDataPanel
