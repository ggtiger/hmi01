'use client'

import { useRef } from 'react'
import { useDevice } from '@/lib/comm'
import { abortReasonText } from '@/lib/comm/types'

/**
 * 全局底部 Info 状态栏（参考 PPT 设计稿每页底部 Info 条）
 * 显示：连接状态 | 设备状态 | 传感器 | 最近事件/错误
 */
export default function InfoBar() {
  const { state, lastEvent } = useDevice()
  const lastEventRef = useRef<string>('')
  const messageRef = useRef<string>('')

  const t = state.telemetry

  if (lastEvent && lastEvent.raw !== lastEventRef.current) {
    lastEventRef.current = lastEvent.raw
    const side = lastEvent.side ? `${lastEvent.side} 侧 ` : ''
    if (lastEvent.kind === 'LEVEL_ABORT') {
      messageRef.current = `${side}流程中止：${lastEvent.reason}（${abortReasonText(lastEvent.reason)}）`
    } else if (lastEvent.kind === 'LEVELED') {
      messageRef.current = `${side}调平完成`
    } else if (lastEvent.kind === 'STABLE') {
      messageRef.current = `${side}推出后稳定`
    } else if (lastEvent.kind === 'PUSH_STOPPED') {
      messageRef.current = `${side}推杆已停止`
    } else if (lastEvent.kind === 'LEVEL_DONE') {
      messageRef.current = `${side}手动调平完成 comp=${lastEvent.comp}°`
    } else {
      messageRef.current = lastEvent.raw
    }
  }

  const statusText = !state.is_connected
    ? '未连接设备'
    : `设备 ${t.state} · 传感器 ${t.sensor} · 选中侧 ${t.pedal_select}`

  const detail = state.last_error
    ? `⚠ ${state.last_error}`
    : messageRef.current || (state.is_connected ? `${state.device_id} ${state.info?.fw ?? state.fw_version ?? ''}` : '请在主页连接设备（mock 环境填 127.0.0.1:10001）')

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
