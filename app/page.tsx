'use client'

import { useState } from 'react'
import { useDevice } from '@/lib/comm'
import { useAppStore } from '@/lib/store'
import ConnectionPanel from '@/components/ui/ConnectionPanel'
import TelemetryPanel from '@/components/ui/TelemetryPanel'
import DebugConsole from '@/components/ui/DebugConsole'
import EstopButton from '@/components/ui/EstopButton'

export default function HomePage() {
  const { state, actions, debugLog, error } = useDevice()
  const ip = useAppStore((s) => s.ip)
  const port = useAppStore((s) => s.port)
  const [connecting, setConnecting] = useState(false)

  const handleConnect = async () => {
    setConnecting(true)
    try {
      await actions.connect(ip, Number(port))
    } catch {
      // 错误已由 useDevice 捕获
    } finally {
      setConnecting(false)
    }
  }

  // ===== 未连接：欢迎视图（PPT slide 1 布局） =====
  if (!state.is_connected) {
    return (
      <div className="h-full overflow-y-auto flex flex-col items-center justify-center gap-6 p-6">
        <img src="/icon.png" alt="XdesinHMI" className="w-24 h-24 rounded-2xl shadow-lg" />
        <h1 className="text-4xl font-black text-primary tracking-tight">踏板总成测试台</h1>
        <div className="ui-data-box !px-6 !py-3 !text-[14px] max-w-xl w-full justify-center">
          <span className="text-on-surface-variant">
            WiFi TCP 连接 ESP32-S3 下位机 · AES-128-CTR 加密传输 · 开机自检，系统网络设置
          </span>
        </div>

        <div className="industrial-card rounded-xl p-5 w-full max-w-md space-y-3">
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="font-label-bold text-label-sm text-on-surface-variant">主机地址</label>
              <input
                value={ip}
                onChange={(e) => useAppStore.getState().setIp(e.target.value)}
                placeholder="192.168.4.1"
                className="ui-input mt-1 w-full !py-2"
              />
            </div>
            <div className="w-28">
              <label className="font-label-bold text-label-sm text-on-surface-variant">端口</label>
              <input
                value={port}
                onChange={(e) => useAppStore.getState().setPort(e.target.value)}
                placeholder="10001"
                className="ui-input mt-1 w-full !py-2"
              />
            </div>
          </div>
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="ui-action-btn w-full !py-3 !text-[15px]"
          >
            {connecting ? '连接中...' : '连接设备'}
          </button>
          {error && (
            <div className="rounded-[10px] bg-red-50 border border-red-200 text-red-700 px-3 py-2 text-[13px] font-label-bold flex justify-between items-center">
              <span>{error}</span>
              <button onClick={actions.clearError} className="material-symbols-outlined text-[16px]">close</button>
            </div>
          )}
          <div className="text-center font-label-sm text-outline">
            mock 联调环境主机填 127.0.0.1，真实设备默认 192.168.4.1
          </div>
        </div>
      </div>
    )
  }

  // ===== 已连接：命令监测视图（PPT slide 6 布局） =====
  return (
    <div className="h-full flex gap-2 p-3 overflow-hidden">
      {/* 左栏：连接信息 + 遥测 + 急停 */}
      <div className="w-[380px] flex-shrink-0 flex flex-col gap-2 overflow-y-auto">
        <ConnectionPanel
          state={state}
          connecting={connecting}
          onConnect={handleConnect}
          onDisconnect={actions.disconnect}
        />
        <TelemetryPanel telemetry={state.telemetry} />
        <div className="flex justify-center">
          <EstopButton onEstop={actions.estop} />
        </div>
      </div>

      {/* 右栏：命令监测控制台（上下位机通讯命令） */}
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        {error && (
          <div className="flex items-center justify-between px-3 py-1.5 rounded-[10px] bg-red-50 border border-red-200 text-red-700 text-[13px] font-label-bold">
            <span>{error}</span>
            <button onClick={actions.clearError} className="material-symbols-outlined text-[16px]">close</button>
          </div>
        )}
        <div className="industrial-card rounded-xl flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="industrial-card-header flex justify-between items-center flex-shrink-0">
            <h3 className="font-label-bold text-label-bold uppercase tracking-widest text-on-surface-variant">
              上下位机通讯命令
            </h3>
          </div>
          <div className="flex-1 min-h-0">
            <DebugConsole
              debugLog={debugLog}
              connected={state.is_connected}
              onSend={actions.sendRaw}
              onClear={actions.clearDebugLog}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
