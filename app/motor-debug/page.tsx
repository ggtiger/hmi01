'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useDevice, type MotorAxis } from '@/lib/comm'
import type { BoardSide } from '@/lib/comm/types'
import { fmtNum } from '@/lib/comm/types'
import { useMotorStore, MOTOR_AXES, AXIS_LABELS } from '@/lib/store'
import MotorAxisPanel from '@/components/ui/MotorAxisPanel'
import { useT } from '@/lib/i18n'

/** 顶部/卡片标题条：统一层级，替代原先的大写小字表头 */
function PanelHeader({
  icon,
  title,
  subtitle,
  right,
}: {
  icon: string
  title: string
  subtitle?: string
  right?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-[rgba(15,80,120,.08)] px-3.5 py-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[#0891b2]/15 bg-[#0891b2]/8 text-[#0891b2]">
        <span className="material-symbols-outlined text-[18px]">{icon}</span>
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-extrabold tracking-tight text-[#0f2233]">{title}</div>
        {subtitle && <div className="mt-0.5 truncate text-[10.5px] text-slate-400">{subtitle}</div>}
      </div>
      {right && <div className="ml-auto flex min-w-0 items-center justify-end">{right}</div>}
    </div>
  )
}

/** 控制区分组标题：编号 + 图标，保持层级但不堆叠说明文字 */
function SectionHeading({ step, icon, title }: { step: string; icon: string; title: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[#0f2233] font-mono text-[9px] font-bold text-white/90">
        {step}
      </span>
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-bold text-[#142639]">
        <span className="material-symbols-outlined text-[15px] text-[#0891b2]">{icon}</span>
        {title}
      </div>
    </div>
  )
}

/** 紧凑遥测卡：替代超长状态表格 */
function MetricTile({
  label,
  value,
  unit,
  tone = 'text-[#0f2233]',
  sub,
  size = 'md',
  className = '',
}: {
  label: string
  value: string
  unit?: string
  tone?: string
  sub?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const valueSize = size === 'lg' ? 'text-[24px]' : size === 'sm' ? 'text-[17px]' : 'text-[19px]'
  return (
    <div
      className={`flex h-full min-w-0 flex-col justify-center rounded-xl border border-[rgba(15,80,120,.10)] bg-white/65 shadow-[0_3px_12px_rgba(31,86,130,.045)] ${
        size === 'lg' ? 'px-3.5 py-2.5' : 'px-3 py-2'
      } ${className}`}
    >
      <div className="flex items-baseline gap-1.5">
        <span className="truncate text-[10px] font-bold uppercase tracking-[1.1px] text-slate-500">{label}</span>
        {unit && <span className="ml-auto shrink-0 font-mono text-[9.5px] text-slate-400">{unit}</span>}
      </div>
      <div className={`mt-1 truncate font-mono ${valueSize} font-bold leading-none tabular-nums ${tone}`}>
        {value}
      </div>
      {sub && <div className="mt-1 truncate font-mono text-[9px] text-slate-400">{sub}</div>}
    </div>
  )
}

/** 顶部小信息块：设备号 / 固件 / 心跳 */
function MetaChip({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-white/90 bg-white/45 px-2 py-1">
      <span className="shrink-0 text-[8.5px] font-bold uppercase tracking-[1px] text-slate-400">{label}</span>
      <b className={`truncate text-[10px] font-bold text-[#24405a] ${mono ? 'font-mono' : ''}`}>{value}</b>
    </span>
  )
}

function formatUptime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '--'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 轴切换时，轴所属板侧 */
function axisSide(axis: MotorAxis): BoardSide {
  return axis === 'B' || axis === 'PUSH_B' ? 'B' : 'A'
}

const DESIGN_WIDTH = 1280
const DESIGN_HEIGHT = 820

const AXIS_TAB_LABELS: Record<MotorAxis, string> = {
  A: 'A 角度',
  B: 'B 角度',
  PUSH_A: 'A 推杆',
  PUSH_B: 'B 推杆',
}

/**
 * 双板调试台
 * 设计层级：设备总览 → 测试控制 / 实时状态 → 轴级微调
 * 所有板级快捷按钮只发往目标板；轴控制按轴所在板路由，并自动同步目标板。
 */
export default function MotorDebugPage() {
  const tr = useT()
  const { state, boards, actions, error } = useDevice()
  const { axis, setAxis, targetPos, setTargetPos, feed, setFeed } = useMotorStore()

  const [target, setTarget] = useState<BoardSide>('A')
  const [pushDist, setPushDist] = useState('80')
  const [busy, setBusy] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const [canvas, setCanvas] = useState({ scale: 1, width: DESIGN_WIDTH, height: DESIGN_HEIGHT })

  // 固定 1280×740 设计画布，等比缩放并铺满可用区域：
  // 不出现滚动条，不裁切内容，也不会在上下留出黑边。
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const update = () => {
      const { width, height } = host.getBoundingClientRect()
      if (width <= 0 || height <= 0) return
      const scale = Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT)
      setCanvas({
        scale,
        width: Math.max(DESIGN_WIDTH, width / scale),
        height: Math.max(DESIGN_HEIGHT, height / scale),
      })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

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

  const currentAxisSide = axisSide(axis)
  const axisBoard = boards[currentAxisSide]
  const axisTelemetry = axisBoard.telemetry
  const axisConnected = axisBoard.is_connected
  const isPush = axis.startsWith('PUSH')
  const position = isPush
    ? currentAxisSide === 'A'
      ? axisTelemetry.pedal_a
      : axisTelemetry.pedal_b
    : currentAxisSide === 'A'
      ? axisTelemetry.ang_cor_a
      : axisTelemetry.ang_cor_b
  const unit = isPush ? 'mm' : '°'

  const sensorTone = bt.sensor === 'NG' ? 'text-rose-600' : 'text-emerald-600'
  const running = bt.state === 'PEDAL_RUN' || bt.state === 'STEER_RUN'
  const stateCard =
    bt.state === 'FAULT'
      ? 'border-rose-300/70 bg-[linear-gradient(135deg,#e11d48,#9f1239)] text-white'
      : running
        ? 'border-cyan-300/60 bg-[linear-gradient(135deg,#0891b2,#2563eb)] text-white'
        : 'border-[#0f2233]/30 bg-[linear-gradient(135deg,#0f2233,#1e3a52)] text-white'
  const stateIcon = bt.state === 'FAULT' ? 'error' : running ? 'directions_run' : 'schedule'

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

  const selectBoard = (side: BoardSide) => {
    if (boards[side].is_connected) actions.pedalSelect(side).catch(() => {})
  }

  const handleTargetChange = (side: BoardSide) => {
    setTarget(side)
    if (axisSide(axis) !== side) setAxis(side)
    selectBoard(side)
  }

  const handleAxisChange = (next: MotorAxis) => {
    setAxis(next)
    const side = axisSide(next)
    if (side !== target) {
      setTarget(side)
      selectBoard(side)
    }
  }

  const feedNum = () => {
    const f = Number(feed)
    return Number.isFinite(f) && f > 0 ? f : undefined
  }

  const moveAxis = (absolute: boolean) =>
    run(async () => {
      const pos = Number(targetPos)
      if (!Number.isFinite(pos)) return
      if (absolute) await actions.motorMoveabs(axis, pos, feedNum())
      else await actions.motorMove(axis, pos, feedNum())
    })

  return (
    <div ref={hostRef} className="relative h-full w-full overflow-hidden">
      {error && (
        <div className="absolute bottom-6 right-4 z-[80] flex max-w-[420px] items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50/95 px-4 py-2.5 text-[12px] font-bold text-rose-700 shadow-[0_14px_40px_rgba(190,18,60,.18)] backdrop-blur">
          <span className="flex min-w-0 items-center gap-2">
            <span className="material-symbols-outlined text-[18px]">error</span>
            <span className="truncate">{error}</span>
          </span>
          <button onClick={actions.clearError} className="material-symbols-outlined shrink-0 text-[18px]">close</button>
        </div>
      )}

      <div
        className="absolute left-1/2 top-1/2 flex flex-col gap-3 overflow-hidden p-4"
        style={{
          width: canvas.width,
          height: canvas.height,
          transform: `translate(-50%, -50%) scale(${canvas.scale})`,
          transformOrigin: 'center center',
        }}
      >

        {/* ===== 设备总览 ===== */}
        <section className="glass-panel relative shrink-0 overflow-hidden">
          <div className="pointer-events-none absolute -right-24 -top-28 h-64 w-64 rounded-full bg-[radial-gradient(circle,rgba(8,145,178,.16),transparent_68%)]" />
          <div className="relative flex flex-wrap items-center justify-between gap-2 px-3.5 pb-1.5 pt-2.5">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[linear-gradient(140deg,rgba(8,145,178,.95),rgba(37,99,235,.92))] text-white shadow-[0_6px_16px_rgba(8,145,178,.22)]">
                <span className="material-symbols-outlined text-[19px]">developer_board</span>
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[18px] font-black tracking-tight text-[#0f2233]">{tr('双板调试台')}</h1>
                <span className="rounded-full border border-[#0891b2]/20 bg-[#0891b2]/8 px-1.5 py-0.5 text-[8.5px] font-extrabold tracking-wide text-[#0891b2]">
                  {tr('工程模式')}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1 rounded-xl border border-white/80 bg-white/35 p-1">
              <span className="px-1 text-[8.5px] font-bold uppercase tracking-[1.1px] text-slate-400">
                {tr('全局控制')}
              </span>
              <button
                onClick={actions.motorEnable}
                disabled={!state.is_connected}
                className="ui-action-btn !h-7 !border-emerald-200/80 !bg-emerald-50/70 !px-2 !text-[10.5px] !text-emerald-700"
              >
                <span className="material-symbols-outlined text-[14px]">power_settings_new</span>
                {tr('总使能')}
              </button>
              <button
                onClick={actions.motorDisable}
                disabled={!state.is_connected}
                className="ui-action-btn ui-action-btn-ghost !h-7 !px-2 !text-[10.5px]"
              >
                <span className="material-symbols-outlined text-[14px]">power_off</span>
                {tr('总释放')}
              </button>
              <button
                onClick={actions.motorStopAll}
                disabled={!state.is_connected}
                className="ui-action-btn ui-action-btn-danger !h-7 !px-2 !text-[10.5px]"
              >
                <span className="material-symbols-outlined text-[14px]">stop_circle</span>
                {tr('全轴停止')}
              </button>
              <button
                onClick={() => run(() => actions.resetFault(target))}
                disabled={!targetConnected || busy}
                className="ui-action-btn !h-7 !border-amber-200/80 !bg-amber-50/70 !px-2 !text-[10.5px] !text-amber-700"
                title={tr('ESTOP 后必须先故障复位（RESET FAULT）')}
              >
                <span className="material-symbols-outlined text-[14px]">restart_alt</span>
                {tr('故障复位')}
              </button>
            </div>
          </div>

          <div className="relative flex flex-wrap items-center gap-2 border-t border-[rgba(15,80,120,.07)] px-3.5 py-1.5">
            <span className="mr-1 text-[9px] font-bold uppercase tracking-[1.1px] text-slate-400">{tr('目标板')}</span>
            <div className="inline-flex items-center gap-0.5 rounded-lg border border-white/90 bg-white/45 p-0.5">
              {(['A', 'B'] as BoardSide[]).map((side) => {
                const active = target === side
                const online = boards[side].is_connected
                return (
                  <button
                    key={side}
                    onClick={() => handleTargetChange(side)}
                    className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-bold transition-all ${
                      active
                        ? 'bg-[linear-gradient(135deg,rgba(8,145,178,.95),rgba(37,99,235,.94))] text-white shadow-[0_5px_14px_rgba(8,145,178,.22)]'
                        : 'text-slate-500 hover:bg-white/80'
                    }`}
                  >
                    <span className={`led ${online ? 'on' : ''} !h-1.5 !w-1.5`} />
                    {side} {tr('板')}
                    <span className={`text-[8.5px] font-normal ${active ? 'text-white/75' : 'text-slate-400'}`}>
                      {online ? tr('在线') : tr('离线')}
                    </span>
                  </button>
                )
              })}
            </div>

            <span className="h-6 w-px bg-[rgba(15,80,120,.12)]" />
            <MetaChip label="DEVICE" value={targetConnected ? board.device_id || '--' : '--'} />
            <MetaChip label="FW" value={targetConnected ? board.info?.fw || board.fw_version || '--' : '--'} />
            <MetaChip label="HB" value={targetConnected ? board.last_pong || '--' : '--'} />

            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <span
                title={bt.state === 'FAULT' ? tr('设备处于故障态：运动命令被拒绝，请先点击「故障复位」') : undefined}
                className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold ${bt.state === 'FAULT' ? 'border-rose-200/80 bg-rose-50/70 text-rose-600' : 'border-white/90 bg-white/45 text-slate-500'}`}
              >
                {bt.state || '--'}
              </span>
            </div>
          </div>
        </section>

        {/* ===== 测试控制 / 实时状态 ===== */}
        <div className="grid flex-1 grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)] items-stretch gap-3">
          <section className="glass-panel flex flex-col overflow-hidden">
            <PanelHeader
              icon="touch_app"
              title={tr('测试控制')}
              subtitle={`${tr('目标板')} ${target} · ${tr('命令仅发往目标板')}`}
            />

            <div className="flex flex-1 flex-col p-3.5">
              <div className="grid flex-1 grid-cols-[0.95fr_1.3fr_0.9fr] gap-3">
                <div className="min-w-0">
                  <SectionHeading step="01" icon="tune" title={tr('调平与校正')} />
                  <div className="mt-2 grid gap-2">
                    <button
                      onClick={() => run(() => actions.pedalLevel(target))}
                      disabled={!targetConnected || busy}
                      className="ui-action-btn !h-9 !justify-start !px-3 !text-[12px]"
                    >
                      <span className="material-symbols-outlined text-[16px] text-[#0891b2]">tune</span>
                      {tr('角度补偿')}
                    </button>
                    <button
                      onClick={() => run(() => actions.motorZero(target))}
                      disabled={!targetConnected || busy}
                      className="ui-action-btn ui-action-btn-ghost !h-9 !justify-start !px-3 !text-[12px]"
                      title={tr('把当前物理位置记为 0°（MSH 软件零点）')}
                    >
                      <span className="material-symbols-outlined text-[16px] text-slate-400">my_location</span>
                      {tr('角度电机设零点')}
                    </button>
                    <button
                      onClick={() => run(() => actions.setMshZeroClear(target))}
                      disabled={!targetConnected || busy}
                      className="ui-action-btn ui-action-btn-ghost !h-9 !justify-start !px-3 !text-[12px]"
                      title={tr('清除该板 MSH 角度软零点（SET MSH_ZERO_CLEAR）')}
                    >
                      <span className="material-symbols-outlined text-[16px] text-slate-400">delete_sweep</span>
                      {tr('清除 MSH 零点')}
                    </button>
                  </div>
                </div>

                <div className="min-w-0 border-l border-white/70 pl-3">
                  <SectionHeading step="02" icon="south" title={tr('推杆与加载')} />
                  <div className="mt-2 flex items-stretch gap-1.5">
                    <div className="relative min-w-0 flex-1">
                      <input
                        value={pushDist}
                        onChange={(e) => setPushDist(e.target.value)}
                        inputMode="decimal"
                        disabled={!targetConnected}
                        className="ui-input h-9 w-full !pr-9 text-center"
                        title={tr('推出距离 0–500 mm')}
                        placeholder="mm"
                      />
                      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[9px] text-slate-400">
                        mm
                      </span>
                    </div>
                    <button
                      onClick={applyPushDist}
                      disabled={!targetConnected || busy}
                      className="ui-action-btn !h-9 shrink-0 !px-2.5 !text-[11.5px]"
                      title={tr('推出距离 0–500 mm')}
                    >
                      <span className="material-symbols-outlined text-[15px] text-slate-400">straighten</span>
                      {tr('设置推出距离')}
                    </button>
                  </div>
                  <div className="mt-2 grid gap-2">
                    <button
                      onClick={() => run(() => actions.pedalPushStart(target))}
                      disabled={!targetConnected || busy}
                      className="ui-action-btn ui-action-btn-primary !h-9 !justify-start !px-3 !text-[12px]"
                    >
                      <span className="material-symbols-outlined text-[16px]">play_arrow</span>
                      {tr('开始推出')}
                    </button>
                    <button
                      onClick={() => run(() => actions.pedalPushStop(target))}
                      disabled={!targetConnected || busy}
                      className="ui-action-btn !h-9 !justify-start !border-amber-200/80 !bg-amber-50/60 !px-3 !text-[12px] !text-amber-700"
                    >
                      <span className="material-symbols-outlined text-[16px]">pause</span>
                      {tr('停止推出')}
                    </button>
                    <button
                      onClick={() => run(() => actions.motorHome(isA ? 'PUSH_A' : 'PUSH_B'))}
                      disabled={!targetConnected || busy}
                      className="ui-action-btn ui-action-btn-ghost !h-9 !justify-start !px-3 !text-[12px]"
                    >
                      <span className="material-symbols-outlined text-[16px] text-slate-400">home</span>
                      {tr('推杆回零')}
                    </button>
                  </div>
                </div>

                <div className="min-w-0 border-l border-white/70 pl-3">
                  <SectionHeading step="03" icon="monitor_heart" title={tr('诊断与安全')} />
                  <div className="mt-2 grid gap-2">
                    <button
                      onClick={() => run(() => actions.scanModbus(target, 1, 32))}
                      disabled={!targetConnected || busy}
                      className="ui-action-btn ui-action-btn-ghost !h-9 !justify-start !px-3 !text-[12px]"
                      title={tr('扫描 Modbus 从站地址 1–32，结果见通信日志')}
                    >
                      <span className="material-symbols-outlined text-[16px] text-slate-400">radar</span>
                      {tr('扫描 Modbus 从站')}
                    </button>
                    <button
                      onClick={() => run(() => actions.pedalStop(target))}
                      disabled={!targetConnected || busy}
                      className="ui-action-btn ui-action-btn-danger !h-9 !justify-start !px-3 !text-[12px]"
                      title={tr('停止该侧')}
                    >
                      <span className="material-symbols-outlined text-[16px]">stop_circle</span>
                      STOP · {tr('停止该侧')}
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex items-start gap-2 rounded-xl border border-white/80 bg-white/35 px-3 py-2 text-[10px] leading-relaxed text-slate-500">
                <span className="material-symbols-outlined mt-0.5 shrink-0 text-[15px] text-[#0891b2]">info</span>
                <span>{tr('推杆未回原点时自动回零；距离通过上方写入。')}</span>
              </div>
            </div>
          </section>

          <section className="glass-panel flex flex-col overflow-hidden">
            <PanelHeader
              icon="monitor_heart"
              title={tr('状态检测（全字段）')}
              subtitle={`${target} ${tr('板')} · ${bt.side ? `SIDE ${bt.side}` : 'TELEMETRY'}`}
            />
            <div className="flex flex-1 flex-col gap-2 p-3.5">
              <div className="grid grid-cols-4 gap-2">
                <div className={`flex flex-col justify-center rounded-xl border px-4 py-2.5 shadow-[0_6px_18px_rgba(15,34,51,.16)] ${stateCard}`}>
                  <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[1.1px] text-white/65">
                    <span className={`led ${bt.state === 'FAULT' ? 'err' : running ? 'on' : ''} !h-1.5 !w-1.5`} />
                    {tr('设备状态')}
                    <span className="material-symbols-outlined ml-auto text-[19px] text-white/55">{stateIcon}</span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[26px] font-black leading-none text-white">
                    {bt.state || '--'}
                  </div>
                </div>
                <MetricTile size="lg" label={tr('传感器汇总')} value={bt.sensor || '--'} tone={sensorTone} className={bt.sensor === 'NG' ? '!border-rose-200/80 !bg-rose-50/70' : '!border-emerald-200/70 !bg-emerald-50/55'} />
                <MetricTile size="lg" label={tr('踏板选中')} value={bt.pedal_select || '--'} />
                <MetricTile
                  label={tr('运行时间')}
                  value={formatUptime(bt.t)}
                  unit="h:m:s"
                  sub={bt.t == null ? undefined : `${fmtNum(bt.t, 0)} ms`}
                />
              </div>

              <div className="grid grid-cols-4 gap-2">
                <MetricTile size="lg" label={tr('倾角 X')} value={fmtNum(tiltX, 3)} unit="°" tone="text-[#0891b2]" />
                <MetricTile size="lg" label={tr('倾角 Y')} value={fmtNum(tiltY, 3)} unit="°" tone="text-[#7c3aed]" />
                <MetricTile size="lg" label={tr('激光距离')} value={fmtNum(laser, 2)} unit="mm" />
                <MetricTile size="lg" label={tr('推杆行程')} value={fmtNum(pedal, 2)} unit="mm" />
              </div>

              <div className="flex flex-1 flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[1.1px] text-slate-500">
                  <span className="material-symbols-outlined text-[14px] text-[#0891b2]">south</span>
                  {tr('推杆')}
                  <span className="ml-1 h-px flex-1 bg-[rgba(15,80,120,.09)]" />
                </div>
                <div className="grid flex-1 auto-rows-fr grid-cols-3 gap-2">
                  <MetricTile label={tr('推杆位置(脉冲)')} value={fmtNum(pushRaw, 0)} />
                  <MetricTile label={tr('推杆状态字')} value={fmtNum(pushSt, 0)} sub={pushSt === 2 ? tr('Bit1=已回零') : undefined} />
                  <MetricTile label={tr('角度校正位置')} value={fmtNum(angCor, 3)} unit="°" />
                </div>
              </div>

              <div className="flex flex-1 flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[1.1px] text-slate-500">
                  <span className="material-symbols-outlined text-[14px] text-[#0891b2]">rotate_right</span>
                  {tr('方向盘')}
                  <span className="ml-1 h-px flex-1 bg-[rgba(15,80,120,.09)]" />
                </div>
                <div className="grid flex-1 auto-rows-fr grid-cols-3 gap-2">
                  <MetricTile label={tr('转向 X')} value={fmtNum(bt.steer_x, 2)} />
                  <MetricTile label={tr('转向 Y')} value={fmtNum(bt.steer_y, 2)} />
                  <MetricTile label={tr('释放标志')} value={fmtNum(bt.steer_free, 0)} />
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* ===== 轴级微调 ===== */}
        <section className="glass-panel shrink-0 overflow-hidden">
          <PanelHeader
            icon="precision_manufacturing"
            title={tr('轴手动控制')}
            subtitle={tr('切换轴会同步目标板')}
            right={
              <div className="flex flex-wrap gap-1 rounded-xl border border-white/90 bg-white/40 p-1">
                {MOTOR_AXES.map((ax) => {
                  const active = axis === ax
                  return (
                    <button
                      key={ax}
                      onClick={() => handleAxisChange(ax)}
                      className={`rounded-lg px-3 py-1.5 text-[10.5px] font-bold transition-all ${
                        active
                          ? 'bg-[#0f2233] text-white shadow-[0_4px_12px_rgba(15,34,51,.18)]'
                          : 'text-slate-500 hover:bg-white/80 hover:text-[#0891b2]'
                      }`}
                    >
                      {tr(AXIS_TAB_LABELS[ax])}
                    </button>
                  )
                })}
              </div>
            }
          />

          <MotorAxisPanel
            axis={axis}
            position={position}
            unit={unit}
            targetPos={targetPos}
            feed={feed}
            disabled={!axisConnected || busy}
            onTargetPosChange={setTargetPos}
            onFeedChange={setFeed}
            onMove={() => moveAxis(false)}
            onMoveabs={() => moveAxis(true)}
            onHome={() => run(() => actions.motorHome(axis))}
            onStop={() => run(() => actions.motorStop(axis))}
            onZero={() => run(() => actions.motorZero(axis))}
          />
        </section>

      </div>
    </div>
  )
}
