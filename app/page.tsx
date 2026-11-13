'use client'

import { useState } from 'react'
import { useDevice, useForce } from '@/lib/comm'
import type { ForceChannel } from '@/lib/comm/types'
import { useAppStore } from '@/lib/store'
import DebugConsole from '@/components/ui/DebugConsole'
import EstopButton from '@/components/ui/EstopButton'
import ForceModal from '@/components/ui/ForceModal'

/** 模块状态条目 */
const MODULES: { ch: ForceChannel; name: string; sub: string }[] = [
  { ch: 'STEER', name: '倾角模块', sub: '转盘 X/Y · Modbus 10Hz' },
  { ch: 'TORQUE', name: '转向力模块', sub: '转盘力值 · 100ms' },
  { ch: 'A', name: '加载模块 A', sub: '踏板 A 加载力' },
  { ch: 'B', name: '加载模块 B', sub: '踏板 B 加载力' },
  { ch: 'SWITCH', name: '二路开关', sub: '继电器控制 · EE 协议' },
]

/**
 * 命令监测页（对齐《软件UI》PPT 第 3 页）
 * 顶部工具条：命令监测模块 / 无线设置 / 蓝牙设置
 * 左侧：系统测试命令说明 + 连接与模块状态
 * 右侧：上下位机通讯命令大面板
 */
export default function MonitorPage() {
  const { state, actions, debugLog, error } = useDevice()
  const { states: forceStates } = useForce()
  const ip = useAppStore((s) => s.ip)
  const port = useAppStore((s) => s.port)
  const setIp = useAppStore((s) => s.setIp)
  const setPort = useAppStore((s) => s.setPort)

  const [connecting, setConnecting] = useState(false)
  const [forceModalOpen, setForceModalOpen] = useState(false)
  const connected = state.is_connected
  const connectedModules = MODULES.filter((m) => forceStates[m.ch].isConnected).length

  const handleConnect = async () => {
    setConnecting(true)
    try {
      await actions.connect(ip, Number(port))
    } catch {
      /* useDevice 已记录错误 */
    } finally {
      setConnecting(false)
    }
  }

  const sendQuick = (cmd: string) => actions.sendRaw(cmd).catch(() => {})

  return (
    <div className="h-full flex flex-col gap-3 p-4 overflow-hidden">
      {error && (
        <div className="flex items-center justify-between px-4 py-2 rounded-xl bg-red-50/80 backdrop-blur border border-red-200 text-red-700 text-[13px] font-label-bold">
          <span>{error}</span>
          <button onClick={actions.clearError} className="material-symbols-outlined text-[16px]">close</button>
        </div>
      )}

      {/* ===== 工具条（命令监测模块 / 无线设置 / 蓝牙设置） ===== */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="glass-panel px-4 py-2 flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px] text-[#0891b2]">terminal</span>
          <span className="font-label-bold text-[14px] text-primary">命令监测模块</span>
          <span className={`led ${connected ? 'on' : ''}`} />
          <span className="font-label-sm text-on-surface-variant">
            {connected ? 'WiFi 已连接' : 'WiFi 未连接'}
          </span>
        </div>
        <button
          onClick={() => document.getElementById('conn-ip')?.focus()}
          className="glass-btn"
          title="配置 WiFi 连接参数"
        >
          <span className="material-symbols-outlined text-[16px]">wifi</span>
          无线设置
        </button>
        <button onClick={() => setForceModalOpen(true)} className="glass-btn" title="蓝牙模块扫描与连接">
          <span className="material-symbols-outlined text-[16px]">bluetooth</span>
          蓝牙设置
          <span className="text-[11px] text-slate-500">{connectedModules}/5</span>
        </button>
        <div className="flex-1" />
        <EstopButton onEstop={actions.estop} />
      </div>

      {/* ===== 主体：左说明 + 右通讯命令 ===== */}
      <div className="flex-1 min-h-0 flex gap-3">
        {/* 左侧 */}
        <div className="w-[340px] flex-shrink-0 flex flex-col gap-3 min-h-0">
          <div className="glass-panel flex-1 min-h-0 flex flex-col">
            <div className="glass-panel-header">系统测试命令</div>
            <div className="p-4 flex flex-col gap-3 flex-1 min-h-0">
              <p className="font-label-sm text-on-surface-variant leading-relaxed">
                常用测试命令一键下发：心跳、设备信息、遥测频率与调试开关。
                无线设置用于配置 WiFi 连接参数；蓝牙设置用于模块扫描、连接与手动调试。
              </p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'PING', cmd: 'PING' },
                  { label: 'INFO GET', cmd: 'INFO GET' },
                  { label: 'DEBUG ON', cmd: 'DEBUG ON' },
                  { label: 'SET 10Hz', cmd: 'SET REPORT 10' },
                  { label: 'PEDAL NONE', cmd: 'PEDAL SELECT NONE' },
                  { label: 'MOTOR STOP', cmd: 'MOTOR STOP' },
                ].map((q) => (
                  <button
                    key={q.label}
                    onClick={() => sendQuick(q.cmd)}
                    disabled={!connected}
                    className="glass-btn justify-center !text-[11px]"
                    title={q.cmd}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
              <div className="mt-auto space-y-1.5">
                <div className="font-label-bold text-[11px] uppercase tracking-widest text-on-surface-variant">
                  蓝牙模块
                </div>
                {MODULES.map((m) => {
                  const st = forceStates[m.ch]
                  return (
                    <div key={m.ch} className="glass-row !min-h-[42px]">
                      <span className={`led ${st.isConnected ? 'on' : ''}`} />
                      <div className="min-w-0">
                        <div className="font-label-bold text-[12px] text-on-surface">{m.name}</div>
                        <div className="font-label-sm text-outline truncate">
                          {st.isConnected ? st.deviceName || m.sub : m.sub}
                        </div>
                      </div>
                      <span className={`font-label-bold text-[11px] ml-auto ${st.isConnected ? 'text-emerald-700' : 'text-slate-400'}`}>
                        {st.isConnected ? 'ON' : 'OFF'}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* 连接参数（无线设置） */}
          <div className="glass-panel">
            <div className="glass-panel-header">无线设置</div>
            <div className="p-3 space-y-2">
              <div className="flex gap-2">
                <input
                  id="conn-ip"
                  value={ip}
                  onChange={(e) => setIp(e.target.value)}
                  placeholder="192.168.4.1"
                  disabled={connected}
                  className="ui-input flex-1 !py-2"
                />
                <input
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="10001"
                  disabled={connected}
                  className="ui-input w-20 !py-2 text-center"
                />
              </div>
              {connected ? (
                <button onClick={actions.disconnect} className="glass-btn danger w-full justify-center !py-2">
                  断开连接
                </button>
              ) : (
                <button
                  onClick={handleConnect}
                  disabled={connecting}
                  className="glass-btn primary w-full justify-center !py-2"
                >
                  {connecting ? '连接中...' : '连接设备'}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 右侧：上下位机通讯命令 */}
        <div className="glass-panel flex-1 min-w-0 flex flex-col">
          <div className="glass-panel-header">
            上下位机通讯命令
            <span className="ml-auto font-label-sm font-normal normal-case tracking-normal text-slate-500">
              AES-128-CTR · HMAC-MD5
            </span>
          </div>
          <div className="flex-1 min-h-0 p-2">
            <DebugConsole
              debugLog={debugLog}
              connected={connected}
              onSend={actions.sendRaw}
              onClear={actions.clearDebugLog}
              bare
            />
          </div>
        </div>
      </div>

      <ForceModal open={forceModalOpen} onClose={() => setForceModalOpen(false)} />
    </div>
  )
}
