'use client'

import { useEffect } from 'react'
import IndustrialCard from './IndustrialCard'
import StatusIndicator from './StatusIndicator'
import Button from './Button'
import { useAppStore } from '@/lib/store'
import type { DeviceState } from '@/lib/comm/types'

interface ConnectionPanelProps {
  state: DeviceState
  connecting: boolean
  onConnect: () => Promise<void>
  onDisconnect: () => Promise<void>
}

/** 连接表单 + 设备信息卡 */
export default function ConnectionPanel({
  state,
  connecting,
  onConnect,
  onDisconnect,
}: ConnectionPanelProps) {
  const { ip, port, setIp, setPort, initFromConfig } = useAppStore()

  useEffect(() => {
    initFromConfig()
  }, [initFromConfig])

  const connected = state.is_connected

  return (
    <IndustrialCard
      title="设备连接"
      headerRight={
        <StatusIndicator
          status={connected ? 'connected' : connecting ? 'warning' : 'disconnected'}
          label={connected ? '已连接' : connecting ? '连接中...' : '未连接'}
        />
      }
    >
      <div className="p-4 space-y-3">
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="font-label-bold text-label-sm text-on-surface-variant">主机地址</label>
            <input
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              disabled={connected}
              placeholder="192.168.4.1"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-outline-variant monospaced-data text-body-md focus:outline-none focus:border-primary disabled:bg-surface-container disabled:text-outline"
            />
          </div>
          <div className="w-28">
            <label className="font-label-bold text-label-sm text-on-surface-variant">端口</label>
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              disabled={connected}
              placeholder="10001"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-outline-variant monospaced-data text-body-md focus:outline-none focus:border-primary disabled:bg-surface-container disabled:text-outline"
            />
          </div>
        </div>

        <div className="flex gap-2">
          {!connected ? (
            <Button onClick={onConnect} disabled={connecting} className="flex-1 justify-center" icon="link">
              {connecting ? '连接中...' : '连接设备'}
            </Button>
          ) : (
            <Button variant="ghost" onClick={onDisconnect} className="flex-1 justify-center" icon="link_off">
              断开连接
            </Button>
          )}
        </div>

        {connected && (
          <div className="rounded-lg bg-surface-container-low p-3 space-y-1">
            <div className="flex justify-between font-label-sm">
              <span className="text-on-surface-variant">设备 ID</span>
              <span className="monospaced-data font-label-bold">{state.device_id || '--'}</span>
            </div>
            <div className="flex justify-between font-label-sm">
              <span className="text-on-surface-variant">固件版本</span>
              <span className="monospaced-data font-label-bold">{state.info?.fw || state.fw_version || '--'}</span>
            </div>
            <div className="flex justify-between font-label-sm">
              <span className="text-on-surface-variant">硬件</span>
              <span className="monospaced-data font-label-bold">{state.info?.hw || '--'}</span>
            </div>
            <div className="flex justify-between font-label-sm">
              <span className="text-on-surface-variant">运行时间</span>
              <span className="monospaced-data font-label-bold">
                {state.info ? `${state.info.uptime}s` : '--'}
              </span>
            </div>
            <div className="flex justify-between font-label-sm">
              <span className="text-on-surface-variant">SSID / 模式</span>
              <span className="monospaced-data font-label-bold">
                {state.info?.ssid || '--'} / {state.plain_mode ? '明文' : '加密'}
              </span>
            </div>
          </div>
        )}
      </div>
    </IndustrialCard>
  )
}
