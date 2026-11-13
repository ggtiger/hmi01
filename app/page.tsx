'use client'

import { useState } from 'react'
import { useDevice, useForce } from '@/lib/comm'
import type { BoardSide, ForceChannel } from '@/lib/comm/types'
import { useAppStore } from '@/lib/store'
import DebugConsole from '@/components/ui/DebugConsole'
import EstopButton from '@/components/ui/EstopButton'
import ForceModal from '@/components/ui/ForceModal'
import { useT } from '@/lib/i18n'

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
  const t = useT()
  const { state, boards, actions, debugLog, error } = useDevice()
  const { states: forceStates } = useForce()
  const conns = useAppStore((s) => s.boards)
  const setBoardIp = useAppStore((s) => s.setBoardIp)
  const setBoardPort = useAppStore((s) => s.setBoardPort)

  const [connecting, setConnecting] = useState<Partial<Record<BoardSide, boolean>>>({})
  const [target, setTarget] = useState<BoardSide>('A')
  const [forceModalOpen, setForceModalOpen] = useState(false)
  const connected = state.is_connected
  const targetConnected = boards[target].is_connected
  const connectedBoards = (['A', 'B'] as BoardSide[]).filter((s) => boards[s].is_connected).length
  const connectedModules = MODULES.filter((m) => forceStates[m.ch].isConnected).length

  const handleConnect = async (side: BoardSide) => {
    setConnecting((p) => ({ ...p, [side]: true }))
    try {
      await actions.connect(side, conns[side].ip, Number(conns[side].port))
    } catch {
      /* useDevice 已记录错误 */
    } finally {
      setConnecting((p) => ({ ...p, [side]: false }))
    }
  }

  const sendQuick = (cmd: string) => actions.sendRaw(target, cmd).catch(() => {})

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
          <span className="font-label-bold text-[14px] text-primary">{t('命令监测模块')}</span>
          <span className={`led ${connected ? 'on' : ''}`} />
          <span className="font-label-sm text-on-surface-variant">
            {connected ? `${t('WiFi 已连接')} ${connectedBoards}/2` : t('WiFi 未连接')}
          </span>
        </div>
        <button
          onClick={() => document.getElementById('conn-ip')?.focus()}
          className="glass-btn"
          title={t('配置 WiFi 连接参数')}
        >
          <span className="material-symbols-outlined text-[16px]">wifi</span>
          {t('无线设置')}
        </button>
        <button onClick={() => setForceModalOpen(true)} className="glass-btn" title={t('蓝牙模块扫描与连接')}>
          <span className="material-symbols-outlined text-[16px]">bluetooth</span>
          {t('蓝牙设置')}
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
            <div className="glass-panel-header">{t('系统测试命令')}</div>
            <div className="p-4 flex flex-col gap-3 flex-1 min-h-0">
              <p className="font-label-sm text-on-surface-variant leading-relaxed">
                {t('常用测试命令一键下发：心跳、设备信息、遥测频率与调试开关。无线设置用于配置 WiFi 连接参数；蓝牙设置用于模块扫描、连接与手动调试。')}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'PING', cmd: 'PING' },
                  { label: 'INFO', cmd: 'INFO' },
                  { label: 'GET PARAMS', cmd: 'GET PARAMS' },
                  { label: 'RESET FAULT', cmd: 'RESET FAULT' },
                  { label: 'SCAN 1 32', cmd: 'SCAN 1 32' },
                  { label: 'DEBUG ON', cmd: 'DEBUG ON' },
                  { label: 'SET 10Hz', cmd: 'SET REPORT 10' },
                  { label: 'PEDAL NONE', cmd: 'PEDAL SELECT NONE' },
                  { label: 'MOTOR STOP', cmd: 'MOTOR STOP' },
                ].map((q) => (
                  <button
                    key={q.label}
                    onClick={() => sendQuick(q.cmd)}
                    disabled={!targetConnected}
                    className="glass-btn justify-center !text-[11px]"
                    title={q.cmd}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
              <div className="mt-auto space-y-1.5">
                <div className="font-label-bold text-[11px] uppercase tracking-widest text-on-surface-variant">
                  {t('蓝牙模块')}
                </div>
                {MODULES.map((m) => {
                  const st = forceStates[m.ch]
                  return (
                    <div key={m.ch} className="glass-row !min-h-[42px]">
                      <span className={`led ${st.isConnected ? 'on' : ''}`} />
                      <div className="min-w-0">
                        <div className="font-label-bold text-[12px] text-on-surface">{t(m.name)}</div>
                        <div className="font-label-sm text-outline truncate">
                          {st.isConnected ? st.deviceName || t(m.sub) : t(m.sub)}
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

          {/* 连接参数（无线设置，A/B 双板独立） */}
          <div className="glass-panel">
            <div className="glass-panel-header">
              {t('无线设置')}
              <span className="ml-auto flex items-center gap-2 font-normal normal-case tracking-normal">
                <span className="font-label-sm text-slate-500">{connectedBoards}/2</span>
                <button
                  onClick={() =>
                    (['A', 'B'] as BoardSide[]).forEach((side) => {
                      if (!boards[side].is_connected && !connecting[side]) handleConnect(side)
                    })
                  }
                  disabled={connectedBoards === 2 || connecting.A || connecting.B}
                  className="glass-btn !h-6 !px-2 !text-[11px]"
                >
                  {t('全部连接')}
                </button>
              </span>
            </div>
            <div className="p-2.5 space-y-2">
              {(['A', 'B'] as BoardSide[]).map((side) => {
                const b = boards[side]
                const busy = !!connecting[side]
                return (
                  <div key={side} className="rounded-[10px] border border-white/70 bg-white/40 p-2 space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className={`led ${b.is_connected ? 'on' : ''}`} />
                      <span className="font-label-bold text-[12px] text-primary">
                        {t(side === 'A' ? 'A 板' : 'B 板')}
                      </span>
                      <span className="font-label-sm text-slate-500">
                        {b.is_connected ? t('已连接') : t('未连接')}
                      </span>
                      <span className="font-label-sm text-slate-400 whitespace-nowrap">
                        心跳 {b.last_pong || '--'}
                      </span>
                      {b.is_connected ? (
                        <button
                          onClick={() => actions.disconnect(side).catch(() => {})}
                          className="glass-btn danger !h-6 !px-2 !text-[11px] ml-auto"
                        >
                          {t('断开')}
                        </button>
                      ) : (
                        <button
                          onClick={() => handleConnect(side)}
                          disabled={busy}
                          className="glass-btn primary !h-6 !px-2 !text-[11px] ml-auto"
                        >
                          {busy ? t('连接中...') : t('连接')}
                        </button>
                      )}
                    </div>
                    <div className="flex gap-1.5">
                      <input
                        value={conns[side].ip}
                        onChange={(e) => setBoardIp(side, e.target.value)}
                        placeholder={side === 'A' ? '192.168.8.88' : '192.168.8.89'}
                        disabled={b.is_connected}
                        className="ui-input flex-1 !py-1 !text-[11px]"
                      />
                      <input
                        value={conns[side].port}
                        onChange={(e) => setBoardPort(side, e.target.value)}
                        placeholder="10001"
                        disabled={b.is_connected}
                        className="ui-input w-16 !py-1 text-center !text-[11px]"
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* 右侧：上下位机通讯命令 */}
        <div className="glass-panel flex-1 min-w-0 flex flex-col">
          <div className="glass-panel-header">
            {t('上下位机通讯命令')}
            <div className="ml-auto flex items-center gap-1.5 normal-case tracking-normal font-normal">
              <span className="font-label-sm text-slate-500">{t('目标板')}</span>
              {(['A', 'B'] as BoardSide[]).map((side) => (
                <button
                  key={side}
                  onClick={() => setTarget(side)}
                  className={`glass-btn !h-7 !px-2.5 !text-[11px] ${target === side ? 'primary' : ''}`}
                >
                  {t(side === 'A' ? 'A 板' : 'B 板')}
                  <span className={`led ${boards[side].is_connected ? 'on' : ''} !w-1.5 !h-1.5`} />
                </button>
              ))}
              <span className="font-label-sm text-slate-500 ml-1">AES-128-CTR · HMAC-MD5</span>
            </div>
          </div>
          <div className="flex-1 min-h-0 p-2">
            <DebugConsole
              debugLog={debugLog}
              connected={targetConnected}
              onSend={(cmd) => actions.sendRaw(target, cmd)}
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
