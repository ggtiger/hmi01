'use client'

import { useEffect, useState } from 'react'
import { useForce } from '@/lib/comm'
import type { ForceChannel, ForceDeviceInfo } from '@/lib/comm/types'
import { FORCE_CHANNEL_LABELS } from '@/lib/comm/types'
import { fmtNum } from '@/lib/comm/types'

const CHANNELS: ForceChannel[] = ['A', 'B', 'STEER']
const LAST_ADDR_KEY = 'xdesin-force-last-addr'

function loadLastAddrs(): Partial<Record<ForceChannel, string>> {
  try {
    return JSON.parse(localStorage.getItem(LAST_ADDR_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveLastAddr(channel: ForceChannel, address: string) {
  const addrs = loadLastAddrs()
  addrs[channel] = address
  localStorage.setItem(LAST_ADDR_KEY, JSON.stringify(addrs))
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
  const { states, actions, error } = useForce()
  const [devices, setDevices] = useState<ForceDeviceInfo[]>([])
  const [scanning, setScanning] = useState(false)
  const [pickChannel, setPickChannel] = useState<ForceChannel>('A')
  const [calWeight, setCalWeight] = useState<Record<ForceChannel, string>>({ A: '', B: '', STEER: '' })
  const [busy, setBusy] = useState<string | null>(null)
  const [lastAddrs, setLastAddrs] = useState<Partial<Record<ForceChannel, string>>>({})

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

  const handleConnect = async (channel: ForceChannel, address: string) => {
    setBusy(channel)
    try {
      await actions.connect(channel, address)
      saveLastAddr(channel, address)
      setLastAddrs(loadLastAddrs())
    } catch {
      /* */
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

          {/* 三通道状态卡 */}
          {CHANNELS.map((ch) => {
            const st = states[ch]
            return (
              <div key={ch} className="rounded-[10px] border border-surface-variant overflow-hidden">
                <div className={`flex items-center justify-between px-3 py-2 ${st.isConnected ? 'bg-emerald-50' : 'bg-slate-50'}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${st.isConnected ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]' : 'bg-slate-300'}`} />
                    <span className="font-label-bold text-[13px]">{FORCE_CHANNEL_LABELS[ch]}</span>
                    <span className="font-label-sm text-outline truncate">
                      {st.isConnected ? `${st.deviceName} (${st.deviceAddress})` : '未连接'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className="ui-data-box !py-0.5 !px-2">
                      <span className="ui-label text-[11px]">力值</span>
                      <span className="ui-value !text-[13px]">
                        {fmtNum(st.latest?.weightN ?? null, 2)} N
                      </span>
                    </span>
                    {st.isConnected ? (
                      <>
                        <button
                          onClick={() => actions.zero(ch).catch(() => {})}
                          disabled={busy === ch}
                          className="ui-action-btn ui-action-btn-ghost !px-2 !py-0.5 !text-[11px]"
                        >
                          清零
                        </button>
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
                        onClick={() => handleConnect(ch, lastAddrs[ch]!)}
                        disabled={busy === ch}
                        className="ui-action-btn !px-2 !py-0.5 !text-[11px]"
                        title={`重连上次设备 ${lastAddrs[ch]}`}
                      >
                        {busy === ch ? '连接中...' : '重连'}
                      </button>
                    ) : null}
                  </div>
                </div>

                {/* 校准区（已连接时展开） */}
                {st.isConnected && (
                  <div className="flex items-center gap-2 px-3 py-2 border-t border-surface-variant">
                    <span className="font-label-sm text-on-surface-variant">最大力值 {fmtNum(st.maxN, 2)} N</span>
                    <button onClick={() => actions.resetMax(ch).catch(() => {})} className="font-label-sm text-outline hover:text-critical">重置</button>
                    <div className="flex-1" />
                    <span className="font-label-sm text-on-surface-variant">砝码标定</span>
                    <input
                      value={calWeight[ch]}
                      onChange={(e) => setCalWeight((p) => ({ ...p, [ch]: e.target.value }))}
                      inputMode="numeric"
                      placeholder="重量 g"
                      className="ui-input w-20 !py-0.5 text-center"
                    />
                    <button
                      onClick={() => {
                        const w = Number(calWeight[ch])
                        if (Number.isFinite(w) && w > 0) actions.calibrate(ch, Math.round(w)).catch(() => {})
                      }}
                      disabled={!calWeight[ch]}
                      className="ui-action-btn !px-2 !py-0.5 !text-[11px]"
                    >
                      校准
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
                <div key={d.address} className="flex items-center justify-between px-3 py-1.5 border-t border-surface-variant hover:bg-slate-50">
                  <div className="min-w-0">
                    <div className="font-label-bold text-[13px] truncate">{d.name}</div>
                    <div className="font-label-sm text-outline monospaced-data">{d.address}{d.rssi != null ? ` · ${d.rssi}dBm` : ''}</div>
                  </div>
                  <button
                    onClick={() => handleConnect(pickChannel, d.address)}
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
