'use client'

import { useRef } from 'react'
import { useDevice } from '@/lib/comm'
import { abortReasonText } from '@/lib/comm/types'
import type { DebugEvent } from '@/lib/comm/types'
import { useT, useI18nStore } from '@/lib/i18n'

/**
 * 全局底部 Info 状态栏（参考 PPT 设计稿每页底部 Info 条）
 * 显示：连接状态 | 设备状态 | 传感器 | 最近事件/错误
 */
export default function InfoBar() {
  const tr = useT()
  const locale = useI18nStore((s) => s.locale)
  const { state, boards, lastEvent } = useDevice()
  const lastRawRef = useRef<string>('')
  /** 保存最近事件对象（渲染时按当前语言格式化，切换语言即时生效） */
  const messageEventRef = useRef<DebugEvent | null>(null)

  const t = state.telemetry

  if (lastEvent && lastEvent.raw !== lastRawRef.current) {
    lastRawRef.current = lastEvent.raw
    messageEventRef.current = lastEvent
  }

  const ev = messageEventRef.current
  let message = ''
  if (ev) {
    const side = ev.side ? (locale === 'zh' ? `${ev.side} 侧 ` : `${ev.side} · `) : ''
    if (ev.kind === 'LEVEL_ABORT') {
      message = `${side}${tr('流程中止')}：${ev.reason} (${abortReasonText(ev.reason, locale)})`
    } else if (ev.kind === 'LEVELED') {
      message = `${side}${tr('调平完成')}`
    } else if (ev.kind === 'STABLE') {
      message = `${side}${tr('推出稳定')}`
    } else if (ev.kind === 'PUSH_STOPPED') {
      message = `${side}${tr('推杆停止')}`
    } else if (ev.kind === 'LEVEL_DONE') {
      message = `${side}${tr('手动调平完成')} comp=${ev.comp}°`
    } else {
      message = ev.raw
    }
  }

  const boardText = `A ${boards.A.is_connected ? tr('已连接') : tr('未连接')} ${
    boards.A.last_pong || '--'
  } · B ${boards.B.is_connected ? tr('已连接') : tr('未连接')} ${boards.B.last_pong || '--'}`
  const statusText = !state.is_connected
    ? `${tr('未连接设备')}（${boardText}）`
    : `${boardText} · ${tr('设备')} ${t.state} · ${tr('传感器')} ${t.sensor} · ${tr('选中侧')} ${t.pedal_select}`

  const detail = state.last_error
    ? `⚠ ${state.last_error}`
    : message || (state.is_connected ? `${state.device_id} ${state.info?.fw ?? state.fw_version ?? ''}` : tr('请在主页连接设备（mock 环境填 127.0.0.1:10001）'))

  const isAlert = !!state.last_error || lastEvent?.kind === 'LEVEL_ABORT'

  return (
    <footer className="flex-shrink-0 px-4 pb-2 pt-1 bg-transparent">
      <div className={`ui-info-bar ${isAlert ? '!bg-red-50 !border-red-200 !text-red-700' : ''}`}>
        <span className="font-bold mr-3">{statusText}</span>
        <span>{detail}</span>
      </div>
    </footer>
  )
}
