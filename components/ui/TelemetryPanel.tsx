'use client'

import { memo } from 'react'
import { fmtNum } from '@/lib/comm/types'
import type { TelemetryData } from '@/lib/comm/types'
import IndustrialCard from './IndustrialCard'
import StatusIndicator from './StatusIndicator'

interface TelemetryPanelProps {
  telemetry: TelemetryData
}

function KV({ k, v, unit = '', digits = 2 }: { k: string; v: number | null | string; unit?: string; digits?: number }) {
  const text = typeof v === 'string' ? v : fmtNum(v, digits, unit)
  return (
    <div className="flex justify-between items-center px-3 py-1.5 border-b border-surface-variant last:border-b-0">
      <span className="font-label-sm text-on-surface-variant monospaced-data">{k}</span>
      <span className={`font-label-bold monospaced-data ${typeof v === 'number' && v === null ? 'text-outline' : 'text-on-surface'}`}>
        {text}
      </span>
    </div>
  )
}

/** k=v 遥测总览面板（nan → "--"）；接收实时遥测数据，本身重渲染开销极低 */
function TelemetryPanelImpl({ telemetry: t }: TelemetryPanelProps) {
  const stateColor =
    t.state === 'FAULT' ? 'warning' : t.state === 'PEDAL_RUN' ? 'connected' : 'disconnected'

  return (
    <IndustrialCard
      title="遥测总览"
      headerRight={
        <div className="flex items-center gap-4">
          <StatusIndicator
            status={t.sensor === 'OK' ? 'connected' : 'warning'}
            label={`传感器 ${t.sensor}`}
          />
          <span className="font-label-bold text-label-sm monospaced-data text-on-surface-variant">
            t={t.t}ms
          </span>
        </div>
      }
    >
      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 p-3">
        <div>
          <KV k="tilt_x" v={t.tilt_x} unit="°" />
          <KV k="tilt_y" v={t.tilt_y} unit="°" />
          <KV k="steer_x" v={t.steer_x} unit="°" />
          <KV k="steer_y" v={t.steer_y} unit="°" />
        </div>
        <div>
          <KV k="pedal_a_tilt_x" v={t.pedal_a_tilt_x} unit="°" />
          <KV k="pedal_a_tilt_y" v={t.pedal_a_tilt_y} unit="°" />
          <KV k="laser_a" v={t.laser_a} unit="mm" />
          <KV k="pedal_a" v={t.pedal_a} digits={0} />
          <KV k="ang_cor_a" v={t.ang_cor_a} unit="°" />
        </div>
        <div>
          <KV k="pedal_b_tilt_x" v={t.pedal_b_tilt_x} unit="°" />
          <KV k="pedal_b_tilt_y" v={t.pedal_b_tilt_y} unit="°" />
          <KV k="laser_b" v={t.laser_b} unit="mm" />
          <KV k="pedal_b" v={t.pedal_b} digits={0} />
          <KV k="ang_cor_b" v={t.ang_cor_b} unit="°" />
        </div>
      </div>
      <div className="flex items-center gap-6 px-4 pb-3">
        <StatusIndicator
          status={stateColor === 'connected' ? 'connected' : stateColor === 'warning' ? 'warning' : 'disconnected'}
          label={`状态 ${t.state}`}
        />
        <StatusIndicator
          status={t.pedal_select === 'NONE' ? 'warning' : 'connected'}
          label={`选中侧 ${t.pedal_select}`}
        />
      </div>
    </IndustrialCard>
  )
}

const TelemetryPanel = memo(TelemetryPanelImpl)
export default TelemetryPanel
