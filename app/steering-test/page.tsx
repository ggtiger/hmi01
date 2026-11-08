'use client'

import { useEffect, useRef, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { useDevice, useForce } from '@/lib/comm'
import { fmtNum } from '@/lib/comm/types'
import { exportWorkbook, renderLineChartPng } from '@/lib/export-excel'
import EstopButton from '@/components/ui/EstopButton'
import ForceModal from '@/components/ui/ForceModal'

/** 记录点（转盘测试本地记录） */
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

/** 数据行（与踏板页数据面板同风格） */
function DataRow({
  label, value, unit, digits = 2, direction, actions,
}: {
  label: string
  value: number | null
  unit: string
  digits?: number
  direction?: 'cw' | 'ccw' | null
  actions?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="ui-data-box flex-1">
        <span className="ui-label">
          {label} <span className="text-outline">{unit}</span>
          {direction && (
            <span className={`ml-1 font-label-bold ${direction === 'cw' ? 'text-sky-600' : 'text-violet-600'}`}>
              {direction === 'cw' ? '顺时针' : '逆时针'}
            </span>
          )}
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
 * 转盘测试
 * 仅依赖蓝牙两个采集模块：倾角模块（STEER 通道，Modbus RTU）+ 转向力模块（TORQUE 通道，0xAA 帧）
 * 无 WiFi / TCP 依赖，两个模块连接成功即可开始测试
 */
export default function SteeringTestPage() {
  const { actions: deviceActions } = useDevice()
  const { states: forceStates, actions: forceActions } = useForce()

  const tiltCh = forceStates.STEER
  const torqueCh = forceStates.TORQUE
  const tiltConnected = tiltCh.isConnected
  const torqueConnected = torqueCh.isConnected
  const bleReady = tiltConnected && torqueConnected

  // 倾角（方向盘 X/Y 合并来源）
  const angle = tiltCh.isConnected ? tiltCh.latestAngle : null
  const tiltX = angle?.angleX ?? null
  const tiltY = angle?.angleY ?? null

  // 转向力
  const torqueLive = torqueCh.isConnected ? torqueCh.latest?.weightN ?? null : null

  const [busy, setBusy] = useState(false)
  const [forceModalOpen, setForceModalOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [trend, setTrend] = useState<TrendPoint[]>([])
  const [records, setRecords] = useState<SteerRecord[]>([])
  /** 自由转角基准（清零时保存当前倾角 X） */
  const [zeroOffset, setZeroOffset] = useState(0)
  const [cwAngle, setCwAngle] = useState<number | null>(null)
  const [ccwAngle, setCcwAngle] = useState<number | null>(null)
  /** 最大力值（本地跟踪，清除时归零） */
  const [torqueMax, setTorqueMax] = useState(0)
  const lastTrendPush = useRef(0)

  // 自由转角 = 当前倾角 X − 清零基准
  const freeAngle = tiltX === null ? null : tiltX - zeroOffset
  const direction: 'cw' | 'ccw' | null =
    freeAngle === null || Math.abs(freeAngle) < 0.001 ? null : freeAngle > 0 ? 'cw' : 'ccw'

  // 角度 + 力值 → 趋势（200ms 采样门控）
  useEffect(() => {
    if (tiltX === null && tiltY === null && torqueLive === null) return
    const now = Date.now()
    if (now - lastTrendPush.current < 200) return
    lastTrendPush.current = now
    const d = new Date()
    const label = `${d.getMinutes().toString().padStart(2, '0')}:${d
      .getSeconds()
      .toString()
      .padStart(2, '0')}`
    const free = tiltX === null ? null : tiltX - zeroOffset
    setTrend((prev) => {
      const next = [...prev, { label, tilt_x: tiltX, tilt_y: tiltY, free, torque: torqueLive }]
      return next.length > MAX_TREND ? next.slice(-MAX_TREND) : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [angle?.angleX, angle?.angleY, torqueLive])

  // 最大力值本地跟踪（转向力模块）
  useEffect(() => {
    if (torqueLive === null) return
    setTorqueMax((prev) => (torqueLive > prev ? torqueLive : prev))
  }, [torqueLive])

  // 顺/逆时针峰值：不自动跟踪——点「记录」时把当前自由转角值写入峰值行 + 历史记录表
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

  const startTest = () => {
    setTesting(true)
    setCwAngle(null)
    setCcwAngle(null)
    setTorqueMax(0)
    forceActions.resetMax('TORQUE').catch(() => {})
  }

  /** 导出两个 Sheet：记录值 + 实时曲线（含顶部曲线图与实时力值列） */
  const exportExcel = async () => {
    try {
      const round = (v: number | null, d = 3) => (v === null ? null : Number(v.toFixed(d)))
      const labels = trend.map((p) => p.label)
      const chartImage =
        trend.length > 1
          ? renderLineChartPng(labels, [
              { name: '倾角 X (°)', color: '#041627', values: trend.map((p) => p.tilt_x) },
              { name: '倾角 Y (°)', color: '#8192a7', values: trend.map((p) => p.tilt_y) },
              { name: '自由转角 (°)', color: '#f59e0b', values: trend.map((p) => p.free) },
              {
                name: '实时力值 (N)',
                color: '#16a34a',
                values: trend.map((p) => p.torque),
                separateScale: true,
              },
            ])
          : null

      await exportWorkbook(`steer-records-${Date.now()}.xlsx`, [
        {
          name: '记录值',
          rows: [
            ['序号', '时间', '记录项', '值', '单位'],
            ...records.map((r) => [
              r.index,
              r.timestamp,
              r.key,
              round(r.value),
              r.unit,
            ]),
          ],
        },
        {
          name: '实时曲线',
          chartImage: chartImage ?? undefined,
          rows: [
            ['时间', '倾角 X (°)', '倾角 Y (°)', '自由转角 (°)', '实时力值 (N)'],
            ...trend.map((p) => [
              p.label,
              round(p.tilt_x),
              round(p.tilt_y),
              round(p.free),
              round(p.torque, 2),
            ]),
          ],
        },
      ])
    } catch (err) {
      console.error('[Steer] 导出失败:', err)
    }
  }

  const clearTrendAndRecords = () => {
    setTrend([])
    setRecords([])
  }

  return (
    <div className="h-full flex flex-col gap-2 p-3 overflow-hidden">
      {/* ===== 顶部行：蓝牙连接状态（无 WiFi 依赖） ===== */}
      <div className="flex items-stretch gap-1.5">
        <button
          onClick={() => setForceModalOpen(true)}
          className={`ui-action-btn ${bleReady ? '' : 'ui-action-btn-ghost'} !px-3`}
          title="蓝牙模块管理"
        >
          <span className="material-symbols-outlined text-[16px]">bluetooth</span>
          蓝牙模块联结
          <span className="text-[11px] opacity-70">
            {[tiltConnected, torqueConnected].filter(Boolean).length}/2
          </span>
        </button>
        <div className={`ui-data-box !px-3 ${tiltConnected ? '!border-success' : '!border-critical'}`}>
          <span className="ui-label">倾角模块</span>
          <span className={`ui-value ${tiltConnected ? '!text-success' : '!text-critical'}`}>
            {tiltConnected ? '已连接' : '未连接'}
          </span>
        </div>
        <div className={`ui-data-box !px-3 ${torqueConnected ? '!border-success' : '!border-critical'}`}>
          <span className="ui-label">转向力模块</span>
          <span className={`ui-value ${torqueConnected ? '!text-success' : '!text-critical'}`}>
            {torqueConnected ? '已连接' : '未连接'}
          </span>
        </div>
        <div className="ui-data-box">
          <span className="ui-label">测试状态</span>
          <span className={`ui-value ${testing ? '!text-success' : ''}`}>
            {testing ? '测试中' : '待机'}
          </span>
        </div>
        <div className="flex-1" />
        <div className="ui-data-box">
          <span className="ui-label">倾角 X</span>
          <span className="ui-value">{fmtNum(tiltX, 3)}°</span>
        </div>
        <div className="ui-data-box">
          <span className="ui-label">倾角 Y</span>
          <span className="ui-value">{fmtNum(tiltY, 3)}°</span>
        </div>
      </div>

      {/* ===== 主体：左侧数据面板 + 右侧图表区 ===== */}
      <div className="flex-1 min-h-0 flex gap-2">
        {/* 左侧数据面板 */}
        <div className="w-[460px] flex-shrink-0 industrial-card rounded-xl p-2.5">
          <div className="flex flex-col gap-1.5 h-full justify-center">
            <div className="ui-data-box !bg-primary !border-primary">
              <span className="font-label-bold text-on-primary tracking-widest">转盘测试</span>
              <span className="ui-value !text-on-primary/70 text-[11px]">蓝牙采集</span>
            </div>

            {/* 倾角 X/Y 合并一行展示 */}
            <div className="ui-data-box">
              <span className="ui-label">倾角 X / Y <span className="text-outline">°</span></span>
              <span className="ui-value">
                {fmtNum(tiltX, 3)} / {fmtNum(tiltY, 3)}
              </span>
            </div>

            <DataRow
              label="自由转角"
              unit="°"
              value={freeAngle}
              digits={3}
              direction={direction}
              actions={
                <MiniBtn
                  onClick={() => setZeroOffset(tiltX ?? 0)}
                  disabled={tiltX === null}
                >
                  清零
                </MiniBtn>
              }
            />

            <DataRow
              label="顺时针峰值"
              unit="°"
              value={cwAngle}
              digits={3}
              actions={
                <>
                  <MiniBtn onClick={() => setCwAngle(null)} disabled={!testing}>清除</MiniBtn>
                  <MiniBtn
                    onClick={recordCwPeak}
                    disabled={freeAngle === null || freeAngle <= 0.001}
                  >
                    记录
                  </MiniBtn>
                </>
              }
            />
            <DataRow
              label="逆时针峰值"
              unit="°"
              value={ccwAngle}
              digits={3}
              actions={
                <>
                  <MiniBtn onClick={() => setCcwAngle(null)} disabled={!testing}>清除</MiniBtn>
                  <MiniBtn
                    onClick={recordCcwPeak}
                    disabled={freeAngle === null || freeAngle >= -0.001}
                  >
                    记录
                  </MiniBtn>
                </>
              }
            />

            <DataRow
              label="实时力值"
              unit="N"
              value={torqueLive}
              digits={2}
              actions={
                <MiniBtn
                  onClick={() => run(() => forceActions.zero('TORQUE'))}
                  disabled={!torqueConnected || busy}
                >
                  清零
                </MiniBtn>
              }
            />
            <DataRow
              label="最大力值"
              unit="N"
              value={torqueMax}
              digits={2}
              actions={
                <>
                  <MiniBtn
                    onClick={() => addRecord('最大力值', torqueMax, 'N')}
                    disabled={!torqueConnected}
                  >
                    记录
                  </MiniBtn>
                  <MiniBtn
                    onClick={() => {
                      setTorqueMax(0)
                      forceActions.resetMax('TORQUE').catch(() => {})
                    }}
                    disabled={!torqueConnected}
                  >
                    清除
                  </MiniBtn>
                </>
              }
            />

            <div className="flex items-center gap-1.5 mt-2">
              <button
                onClick={() => (testing ? setTesting(false) : startTest())}
                disabled={!bleReady}
                className={`ui-action-btn flex-1 !py-2.5 !text-[14px] ${testing ? 'ui-action-btn-danger' : ''}`}
              >
                {testing ? '停止测试' : '开始测试'}
              </button>
              <button
                onClick={exportExcel}
                disabled={records.length === 0 && trend.length === 0}
                className="ui-action-btn ui-action-btn-ghost !px-6 !py-2.5"
                title="导出 Excel：记录值 + 实时曲线两个 Sheet"
              >
                导出 Excel
              </button>
            </div>
            {!bleReady && (
              <div className="font-label-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-[8px] px-2 py-1">
                请先连接倾角模块与转向力模块（蓝牙模块联结）后开始测试
              </div>
            )}
            <div className="font-label-sm text-outline">
              倾角来源：Modbus RTU 10Hz 轮询；力值来源：转向力蓝牙模块
            </div>
          </div>
        </div>

        {/* 右侧图表区 */}
        <div className="flex-1 min-w-0 industrial-card rounded-xl flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 border-b-2 border-surface-container">
            <span className="font-label-bold text-label-bold uppercase tracking-widest text-on-surface-variant">
              角度趋势
            </span>
            {/* 清空趋势曲线 + 全部历史记录 */}
            <button
              onClick={clearTrendAndRecords}
              className="font-label-sm text-outline hover:text-critical"
              title="清空趋势曲线与全部历史记录"
            >
              清空
            </button>
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
                <Line type="monotone" dataKey="tilt_x" name="倾角 X °" stroke="#041627" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
                <Line type="monotone" dataKey="tilt_y" name="倾角 Y °" stroke="#8192a7" dot={false} isAnimationActive={false} connectNulls={false} />
                <Line type="monotone" dataKey="free" name="自由转角 °" stroke="#f59e0b" dot={false} isAnimationActive={false} connectNulls={false} />
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
                        {r.value === null ? '--' : `${r.value.toFixed(3)} ${r.unit}`}
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
        {/* 急停仅对已连 TCP 的运动控制生效；纯蓝牙场景未连接时静默 */}
        <EstopButton
          onEstop={async () => {
            try {
              await deviceActions.estop()
            } catch {
              /* 未连接 WiFi 设备 */
            }
          }}
        />
      </div>

      <ForceModal open={forceModalOpen} onClose={() => setForceModalOpen(false)} />
    </div>
  )
}
