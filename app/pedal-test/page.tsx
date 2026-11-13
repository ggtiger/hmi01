'use client'

import { useEffect, useRef, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { useDevice, useForce } from '@/lib/comm'
import { usePedalStore, useSettingsStore, forceCoefficient } from '@/lib/store'
import EventTimeline from '@/components/ui/EventTimeline'
import ForceModal from '@/components/ui/ForceModal'
import { useT } from '@/lib/i18n'
import { fmtNum } from '@/lib/comm/types'

interface FieldSnapshot {
  startH: number | null
  endH: number | null
}

const emptySnapshot = (): FieldSnapshot => ({ startH: null, endH: null })

const PHASE_TEXT: Record<string, string> = {
  idle: '待机', leveling: '调平中', pushing: '推出中', stable: '已稳定',
}

/** 踏板测试（V6 原型）：顶部工具栏 + 左侧测量/电机 + 右侧图表/记录 + 底部 Info/动作 */
export default function PedalTestPage() {
  const t9n = useT()
  const { boards, actions, lastEvent, error } = useDevice()
  const { states: forceStates } = useForce()
  const {
    side, setSide, sides, setPhase, setParam,
    events, pushEvent, clearEvents,
    trend, pushTrend, clearTrend,
    records, addRecord, removeRecord, clearRecords,
  } = usePedalStore()

  const lastTrendPush = useRef(0)
  const lastProcessedEvent = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [chartTab, setChartTab] = useState<'trend' | 'events'>('trend')
  const [forceModalOpen, setForceModalOpen] = useState(false)
  const [avgForce, setAvgForce] = useState<number | null>(null)
  const [guard, setGuard] = useState<string | null>(null)
  const [snapshots, setSnapshots] = useState<Record<'A' | 'B', FieldSnapshot>>({
    A: emptySnapshot(),
    B: emptySnapshot(),
  })
  const forceHistory = useRef<number[]>([])

  const workSide: 'A' | 'B' = side === 'B' ? 'B' : 'A'
  const work = sides[workSide]
  const snap = snapshots[workSide]
  const board = boards[workSide]
  const t = board.telemetry
  const connected = board.is_connected

  const forceCh = forceStates[workSide]
  const forceCoef = forceCoefficient(
    useSettingsStore((s) => s.forceCoefficients),
    workSide
  )
  const forceRawN = forceCh.isConnected ? forceCh.latest?.weightN ?? null : null
  const forceLive = forceRawN === null ? null : forceRawN * forceCoef
  const forceMax = forceCh.isConnected ? forceCh.maxN * forceCoef : null

  const isA = workSide === 'A'
  const tiltX = isA ? t.pedal_a_tilt_x : t.pedal_b_tilt_x
  const tiltY = isA ? t.pedal_a_tilt_y : t.pedal_b_tilt_y
  const laser = isA ? t.laser_a : t.laser_b
  const heightDiff = snap.startH !== null && snap.endH !== null ? snap.endH - snap.startH : null
  const fault = board.telemetry.state === 'FAULT'
  const ready = connected && forceCh.isConnected

  useEffect(() => {
    if (forceLive === null) return
    const arr = forceHistory.current
    arr.push(forceLive)
    if (arr.length > 30) arr.shift()
    if (arr.length === 1 || arr.length % 5 === 0) {
      setAvgForce(arr.reduce((a, b) => a + b, 0) / arr.length)
    }
  }, [forceLive])

  useEffect(() => {
    if (t.t <= 0) return
    const now = Date.now()
    if (now - lastTrendPush.current < 200) return
    lastTrendPush.current = now
    pushTrend(t)
  }, [t, pushTrend])

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
      setGuard(null)
    })

  const setField = (s: 'A' | 'B', key: keyof FieldSnapshot, value: number | null) =>
    setSnapshots((prev) => ({ ...prev, [s]: { ...prev[s], [key]: value } }))

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
      case 'heightDiff':
        addRecord({ timestamp: ts, side: workSide, key: '高度差', value: heightDiff, unit: 'mm' })
        break
      case 'force':
        addRecord({ timestamp: ts, side: workSide, key: '实时力值', value: forceLive, unit: 'N' })
        break
    }
  }

  const toggleTest = () =>
    run(async () => {
      if (work.phase === 'idle') {
        if (!connected) {
          setGuard('目标板未连接，请先在顶部「连接」中完成 A/B 板连接。')
          return
        }
        if (!forceCh.isConnected) {
          setGuard(`${workSide} 侧力值蓝牙模块未连接，请先在「蓝牙模块联结」中连接。`)
          return
        }
        setGuard(null)
        await actions.pedalSelect(workSide)
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
      ['#', '时间', '侧', '记录项', '值', '单位'].map(t9n).join(','),
      ...records.map((r) =>
        [r.index, r.timestamp, r.side, t9n(r.key), r.value === null ? '--' : r.value.toFixed(3), r.unit].join(',')
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

  const rowBtn = 'h-8 min-w-[46px] px-2 rounded-md border border-white/80 bg-white/70 text-[11px] font-bold text-slate-600 hover:text-[#0891b2]'
  const rowBtnClear = 'h-8 min-w-[46px] px-2 rounded-md border border-white/80 bg-white/50 text-[11px] font-bold text-slate-500 hover:text-red-600'

  return (
    <div className="h-full flex flex-col gap-2 p-3 overflow-hidden">
      {error && (
        <div className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-red-50/80 border border-red-200 text-red-700 text-[12px] font-label-bold">
          <span>{error}</span>
          <button onClick={actions.clearError} className="material-symbols-outlined text-[16px]">close</button>
        </div>
      )}
      {guard && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-[12px] font-label-bold">
          <span className="material-symbols-outlined text-[17px]">warning</span>
          {guard}
          <button onClick={() => setGuard(null)} className="material-symbols-outlined text-[16px] ml-auto">close</button>
        </div>
      )}
      {fault && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-[12px] font-label-bold">
          <span className="material-symbols-outlined text-[17px]">warning</span>
          {t9n('设备处于故障态：运动命令被拒绝，请先点击「故障复位」')}
          <button
            onClick={() => run(() => actions.resetFault(workSide))}
            disabled={!connected || busy}
            className="glass-btn !h-7 !px-3 !text-[11px] ml-auto"
          >
            {t9n('故障复位')}
          </button>
        </div>
      )}

      {/* 命令条 */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <h1 className="text-[21px] font-black text-primary whitespace-nowrap">{t9n('踏板测试')}</h1>
        <span className="px-2 py-0.5 rounded-full bg-[#0891b2]/8 border border-[#0891b2]/20 text-[9px] font-extrabold text-[#0891b2]">
          {t9n('生产检测')}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={() => setForceModalOpen(true)} className="glass-btn primary !h-9 !px-3 !text-[12px]">
            <span className="material-symbols-outlined text-[16px]">bluetooth</span>
            {t9n('蓝牙模块联结')}
          </button>
          <div className="flex rounded-lg overflow-hidden border border-[rgba(15,80,120,.14)] bg-white/55">
            {(['A', 'B'] as const).map((s) => (
              <button
                key={s}
                onClick={() => handleSideChange(s)}
                disabled={!boards[s].is_connected || busy}
                className={`h-9 px-3 text-[12px] font-bold ${
                  workSide === s ? 'bg-[linear-gradient(135deg,#0891b2,#2563eb)] text-white' : 'text-slate-500'
                }`}
              >
                {t9n(s === 'A' ? 'A 模块' : 'B 模块')}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-[minmax(300px,.82fr)_minmax(0,1.4fr)] gap-3">
        {/* 左：测量 + 电机 */}
        <section className="glass-panel min-h-0 flex flex-col">
          <div className="glass-panel-header">
            {t9n('踏板')} {workSide} · {t9n('数据面板')}
            <span className="ml-auto flex items-center gap-1.5 font-normal normal-case tracking-normal">
              <span className={`led ${forceCh.isConnected ? 'on' : ''}`} />
              <span className="font-label-sm text-slate-500">
                {forceCh.isConnected ? forceCh.deviceName : t9n('力值模块未连接')}
              </span>
            </span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-2.5 flex flex-col gap-1.5">
            <div className="grid grid-cols-2 gap-1.5">
              <div className="glass-row !min-h-[46px]">
                <span className="k">{t9n('倾角 X')} <em>°</em></span>
                <span className="v">{fmtNum(tiltX, 3)}</span>
              </div>
              <div className="glass-row !min-h-[46px]">
                <span className="k">{t9n('倾角 Y')} <em>°</em></span>
                <span className="v">{fmtNum(tiltY, 3)}</span>
              </div>
            </div>

            <div className="glass-row !min-h-[46px]">
              <span className="k">{t9n('垂直测距')} <em>mm</em></span>
              <span className="v">{fmtNum(laser, 2)}</span>
              <button onClick={() => run(() => actions.pedalZero(workSide))} disabled={!connected || busy} className={rowBtn}>
                {t9n('清零')}
              </button>
            </div>
            <div className="glass-row !min-h-[46px]">
              <span className="k">{t9n('起始高度')} <em>mm</em></span>
              <span className="v">{fmtNum(snap.startH, 2)}</span>
              <button onClick={() => recordField('startH')} disabled={!connected} className={rowBtn}>{t9n('记录')}</button>
              <button onClick={() => setField(workSide, 'startH', null)} disabled={!connected} className={rowBtnClear}>{t9n('清除')}</button>
            </div>
            <div className="glass-row !min-h-[46px]">
              <span className="k">{t9n('终末高度')} <em>mm</em></span>
              <span className="v">{fmtNum(snap.endH, 2)}</span>
              <button onClick={() => recordField('endH')} disabled={!connected} className={rowBtn}>{t9n('记录')}</button>
              <button onClick={() => setField(workSide, 'endH', null)} disabled={!connected} className={rowBtnClear}>{t9n('清除')}</button>
            </div>
            <div className="glass-row !min-h-[46px]">
              <span className="k">{t9n('高度差')} <em>mm</em></span>
              <span className="v cyan">{fmtNum(heightDiff, 2)}</span>
              <button onClick={() => recordField('heightDiff')} disabled={!connected} className={rowBtn}>{t9n('记录')}</button>
              <button
                onClick={() => { setField(workSide, 'startH', null); setField(workSide, 'endH', null) }}
                disabled={!connected}
                className={rowBtnClear}
              >
                {t9n('清除')}
              </button>
            </div>
            <div className="glass-row !min-h-[46px]">
              <span className="k">{t9n('实时力值')} <em>N</em></span>
              <span className="v cyan">{fmtNum(forceLive, 2)}</span>
              <button onClick={() => recordField('force')} disabled={!forceCh.isConnected} className={rowBtn}>{t9n('记录')}</button>
              <button disabled className={rowBtnClear}>{t9n('清除')}</button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="glass-row !min-h-[46px]">
                <span className="k">{t9n('最大力值')} <em>N</em></span>
                <span className="v">{fmtNum(forceMax, 2)}</span>
              </div>
              <div className="glass-row !min-h-[46px]">
                <span className="k">{t9n('均匀力值')} <em>N</em></span>
                <span className="v">{fmtNum(avgForce, 2)}</span>
              </div>
            </div>

            <details className="mt-1 rounded-[10px] border border-[rgba(15,80,120,.10)] bg-white/35 overflow-hidden" open>
              <summary className="cursor-pointer px-3 py-2 font-label-bold text-[11px] tracking-wider text-slate-500 list-none flex items-center gap-1.5">
                <span className="text-[#0891b2]">▾</span>{t9n('电机控制部分')}
                <span className="ml-auto text-[9px] font-normal text-slate-400">{t9n('需总使能 · 命令发往目标板')}</span>
              </summary>
              <div className="border-t border-[rgba(15,80,120,.07)] p-2 space-y-1.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="w-14 text-[10px] font-bold text-slate-500">{t9n('调平电机')}</span>
                  <input
                    value={work.params.setAngle}
                    onChange={(e) => setParam(workSide, 'setAngle', e.target.value)}
                    className="ui-input w-16 !h-8 !py-1 text-center !text-[12px]"
                    inputMode="decimal"
                    title={t9n('目标角度 °')}
                  />
                  <button
                    onClick={() => run(async () => {
                      const angle = Number(work.params.setAngle)
                      if (!Number.isFinite(angle)) throw new Error(t9n('目标角度无效'))
                      await actions.motorMove(workSide, angle)
                    })}
                    disabled={!connected || busy}
                    className="glass-btn !h-8 !px-2.5 !text-[11px]"
                  >
                    {t9n('启动')}
                  </button>
                  <button onClick={() => run(() => actions.pedalLevel(workSide))} disabled={!connected || busy} className="glass-btn !h-8 !px-2.5 !text-[11px]">
                    {t9n('调平补偿')}
                  </button>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="w-14 text-[10px] font-bold text-slate-500">{t9n('加载电机')}</span>
                  <input
                    value={work.params.pushDist}
                    onChange={(e) => setParam(workSide, 'pushDist', e.target.value)}
                    onBlur={() => {
                      if (work.params.pushDist) actions.pedalSet(workSide, 'PUSH_DIST', work.params.pushDist).catch(() => {})
                    }}
                    className="ui-input w-14 !h-8 !py-1 text-center !text-[12px]"
                    inputMode="decimal"
                    placeholder="mm"
                  />
                  <button onClick={() => run(() => actions.pedalPushStart(workSide))} disabled={!connected || busy} className="glass-btn !h-8 !px-2.5 !text-[11px]">
                    {t9n('启动加载')}
                  </button>
                  <button onClick={() => run(() => actions.motorHome(workSide === 'A' ? 'PUSH_A' : 'PUSH_B'))} disabled={!connected || busy} className="glass-btn !h-8 !px-2.5 !text-[11px]">
                    {t9n('推杆回零')}
                  </button>
                  <button onClick={() => run(() => actions.motorMove(workSide === 'A' ? 'PUSH_A' : 'PUSH_B', -1.0))} disabled={!connected || busy} className="glass-btn !h-8 !px-2.5 !text-[11px]">−</button>
                  <button onClick={() => run(() => actions.motorMove(workSide === 'A' ? 'PUSH_A' : 'PUSH_B', 1.0))} disabled={!connected || busy} className="glass-btn !h-8 !px-2.5 !text-[11px]">＋</button>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button onClick={actions.motorEnable} disabled={!connected} className="glass-btn !h-8 !px-3 !text-[11px]">{t9n('总使能')}</button>
                  <button onClick={() => run(() => actions.pedalStop(workSide))} disabled={!connected || busy} className="glass-btn danger !h-8 !px-3 !text-[11px]">STOP</button>
                  <button onClick={() => run(() => actions.resetFault(workSide))} disabled={!connected || busy} className="glass-btn !h-8 !px-3 !text-[11px]">{t9n('故障复位')}</button>
                  <span className="ml-auto text-[9px] text-slate-400">{t9n('急停后必须先故障复位')}</span>
                </div>
              </div>
            </details>
          </div>
        </section>

        {/* 右：图表 + 本次记录 */}
        <div className="min-h-0 flex flex-col gap-3">
          <section className="glass-panel flex-1 min-h-0 flex flex-col">
            <div className="glass-panel-header">
              {t9n('图表 A')}
              <div className="ml-auto flex items-center gap-1.5 normal-case tracking-normal font-normal">
                <button onClick={() => setChartTab('trend')} className={`glass-btn !h-7 !px-2.5 !text-[11px] ${chartTab === 'trend' ? 'primary' : ''}`}>{t9n('趋势')}</button>
                <button onClick={() => setChartTab('events')} className={`glass-btn !h-7 !px-2.5 !text-[11px] ${chartTab === 'events' ? 'primary' : ''}`}>
                  {t9n('事件')}
                  {events.length > 0 && <span className="ml-1 px-1.5 rounded-full bg-[#e11d48] text-white text-[10px]">{events.length}</span>}
                </button>
                <button onClick={chartTab === 'trend' ? clearTrend : clearEvents} className="glass-btn !h-7 !px-2.5 !text-[11px]">{t9n('清空')}</button>
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
                    <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v, name) => (v === null || v === undefined ? ['--', String(name)] : [v, String(name)]) as [string, string]} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line yAxisId="tilt" type="monotone" dataKey="tilt_y" name={t9n('倾角 Y °')} stroke="#0891b2" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
                    <Line yAxisId="tilt" type="monotone" dataKey="tilt_x" name={t9n('倾角 X °')} stroke="#7c3aed" dot={false} isAnimationActive={false} connectNulls={false} />
                    <Line yAxisId="pedal" type="monotone" dataKey="pedal_mm" name={t9n('推杆 mm')} stroke="#d97706" dot={false} isAnimationActive={false} connectNulls={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <EventTimeline events={events} />
              )}
            </div>
          </section>

          <section className="glass-panel flex-shrink-0 h-[186px] flex flex-col">
            <div className="glass-panel-header">
              {t9n('本次记录')}
              <span className="ml-auto flex items-center gap-2 font-normal normal-case tracking-normal">
                <span className="font-label-sm text-slate-500">{records.length} {t9n('条')}</span>
                <button
                  onClick={() => { clearRecords(); actions.pedalClear(workSide).catch(() => {}) }}
                  disabled={records.length === 0}
                  className="glass-btn !h-7 !px-2.5 !text-[11px]"
                >
                  {t9n('清空')}
                </button>
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
              {records.length === 0 ? (
                <div className="text-center text-slate-400 text-[11px] py-6">{t9n('暂无记录')}</div>
              ) : (
                records.map((r) => (
                  <div key={r.index} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/50 text-[10.5px] text-slate-600">
                    <span className="font-mono text-[9px] text-slate-400">{r.timestamp}</span>
                    <span className="font-bold text-[#0891b2]">[{r.side}]</span>
                    <span className="truncate">{t9n(r.key)}</span>
                    <span className="ml-auto font-mono font-bold text-slate-700">
                      {r.value === null ? '--' : `${r.value.toFixed(3)} ${r.unit}`}
                    </span>
                    <button onClick={() => removeRecord(r.index)} className="material-symbols-outlined text-[14px] text-slate-400 hover:text-red-600">close</button>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>

      <div className="flex-shrink-0 h-[30px] flex items-center gap-2 px-3 rounded-lg border border-white/90 bg-white/55 text-[11px] text-slate-500">
        <span>Info:</span>
        <b className="text-[#0891b2]">
          {workSide} {t9n('侧')} · {t9n(PHASE_TEXT[work.phase])} · {t9n('心跳')} {board.last_pong || '--'}
        </b>
        <span className="ml-auto">{t9n('已记录')} {records.length} {t9n('条')}</span>
      </div>

      <div className="flex-shrink-0 flex items-center gap-2 pt-1">
        <button
          onClick={toggleTest}
          disabled={busy || fault}
          className={`glass-action flex-1 !h-[50px] !text-[15px] ${work.phase !== 'idle' ? 'danger' : 'primary'}`}
        >
          {work.phase === 'idle' ? t9n('开始测试') : t9n('停止测试')}
        </button>
        <button
          onClick={() => addRecord({
            timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            side: workSide,
            key: '遥测快照',
            value: forceLive,
            unit: 'N',
          })}
          disabled={!ready}
          className="glass-action !h-[50px] min-w-[88px]"
        >
          {t9n('记录')}
        </button>
        <button onClick={exportCsv} disabled={records.length === 0} className="glass-action !h-[50px] min-w-[88px]">
          {t9n('导出')}
        </button>
        <button
          onClick={() => handleSideChange(workSide === 'A' ? 'B' : 'A')}
          disabled={!connected || busy}
          className="glass-action !h-[50px] min-w-[100px]"
        >
          {t9n('踏板')} {workSide === 'A' ? 'B' : 'A'}
        </button>
      </div>

      <ForceModal open={forceModalOpen} onClose={() => setForceModalOpen(false)} />
    </div>
  )
}
