'use client'

import { useEffect, useState } from 'react'
import { useForce } from '@/lib/comm'
import type { ForceChannel, ForceDeviceInfo } from '@/lib/comm/types'
import { FORCE_CHANNEL_LABELS } from '@/lib/comm/types'
import { fmtNum } from '@/lib/comm/types'
import { useSettingsStore, forceCoefficient } from '@/lib/store'

const CHANNELS: ForceChannel[] = ['A', 'B', 'STEER', 'SWITCH', 'TORQUE']
const LAST_ADDR_KEY = 'xdesin-force-last-dev'

interface LastDevice {
  id: string
  name: string
}

function loadLastAddrs(): Partial<Record<ForceChannel, LastDevice>> {
  try {
    return JSON.parse(localStorage.getItem(LAST_ADDR_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveLastAddr(channel: ForceChannel, dev: LastDevice) {
  const addrs = loadLastAddrs()
  addrs[channel] = dev
  localStorage.setItem(LAST_ADDR_KEY, JSON.stringify(addrs))
}

/** macOS 上地址全零，显示占位 */
function displayAddr(address: string): string {
  return !address || /^0{2}(:0{2}){5}$/.test(address) ? '—' : address
}

interface ForceModalProps {
  open: boolean
  onClose: () => void
}

/**
 * 蓝牙模块管理弹窗（三通道力值传感器）
 * 扫描 → 选择通道连接 / 断开 / 清零 / 校准
 */
export default function ForceModal({ open, onClose }: ForceModalProps) {
  const { states, actions, error, debugInfo } = useForce()
  const forceCoefficients = useSettingsStore((s) => s.forceCoefficients)
  const setForceCoefficient = useSettingsStore((s) => s.setForceCoefficient)
  const [devices, setDevices] = useState<ForceDeviceInfo[]>([])
  const [scanning, setScanning] = useState(false)
  const [pickChannel, setPickChannel] = useState<ForceChannel>('A')
  const [calWeight, setCalWeight] = useState<Record<ForceChannel, string>>({ A: '', B: '', STEER: '', SWITCH: '', TORQUE: '' })
  const [busy, setBusy] = useState<string | null>(null)
  const [lastAddrs, setLastAddrs] = useState<Partial<Record<ForceChannel, LastDevice>>>({})
  const [rawMonitor, setRawMonitor] = useState<Partial<Record<ForceChannel, boolean>>>({})

  useEffect(() => {
    if (open) {
      setLastAddrs(loadLastAddrs())
      setDevices([])
    }
  }, [open])

  if (!open) return null

  const handleScan = async () => {
    setScanning(true)
    try {
      const list = await actions.scan()
      setDevices(list ?? [])
    } catch {
      /* error 已记录 */
    } finally {
      setScanning(false)
    }
  }

  const handleConnect = async (channel: ForceChannel, deviceId: string, name: string) => {
    setBusy(channel)
    // 点击即记录设备：连接失败也显示「重连」按钮，可直接重试
    saveLastAddr(channel, { id: deviceId, name })
    setLastAddrs(loadLastAddrs())
    try {
      await actions.connect(channel, deviceId)
    } catch {
      /* 错误已记录展示，通道状态由 Rust 侧清理并推送 */
    } finally {
      setBusy(null)
    }
  }

  const handleDisconnect = async (channel: ForceChannel) => {
    setBusy(channel)
    try {
      await actions.disconnect(channel)
    } catch {
      /* */
    } finally {
      setBusy(null)
    }
  }

  const connectedCount = CHANNELS.filter((c) => states[c].isConnected).length

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-2xl mx-4 bg-white rounded-xl border border-slate-200 shadow-2xl overflow-hidden animate-[slideIn_0.2s_ease-out] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-slate-50 flex-shrink-0">
          <h2 className="text-base font-semibold text-primary flex items-center gap-2">
            <span className="material-symbols-outlined text-xl">bluetooth</span>
            蓝牙模块联结
            <span className="font-label-sm text-on-surface-variant font-normal">
              {connectedCount}/3 通道已连接
            </span>
          </h2>
          <button onClick={onClose} className="material-symbols-outlined text-slate-400 hover:text-slate-600">
            close
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-3">
          {error && (
            <div className="flex items-center justify-between px-3 py-1.5 rounded-[10px] bg-red-50 border border-red-200 text-red-700 text-[13px] font-label-bold">
              <span>{error}</span>
              <button onClick={actions.clearError} className="material-symbols-outlined text-[16px]">close</button>
            </div>
          )}

          {/* 三通道状态卡（STEER 为角度通道，显示角度 X/Y） */}
          {CHANNELS.map((ch) => {
            const st = states[ch]
            const isSteer = ch === 'STEER'
            return (
              <div key={ch} className="rounded-[10px] border border-surface-variant overflow-hidden">
                <div className={`flex items-center justify-between px-3 py-2 ${st.isConnected ? 'bg-emerald-50' : 'bg-slate-50'}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${st.isConnected ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]' : 'bg-slate-300'}`} />
                    <span className="font-label-bold text-[13px] whitespace-nowrap">{FORCE_CHANNEL_LABELS[ch]}</span>
                    <span className="font-label-sm text-outline truncate">
                      {st.isConnected ? `${st.deviceName}（${displayAddr(st.deviceAddress)}）` : '未连接'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {isSteer ? (
                      <>
                        <span className="ui-data-box !py-0.5 !px-2">
                          <span className="ui-label text-[11px]">角度 X</span>
                          <span className="ui-value !text-[13px]">{fmtNum(st.latestAngle?.angleX ?? null, 3)}°</span>
                        </span>
                        <span className="ui-data-box !py-0.5 !px-2">
                          <span className="ui-label text-[11px]">角度 Y</span>
                          <span className="ui-value !text-[13px]">{fmtNum(st.latestAngle?.angleY ?? null, 3)}°</span>
                        </span>
                      </>
                    ) : ch === 'SWITCH' ? (
                      <>
                        {[1, 2].map((relay) => {
                          const relayState =
                            st.switchState?.relay === relay ? st.switchState : null
                          const on = relayState?.on ?? false
                          return (
                            <span key={relay} className="ui-data-box !py-0.5 !px-2">
                              <span className="ui-label text-[11px]">第{relay}路</span>
                              <span
                                className={`font-label-bold text-[12px] ${on ? 'text-emerald-600' : 'text-slate-400'}`}
                              >
                                {relayState ? (on ? '开' : '关') : '--'}
                              </span>
                            </span>
                          )
                        })}
                      </>
                    ) : (
                      <span className="ui-data-box !py-0.5 !px-2">
                        <span className="ui-label text-[11px]">力值</span>
                        <span className="ui-value !text-[13px]">
                          {fmtNum(
                            st.latest
                              ? st.latest.weightN * forceCoefficient(forceCoefficients, ch)
                              : null,
                            2
                          )}{' '}N
                        </span>
                      </span>
                    )}
                    {st.isConnected ? (
                      <>
                        {!isSteer && (
                          <button
                            onClick={() => actions.zero(ch).catch(() => {})}
                            disabled={busy === ch}
                            className="ui-action-btn ui-action-btn-ghost !px-2 !py-0.5 !text-[11px]"
                          >
                            清零
                          </button>
                        )}
                        <button
                          onClick={() => handleDisconnect(ch)}
                          disabled={busy === ch}
                          className="ui-action-btn ui-action-btn-danger !px-2 !py-0.5 !text-[11px]"
                        >
                          断开
                        </button>
                      </>
                    ) : lastAddrs[ch] ? (
                      <button
                        onClick={() => handleConnect(ch, lastAddrs[ch]!.id, lastAddrs[ch]!.name)}
                        disabled={busy === ch}
                        className="ui-action-btn !px-2 !py-0.5 !text-[11px]"
                        title={`重连上次设备 ${lastAddrs[ch]!.name}`}
                      >
                        {busy === ch ? '连接中...' : '重连'}
                      </button>
                    ) : null}
                  </div>
                </div>

                {/* 诊断日志（TX/RX 帧内容，最近 8 条，完整显示） */}
                {st.isConnected && debugInfo[ch] && debugInfo[ch]!.length > 0 && (
                  <div className="px-3 py-1.5 border-t border-surface-variant bg-slate-50 max-h-32 overflow-y-auto space-y-0.5">
                    {debugInfo[ch]!.map((msg, i) => (
                      <div
                        key={i}
                        className={`font-label-sm monospaced-data break-all ${
                          msg.startsWith('TX') ? 'text-sky-700' : 'text-amber-800'
                        }`}
                      >
                        {msg}
                      </div>
                    ))}
                  </div>
                )}

                {/* 手动调试区（已连接时展开） */}
                {st.isConnected && <ChannelDebugArea channel={ch} actions={actions} rawOn={rawMonitor[ch] ?? false} onToggleRaw={(on) => {
                  setRawMonitor((p) => ({ ...p, [ch]: on }))
                  actions.rawMonitor(ch, on).catch(() => {})
                }} />}

                {/* 开关控制区（SWITCH 通道专用） */}
                {st.isConnected && ch === 'SWITCH' && (
                  <div className="px-3 py-2 border-t border-surface-variant space-y-1.5">
                    <span className="font-label-bold text-[12px] text-on-surface-variant">开关控制</span>
                    {[1, 2].map((relay) => (
                      <div key={relay} className="flex items-center gap-1.5">
                        <span className="font-label-bold text-[13px] w-14">第{relay}路</span>
                        <button
                          onClick={() => actions.switchControl(relay as 1 | 2, 'on').catch(() => {})}
                          className="ui-action-btn !px-3 !py-0.5 !text-[11px]"
                        >
                          开
                        </button>
                        <button
                          onClick={() => actions.switchControl(relay as 1 | 2, 'off').catch(() => {})}
                          className="ui-action-btn ui-action-btn-ghost !px-3 !py-0.5 !text-[11px]"
                        >
                          关
                        </button>
                        <button
                          onClick={() => actions.switchControl(relay as 1 | 2, 'momentary').catch(() => {})}
                          className="ui-action-btn ui-action-btn-ghost !px-3 !py-0.5 !text-[11px]"
                          title="点动：开约 2 秒后自动关"
                        >
                          点动
                        </button>
                      </div>
                    ))}
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => actions.switchControl(1, 'query').catch(() => {})}
                        className="ui-action-btn ui-action-btn-ghost !px-3 !py-0.5 !text-[11px]"
                        title="查询当前开关状态（应答显示在调试日志）"
                      >
                        查询状态
                      </button>
                      <span className="font-label-sm text-outline">
                        应答/上报自动更新上方状态徽标（E0 帧）
                      </span>
                    </div>
                  </div>
                )}

                {/* 校准区（仅力值通道；已连接时展开） */}
                {st.isConnected && !isSteer && (
                  <div className="flex items-center gap-2 px-3 py-2 border-t border-surface-variant">
                    <span className="font-label-sm text-on-surface-variant">最大力值 {fmtNum(st.maxN, 2)} N</span>
                    <button onClick={() => actions.resetMax(ch).catch(() => {})} className="font-label-sm text-outline hover:text-critical">重置</button>
                    <span className="font-label-sm text-on-surface-variant">
                      系数{' '}
                      <span className="monospaced-data font-label-bold text-on-surface">
                        {forceCoefficient(forceCoefficients, ch).toFixed(5)}
                      </span>
                    </span>
                    <div className="flex-1" />
                    <input
                      value={calWeight[ch]}
                      onChange={(e) => setCalWeight((p) => ({ ...p, [ch]: e.target.value }))}
                      inputMode="decimal"
                      placeholder="标准 N"
                      className="ui-input w-20 !py-0.5 text-center"
                      title="施加已知载荷（N）后填写"
                    />
                    <button
                      onClick={() => {
                        const standardN = Number(calWeight[ch])
                        if (!Number.isFinite(standardN) || standardN <= 0) return
                        const grams = Math.round((standardN / 9.80665) * 1000)
                        if (grams > 0) actions.calibrate(ch, grams).catch(() => {})
                      }}
                      disabled={!calWeight[ch]}
                      className="ui-action-btn !px-2 !py-0.5 !text-[11px]"
                      title="发送设备标定命令（原始重量恒定时使用）"
                    >
                      设备标定
                    </button>
                    <button
                      onClick={() => {
                        const standardN = Number(calWeight[ch])
                        const rawN = st.latest?.weightN ?? null
                        if (!Number.isFinite(standardN) || standardN <= 0) return
                        if (rawN === null || Math.abs(rawN) < 0.01) return
                        const coef = standardN / rawN
                        if (Number.isFinite(coef) && coef > 0 && coef <= 1000) {
                          setForceCoefficient(ch, String(Number(coef.toFixed(5))))
                        }
                      }}
                      disabled={!calWeight[ch] || !st.latest || Math.abs(st.latest.weightN) < 0.01}
                      className="ui-action-btn ui-action-btn-ghost !px-2 !py-0.5 !text-[11px]"
                      title="以「标准载荷 ÷ 当前读数」计算软件校正系数"
                    >
                      系数校准
                    </button>
                  </div>
                )}
              </div>
            )
          })}

          {/* 扫描区 */}
          <div className="rounded-[10px] border border-surface-variant">
            <div className="flex items-center justify-between px-3 py-2 bg-slate-50">
              <span className="font-label-bold text-[13px] text-on-surface-variant">扫描设备</span>
              <div className="flex items-center gap-2">
                <select
                  value={pickChannel}
                  onChange={(e) => setPickChannel(e.target.value as ForceChannel)}
                  className="ui-input !py-0.5 !text-[12px]"
                  title="连接目标通道"
                >
                  {CHANNELS.map((c) => (
                    <option key={c} value={c}>{FORCE_CHANNEL_LABELS[c]}</option>
                  ))}
                </select>
                <button onClick={handleScan} disabled={scanning} className="ui-action-btn !px-3 !py-0.5 !text-[12px]">
                  {scanning ? '扫描中...' : '扫描'}
                </button>
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto">
              {devices.length === 0 && (
                <div className="text-center text-outline font-label-sm py-6">
                  {scanning ? '正在扫描附近 BLE 设备...' : '点击「扫描」查找力值模块'}
                </div>
              )}
              {devices.map((d) => (
                <div key={d.id} className="flex items-center justify-between px-3 py-1.5 border-t border-surface-variant hover:bg-slate-50">
                  <div className="min-w-0">
                    <div className="font-label-bold text-[13px] truncate">{d.name}</div>
                    <div className="font-label-sm text-outline monospaced-data">
                      {d.rssi != null ? `${d.rssi}dBm` : ''}
                      {d.rssi != null && d.rssi < -80 ? ' · 信号弱' : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => handleConnect(pickChannel, d.id, d.name)}
                    disabled={busy !== null}
                    className="ui-action-btn !px-3 !py-0.5 !text-[12px] flex-shrink-0"
                  >
                    连接到 {pickChannel}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 快捷调试命令（hex 直发） */
const QUICK_HEX: { label: string; hex: string; channels: ForceChannel[] }[] = [
  { label: '读角度(01)', hex: '01 03 00 01 00 04 15 C9', channels: ['STEER'] },
  { label: '读角度(03)', hex: '03 03 00 01 00 04 15 C9', channels: ['STEER'] },
  { label: '读X(01)', hex: '01 03 00 01 00 02 95 CB', channels: ['STEER'] },
  { label: '读Y(01)', hex: '01 03 00 03 00 02 34 0B', channels: ['STEER'] },
  { label: '清零(AA帧)', hex: 'AA 01 03 08 A6 01 07 00', channels: ['A', 'B'] },
  { label: '开第1路', hex: 'EE 03 E1 01 FF', channels: ['SWITCH'] },
  { label: '关第1路', hex: 'EE 03 E1 01 00', channels: ['SWITCH'] },
  { label: '查状态', hex: 'EE 01 E0', channels: ['SWITCH'] },
]

/** 单通道手动调试区：原始数据监视开关 + hex 手动发送 + 快捷命令 */
function ChannelDebugArea({
  channel,
  actions,
  rawOn,
  onToggleRaw,
}: {
  channel: ForceChannel
  actions: {
    sendRaw: (channel: ForceChannel, hex: string) => Promise<void>
  }
  rawOn: boolean
  onToggleRaw: (on: boolean) => void
}) {
  const [hex, setHex] = useState('')
  const [sending, setSending] = useState(false)

  const send = async (data: string) => {
    const trimmed = data.trim()
    if (!trimmed || sending) return
    setSending(true)
    try {
      await actions.sendRaw(channel, trimmed)
      setHex('')
    } catch {
      /* 错误已展示 */
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="px-3 py-2 border-t border-surface-variant bg-brand-ghost/50 space-y-2">
      <div className="flex items-center gap-3">
        <span className="font-label-bold text-[12px] text-on-surface-variant">手动调试</span>
        <label className="flex items-center gap-1.5 font-label-sm text-on-surface-variant cursor-pointer select-none">
          <input
            type="checkbox"
            checked={rawOn}
            onChange={(e) => onToggleRaw(e.target.checked)}
            className="accent-[#041627]"
          />
          原始数据监视（全量显示收到的字节）
        </label>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <input
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send(hex)
          }}
          placeholder="输入 hex 数据，如 03 03 00 01 00 04 15 C9"
          className="ui-input flex-1 min-w-[200px] !py-1 !text-[12px]"
        />
        <button
          onClick={() => send(hex)}
          disabled={!hex.trim() || sending}
          className="ui-action-btn !px-3 !py-1 !text-[12px]"
        >
          发送
        </button>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {QUICK_HEX.filter((q) => q.channels.includes(channel)).map((q) => (
          <button
            key={q.label}
            onClick={() => send(q.hex)}
            disabled={sending}
            title={q.hex}
            className="px-2 py-0.5 rounded-full border border-outline-variant font-label-sm monospaced-data text-[11px] text-on-surface-variant hover:bg-primary hover:text-on-primary hover:border-primary transition-colors disabled:opacity-40"
          >
            {q.label}
          </button>
        ))}
      </div>
    </div>
  )
}
