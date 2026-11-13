'use client'

import { useEffect, useRef, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { useForce } from '@/lib/comm'
import { fmtNum } from '@/lib/comm/types'
import { useSettingsStore, channelForceN } from '@/lib/store'
import { exportWorkbook, renderLineChartPng } from '@/lib/export-excel'
import ForceModal from '@/components/ui/ForceModal'
import { useT } from '@/lib/i18n'

interface SteerRecord {
  index: number
  timestamp: string
  key: string
  value: number | null
  unit: string
}

interface TrendPoint {
  label: string
  tilt_x: number | null
  tilt_y: number | null
  free: number | null
  torque: number | null
}

const MAX_TREND = 100

/** 转盘测试（V6 原型）：BLE 倾角 + 转向力，测量表 + 图表 + 记录 */
export default function SteeringTestPage() {
  const t = useT()
  const { states: forceStates, actions: forceActions } = useForce()

  const tiltCh = forceStates.STEER
  const torqueCh = forceStates.TORQUE
  const tiltConnected = tiltCh.isConnected
  const torqueConnected = torqueCh.isConnected
  const bleReady = tiltConnected && torqueConnected

  const angle = tiltConnected ? tiltCh.latestAngle : null
  const tiltX = angle?.angleX ?? null
  const tiltY = angle?.angleY ?? null

  const forceCoefficients = useSettingsStore((s) => s.forceCoefficients)
  const adCalibration = useSettingsStore((s) => s.adCalibration)
  const torqueLive = channelForceN(torqueCh, 'TORQUE', forceCoefficients, adCalibration)

  const [busy, setBusy] = useState(false)
  const [forceModalOpen, setForceModalOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [trend, setTrend] = useState<TrendPoint[]>([])
  const [records, setRecords] = useState<SteerRecord[]>([])
  const [zeroOffset, setZeroOffset] = useState(0)
  const [cwAngle, setCwAngle] = useState<number | null>(null)
  const [ccwAngle, setCcwAngle] = useState<number | null>(null)
  const [torqueMax, setTorqueMax] = useState<number | null>(null)
  const [guard, setGuard] = useState<string | null>(null)
  const lastTrendPush = useRef(0)

  const freeAngle = tiltX === null ? null : tiltX - zeroOffset
  const direction: 'cw' | 'ccw' | null =
    freeAngle === null || Math.abs(freeAngle) < 0.001 ? null : freeAngle > 0 ? 'cw' : 'ccw'

  useEffect(() => {
    if (!testing) return
    if (tiltX === null && tiltY === null && torqueLive === null) return
    const now = Date.now()
    if (now - lastTrendPush.current < 200) return
    lastTrendPush.current = now
    const d = new Date()
    const label = `${d.getHours().toString().padStart(2, '0')}:${d
      .getMinutes()
      .toString()
      .padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
    const free = tiltX === null ? null : tiltX - zeroOffset
    setTrend((prev) => {
      const next = [...prev, { label, tilt_x: tiltX, tilt_y: tiltY, free, torque: torqueLive }]
      return next.length > MAX_TREND ? next.slice(-MAX_TREND) : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [angle?.angleX, angle?.angleY, torqueLive, testing])

  const addRecord = (key: string, value: number | null, unit = '°') =>
    setRecords((prev) => [
      ...prev,
      {
        index: prev.length + 1,
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        key,
        value,
        unit,
      },
    ])

  const recordTorqueMax = () => {
    if (torqueLive === null) return
    setTorqueMax(torqueLive)
    addRecord('最大力值', torqueLive, 'N')
  }
  const recordCwPeak = () => {
    if (freeAngle === null || freeAngle <= 0.001) return
    setCwAngle(freeAngle)
    addRecord('顺时针峰值', freeAngle)
  }
  const recordCcwPeak = () => {
    if (freeAngle === null || freeAngle >= -0.001) return
    setCcwAngle(freeAngle)
    addRecord('逆时针峰值', freeAngle)
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch {
      /* useForce 已记录错误 */
    } finally {
      setBusy(false)
    }
  }

  const startTest = () => {
    if (!bleReady) {
      setGuard('请先连接倾角模块与转向力模块，再开始测试。')
      return
    }
    setGuard(null)
    setTesting(true)
    setTrend([])
    lastTrendPush.current = 0
    setCwAngle(null)
    setCcwAngle(null)
    setTorqueMax(null)
    forceActions.resetMax('TORQUE').catch(() => {})
  }

  const toggleTest = () => {
    if (testing) setTesting(false)
    else startTest()
  }

  const exportExcel = async () => {
    try {
      const round = (v: number | null, d = 3) => (v === null ? null : Number(v.toFixed(d)))
      const labels = trend.map((p) => p.label)
      const chartImage =
        trend.length > 1
          ? renderLineChartPng(labels, [
              { name: t('倾角 X (°)'), color: '#041627', values: trend.map((p) => p.tilt_x) },
              { name: t('倾角 Y (°)'), color: '#8192a7', values: trend.map((p) => p.tilt_y) },
              { name: t('自由转角 (°)'), color: '#f59e0b', values: trend.map((p) => p.free) },
              { name: t('实时力值 (N)'), color: '#16a34a', values: trend.map((p) => p.torque), separateScale: true },
            ])
          : null

      await exportWorkbook(`steer-records-${Date.now()}.xlsx`, [
        {
          name: t('记录值'),
          rows: [
            ['序号', '时间', '记录项', '值', '单位'].map(t),
            ...records.map((r) => [r.index, r.timestamp, t(r.key), round(r.value), r.unit]),
          ],
        },
        {
          name: t('实时曲线'),
          chartImage: chartImage ?? undefined,
          rows: [
            ['时间', '倾角 X (°)', '倾角 Y (°)', '自由转角 (°)', '实时力值 (N)'].map(t),
            ...trend.map((p) => [p.label, round(p.tilt_x), round(p.tilt_y), round(p.free), round(p.torque, 2)]),
          ],
        },
      ])
    } catch (err) {
      console.error('[Steer] 导出失败:', err)
    }
  }

  const clearAll = () => {
    setTrend([])
    setRecords([])
  }

  const rowBtn = 'h-8 min-w-[46px] px-2 rounded-md border border-white/80 bg-white/70 text-[11px] font-bold text-slate-600 hover:text-[#0891b2]'
  const rowBtnClear = 'h-8 min-w-[46px] px-2 rounded-md border border-white/80 bg-white/50 text-[11px] font-bold text-slate-500 hover:text-red-600'

  return (
    <div className="h-full flex flex-col gap-2 p-3 overflow-hidden">
      {guard && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-[12px] font-label-bold">
          <span className="material-symbols-outlined text-[17px]">warning</span>
          {guard}
          <button onClick={() => setGuard(null)} className="material-symbols-outlined text-[16px] ml-auto">close</button>
        </div>
      )}

      <div className="flex items-center gap-2 flex-shrink-0">
        <h1 className="text-[21px] font-black text-primary whitespace-nowrap">{t('转盘测试')}</h1>
        <span className="px-2 py-0.5 rounded-full bg-[#0891b2]/8 border border-[#0891b2]/20 text-[9px] font-extrabold text-[#0891b2]">
          {t('双模块采集')}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={() => setForceModalOpen(true)} className="glass-btn primary !h-9 !px-3 !text-[12px]">
            <span className="material-symbols-outlined text-[16px]">bluetooth</span>
            {t('蓝牙模块联结')}
          </button>
          <button onClick={() => setForceModalOpen(true)} className="glass-btn !h-9 !px-3 !text-[12px]">
            <span className={`led ${tiltConnected ? 'on' : ''}`} />
            {t('倾角模块')}
          </button>
          <button onClick={() => setForceModalOpen(true)} className="glass-btn !h-9 !px-3 !text-[12px]">
            <span className={`led ${torqueConnected ? 'on' : ''}`} />
            {t('转向力模块')}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-[minmax(300px,.82fr)_minmax(0,1.4fr)] gap-3">
        <section className="glass-panel min-h-0 flex flex-col">
          <div className="glass-panel-header">
            {t('转盘')} · {t('数据面板')}
            <span className="ml-auto font-label-sm font-normal normal-case tracking-normal text-slate-500">
              {t('倾角 10Hz · 力值 100ms')}
            </span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-2.5 flex flex-col gap-1.5">
            <div className="grid grid-cols-2 gap-1.5">
              <div className="glass-row !min-h-[46px]">
                <span className="k">{t('倾角 X')} <em>°</em></span>
                <span className="v">{fmtNum(tiltX, 3)}</span>
              </div>
              <div className="glass-row !min-h-[46px]">
                <span className="k">{t('倾角 Y')} <em>°</em></span>
                <span className="v">{fmtNum(tiltY, 3)}</span>
              </div>
            </div>

            <div className="glass-row !min-h-[46px]">
              <span className="k">
                {t('自由转角')} <em>°</em>
                {direction && (
                  <span className={`ml-1 text-[9px] font-extrabold ${direction === 'cw' ? 'text-sky-600' : 'text-violet-600'}`}>
                    {direction === 'cw' ? t('顺时针') : t('逆时针')}
                  </span>
                )}
              </span>
              <span className="v cyan">{fmtNum(freeAngle, 3)}</span>
              <button onClick={() => setZeroOffset(tiltX ?? 0)} disabled={tiltX === null} className={rowBtn}>{t('清零')}</button>
              <button onClick={() => addRecord('自由转角', freeAngle)} disabled={freeAngle === null} className={rowBtn}>{t('记录')}</button>
            </div>
            <div className="glass-row !min-h-[46px]">
              <span className="k">{t('顺时针峰值')} <em>°</em></span>
              <span className="v violet">{fmtNum(cwAngle, 3)}</span>
              <button onClick={recordCwPeak} disabled={freeAngle === null || freeAngle <= 0.001} className={rowBtn}>{t('记录')}</button>
              <button onClick={() => setCwAngle(null)} disabled={!testing} className={rowBtnClear}>{t('清除')}</button>
            </div>
            <div className="glass-row !min-h-[46px]">
              <span className="k">{t('逆时针峰值')} <em>°</em></span>
              <span className="v violet">{fmtNum(ccwAngle, 3)}</span>
              <button onClick={recordCcwPeak} disabled={freeAngle === null || freeAngle >= -0.001} className={rowBtn}>{t('记录')}</button>
              <button onClick={() => setCcwAngle(null)} disabled={!testing} className={rowBtnClear}>{t('清除')}</button>
            </div>
            <div className="glass-row !min-h-[46px]">
              <span className="k">{t('实时力值')} <em>N</em></span>
              <span className="v cyan">{fmtNum(torqueLive, 2)}</span>
              <button onClick={() => run(() => forceActions.zero('TORQUE'))} disabled={!torqueConnected || busy} className={rowBtn}>{t('清零')}</button>
              <button onClick={() => addRecord('实时力值', torqueLive, 'N')} disabled={torqueLive === null} className={rowBtn}>{t('记录')}</button>
            </div>
            <div className="glass-row !min-h-[46px]">
              <span className="k">{t('最大力值')} <em>N</em></span>
              <span className="v">{fmtNum(torqueMax, 2)}</span>
              <button onClick={recordTorqueMax} disabled={torqueLive === null} className={rowBtn}>{t('记录')}</button>
              <button
                onClick={() => { setTorqueMax(null); forceActions.resetMax('TORQUE').catch(() => {}) }}
                disabled={!torqueConnected}
                className={rowBtnClear}
              >
                {t('清除')}
              </button>
            </div>

            <div className="mt-1 rounded-[10px] border border-[rgba(15,80,120,.10)] bg-white/35 px-3 py-2 text-[10px] text-slate-500 leading-relaxed">
              <b className="text-slate-600">{t('记录规则')}</b><br />
              {t('趋势仅在测试中采集；峰值与力值需点击「记录」写入记录表。')}
            </div>
          </div>
        </section>

        <div className="min-h-0 flex flex-col gap-3">
          <section className="glass-panel flex-1 min-h-0 flex flex-col">
            <div className="glass-panel-header">
              {t('图表 A')}
              <span className="ml-auto font-label-sm font-normal normal-case tracking-normal text-slate-500">
                {t('倾角')} / {t('自由转角')} / {t('力值')}
              </span>
            </div>
            <div className="flex-1 min-h-0 p-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#c9d8e6" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="angle" tick={{ fontSize: 11 }} unit="°" />
                  <YAxis yAxisId="force" orientation="right" tick={{ fontSize: 11 }} unit="N" />
                  <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v, name) => (v === null || v === undefined ? ['--', String(name)] : [v, String(name)]) as [string, string]} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line yAxisId="angle" type="monotone" dataKey="tilt_x" name={t('倾角 X °')} stroke="#0891b2" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
                  <Line yAxisId="angle" type="monotone" dataKey="free" name={t('自由转角 °')} stroke="#7c3aed" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
                  <Line yAxisId="force" type="monotone" dataKey="torque" name={t('实时力值 N')} stroke="#16a34a" dot={false} isAnimationActive={false} connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="glass-panel flex-shrink-0 h-[186px] flex flex-col">
            <div className="glass-panel-header">
              {t('本次记录')}
              <span className="ml-auto flex items-center gap-2 font-normal normal-case tracking-normal">
                <span className="font-label-sm text-slate-500">{records.length} {t('条')}</span>
                <button onClick={clearAll} disabled={records.length === 0} className="glass-btn !h-7 !px-2.5 !text-[11px]">
                  {t('清空')}
                </button>
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
              {records.length === 0 ? (
                <div className="text-center text-slate-400 text-[11px] py-6">{t('暂无记录')}</div>
              ) : (
                records.map((r) => (
                  <div key={r.index} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/50 text-[10.5px] text-slate-600">
                    <span className="font-mono text-[9px] text-slate-400">{r.timestamp}</span>
                    <span className="truncate">{t(r.key)}</span>
                    <span className="ml-auto font-mono font-bold text-slate-700">
                      {r.value === null ? '--' : `${r.value.toFixed(3)} ${r.unit}`}
                    </span>
                    <button
                      onClick={() => setRecords((prev) => prev.filter((x) => x.index !== r.index).map((x, i) => ({ ...x, index: i + 1 })))}
                      className="material-symbols-outlined text-[14px] text-slate-400 hover:text-red-600"
                    >
                      close
                    </button>
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
          {t('倾角模块')} {tiltConnected ? t('已连接') : t('未连接')} · {t('转向力模块')} {torqueConnected ? t('已连接') : t('未连接')} · {testing ? t('测试中') : t('待机')}
        </b>
        <span className="ml-auto">{t('已记录')} {records.length} {t('条')}</span>
      </div>

      <div className="flex-shrink-0 flex items-center gap-2 pt-1">
        <button
          onClick={toggleTest}
          disabled={busy}
          className={`glass-action flex-1 !h-[50px] !text-[15px] ${testing ? 'danger' : 'primary'}`}
        >
          {testing ? t('停止测试') : t('开始测试')}
        </button>
        <button onClick={() => addRecord('自由转角', freeAngle)} disabled={freeAngle === null} className="glass-action !h-[50px] min-w-[88px]">
          {t('记录')}
        </button>
        <button onClick={exportExcel} disabled={records.length === 0 && trend.length === 0} className="glass-action !h-[50px] min-w-[110px]">
          {t('导出 Excel')}
        </button>
        <button onClick={clearAll} className="glass-action !h-[50px] min-w-[88px]">
          {t('清空')}
        </button>
      </div>

      <ForceModal open={forceModalOpen} onClose={() => setForceModalOpen(false)} />
    </div>
  )
}
