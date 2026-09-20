'use client'

import { useEffect, useRef, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { useDevice, useForce } from '@/lib/comm'
import { fmtNum } from '@/lib/comm/types'
import EstopButton from '@/components/ui/EstopButton'
import ForceModal from '@/components/ui/ForceModal'

/** 记录点（转盘测试本地记录，协议 STEER 为预留功能） */
interface SteerRecord {
  index: number
  timestamp: string
  key: string
  value: number | null
  unit: string
}

interface TrendPoint {
  label: string
  steer_x: number | null
  steer_y: number | null
}

const MAX_TREND = 100

/** 数据行（与踏板页数据面板同风格） */
function DataRow({
  label, value, unit, digits = 2, actions,
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
  children, onClick, disabled,
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="ui-action-btn !px-2.5 !py-1 !text-[12px] flex-shrink-0"
    >
      {children}
    </button>
  )
}

/**
 * 转盘测试（PPT 设计稿 slide 4）
 * 协议 §2.9 STEER START/STOP + 遥测 steer_x/steer_y（方向盘 X/Y 角度）
 */
export default function SteeringTestPage() {
  const { state, actions, error } = useDevice()
  const { states: forceStates } = useForce()
  const t = state.telemetry
  const connected = state.is_connected
  const running = t.state === 'STEER_RUN'

  const steerForce = forceStates.STEER
  const forceLive = steerForce.isConnected ? steerForce.latest?.weightN ?? null : null
  const forceMax = steerForce.isConnected ? steerForce.maxN : null

  const [busy, setBusy] = useState(false)
  const [forceModalOpen, setForceModalOpen] = useState(false)
  const [processForce, setProcessForce] = useState<number | null>(null)
  const [trend, setTrend] = useState<TrendPoint[]>([])
  const [records, setRecords] = useState<SteerRecord[]>([])
  const [freeAngle, setFreeAngle] = useState<number | null>(null)
  const [cwAngle, setCwAngle] = useState<number | null>(null)
  const [ccwAngle, setCcwAngle] = useState<number | null>(null)
  const lastTrendPush = useRef(0)
  const prevSteerSign = useRef(0)

  // 遥测 → 趋势（200ms 采样门控）
  useEffect(() => {
    if (t.t <= 0) return
    const now = Date.now()
    if (now - lastTrendPush.current < 200) return
    lastTrendPush.current = now
    const d = new Date()
    const label = `${d.getMinutes().toString().padStart(2, '0')}:${d
      .getSeconds()
      .toString()
      .padStart(2, '0')}`
    setTrend((prev) => {
      const next = [...prev, { label, steer_x: t.steer_x, steer_y: t.steer_y }]
      return next.length > MAX_TREND ? next.slice(-MAX_TREND) : next
    })
  }, [t])

  // 顺时针/逆时针峰值跟踪（运行中自动更新）+ 进程力值跟踪
  useEffect(() => {
    if (!running) return
    if (forceLive !== null) setProcessForce(forceLive)
    if (t.steer_x === null) return
    const x = t.steer_x
    if (x > 0 && (cwAngle === null || x > cwAngle)) setCwAngle(x)
    if (x < 0 && (ccwAngle === null || x < ccwAngle)) setCcwAngle(x)
    // 自由转角 = 方向反转点的幅值（近似）
    const sign = Math.sign(x)
    if (sign !== 0 && prevSteerSign.current !== 0 && sign !== prevSteerSign.current) {
      setFreeAngle(Math.abs(x))
    }
    if (sign !== 0) prevSteerSign.current = sign
  }, [t.steer_x, running, cwAngle, ccwAngle, forceLive])

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

  const exportCsv = () => {
    const lines = [
      ['#', '时间', '记录项', '值'].join(','),
      ...records.map((r) =>
        [r.index, r.timestamp, r.key, r.value === null ? '--' : `${r.value.toFixed(2)}${r.unit}`].join(',')
      ),
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `steer-records-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="h-full flex flex-col gap-2 p-3 overflow-hidden">
      {/* ===== 顶部行：蓝牙 / 连接 + 公用倾角 ===== */}
      <div className="flex items-stretch gap-1.5">
        <button
          onClick={() => setForceModalOpen(true)}
          className={`ui-action-btn ${steerForce.isConnected ? '' : 'ui-action-btn-ghost'} !px-3`}
          title="蓝牙力值模块管理"
        >
          <span className="material-symbols-outlined text-[16px]">bluetooth</span>
          蓝牙模块联结
        </button>
        <div className={`ui-data-box !px-3 ${connected ? '!border-success' : '!border-critical'}`}>
          <span className="ui-label">WiFi 连接</span>
          <span className={`ui-value ${connected ? '!text-success' : '!text-critical'}`}>
            {connected ? '已连接' : '未连接'}
          </span>
        </div>
        <div className="ui-data-box">
          <span className="ui-label">无线状态</span>
          <span className="ui-value">{running ? 'STEER_RUN 测试中' : t.state}</span>
        </div>
        <div className="flex-1" />
        <div className="ui-data-box">
          <span className="ui-label">倾角 X</span>
          <span className="ui-value">{fmtNum(t.tilt_x, 3)}°</span>
        </div>
        <div className="ui-data-box">
          <span className="ui-label">倾角 Y</span>
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
        <div className="w-[460px] flex-shrink-0 industrial-card rounded-xl p-2.5">
          <div className="flex flex-col gap-1.5 h-full justify-between">
            <div className="ui-data-box !bg-primary !border-primary">
              <span className="font-label-bold text-on-primary tracking-widest">转盘测试</span>
              <span className="ui-value !text-on-primary/70 text-[11px]">方向盘</span>
            </div>

            <DataRow
              label="方向盘 X"
              unit="°"
              value={t.steer_x}
              actions={<MiniBtn onClick={() => addRecord('方向盘 X', t.steer_x)} disabled={!connected}>记录</MiniBtn>}
            />
            <DataRow
              label="方向盘 Y"
              unit="°"
              value={t.steer_y}
              actions={<MiniBtn onClick={() => addRecord('方向盘 Y', t.steer_y)} disabled={!connected}>记录</MiniBtn>}
            />

            <DataRow
              label="自由转角"
              unit="°"
              value={freeAngle}
              actions={
                <>
                  <MiniBtn onClick={() => addRecord('自由转角', freeAngle)} disabled={!connected}>记录</MiniBtn>
                  <MiniBtn onClick={() => setFreeAngle(null)} disabled={!connected}>清除</MiniBtn>
                </>
              }
            />
            <DataRow
              label="顺时针峰值"
              unit="°"
              value={cwAngle}
              actions={
                <>
                  <MiniBtn onClick={() => addRecord('顺时针峰值', cwAngle)} disabled={!connected}>记录</MiniBtn>
                  <MiniBtn onClick={() => setCwAngle(null)} disabled={!connected}>清除</MiniBtn>
                </>
              }
            />
            <DataRow
              label="逆时针峰值"
              unit="°"
              value={ccwAngle}
              actions={
                <>
                  <MiniBtn onClick={() => addRecord('逆时针峰值', ccwAngle)} disabled={!connected}>记录</MiniBtn>
                  <MiniBtn onClick={() => setCcwAngle(null)} disabled={!connected}>清除</MiniBtn>
                </>
              }
            />

            <div className="grid grid-cols-2 gap-1.5">
              <div className="ui-data-box">
                <span className="ui-label">实时力值 N</span>
                <span className="ui-value">{fmtNum(forceLive, 2)}</span>
              </div>
              <div className="ui-data-box">
                <span className="ui-label">最大力值 N</span>
                <span className="ui-value">{fmtNum(forceMax, 2)}</span>
              </div>
            </div>
            <DataRow
              label="进程力值"
              unit="N"
              value={processForce}
              digits={2}
              actions={
                <>
                  <MiniBtn onClick={() => addRecord('进程力值', processForce, 'N')} disabled={!connected}>记录</MiniBtn>
                  <MiniBtn onClick={() => setProcessForce(null)} disabled={!connected}>清除</MiniBtn>
                </>
              }
            />

            <div className="flex items-center gap-1.5 mt-1">
              <button
                onClick={() => run(running ? actions.steerStop : actions.steerStart)}
                disabled={!connected || busy}
                className={`ui-action-btn flex-1 !py-2.5 !text-[14px] ${running ? 'ui-action-btn-danger' : ''}`}
              >
                {running ? '停止测试' : '开始测试'}
              </button>
              <button
                onClick={() => addRecord('遥测快照', t.steer_x)}
                disabled={!connected}
                className="ui-action-btn flex-1 !py-2.5"
              >
                记录
              </button>
              <button onClick={exportCsv} disabled={records.length === 0} className="ui-action-btn ui-action-btn-ghost flex-1 !py-2.5">
                导出
              </button>
            </div>
            <div className="font-label-sm text-outline">
              力值字段协议未提供，显示 --；STEER 为协议 §2.9 预留功能
            </div>
          </div>
        </div>

        {/* 右侧图表区 */}
        <div className="flex-1 min-w-0 industrial-card rounded-xl flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 border-b-2 border-surface-container">
            <span className="font-label-bold text-label-bold uppercase tracking-widest text-on-surface-variant">
              方向盘角度趋势
            </span>
            <button onClick={() => setTrend([])} className="font-label-sm text-outline hover:text-critical">清空</button>
          </div>
          <div className="flex-1 min-h-0 p-2">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} unit="°" />
                <Tooltip
                  contentStyle={{ fontSize: 12 }}
                  formatter={(v, name) => (v === null || v === undefined ? ['--', String(name)] : [v, String(name)]) as [string, string]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="steer_x" name="方向盘 X °" stroke="#041627" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
                <Line type="monotone" dataKey="steer_y" name="方向盘 Y °" stroke="#8192a7" dot={false} isAnimationActive={false} connectNulls={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* 记录点列表 */}
          {records.length > 0 && (
            <div className="max-h-36 overflow-y-auto border-t border-surface-container">
              <table className="w-full border-collapse text-[12px]">
                <thead className="sticky top-0 bg-slate-50">
                  <tr className="text-left">
                    {['#', '时间', '记录项', '值', ''].map((h) => (
                      <th key={h} className="px-2 py-1 font-label-bold text-on-surface-variant">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.index} className="hover:bg-slate-50">
                      <td className="px-2 py-0.5 monospaced-data">{r.index}</td>
                      <td className="px-2 py-0.5 monospaced-data">{r.timestamp}</td>
                      <td className="px-2 py-0.5">{r.key}</td>
                      <td className="px-2 py-0.5 monospaced-data">
                        {r.value === null ? '--' : `${r.value.toFixed(2)} ${r.unit}`}
                      </td>
                      <td className="px-2 py-0.5">
                        <button
                          onClick={() =>
                            setRecords((prev) =>
                              prev.filter((x) => x.index !== r.index).map((x, i) => ({ ...x, index: i + 1 }))
                            )
                          }
                          className="material-symbols-outlined text-[14px] text-outline hover:text-critical"
                        >
                          close
                        </button>
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
        <div className="flex-1" />
        <EstopButton onEstop={actions.estop} />
      </div>

      <ForceModal open={forceModalOpen} onClose={() => setForceModalOpen(false)} />
    </div>
  )
}
