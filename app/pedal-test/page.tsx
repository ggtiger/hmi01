'use client'

import { useEffect, useRef, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { useDevice, useForce } from '@/lib/comm'
import { fmtNum } from '@/lib/comm/types'
import {
  usePedalStore, useSettingsStore,
  type PedalSide, RECORD_POINT_LABELS, type RecordPointKey,
} from '@/lib/store'
import PedalDataPanel from '@/components/ui/PedalDataPanel'
import EventTimeline from '@/components/ui/EventTimeline'
import EstopButton from '@/components/ui/EstopButton'
import ForceModal from '@/components/ui/ForceModal'

/** 字段快照（起始/终末高度、进深，mm） */
interface FieldSnapshot {
  startH: number | null
  endH: number | null
  startDepth: number | null
  endDepth: number | null
}

const emptySnapshot = (): FieldSnapshot => ({
  startH: null, endH: null, startDepth: null, endDepth: null,
})

export default function PedalTestPage() {
  const { state, actions, lastEvent, error } = useDevice()
  const {
    side, setSide, sides, setPhase, setParam,
    events, pushEvent, clearEvents,
    trend, pushTrend, clearTrend,
    records, addRecord, removeRecord, clearRecords,
  } = usePedalStore()
  const pulsesPerMm = Number(useSettingsStore((s) => s.pulsesPerMm)) || 320

  const lastTrendPush = useRef(0)
  const lastProcessedEvent = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [chartTab, setChartTab] = useState<'trend' | 'events'>('trend')
  const [forceModalOpen, setForceModalOpen] = useState(false)
  const [processForce, setProcessForce] = useState<Record<PedalSide, number | null>>({ A: null, B: null })
  const [snapshots, setSnapshots] = useState<Record<PedalSide, FieldSnapshot>>({
    A: emptySnapshot(),
    B: emptySnapshot(),
  })

  // BLE 力值（当前工作侧通道）
  const { states: forceStates } = useForce()
  const t = state.telemetry
  const connected = state.is_connected
  // 当前工作侧：NONE 时默认 A 视图（设计稿为单侧工作视图）
  const workSide: PedalSide = side === 'B' ? 'B' : 'A'
  const work = sides[workSide]
  const snap = snapshots[workSide]
  const forceCh = forceStates[workSide]
  const forceLive = forceCh.isConnected ? forceCh.latest?.weightN ?? null : null
  const forceMax = forceCh.isConnected ? forceCh.maxN : null

  // 进程力值：测试流程进行中实时跟踪，停止后保持最后值
  const phaseRef = useRef(work.phase)
  useEffect(() => {
    if (work.phase !== 'idle' && forceLive !== null) {
      setProcessForce((prev) => ({ ...prev, [workSide]: forceLive }))
    }
    if (phaseRef.current !== 'idle' && work.phase === 'idle') {
      // 流程结束保持最后值
    }
    phaseRef.current = work.phase
  }, [work.phase, forceLive, workSide])

  const laser = workSide === 'A' ? t.laser_a : t.laser_b
  const pedalPulses = workSide === 'A' ? t.pedal_a : t.pedal_b
  const pedalMm = pedalPulses === null ? null : pedalPulses / pulsesPerMm

  // 遥测 → 趋势（200ms 采样门控）
  useEffect(() => {
    if (t.t <= 0) return
    const now = Date.now()
    if (now - lastTrendPush.current < 200) return
    lastTrendPush.current = now
    pushTrend(t)
  }, [t, pushTrend])

  // 终末高度/终末进深跟随遥测实时更新（起始值需手动记录）
  useEffect(() => {
    setSnapshots((prev) => {
      const cur = prev[workSide]
      const endH = laser
      const endDepth = pedalMm
      if (cur.endH === endH && cur.endDepth === endDepth) return prev
      return { ...prev, [workSide]: { ...cur, endH, endDepth } }
    })
  }, [laser, pedalMm, workSide])

  // DEBUG 事件 → 时间线 + 流程阶段
  useEffect(() => {
    if (!lastEvent) return
    const key = `${lastEvent.raw}-${events.length}`
    if (lastProcessedEvent.current === key) return
    lastProcessedEvent.current = key
    pushEvent(lastEvent)
    const evSide = lastEvent.side
    if (lastEvent.kind === 'STABLE' && evSide) setPhase(evSide, 'stable')
    if (lastEvent.kind === 'PUSH_STOPPED' && evSide) setPhase(evSide, 'leveling')
    if (lastEvent.kind === 'LEVEL_ABORT' && evSide) setPhase(evSide, 'idle')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent])

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

  const handleSideChange = (s: PedalSide) =>
    run(async () => {
      await actions.pedalSelect(s)
      setSide(s)
    })

  // ===== 字段记录 / 清除 =====

  const setField = (side: PedalSide, key: keyof FieldSnapshot, value: number | null) =>
    setSnapshots((prev) => ({ ...prev, [side]: { ...prev[side], [key]: value } }))

  const recordField = (key: RecordPointKey) => {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    let value: number | null = null
    switch (key) {
      case 'startH':
        value = laser
        setField(workSide, 'startH', value)
        break
      case 'endH':
        value = laser
        setField(workSide, 'endH', value)
        break
      case 'heightDiff':
        value =
          snap.startH !== null && snap.endH !== null ? snap.endH - snap.startH : null
        break
      case 'startDepth':
        value = pedalMm
        setField(workSide, 'startDepth', value)
        break
      case 'endDepth':
        value = pedalMm
        setField(workSide, 'endDepth', value)
        break
      case 'depthDiff':
        value =
          snap.startDepth !== null && snap.endDepth !== null
            ? snap.endDepth - snap.startDepth
            : null
        break
      case 'processForce':
        value = forceLive // BLE 力值模块当前力值
        break
    }
    addRecord({
      timestamp: ts,
      side: workSide,
      key: RECORD_POINT_LABELS[key],
      value,
      unit: key === 'processForce' ? 'N' : 'mm',
    })
  }

  const clearField = (key: keyof FieldSnapshot) => setField(workSide, key, null)

  // ===== 底部操作 =====

  const toggleTest = () =>
    run(async () => {
      if (work.phase === 'idle') {
        await actions.pedalStart(workSide)
        setPhase(workSide, 'leveling')
      } else {
        await actions.pedalStop(workSide)
        setPhase(workSide, 'idle')
      }
    })

  const snapshotRecord = () => {
    actions.pedalRecord(workSide).catch(() => {})
    addRecord({
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      side: workSide,
      key: '遥测快照',
      value: null,
      unit: '',
      tilt_x: workSide === 'A' ? t.pedal_a_tilt_x : t.pedal_b_tilt_x,
      tilt_y: workSide === 'A' ? t.pedal_a_tilt_y : t.pedal_b_tilt_y,
      laser,
      pedal_pos: pedalPulses,
      ang_cor: workSide === 'A' ? t.ang_cor_a : t.ang_cor_b,
    })
  }

  const exportCsv = () => {
    const lines = [
      ['#', '时间', '侧', '记录项', '值', '倾角X°', '倾角Y°', '激光mm', '推杆脉冲', '校正角°'].join(','),
      ...records.map((r) =>
        [
          r.index, r.timestamp, r.side, r.key,
          r.value === null ? '--' : `${r.value.toFixed(3)}${r.unit}`,
          r.tilt_x ?? '', r.tilt_y ?? '', r.laser ?? '', r.pedal_pos ?? '', r.ang_cor ?? '',
        ].join(',')
      ),
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `pedal-${workSide}-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const PHASE_TEXT: Record<string, string> = {
    idle: '待机', leveling: '调平中', pushing: '推出中', stable: '已稳定',
  }

  return (
    <div className="h-full flex flex-col gap-2 p-3 overflow-hidden">
      {/* ===== 顶部行：蓝牙 / 连接 / 侧选 / 加载 / 公用倾角 ===== */}
      <div className="flex items-stretch gap-1.5 flex-wrap">
        <button
          onClick={() => setForceModalOpen(true)}
          className={`ui-action-btn ${['A', 'B'].some((c) => forceStates[c as PedalSide].isConnected) ? '' : 'ui-action-btn-ghost'} !px-3`}
          title="蓝牙力值模块管理"
        >
          <span className="material-symbols-outlined text-[16px]">bluetooth</span>
          蓝牙模块联结
          <span className="text-[11px] opacity-70">
            {['A', 'B'].filter((c) => forceStates[c as PedalSide].isConnected).length}/2
          </span>
        </button>
        <div className={`ui-data-box !px-3 ${connected ? '!border-success' : '!border-critical'}`}>
          <span className="ui-label">WiFi 连接</span>
          <span className={`ui-value ${connected ? '!text-success' : '!text-critical'}`}>
            {connected ? '已连接' : '未连接'}
          </span>
        </div>
        {(['A', 'B'] as const).map((s) => (
          <button
            key={s}
            onClick={() => handleSideChange(s)}
            disabled={!connected || busy}
            className={`ui-action-btn !px-5 ${side === s ? '' : 'ui-action-btn-ghost'}`}
          >
            踏板 {s}
          </button>
        ))}
        {(['A', 'B'] as const).map((s) => (
          <button
            key={`load-${s}`}
            onClick={() => run(() => actions.pedalPushStart(s))}
            disabled={!connected || busy}
            className="ui-action-btn ui-action-btn-ghost !px-4"
            title={`启动 ${s} 侧加载（PUSH START）`}
          >
            加载 {s}
          </button>
        ))}
        <div className="flex-1" />
        <div className="ui-data-box">
          <span className="ui-label">激光安装倾角 X</span>
          <span className="ui-value">{fmtNum(t.tilt_x, 3)}°</span>
        </div>
        <div className="ui-data-box">
          <span className="ui-label">激光安装倾角 Y</span>
          <span className="ui-value">{fmtNum(t.tilt_y, 3)}°</span>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between px-3 py-1.5 rounded-[10px] bg-red-50 border border-red-200 text-red-700 text-[13px] font-label-bold">
          <span>{error}</span>
          <button onClick={actions.clearError} className="material-symbols-outlined text-[16px]">close</button>
        </div>
      )}

      {/* ===== 主体：左侧数据面板 + 右侧图表区 ===== */}
      <div className="flex-1 min-h-0 flex gap-2">
        {/* 左侧数据面板 */}
        <div className="w-[460px] flex-shrink-0 overflow-y-auto industrial-card rounded-xl p-2.5">
          <PedalDataPanel
            side={workSide}
            telemetry={t}
            params={work.params}
            fieldValues={snap}
            pulsesPerMm={pulsesPerMm}
            connected={connected}
            busy={busy}
            forceLive={forceLive}
            forceMax={forceMax}
            processForce={processForce[workSide]}
            onParamChange={(key, value) => setParam(workSide, key, value)}
            onZero={() => run(() => actions.pedalZero(workSide))}
            onRecordField={recordField}
            onClearField={clearField}
            onMotorMove={() =>
              run(async () => {
                const angle = Number(work.params.setAngle)
                if (!Number.isFinite(angle)) throw new Error('目标角度无效')
                await actions.motorMove(workSide, angle)
              })
            }
            onLevel={() => run(() => actions.pedalLevel(workSide))}
            onPushStart={() => run(() => actions.pedalPushStart(workSide))}
            onJog={(dir) =>
              run(() => actions.motorMove(workSide === 'A' ? 'PUSH_A' : 'PUSH_B', dir * 1.0))
            }
            onSetLoadApply={() => {
              const n = Number(work.params.setLoad)
              if (Number.isFinite(n)) actions.pedalSetload(workSide, n).catch(() => {})
            }}
            onPushDistApply={() => {
              const v = work.params.pushDist
              if (v) actions.pedalSet(workSide, 'PUSH_DIST', v).catch(() => {})
            }}
          />
        </div>

        {/* 右侧图表区 */}
        <div className="flex-1 min-w-0 industrial-card rounded-xl flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 border-b-2 border-surface-container">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setChartTab('trend')}
                className={`px-3 py-1 rounded-[8px] font-label-bold text-[12px] transition-colors ${
                  chartTab === 'trend' ? 'bg-primary text-on-primary' : 'text-slate-500 hover:bg-surface-container'
                }`}
              >
                图表 {workSide}
              </button>
              <button
                onClick={() => setChartTab('events')}
                className={`px-3 py-1 rounded-[8px] font-label-bold text-[12px] transition-colors ${
                  chartTab === 'events' ? 'bg-primary text-on-primary' : 'text-slate-500 hover:bg-surface-container'
                }`}
              >
                事件
                {events.length > 0 && (
                  <span className="ml-1 px-1.5 rounded-full bg-critical text-white text-[10px]">{events.length}</span>
                )}
              </button>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-label-bold text-[12px] text-on-surface-variant">
                流程阶段：{PHASE_TEXT[work.phase]}
              </span>
              <button onClick={chartTab === 'trend' ? clearTrend : clearEvents} className="font-label-sm text-outline hover:text-critical">
                清空
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0 p-2">
            {chartTab === 'trend' ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="tilt" tick={{ fontSize: 11 }} domain={[-2, 2]} unit="°" />
                  <YAxis yAxisId="pedal" orientation="right" tick={{ fontSize: 11 }} unit="mm" />
                  <Tooltip
                    contentStyle={{ fontSize: 12 }}
                    formatter={(v, name) => (v === null || v === undefined ? ['--', String(name)] : [v, String(name)]) as [string, string]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line yAxisId="tilt" type="monotone" dataKey="tilt_y" name="倾角 Y °" stroke="#041627" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
                  <Line yAxisId="tilt" type="monotone" dataKey="tilt_x" name="倾角 X °" stroke="#8192a7" dot={false} isAnimationActive={false} connectNulls={false} />
                  <Line yAxisId="pedal" type="monotone" dataKey="pedal_mm" name="推杆 mm" stroke="#f59e0b" dot={false} isAnimationActive={false} connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <EventTimeline events={events} />
            )}
          </div>

          {/* 记录点列表（折叠在图表下方） */}
          {records.length > 0 && (
            <div className="max-h-36 overflow-y-auto border-t border-surface-container">
              <table className="w-full border-collapse text-[12px]">
                <thead className="sticky top-0 bg-slate-50">
                  <tr className="text-left">
                    {['#', '时间', '侧', '记录项', '值', '倾角X', '倾角Y', '激光', '推杆', ''].map((h) => (
                      <th key={h} className="px-2 py-1 font-label-bold text-on-surface-variant">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.index} className="hover:bg-slate-50">
                      <td className="px-2 py-0.5 monospaced-data">{r.index}</td>
                      <td className="px-2 py-0.5 monospaced-data">{r.timestamp}</td>
                      <td className="px-2 py-0.5">{r.side}</td>
                      <td className="px-2 py-0.5">{r.key}</td>
                      <td className="px-2 py-0.5 monospaced-data">
                        {r.value === null ? '--' : `${r.value.toFixed(3)} ${r.unit}`}
                      </td>
                      <td className="px-2 py-0.5 monospaced-data">{r.tilt_x == null ? '' : r.tilt_x.toFixed(3)}</td>
                      <td className="px-2 py-0.5 monospaced-data">{r.tilt_y == null ? '' : r.tilt_y.toFixed(3)}</td>
                      <td className="px-2 py-0.5 monospaced-data">{r.laser == null ? '' : r.laser.toFixed(1)}</td>
                      <td className="px-2 py-0.5 monospaced-data">{r.pedal_pos == null ? '' : r.pedal_pos.toFixed(0)}</td>
                      <td className="px-2 py-0.5">
                        <button onClick={() => removeRecord(r.index)} className="material-symbols-outlined text-[14px] text-outline hover:text-critical">close</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ===== 底部操作栏 ===== */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={toggleTest}
          disabled={!connected || busy}
          className={`ui-action-btn !px-8 !py-2.5 !text-[14px] ${work.phase !== 'idle' ? 'ui-action-btn-danger' : ''}`}
        >
          {work.phase === 'idle' ? '开始测试' : '停止测试'}
        </button>
        <button onClick={snapshotRecord} disabled={!connected} className="ui-action-btn !px-6 !py-2.5">
          记录
        </button>
        <button onClick={exportCsv} disabled={records.length === 0} className="ui-action-btn ui-action-btn-ghost !px-6 !py-2.5">
          导出
        </button>
        <button onClick={() => { clearRecords(); actions.pedalClear(workSide).catch(() => {}) }} disabled={records.length === 0} className="ui-action-btn ui-action-btn-ghost !px-4 !py-2.5">
          清除
        </button>
        <div className="flex-1" />
        <button
          onClick={() => handleSideChange(workSide === 'A' ? 'B' : 'A')}
          disabled={!connected || busy}
          className="ui-action-btn ui-action-btn-ghost !px-6 !py-2.5"
        >
          踏板 {workSide === 'A' ? 'B' : 'A'}
        </button>
        <EstopButton onEstop={actions.estop} />
      </div>

      <ForceModal open={forceModalOpen} onClose={() => setForceModalOpen(false)} />
    </div>
  )
}
