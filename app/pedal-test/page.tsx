'use client'

import { useEffect, useRef, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { useDevice, useForce } from '@/lib/comm'
import { usePedalStore, useSettingsStore, forceCoefficient } from '@/lib/store'
import PedalDataPanel from '@/components/ui/PedalDataPanel'
import EventTimeline from '@/components/ui/EventTimeline'
import EstopButton from '@/components/ui/EstopButton'
import ForceModal from '@/components/ui/ForceModal'

/** 高度记录点现场值（mm） */
interface FieldSnapshot {
  startH: number | null
  endH: number | null
}

const emptySnapshot = (): FieldSnapshot => ({ startH: null, endH: null })

/**
 * 踏板测试页（对齐《软件UI》PPT 第 2 页）
 * 工具条（蓝牙模块联结 / A 模块 / B 模块）→ 左侧数据面板（倾角、垂直测距、高度、力值、电机控制）
 * → 右侧图表 A → 底部 开始测试 / 记录 / 导出 / 踏板 B
 */
export default function PedalTestPage() {
  const { state, actions, lastEvent, error } = useDevice()
  const { states: forceStates } = useForce()
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
  const [avgForce, setAvgForce] = useState<number | null>(null)
  const [snapshots, setSnapshots] = useState<Record<'A' | 'B', FieldSnapshot>>({
    A: emptySnapshot(),
    B: emptySnapshot(),
  })
  const forceHistory = useRef<number[]>([])

  const t = state.telemetry
  const connected = state.is_connected
  const workSide: 'A' | 'B' = side === 'B' ? 'B' : 'A'
  const work = sides[workSide]
  const snap = snapshots[workSide]

  // BLE 力值（当前工作侧通道，应用校正系数）
  const forceCh = forceStates[workSide]
  const forceCoef = forceCoefficient(
    useSettingsStore((s) => s.forceCoefficients),
    workSide
  )
  const forceRawN = forceCh.isConnected ? forceCh.latest?.weightN ?? null : null
  const forceLive = forceRawN === null ? null : forceRawN * forceCoef
  const forceMax = forceCh.isConnected ? forceCh.maxN * forceCoef : null

  // 均匀力值：最近 30 个采样的滑动平均（每 5 帧更新一次）
  useEffect(() => {
    if (forceLive === null) return
    const arr = forceHistory.current
    arr.push(forceLive)
    if (arr.length > 30) arr.shift()
    if (arr.length === 1 || arr.length % 5 === 0) {
      setAvgForce(arr.reduce((a, b) => a + b, 0) / arr.length)
    }
  }, [forceLive])

  // 遥测 → 趋势（200ms 采样门控）
  useEffect(() => {
    if (t.t <= 0) return
    const now = Date.now()
    if (now - lastTrendPush.current < 200) return
    lastTrendPush.current = now
    pushTrend(t)
  }, [t, pushTrend])

  // DEBUG 事件 → 时间线 + 流程阶段复位
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

  const handleSideChange = (s: 'A' | 'B') =>
    run(async () => {
      await actions.pedalSelect(s)
      setSide(s)
      forceHistory.current = []
      setAvgForce(null)
    })

  const setField = (s: 'A' | 'B', key: keyof FieldSnapshot, value: number | null) =>
    setSnapshots((prev) => ({ ...prev, [s]: { ...prev[s], [key]: value } }))

  const isA = workSide === 'A'
  const laser = isA ? t.laser_a : t.laser_b

  /** 记录字段（记录点写入历史表） */
  const recordField = (field: 'startH' | 'endH' | 'heightDiff' | 'force') => {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    switch (field) {
      case 'startH':
        setField(workSide, 'startH', laser)
        addRecord({ timestamp: ts, side: workSide, key: '起始高度', value: laser, unit: 'mm' })
        break
      case 'endH':
        setField(workSide, 'endH', laser)
        addRecord({ timestamp: ts, side: workSide, key: '终末高度', value: laser, unit: 'mm' })
        break
      case 'heightDiff': {
        const diff = snap.startH !== null && snap.endH !== null ? snap.endH - snap.startH : null
        addRecord({ timestamp: ts, side: workSide, key: '高度差', value: diff, unit: 'mm' })
        break
      }
      case 'force':
        addRecord({ timestamp: ts, side: workSide, key: '实时力值', value: forceLive, unit: 'N' })
        break
    }
  }

  const toggleTest = () =>
    run(async () => {
      if (work.phase === 'idle') {
        await actions.pedalStart(workSide)
        setPhase(workSide, 'leveling')
        forceHistory.current = []
        setAvgForce(null)
      } else {
        await actions.pedalStop(workSide)
        setPhase(workSide, 'idle')
      }
    })

  const exportCsv = () => {
    const lines = [
      ['#', '时间', '侧', '记录项', '值', '单位'].join(','),
      ...records.map((r) =>
        [r.index, r.timestamp, r.side, r.key, r.value === null ? '--' : r.value.toFixed(3), r.unit].join(',')
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
    <div className="h-full flex flex-col gap-3 p-4 overflow-hidden">
      {error && (
        <div className="flex items-center justify-between px-4 py-2 rounded-xl bg-red-50/80 backdrop-blur border border-red-200 text-red-700 text-[13px] font-label-bold">
          <span>{error}</span>
          <button onClick={actions.clearError} className="material-symbols-outlined text-[16px]">close</button>
        </div>
      )}

      {/* ===== 工具条：蓝牙模块联结 / A 模块 / B 模块 ===== */}
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => setForceModalOpen(true)} className="glass-btn primary">
          <span className="material-symbols-outlined text-[16px]">bluetooth</span>
          蓝牙模块联结
        </button>
        <button
          onClick={() => handleSideChange('A')}
          disabled={!connected || busy}
          className={`glass-btn ${workSide === 'A' ? '!bg-white/90 !border-[#0891b2] !text-[#0891b2]' : ''}`}
        >
          A 模块
        </button>
        <button
          onClick={() => handleSideChange('B')}
          disabled={!connected || busy}
          className={`glass-btn ${workSide === 'B' ? '!bg-white/90 !border-[#0891b2] !text-[#0891b2]' : ''}`}
        >
          B 模块
        </button>
        <div className="flex-1" />
        <span className="glass-row !min-h-[34px]">
          <span className="k">WiFi</span>
          <span className={`led ${connected ? 'on' : 'err'}`} />
          <span className="v !text-[12px]">{connected ? '已连接' : '未连接'}</span>
        </span>
        <span className="glass-row !min-h-[34px]">
          <span className="k">流程</span>
          <span className="v !text-[12px]">{PHASE_TEXT[work.phase]}</span>
        </span>
        <EstopButton onEstop={actions.estop} />
      </div>

      {/* ===== 主体：左侧数据面板 + 右侧图表 A ===== */}
      <div className="flex-1 min-h-0 flex gap-3">
        <div className="glass-panel w-[480px] flex-shrink-0 flex flex-col min-h-0">
          <div className="glass-panel-header">
            踏板 {workSide} · 数据面板
            <span className="ml-auto flex items-center gap-2 font-normal normal-case tracking-normal">
              <span className={`led ${forceCh.isConnected ? 'on' : ''}`} />
              <span className="font-label-sm text-slate-500">
                {forceCh.isConnected ? forceCh.deviceName : '力值模块未连接'}
              </span>
            </span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-3">
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
              avgForce={avgForce}
              onParamChange={(key, value) => setParam(workSide, key, value)}
              onZero={() => run(() => actions.pedalZero(workSide))}
              onRecordField={recordField}
              onClearField={(field) => setField(workSide, field, null)}
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
        </div>

        {/* 右侧图表 A */}
        <div className="glass-panel flex-1 min-w-0 flex flex-col">
          <div className="glass-panel-header">
            图表 A · 踏板趋势
            <div className="ml-auto flex items-center gap-1.5 normal-case tracking-normal font-normal">
              <button
                onClick={() => setChartTab('trend')}
                className={`glass-btn !h-7 !px-2.5 !text-[11px] ${chartTab === 'trend' ? 'primary' : ''}`}
              >
                趋势
              </button>
              <button
                onClick={() => setChartTab('events')}
                className={`glass-btn !h-7 !px-2.5 !text-[11px] ${chartTab === 'events' ? 'primary' : ''}`}
              >
                事件
                {events.length > 0 && (
                  <span className="ml-1 px-1.5 rounded-full bg-[#e11d48] text-white text-[10px]">{events.length}</span>
                )}
              </button>
              <button
                onClick={chartTab === 'trend' ? clearTrend : clearEvents}
                className="glass-btn !h-7 !px-2.5 !text-[11px]"
              >
                清空
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0 p-2">
            {chartTab === 'trend' ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#c9d8e6" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="tilt" tick={{ fontSize: 11 }} domain={[-2, 2]} unit="°" />
                  <YAxis yAxisId="pedal" orientation="right" tick={{ fontSize: 11 }} unit="mm" />
                  <Tooltip
                    contentStyle={{ fontSize: 12 }}
                    formatter={(v, name) => (v === null || v === undefined ? ['--', String(name)] : [v, String(name)]) as [string, string]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line yAxisId="tilt" type="monotone" dataKey="tilt_y" name="倾角 Y °" stroke="#0891b2" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
                  <Line yAxisId="tilt" type="monotone" dataKey="tilt_x" name="倾角 X °" stroke="#7c3aed" dot={false} isAnimationActive={false} connectNulls={false} />
                  <Line yAxisId="pedal" type="monotone" dataKey="pedal_mm" name="推杆 mm" stroke="#d97706" dot={false} isAnimationActive={false} connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <EventTimeline events={events} />
            )}
          </div>

          {/* 记录点列表 */}
          {records.length > 0 && (
            <div className="max-h-36 overflow-y-auto border-t border-white/60">
              <table className="w-full border-collapse text-[12px]">
                <thead className="sticky top-0 bg-white/80 backdrop-blur">
                  <tr className="text-left">
                    {['#', '时间', '侧', '记录项', '值', ''].map((h) => (
                      <th key={h} className="px-2 py-1 font-label-bold text-on-surface-variant">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.index} className="hover:bg-white/60">
                      <td className="px-2 py-0.5 monospaced-data">{r.index}</td>
                      <td className="px-2 py-0.5 monospaced-data">{r.timestamp}</td>
                      <td className="px-2 py-0.5">{r.side}</td>
                      <td className="px-2 py-0.5">{r.key}</td>
                      <td className="px-2 py-0.5 monospaced-data">
                        {r.value === null ? '--' : `${r.value.toFixed(3)} ${r.unit}`}
                      </td>
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

      {/* ===== 底部动作条（对齐 PPT：开始测试 / 记录 / 导出 / 踏板 B） ===== */}
      <div className="flex items-center gap-2">
        <button
          onClick={toggleTest}
          disabled={!connected || busy}
          className={`glass-action flex-1 ${work.phase !== 'idle' ? 'danger' : 'primary'}`}
        >
          {work.phase === 'idle' ? '开始测试' : '停止测试'}
        </button>
        <button
          onClick={() =>
            addRecord({
              timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
              side: workSide,
              key: '遥测快照',
              value: forceLive,
              unit: 'N',
            })
          }
          disabled={!connected}
          className="glass-action"
        >
          记录
        </button>
        <button onClick={exportCsv} disabled={records.length === 0} className="glass-action">
          导出
        </button>
        <button
          onClick={() => { clearRecords(); actions.pedalClear(workSide).catch(() => {}) }}
          disabled={records.length === 0}
          className="glass-action"
        >
          清除
        </button>
        <button
          onClick={() => handleSideChange(workSide === 'A' ? 'B' : 'A')}
          disabled={!connected || busy}
          className="glass-action"
        >
          踏板 {workSide === 'A' ? 'B' : 'A'}
        </button>
      </div>

      <ForceModal open={forceModalOpen} onClose={() => setForceModalOpen(false)} />
    </div>
  )
}
