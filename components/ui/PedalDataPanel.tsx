'use client'

import { memo } from 'react'
import { fmtNum } from '@/lib/comm/types'
import type { TelemetryData } from '@/lib/comm/types'
import type { PedalSide, SideParams } from '@/lib/store/pedal-store'

/** 数据行：标签 + 值 + 可选操作按钮 */
function DataRow({
  label,
  value,
  unit,
  digits = 3,
  actions,
}: {
  label: string
  value: number | null
  unit: string
  digits?: number
  actions?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="ui-data-box flex-1">
        <span className="ui-label">
          {label} <span className="text-outline">{unit}</span>
        </span>
        <span className="ui-value">{fmtNum(value, digits)}</span>
      </div>
      {actions}
    </div>
  )
}

function MiniBtn({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`ui-action-btn !px-2.5 !py-1 !text-[12px] flex-shrink-0 ${danger ? 'ui-action-btn-danger' : ''}`}
    >
      {children}
    </button>
  )
}

interface PedalDataPanelProps {
  side: PedalSide
  telemetry: TelemetryData
  params: SideParams
  /** 记录点字段当前值（起始/终末高度、进深快照，mm） */
  fieldValues: {
    startH: number | null
    endH: number | null
    startDepth: number | null
    endDepth: number | null
  }
  pulsesPerMm: number
  connected: boolean
  busy: boolean
  /** BLE 力值（当前侧通道）：实时 / 会话最大 / 流程进行中快照 */
  forceLive: number | null
  forceMax: number | null
  processForce: number | null
  onParamChange: (key: keyof SideParams, value: string) => void
  onZero: () => void
  onRecordField: (field: 'startH' | 'endH' | 'heightDiff' | 'startDepth' | 'endDepth' | 'depthDiff' | 'processForce') => void
  onClearField: (field: 'startH' | 'endH' | 'startDepth' | 'endDepth') => void
  onMotorMove: () => void
  onLevel: () => void
  onPushStart: () => void
  onJog: (dir: 1 | -1) => void
  onSetLoadApply: () => void
  onPushDistApply: () => void
}

/**
 * 左侧数据面板（PPT 设计稿 slide2/3 主体）：
 * 倾角 → 测距 → 高度/进深记录区 → 力值 → 调平电机/加载电机控制
 */
function PedalDataPanelImpl(p: PedalDataPanelProps) {
  const t = p.telemetry
  const isA = p.side === 'A'
  const tiltX = isA ? t.pedal_a_tilt_x : t.pedal_b_tilt_x
  const tiltY = isA ? t.pedal_a_tilt_y : t.pedal_b_tilt_y
  const laser = isA ? t.laser_a : t.laser_b
  const pedalPulses = isA ? t.pedal_a : t.pedal_b
  const pedalMm = pedalPulses === null ? null : pedalPulses / p.pulsesPerMm

  const heightDiff =
    p.fieldValues.startH !== null && p.fieldValues.endH !== null
      ? p.fieldValues.endH - p.fieldValues.startH
      : null
  const depthDiff =
    p.fieldValues.startDepth !== null && p.fieldValues.endDepth !== null
      ? p.fieldValues.endDepth - p.fieldValues.startDepth
      : null

  const dis = !p.connected || p.busy

  return (
    <div className="flex flex-col gap-1.5 h-full justify-between">
      {/* 标题 */}
      <div className="ui-data-box !bg-primary !border-primary">
        <span className="font-label-bold text-on-primary tracking-widest">踏板 {p.side}</span>
        <span className="ui-value !text-on-primary/70 text-[11px]">数据面板</span>
      </div>

      {/* 倾角 */}
      <div className="grid grid-cols-2 gap-1.5">
        <div className="ui-data-box">
          <span className="ui-label">倾角 X</span>
          <span className="ui-value">{fmtNum(tiltX, 3)}°</span>
        </div>
        <div className="ui-data-box">
          <span className="ui-label">倾角 Y</span>
          <span className="ui-value">{fmtNum(tiltY, 3)}°</span>
        </div>
      </div>

      {/* 测距 */}
      <DataRow
        label="垂直测距"
        unit="mm"
        value={laser}
        actions={<MiniBtn onClick={p.onZero} disabled={dis}>清零</MiniBtn>}
      />
      <DataRow
        label="水平测距"
        unit="mm"
        value={null}
        actions={<MiniBtn disabled>清零</MiniBtn>}
      />

      {/* 高度记录区 */}
      <DataRow
        label="起始高度"
        unit="mm"
        value={p.fieldValues.startH}
        actions={
          <>
            <MiniBtn onClick={() => p.onRecordField('startH')} disabled={!p.connected}>记录</MiniBtn>
            <MiniBtn onClick={() => p.onClearField('startH')} disabled={!p.connected}>清除</MiniBtn>
          </>
        }
      />
      <DataRow
        label="终末高度"
        unit="mm"
        value={p.fieldValues.endH}
        actions={
          <>
            <MiniBtn onClick={() => p.onRecordField('endH')} disabled={!p.connected}>记录</MiniBtn>
            <MiniBtn onClick={() => p.onClearField('endH')} disabled={!p.connected}>清除</MiniBtn>
          </>
        }
      />
      <DataRow
        label="高度差"
        unit="mm"
        value={heightDiff}
        actions={
          <>
            <MiniBtn onClick={() => p.onRecordField('heightDiff')} disabled={!p.connected}>记录</MiniBtn>
            <MiniBtn onClick={() => { p.onClearField('startH'); p.onClearField('endH') }} disabled={!p.connected}>清除</MiniBtn>
          </>
        }
      />

      {/* 进深记录区 */}
      <DataRow
        label="起始进深"
        unit="mm"
        value={p.fieldValues.startDepth}
        actions={
          <>
            <MiniBtn onClick={() => p.onRecordField('startDepth')} disabled={!p.connected}>记录</MiniBtn>
            <MiniBtn onClick={() => p.onClearField('startDepth')} disabled={!p.connected}>清除</MiniBtn>
          </>
        }
      />
      <DataRow
        label="终末进深"
        unit="mm"
        value={p.fieldValues.endDepth}
        actions={
          <>
            <MiniBtn onClick={() => p.onRecordField('endDepth')} disabled={!p.connected}>记录</MiniBtn>
            <MiniBtn onClick={() => p.onClearField('endDepth')} disabled={!p.connected}>清除</MiniBtn>
          </>
        }
      />
      <DataRow
        label="进深差"
        unit="mm"
        value={depthDiff}
        actions={
          <>
            <MiniBtn onClick={() => p.onRecordField('depthDiff')} disabled={!p.connected}>记录</MiniBtn>
            <MiniBtn onClick={() => { p.onClearField('startDepth'); p.onClearField('endDepth') }} disabled={!p.connected}>清除</MiniBtn>
          </>
        }
      />

      {/* 力值（BLE 模块，未连接显示 --） */}
      <div className="grid grid-cols-2 gap-1.5">
        <div className="ui-data-box">
          <span className="ui-label">实时力值 N</span>
          <span className="ui-value">{fmtNum(p.forceLive, 2)}</span>
        </div>
        <div className="ui-data-box">
          <span className="ui-label">最大力值 N</span>
          <span className="ui-value">{fmtNum(p.forceMax, 2)}</span>
        </div>
      </div>
      <DataRow
        label="进程力值"
        unit="N"
        value={p.processForce}
        digits={2}
        actions={
          <>
            <MiniBtn onClick={() => p.onRecordField('processForce')} disabled={!p.connected}>记录</MiniBtn>
            <MiniBtn disabled>清除</MiniBtn>
          </>
        }
      />

      {/* 调平电机控制行 */}
      <div className="flex items-center gap-1.5 mt-1">
        <div className="ui-data-box flex-shrink-0">
          <span className="ui-label font-label-bold">调平电机</span>
        </div>
        <input
          className="ui-input w-16 text-center"
          value={p.params.setAngle}
          onChange={(e) => p.onParamChange('setAngle', e.target.value)}
          inputMode="decimal"
          title="目标角度 °"
          placeholder="°"
        />
        <MiniBtn onClick={p.onMotorMove} disabled={dis}>启动</MiniBtn>
        <MiniBtn onClick={p.onLevel} disabled={dis}>调平补偿</MiniBtn>
      </div>

      {/* 加载电机控制行 */}
      <div className="flex items-center gap-1.5">
        <div className="ui-data-box flex-shrink-0">
          <span className="ui-label font-label-bold">加载电机</span>
        </div>
        <input
          className="ui-input w-14 text-center"
          value={p.params.pushDist}
          onChange={(e) => p.onParamChange('pushDist', e.target.value)}
          onBlur={p.onPushDistApply}
          inputMode="decimal"
          title="推出距离 mm"
          placeholder="mm"
        />
        <input
          className="ui-input w-14 text-center"
          value={p.params.setLoad}
          onChange={(e) => p.onParamChange('setLoad', e.target.value)}
          onBlur={p.onSetLoadApply}
          inputMode="decimal"
          title="加载力 N（预留）"
          placeholder="N"
        />
        <MiniBtn onClick={p.onPushStart} disabled={dis}>启动加载</MiniBtn>
        <MiniBtn onClick={() => p.onJog(1)} disabled={dis}>+</MiniBtn>
        <MiniBtn onClick={() => p.onJog(-1)} disabled={dis}>-</MiniBtn>
      </div>
    </div>
  )
}

const PedalDataPanel = memo(PedalDataPanelImpl)
export default PedalDataPanel
