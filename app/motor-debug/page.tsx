'use client'

import { useState } from 'react'
import { useDevice, type MotorAxis } from '@/lib/comm'
import type { BoardSide } from '@/lib/comm/types'
import { fmtNum } from '@/lib/comm/types'
import { useMotorStore, MOTOR_AXES, AXIS_LABELS } from '@/lib/store'
import MotorAxisPanel from '@/components/ui/MotorAxisPanel'
import { useT } from '@/lib/i18n'

/** 状态检测表格一行 */
function StatusRow({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/50 last:border-b-0">
      <span className="font-label-sm text-on-surface-variant flex-1">{label}</span>
      <span className="monospaced-data font-label-bold text-on-surface">{value}</span>
      {unit && <span className="font-label-sm text-outline w-8">{unit}</span>}
    </div>
  )
}

/**
 * 手动及状态检测（对齐 plain_test_host.py 的单步测试逻辑）
 * 目标板 A/B → 角度补偿 / 推出控制 / 推杆回零 / MSH 设零 / Modbus 扫描 / STOP / 故障复位
 * + 选中板的 TELEMETRY 全字段状态表 + 各轴手动控制面板
 */
export default function MotorDebugPage() {
  const tr = useT()
  const { state, boards, actions, error } = useDevice()
  const { axis, setAxis, targetPos, setTargetPos, feed, setFeed } = useMotorStore()

  const [target, setTarget] = useState<BoardSide>('A')
  const [pushDist, setPushDist] = useState('80')
  const [busy, setBusy] = useState(false)

  const tm = state.telemetry
  const board = boards[target]
  const bt = board.telemetry
  const targetConnected = board.is_connected
  const isA = target === 'A'

  const tiltX = isA ? bt.pedal_a_tilt_x : bt.pedal_b_tilt_x
  const tiltY = isA ? bt.pedal_a_tilt_y : bt.pedal_b_tilt_y
  const laser = isA ? bt.laser_a : bt.laser_b
  const pedal = isA ? bt.pedal_a : bt.pedal_b
  const pushRaw = isA ? bt.push_a_raw : bt.push_b_raw
  const pushSt = isA ? bt.push_a_st : bt.push_b_st
  const angCor = isA ? bt.ang_cor_a : bt.ang_cor_b

  const isPush = axis.startsWith('PUSH')
  const position = isPush
    ? axis === 'PUSH_A'
      ? tm.pedal_a
      : tm.pedal_b
    : axis === 'A'
      ? tm.ang_cor_a
      : tm.ang_cor_b
  const unit = isPush ? 'mm' : '°'
  // 新固件 TELEMETRY.pedal_a/b 已是 mm（脉冲原始值在 push_a_raw/push_b_raw）
  const displayPos = position

  const num = (v: string) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : NaN
  }

  const feedNum = () => {
    const f = num(feed)
    return Number.isFinite(f) && f > 0 ? f : undefined
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch {
      /* useDevice 已记录错误 */
    } finally {
      setBusy(false)
    }
  }

  const applyPushDist = () => {
    const v = Number(pushDist)
    if (!Number.isFinite(v) || v < 0 || v > 500) return
    run(() => actions.pedalSet(target, 'PUSH_DIST', String(v)))
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-3">
      {error && (
        <div className="flex items-center justify-between px-4 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 font-label-bold">
          <span className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px]">error</span>
            {error}
          </span>
          <button onClick={actions.clearError} className="material-symbols-outlined text-[18px]">close</button>
        </div>
      )}

      <div className="flex items-center gap-2 flex-shrink-0">
        <h1 className="text-[21px] font-black text-primary whitespace-nowrap">{tr('双板调试台')}</h1>
        <span className="px-2 py-0.5 rounded-full bg-[#0891b2]/8 border border-[#0891b2]/20 text-[9px] font-extrabold text-[#0891b2]">
          {tr('工程模式')}
        </span>
      </div>

      {/* ===== 目标板 + 全局操作 ===== */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-label-bold text-[13px] text-on-surface-variant">{tr('目标板')}</span>
          {(['A', 'B'] as BoardSide[]).map((side) => (
            <button
              key={side}
              onClick={() => {
                setTarget(side)
                // 与 Python 工具一致：切换目标侧时同步该板 pedal_select
                if (boards[side].is_connected) actions.pedalSelect(side).catch(() => {})
              }}
              className={`glass-btn !h-8 !px-3 !text-[12px] ${target === side ? 'primary' : ''}`}
            >
              {tr(side === 'A' ? 'A 板' : 'B 板')}
              <span className={`led ${boards[side].is_connected ? 'on' : ''} !w-1.5 !h-1.5`} />
            </button>
          ))}
          <span className="font-label-sm text-slate-500">
            {targetConnected
              ? `${board.device_id || '--'} · ${board.info?.fw || board.fw_version || '--'} · ${tr('心跳')} ${board.last_pong || '--'}`
              : tr('未连接')}
          </span>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={actions.motorEnable} disabled={!state.is_connected} className="ui-action-btn">
            {tr('总使能')}
          </button>
          <button onClick={actions.motorDisable} disabled={!state.is_connected} className="ui-action-btn ui-action-btn-ghost">
            {tr('总释放')}
          </button>
          <button onClick={actions.motorStopAll} disabled={!state.is_connected} className="ui-action-btn ui-action-btn-danger">
            {tr('全轴停止')}
          </button>
          <button
            onClick={() => run(() => actions.resetFault(target))}
            disabled={!targetConnected || busy}
            className="ui-action-btn ui-action-btn-ghost"
            title={tr('ESTOP 后必须先故障复位（RESET FAULT）')}
          >
            <span className="material-symbols-outlined text-[16px]">restart_alt</span>
            {tr('故障复位')}
          </button>
        </div>
      </div>

      {bt.state === 'FAULT' && (
        <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 font-label-bold text-[13px]">
          <span className="material-symbols-outlined text-[18px]">warning</span>
          {tr('设备处于故障态：运动命令被拒绝，请先点击「故障复位」')}
        </div>
      )}

      {/* ===== 手动单步测试 + 选中板状态 ===== */}
      <div className="grid lg:grid-cols-[1.05fr_0.95fr] gap-3">
        <div className="glass-panel p-4 space-y-3">
          <div className="font-label-bold text-[14px] text-primary flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-[#0891b2]">touch_app</span>
            {tr('手动单步测试')}
            <span className="ml-auto font-label-sm font-normal text-slate-500">
              {tr('命令仅发往目标板')}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => run(() => actions.pedalLevel(target))}
              disabled={!targetConnected || busy}
              className="ui-action-btn"
            >
              {tr('角度补偿')}
            </button>
            <div className="flex items-center gap-1.5">
              <input
                value={pushDist}
                onChange={(e) => setPushDist(e.target.value)}
                inputMode="decimal"
                className="ui-input w-full !py-2 text-center"
                title={tr('推出距离 0–500 mm')}
                placeholder="mm"
              />
              <button
                onClick={applyPushDist}
                disabled={!targetConnected || busy}
                className="ui-action-btn ui-action-btn-ghost !px-3 whitespace-nowrap"
              >
                {tr('设置推出距离')}
              </button>
            </div>

            <button
              onClick={() => run(() => actions.pedalPushStart(target))}
              disabled={!targetConnected || busy}
              className="ui-action-btn"
            >
              {tr('开始推出')}
            </button>
            <button
              onClick={() => run(() => actions.pedalPushStop(target))}
              disabled={!targetConnected || busy}
              className="ui-action-btn ui-action-btn-ghost"
            >
              {tr('停止推出')}
            </button>

            <button
              onClick={() => run(() => actions.motorHome(isA ? 'PUSH_A' : 'PUSH_B'))}
              disabled={!targetConnected || busy}
              className="ui-action-btn ui-action-btn-ghost"
            >
              {tr('推杆回零')}
            </button>
            <button
              onClick={() => run(() => actions.motorZero(target))}
              disabled={!targetConnected || busy}
              className="ui-action-btn ui-action-btn-ghost"
              title={tr('把当前物理位置记为 0°（MSH 软件零点）')}
            >
              {tr('角度电机设零点')}
            </button>

            <button
              onClick={() => run(() => actions.scanModbus(target, 1, 32))}
              disabled={!targetConnected || busy}
              className="ui-action-btn ui-action-btn-ghost"
              title={tr('扫描 Modbus 从站地址 1–32，结果见通信日志')}
            >
              {tr('扫描 Modbus 从站')}
            </button>
            <button
              onClick={() => run(() => actions.pedalStop(target))}
              disabled={!targetConnected || busy}
              className="ui-action-btn ui-action-btn-danger"
            >
              STOP
            </button>
          </div>

          <div className="pt-2 border-t border-white/60">
            <button
              onClick={() => run(() => actions.setMshZeroClear(target))}
              disabled={!targetConnected || busy}
              className="ui-action-btn ui-action-btn-ghost w-full"
              title={tr('清除该板 MSH 角度软零点（SET MSH_ZERO_CLEAR）')}
            >
              {tr('清除 MSH 零点')}
            </button>
          </div>
          <div className="font-label-sm text-outline">
            {tr('推杆推出前若未回原点，固件会自动回零；推出距离由 PEDAL SET PUSH_DIST 预先设置。')}
          </div>
        </div>

        {/* 选中板全字段状态（对齐 Python 工具遥测表） */}
        <div className="glass-panel overflow-hidden">
          <div className="glass-panel-header !py-2.5">
            {tr('状态检测（全字段）')}
            <span className="ml-auto font-label-sm font-normal normal-case tracking-normal text-slate-500">
              {tr(target === 'A' ? 'A 板' : 'B 板')} · TELEMETRY
            </span>
          </div>
          <div className="max-h-[360px] overflow-y-auto">
            <StatusRow label={tr('运行时间')} value={String(bt.t ?? '--')} unit="ms" />
            <StatusRow label={tr('本板侧别')} value={bt.side || target} />
            <StatusRow label={tr('设备状态')} value={bt.state || '--'} />
            <StatusRow label={tr('踏板选中')} value={bt.pedal_select || '--'} />
            <StatusRow label={tr('传感器汇总')} value={bt.sensor || '--'} />
            <StatusRow label={tr('倾角 X')} value={fmtNum(tiltX, 3)} unit="°" />
            <StatusRow label={tr('倾角 Y')} value={fmtNum(tiltY, 3)} unit="°" />
            <StatusRow label={tr('激光距离')} value={fmtNum(laser, 2)} unit="mm" />
            <StatusRow label={tr('推杆行程')} value={fmtNum(pedal, 2)} unit="mm" />
            <StatusRow label={tr('推杆位置(脉冲)')} value={fmtNum(pushRaw, 0)} />
            <StatusRow label={tr('推杆状态字')} value={fmtNum(pushSt, 0)} />
            <StatusRow label={tr('角度校正位置')} value={fmtNum(angCor, 3)} unit="°" />
            <StatusRow label={tr('转向 X')} value={fmtNum(bt.steer_x, 2)} />
            <StatusRow label={tr('转向 Y')} value={fmtNum(bt.steer_y, 2)} />
            <StatusRow label={tr('释放标志')} value={fmtNum(bt.steer_free, 0)} />
          </div>
        </div>
      </div>

      {/* ===== 轴手动控制 ===== */}
      <div className="inline-flex rounded-[10px] border border-outline-variant overflow-hidden">
        {MOTOR_AXES.map((ax) => (
          <button
            key={ax}
            onClick={() => setAxis(ax)}
            className={`px-5 py-2 font-label-bold text-sm transition-colors ${
              axis === ax
                ? 'bg-primary text-on-primary'
                : 'bg-white text-on-surface-variant hover:bg-surface-container'
            }`}
          >
            {ax} · {tr(AXIS_LABELS[ax])}
          </button>
        ))}
      </div>

      <MotorAxisPanel
        axis={axis as MotorAxis}
        position={displayPos}
        unit={unit}
        targetPos={targetPos}
        feed={feed}
        onTargetPosChange={setTargetPos}
        onFeedChange={setFeed}
        onMove={() => {
          const pos = num(targetPos)
          if (!Number.isFinite(pos)) return
          actions.motorMove(axis as MotorAxis, pos, feedNum())
        }}
        onMoveabs={() => {
          const pos = num(targetPos)
          if (!Number.isFinite(pos)) return
          actions.motorMoveabs(axis as MotorAxis, pos, feedNum())
        }}
        onHome={() => actions.motorHome(axis as MotorAxis)}
        onStop={() => actions.motorStop(axis as MotorAxis)}
        onZero={() => actions.motorZero(axis as MotorAxis)}
      />

      {!state.is_connected && (
        <div className="text-center font-label-sm text-outline py-4">
          {tr('未连接设备——请先在命令监测页连接 A/B 板（手动操作电机前确保安全区域无人）')}
        </div>
      )}
    </div>
  )
}
