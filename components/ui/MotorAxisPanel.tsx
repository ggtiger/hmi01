'use client'

import { fmtNum } from '@/lib/comm/types'
import type { MotorAxis } from '@/lib/comm/device-service'
import { AXIS_LABELS } from '@/lib/store/motor-store'
import { useT } from '@/lib/i18n'

interface MotorAxisPanelProps {
  axis: MotorAxis
  /** 当前位置（MSH: °；PUSH: mm） */
  position: number | null
  unit: string
  targetPos: string
  feed: string
  disabled?: boolean
  onTargetPosChange: (v: string) => void
  onFeedChange: (v: string) => void
  onMove: () => void
  onMoveabs: () => void
  onHome: () => void
  onStop: () => void
  onZero: () => void
}

/** 单轴控制面板：定位读数 + 目标/进给 + 轴级动作，保持五个原有操作全部可见 */
export default function MotorAxisPanel(p: MotorAxisPanelProps) {
  const t = useT()
  const isPush = p.axis.startsWith('PUSH')
  const disabled = !!p.disabled

  return (
    <div className="p-3">
      <div className="grid grid-cols-[210px_minmax(0,1fr)_auto] items-stretch gap-2.5">
        {/* 当前轴读数 */}
        <div className="flex min-h-[70px] flex-col justify-between rounded-xl border border-white/85 bg-[linear-gradient(135deg,rgba(255,255,255,.78),rgba(255,255,255,.35))] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,.8)]">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-bold uppercase tracking-[1.1px] text-slate-400">{t('当前轴')}</span>
            <span className="ml-auto rounded-md bg-[#0f2233]/[0.06] px-1.5 py-0.5 font-mono text-[9px] font-bold text-[#24405a]">
              {p.axis}
            </span>
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="truncate font-mono text-[24px] font-black leading-none tabular-nums text-[#0f2233]">
              {fmtNum(p.position, 3)}
            </span>
            <span className="text-[11px] font-bold text-slate-400">{p.unit}</span>
          </div>
          <div className="mt-0.5 truncate text-[9.5px] text-slate-400">{t(AXIS_LABELS[p.axis])}</div>
        </div>

        {/* 目标 / 进给 */}
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_140px] gap-3">
          <div className="min-w-0">
            <label className="text-[10px] font-bold text-slate-500">
              {isPush ? t('目标行程（相对，负值收回）') : t('目标角度（绝对位置）')}
            </label>
            <div className="relative mt-1">
              <input
                value={p.targetPos}
                onChange={(e) => p.onTargetPosChange(e.target.value)}
                inputMode="decimal"
                placeholder={isPush ? 'mm' : '°'}
                disabled={disabled}
                className="ui-input h-8 w-full !pr-11"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-slate-400">
                {p.unit}
              </span>
            </div>
          </div>
          <div>
            <label className="text-[10px] font-bold text-slate-500">
              {t('进给 F')} <span className="font-normal text-slate-400">({isPush ? 'RPM' : '°/s'})</span>
            </label>
            <input
              value={p.feed}
              onChange={(e) => p.onFeedChange(e.target.value)}
              inputMode="decimal"
              placeholder={isPush ? t('默认 60') : t('不限速')}
              disabled={disabled}
              className="ui-input mt-1 h-8 w-full"
            />
          </div>
        </div>

        {/* 五个轴动作保持不变 */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            onClick={p.onMove}
            disabled={disabled}
            className="ui-action-btn ui-action-btn-primary !h-8 !px-3.5 !text-[12px]"
          >
            <span className="material-symbols-outlined text-[16px]">arrow_outward</span>
            MOVE
          </button>
          <button
            onClick={p.onMoveabs}
            disabled={disabled || !isPush}
            className="ui-action-btn !h-8 !px-3 !text-[12px]"
            title={!isPush ? t('MOVEABS 仅 PUSH 轴支持；MSH 轴 MOVE 即绝对定位') : t('MOVEABS')}
          >
            <span className="material-symbols-outlined text-[16px] text-slate-400">open_with</span>
            MOVEABS
          </button>
          <button
            onClick={p.onHome}
            disabled={disabled}
            className="ui-action-btn ui-action-btn-ghost !h-8 !px-3 !text-[12px]"
          >
            <span className="material-symbols-outlined text-[16px] text-slate-400">home</span>
            {t('回零')}
          </button>
          <button
            onClick={p.onStop}
            disabled={disabled}
            className="ui-action-btn ui-action-btn-danger !h-8 !px-3 !text-[12px]"
          >
            <span className="material-symbols-outlined text-[16px]">stop_circle</span>
            {t('停止')}
          </button>
          <button
            onClick={p.onZero}
            disabled={disabled}
            className="ui-action-btn ui-action-btn-ghost !h-8 !px-3 !text-[12px]"
          >
            <span className="material-symbols-outlined text-[16px] text-slate-400">exposure_zero</span>
            {t('置零')}
          </button>
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-slate-400">
        <span className="material-symbols-outlined text-[14px]">info</span>
        {!isPush
          ? t('MOVEABS 仅 PUSH 轴支持；MSH 轴 MOVE 即绝对定位')
          : t('相对移动，负值收回；MOVEABS 为绝对位置')}
      </div>
    </div>
  )
}
