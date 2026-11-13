'use client'

import { memo } from 'react'
import type { DebugEvent } from '@/lib/comm/types'
import { abortReasonText } from '@/lib/comm/types'
import { useT, useI18nStore } from '@/lib/i18n'

interface EventTimelineProps {
  events: DebugEvent[]
  onClear?: () => void
}

const KIND_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  LEVELED: { label: '调平完成', color: 'text-emerald-700 bg-emerald-50 border-emerald-200', icon: 'check_circle' },
  STABLE: { label: '推出稳定', color: 'text-sky-700 bg-sky-50 border-sky-200', icon: 'verified' },
  PUSH_STOPPED: { label: '推杆停止', color: 'text-slate-600 bg-slate-50 border-slate-200', icon: 'pause_circle' },
  LEVEL_START: { label: '调平开始', color: 'text-sky-700 bg-sky-50 border-sky-200', icon: 'play_circle' },
  LEVEL_DONE: { label: '手动调平完成', color: 'text-emerald-700 bg-emerald-50 border-emerald-200', icon: 'check_circle' },
  LEVEL_ABORT: { label: '流程中止', color: 'text-red-700 bg-red-50 border-red-200', icon: 'cancel' },
  HOME_START: { label: '回零开始', color: 'text-sky-700 bg-sky-50 border-sky-200', icon: 'home' },
  HOME_DONE: { label: '回零完成', color: 'text-emerald-700 bg-emerald-50 border-emerald-200', icon: 'home' },
  PUSH_HOMING: { label: '推杆回零中', color: 'text-amber-700 bg-amber-50 border-amber-200', icon: 'sync' },
  PUSH_STARTED: { label: '推杆开始推出', color: 'text-sky-700 bg-sky-50 border-sky-200', icon: 'arrow_forward' },
  PUSH_DONE: { label: '推杆推出完成', color: 'text-emerald-700 bg-emerald-50 border-emerald-200', icon: 'check_circle' },
  RAW: { label: '事件', color: 'text-slate-600 bg-slate-50 border-slate-200', icon: 'info' },
}

/** DEBUG / ABORT 事件时间线（memo 化：仅在 events 变化时重渲染） */
function EventTimelineImpl({ events, onClear }: EventTimelineProps) {
  const t = useT()
  const locale = useI18nStore((s) => s.locale)
  const reversed = [...events].reverse()

  return (
    <div className="h-full flex flex-col">
      <div className="flex justify-between items-center px-4 py-2 border-b-2 border-surface-container">
        <span className="font-label-bold text-label-bold uppercase tracking-widest text-on-surface-variant">
          {t('事件时间线')}
        </span>
        {onClear && (
          <button
            onClick={onClear}
            className="font-label-sm text-outline hover:text-critical transition-colors"
          >
            {t('清空')}
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
        {reversed.length === 0 && (
          <div className="text-center text-outline font-label-sm py-8">{t('暂无事件')}</div>
        )}
        {reversed.map((ev, i) => {
          const cfg = KIND_CONFIG[ev.kind] ?? KIND_CONFIG.RAW
          return (
            <div
              key={`${events.length - i}-${ev.raw}`}
              className={`flex items-start gap-2 px-3 py-2 rounded-lg border ${cfg.color}`}
            >
              <span className="material-symbols-outlined text-[18px] mt-0.5">{cfg.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="font-label-bold text-label-bold">
                  {ev.side ? (locale === 'zh' ? `${ev.side} 侧 ` : `${ev.side} · `) : ''}
                  {t(cfg.label)}
                  {ev.kind === 'LEVEL_DONE' && ev.comp !== null && ` comp=${ev.comp}°`}
                  {ev.reason && ` · ${ev.reason} (${abortReasonText(ev.reason, locale)})`}
                </div>
                <div className="font-label-sm monospaced-data opacity-70 truncate">{ev.raw}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const EventTimeline = memo(EventTimelineImpl)
export default EventTimeline
