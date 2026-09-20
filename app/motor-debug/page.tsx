'use client'

import { useDevice, type MotorAxis } from '@/lib/comm'
import { useMotorStore, MOTOR_AXES, AXIS_LABELS } from '@/lib/store'
import MotorAxisPanel from '@/components/ui/MotorAxisPanel'
import EstopButton from '@/components/ui/EstopButton'

export default function MotorDebugPage() {
  const { state, actions, error } = useDevice()
  const { axis, setAxis, targetPos, setTargetPos, feed, setFeed } = useMotorStore()

  const t = state.telemetry
  const isPush = axis.startsWith('PUSH')
  const position = isPush
    ? axis === 'PUSH_A'
      ? t.pedal_a
      : t.pedal_b
    : axis === 'A'
      ? t.ang_cor_a
      : t.ang_cor_b
  const unit = isPush ? 'mm' : '°'
  const displayPos = position === null ? null : isPush ? position / 320 : position

  const num = (v: string) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : NaN
  }

  const feedNum = () => {
    const f = num(feed)
    return Number.isFinite(f) && f > 0 ? f : undefined
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

      {/* 轴 Tab */}
      <div className="inline-flex rounded-[10px] border border-outline-variant overflow-hidden">
        {MOTOR_AXES.map((ax) => (
          <button
            key={ax}
            onClick={() => setAxis(ax)}
            className={`px-5 py-2 font-label-bold text-sm transition-colors ${
              axis === ax
                ? 'bg-primary text-on-primary'
                : 'bg-white text-on-surface-variant hover:bg-surface-container'
            }`}
          >
            {ax} · {AXIS_LABELS[ax]}
          </button>
        ))}
      </div>

      {/* 全局操作 */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex gap-2">
          <button onClick={actions.motorEnable} disabled={!state.is_connected} className="ui-action-btn">
            总使能
          </button>
          <button onClick={actions.motorDisable} disabled={!state.is_connected} className="ui-action-btn ui-action-btn-ghost">
            总释放
          </button>
          <button onClick={actions.motorStopAll} disabled={!state.is_connected} className="ui-action-btn ui-action-btn-danger">
            全轴停止
          </button>
        </div>
        <EstopButton onEstop={actions.estop} />
      </div>

      {/* 单轴面板 */}
      <MotorAxisPanel
        axis={axis as MotorAxis}
        position={displayPos}
        unit={unit}
        targetPos={targetPos}
        feed={feed}
        onTargetPosChange={setTargetPos}
        onFeedChange={setFeed}
        onMove={() => {
          const pos = num(targetPos)
          if (!Number.isFinite(pos)) return
          actions.motorMove(axis as MotorAxis, pos, feedNum())
        }}
        onMoveabs={() => {
          const pos = num(targetPos)
          if (!Number.isFinite(pos)) return
          actions.motorMoveabs(axis as MotorAxis, pos, feedNum())
        }}
        onHome={() => actions.motorHome(axis as MotorAxis)}
        onStop={() => actions.motorStop(axis as MotorAxis)}
        onZero={() => actions.motorZero(axis as MotorAxis)}
      />

      {!state.is_connected && (
        <div className="text-center font-label-sm text-outline py-4">
          未连接设备——请先在主页连接（手动操作电机前确保安全区域无人）
        </div>
      )}
    </div>
  )
}
