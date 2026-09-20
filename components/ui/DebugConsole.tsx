'use client'

import { memo, useEffect, useRef, useState } from 'react'
import IndustrialCard from './IndustrialCard'
import type { LogEntry } from '@/lib/comm/types'

interface DebugConsoleProps {
  debugLog: LogEntry[]
  connected: boolean
  onSend: (cmd: string) => Promise<void>
  onClear: () => void
}

const QUICK_COMMANDS = [
  'PING',
  'INFO GET',
  'DEBUG ON',
  'PEDAL SELECT NONE',
  'PEDAL A LEVEL',
  'MOTOR STOP',
]

const directionStyle: Record<string, { label: string; cls: string }> = {
  TX: { label: '→', cls: 'text-sky-700' },
  RX: { label: '←', cls: 'text-emerald-700' },
  SYS: { label: '●', cls: 'text-slate-400' },
}

/** 交互调试控制台：TX/RX 通信日志 + 手动命令输入
 *  memo 化：debugLog 仅在新日志到达时变化，20Hz 遥测刷新不再触发 500 行列表重渲染
 */
function DebugConsoleImpl({ debugLog, connected, onSend, onClear }: DebugConsoleProps) {
  const [input, setInput] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 自动滚动到底部
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [debugLog, autoScroll])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    // 用户滚离底部超过 40px 时关闭自动滚动
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(atBottom)
  }

  const handleSend = async (cmd: string) => {
    const trimmed = cmd.trim()
    if (!trimmed || !connected || sending) return
    setSending(true)
    try {
      await onSend(trimmed)
      setInput('')
    } catch {
      // 发送失败已记录在日志/错误条
    } finally {
      setSending(false)
    }
  }

  return (
    <IndustrialCard
      title="交互控制台"
      headerRight={
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 font-label-sm text-on-surface-variant cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="accent-[#041627]"
            />
            自动滚动
          </label>
          <button
            onClick={onClear}
            className="font-label-sm text-outline hover:text-critical transition-colors"
          >
            清空
          </button>
        </div>
      }
    >
      <div className="h-full flex flex-col">
        {/* 日志窗口（充满剩余高度，内部滚动） */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 min-h-0 overflow-y-auto px-3 py-2 monospaced-data text-xs leading-5 bg-slate-50 border-b border-surface-variant"
        >
          {debugLog.length === 0 && (
            <div className="text-outline text-center py-10">暂无日志（连接设备后显示交互数据）</div>
          )}
          {debugLog.slice(-200).map((entry, i) => {
            const style = directionStyle[entry.direction] ?? directionStyle.SYS
            return (
              <div key={i} className="flex gap-2">
                <span className={`font-bold w-4 flex-shrink-0 text-center ${style.cls}`}>
                  {style.label}
                </span>
                <span className="text-slate-400 flex-shrink-0">
                  {new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
                <span className="text-on-surface break-all whitespace-pre-wrap">{entry.content}</span>
              </div>
            )
          })}
        </div>

        {/* 快捷命令 */}
        <div className="flex flex-wrap gap-1.5 px-3 pt-2 border-t border-surface-variant">
          {QUICK_COMMANDS.map((cmd) => (
            <button
              key={cmd}
              disabled={!connected}
              onClick={() => handleSend(cmd)}
              className="px-2 py-0.5 rounded-full border border-outline-variant font-label-sm monospaced-data text-on-surface-variant hover:bg-primary hover:text-on-primary hover:border-primary transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              {cmd}
            </button>
          ))}
        </div>

        {/* 命令输入行 */}
        <div className="flex items-center gap-2 p-3">
          <span className="material-symbols-outlined text-[18px] text-outline">terminal</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSend(input)
            }}
            disabled={!connected}
            placeholder={connected ? '输入命令后回车发送（如 PING）' : '连接设备后可手动发送命令'}
            className="flex-1 px-3 py-2 rounded-lg border border-outline-variant monospaced-data text-body-md focus:outline-none focus:border-primary disabled:bg-surface-container disabled:text-outline"
          />
          <button
            onClick={() => handleSend(input)}
            disabled={!connected || !input.trim() || sending}
            className="px-4 py-2 rounded-lg bg-primary text-on-primary font-label-bold text-label-bold disabled:opacity-40 hover:bg-opacity-90 transition-all flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-[16px]">send</span>
            发送
          </button>
        </div>
      </div>
    </IndustrialCard>
  )
}

const DebugConsole = memo(DebugConsoleImpl)
export default DebugConsole
