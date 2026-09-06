'use client'

import { useState } from 'react'
import { useDevice } from '@/lib/comm'
import { useAppStore } from '@/lib/store'
import ConnectionPanel from '@/components/ui/ConnectionPanel'
import TelemetryPanel from '@/components/ui/TelemetryPanel'
import EstopButton from '@/components/ui/EstopButton'
import DebugConsole from '@/components/ui/DebugConsole'

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

      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 max-w-md space-y-4">
          <ConnectionPanel
            state={state}
            connecting={connecting}
            onConnect={handleConnect}
            onDisconnect={actions.disconnect}
          />
          <div className="flex justify-center">
            <EstopButton onEstop={actions.estop} />
          </div>
        </div>

        <div className="flex-1 space-y-4 min-w-0 flex flex-col">
          <TelemetryPanel telemetry={state.telemetry} />

          <DebugConsole
            debugLog={debugLog}
            connected={state.is_connected}
            onSend={actions.sendRaw}
            onClear={actions.clearDebugLog}
          />
        </div>
      </div>
    </div>
  )
}
