'use client'

import { useEffect, useRef } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { useDevice } from '@/lib/comm'
import { usePedalStore, type SideSelection } from '@/lib/store'
import SideSelector from '@/components/ui/SideSelector'
import PedalSideCard from '@/components/ui/PedalSideCard'
import TiltIndicator from '@/components/ui/TiltIndicator'
import EventTimeline from '@/components/ui/EventTimeline'
import EstopButton from '@/components/ui/EstopButton'

export default function PedalTestPage() {
  const { state, actions, lastEvent, error } = useDevice()
  const {
    side, setSide, sides, setPhase, setParam,
    events, pushEvent, clearEvents, trend, pushTrend, clearTrend,
    records, addRecord, removeRecord, clearRecords,
  } = usePedalStore()

  const sideRef = useRef(side)
  sideRef.current = side
  const lastProcessedEvent = useRef<string | null>(null)
  const lastTrendPush = useRef(0)

  // 遥测 → 趋势环形缓冲（200ms 采样门控：图表 20Hz→5Hz，recharts 开销降 75%）
  useEffect(() => {
    const t = state.telemetry
    if (t.t <= 0) return
    const now = Date.now()
    if (now - lastTrendPush.current < 200) return
    lastTrendPush.current = now
    pushTrend(t)
  }, [state.telemetry, pushTrend])

  // DEBUG 事件 → 时间线 + 流程阶段复位
  useEffect(() => {
    if (!lastEvent) return
    const key = `${lastEvent.raw}-${lastEvent.side}-${lastEvent.kind}-${events.length}`
    if (lastProcessedEvent.current === key) return
    lastProcessedEvent.current = key
    pushEvent(lastEvent)

    const evSide = lastEvent.side
    switch (lastEvent.kind) {
      case 'STABLE':
        if (evSide) setPhase(evSide as 'A' | 'B', 'stable')
        break
      case 'PUSH_STOPPED':
        // 自动流程中回到实时补正阶段（AF_WAIT_PUSH）
        if (evSide) setPhase(evSide as 'A' | 'B', 'leveling')
        break
      case 'LEVEL_ABORT':
        if (evSide) setPhase(evSide as 'A' | 'B', 'idle')
        break
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent])

  const t = state.telemetry
  const isA = side !== 'B'
  const sideTiltX = side === 'NONE' ? t.tilt_x : isA ? t.pedal_a_tilt_x : t.pedal_b_tilt_x
  const sideTiltY = side === 'NONE' ? t.tilt_y : isA ? t.pedal_a_tilt_y : t.pedal_b_tilt_y
  const sideLaser = isA ? t.laser_a : t.laser_b
  const sidePedal = isA ? t.pedal_a : t.pedal_b
  const sideAng = isA ? t.ang_cor_a : t.ang_cor_b

  const connected = state.is_connected

  const handleSideChange = async (sel: SideSelection) => {
    try {
      await actions.pedalSelect(sel)
      setSide(sel)
    } catch { /* useDevice 已记录错误 */ }
  }

  const withPhase = async (s: 'A' | 'B', fn: () => Promise<void>, runningPhase: 'leveling' | 'pushing') => {
    try {
      await fn()
      setPhase(s, runningPhase)
    } catch { /* 命令失败保持原状态 */ }
  }

  const stopFlow = async (s: 'A' | 'B', fn: () => Promise<void>) => {
    try {
      await fn()
      setPhase(s, 'idle')
    } catch { /* */ }
  }

  // RECORD：抓当前遥测快照
  const snapshotRecord = (s: 'A' | 'B') => {
    const tel = state.telemetry
    const isASide = s === 'A'
    addRecord({
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      side: s,
      tilt_x: isASide ? tel.pedal_a_tilt_x : tel.pedal_b_tilt_x,
      tilt_y: isASide ? tel.pedal_a_tilt_y : tel.pedal_b_tilt_y,
      laser: isASide ? tel.laser_a : tel.laser_b,
      pedal_pos: (isASide ? tel.pedal_a : tel.pedal_b) ?? null,
      ang_cor: isASide ? tel.ang_cor_a : tel.ang_cor_b,
      angle_comp: null,
    })
    actions.pedalRecord(s).catch(() => {})
  }

  const renderSideCard = (s: 'A' | 'B') => {
    const st = sides[s]
    const isActive = side === s || side === 'NONE'
    const isASide = s === 'A'
    return (
      <PedalSideCard
        key={s}
        side={s}
        active={isActive}
        phase={st.phase}
        params={st.params}
        tiltX={isASide ? t.pedal_a_tilt_x : t.pedal_b_tilt_x}
        tiltY={isASide ? t.pedal_a_tilt_y : t.pedal_b_tilt_y}
        laser={isASide ? t.laser_a : t.laser_b}
        pedalPos={isASide ? t.pedal_a : t.pedal_b}
        angCor={isASide ? t.ang_cor_a : t.ang_cor_b}
        onParamChange={(key, value) => {
          setParam(s, key, value)
          if (key === 'pushDist' && value) {
            actions.pedalSet(s, 'PUSH_DIST', value).catch(() => {})
          }
          if (key === 'angleComp' && value) {
            actions.pedalSet(s, 'ANGLE_COMP', value).catch(() => {})
          }
          if (key === 'endH' && value) {
            actions.pedalSet(s, 'END_H', value).catch(() => {})
          }
        }}
        onStart={() =>
          withPhase(s, () => actions.pedalStart(s), 'leveling')
        }
        onStop={() => stopFlow(s, () => actions.pedalStop(s))}
        onPushStart={() =>
          withPhase(s, () => actions.pedalPushStart(s), 'pushing')
        }
        onPushStop={() => actions.pedalPushStop(s)}
        onLevel={() => actions.pedalLevel(s)}
        onZero={() => actions.pedalZero(s)}
        onRecord={() => snapshotRecord(s)}
      />
    )
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      {error && (
        <div className="flex items-center justify-between px-4 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 font-label-bold">
          <span className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px]">error</span>
            {error}
          </span>
          <button onClick={actions.clearError} className="material-symbols-outlined text-[18px]">close</button>
        </div>
      )}

      {/* 顶部：选侧 + 倾角 + 急停 */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <span className="font-label-bold text-on-surface-variant">选中侧：</span>
          <SideSelector value={side} disabled={!connected} onChange={handleSideChange} />
        </div>
        <div className="flex items-center gap-6">
          <TiltIndicator tiltX={sideTiltX} tiltY={sideTiltY} label={side === 'NONE' ? '公用倾角' : `${side} 侧倾角`} />
          <EstopButton onEstop={actions.estop} />
        </div>
      </div>

      {/* 双侧卡片 */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {renderSideCard('A')}
        {renderSideCard('B')}
      </div>

      {/* 趋势 + 事件 */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 industrial-card rounded-xl p-3 h-72">
          <div className="flex justify-between items-center mb-1">
            <span className="font-label-bold text-label-bold uppercase tracking-widest text-on-surface-variant">
              趋势（{side === 'NONE' ? '公用倾角' : `${side} 侧`}）
            </span>
            <button onClick={clearTrend} className="font-label-sm text-outline hover:text-critical">清空</button>
          </div>
          <ResponsiveContainer width="100%" height="90%">
            <LineChart data={trend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} />
              <YAxis yAxisId="tilt" tick={{ fontSize: 10 }} domain={[-2, 2]} unit="°" />
              <YAxis yAxisId="pedal" orientation="right" tick={{ fontSize: 10 }} unit="mm" />
              <Tooltip
                contentStyle={{ fontSize: 12 }}
                formatter={(v, name) => (v === null || v === undefined ? ['--', String(name)] : [v, String(name)]) as [string, string]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="tilt" type="monotone" dataKey="tilt_y" name="倾角 Y °" stroke="#0284c7" dot={false} isAnimationActive={false} connectNulls={false} />
              <Line yAxisId="tilt" type="monotone" dataKey="tilt_x" name="倾角 X °" stroke="#7c3aed" dot={false} isAnimationActive={false} connectNulls={false} />
              <Line yAxisId="pedal" type="monotone" dataKey="pedal_mm" name="推杆 mm" stroke="#f59e0b" dot={false} isAnimationActive={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="industrial-card rounded-xl h-72 overflow-hidden">
          <EventTimeline events={events} onClear={clearEvents} />
        </div>
      </div>

      {/* 记录点表 */}
      <div className="industrial-card rounded-xl">
        <div className="industrial-card-header flex justify-between items-center">
          <h3 className="font-label-bold text-label-bold uppercase tracking-widest text-on-surface-variant">
            记录点（{records.length}）
          </h3>
          <div className="flex gap-3">
            <button
              onClick={() => {
                const csv = [
                  ['#', '时间', '侧', '倾角X°', '倾角Y°', '激光mm', '推杆脉冲', '校正角°'],
                  ...records.map((r) => [
                    r.index, r.timestamp, r.side,
                    r.tilt_x ?? 'nan', r.tilt_y ?? 'nan',
                    r.laser ?? 'nan', r.pedal_pos ?? 'nan', r.ang_cor ?? 'nan',
                  ].join(',')),
                ].join('\n')
                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `pedal-records-${Date.now()}.csv`
                a.click()
                URL.revokeObjectURL(url)
              }}
              disabled={records.length === 0}
              className="font-label-sm text-primary hover:underline disabled:text-outline"
            >
              导出 CSV
            </button>
            <button
              onClick={() => { clearRecords(); actions.pedalClear().catch(() => {}) }}
              disabled={records.length === 0}
              className="font-label-sm text-outline hover:text-critical disabled:text-outline/50"
            >
              全部清除
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50 text-left">
                {['#', '时间', '侧', '倾角 X °', '倾角 Y °', '激光 mm', '推杆(脉冲)', '校正角 °', ''].map((h) => (
                  <th key={h} className="border-b border-slate-200 px-3 py-2 font-label-bold text-label-sm text-on-surface-variant">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center text-outline py-6 font-label-sm">
                    暂无记录点：测试稳定后点击「记录」抓取遥测快照
                  </td>
                </tr>
              )}
              {records.map((r) => (
                <tr key={r.index} className="hover:bg-slate-50">
                  <td className="px-3 py-1.5 monospaced-data">{r.index}</td>
                  <td className="px-3 py-1.5 monospaced-data">{r.timestamp}</td>
                  <td className="px-3 py-1.5">{r.side}</td>
                  <td className="px-3 py-1.5 monospaced-data">{r.tilt_x === null ? '--' : r.tilt_x.toFixed(3)}</td>
                  <td className="px-3 py-1.5 monospaced-data">{r.tilt_y === null ? '--' : r.tilt_y.toFixed(3)}</td>
                  <td className="px-3 py-1.5 monospaced-data">{r.laser === null ? '--' : r.laser.toFixed(1)}</td>
                  <td className="px-3 py-1.5 monospaced-data">{r.pedal_pos === null ? '--' : r.pedal_pos.toFixed(0)}</td>
                  <td className="px-3 py-1.5 monospaced-data">{r.ang_cor === null ? '--' : r.ang_cor.toFixed(2)}</td>
                  <td className="px-3 py-1.5">
                    <button
                      onClick={() => removeRecord(r.index)}
                      className="material-symbols-outlined text-[16px] text-outline hover:text-critical"
                    >
                      delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
