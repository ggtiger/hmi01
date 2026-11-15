'use client'

import { useEffect, useState } from 'react'
import { useT } from '@/lib/i18n'

/**
 * Windows 原生风格窗口控制按钮（仅 Windows 显示）
 * macOS 使用 titleBarStyle: "Overlay" 已有原生红绿灯，无需自定义
 * 放在窗口右上角：最小化 ─  最大化 □  关闭 ✕
 *
 * inline: 参与父容器布局（V6 顶栏使用），避免 fixed 按钮覆盖顶栏右侧内容
 * 默认: fixed 在窗口右上角（登录页等无顶栏页面使用）
 */
export function WindowControls({ inline = false }: { inline?: boolean } = {}) {
  const t = useT()
  const [isWindows, setIsWindows] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    const isWin = navigator.userAgent.includes('Windows')
    const isDev =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).has('show-windows-controls')
    setIsWindows(isWin || isDev)
  }, [])

  if (!isWindows) return null

  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    const ti = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ as
      | { invoke?: (c: string, a?: unknown) => Promise<unknown> }
      | undefined
    if (!ti?.invoke) return
    await ti.invoke(cmd, args)
  }

  const handleClose = () => invoke('plugin:window|close', { label: 'main' })
  const handleMinimize = () => invoke('plugin:window|minimize', { label: 'main' })
  const handleMaximize = async () => {
    await invoke(
      isMaximized ? 'plugin:window|unmaximize' : 'plugin:window|maximize',
      { label: 'main' }
    )
    setIsMaximized(!isMaximized)
  }

  const barClass = inline
    ? 'flex items-stretch h-[38px] overflow-hidden rounded-[10px] border border-[rgba(15,80,120,.16)] bg-white/85 shadow-[0_4px_14px_rgba(15,40,60,.10)] backdrop-blur-md select-none'
    : 'fixed top-0 right-0 z-[9999] flex items-stretch h-[38px] overflow-hidden rounded-bl-[12px] border-b border-l border-[rgba(15,80,120,.16)] bg-white/90 shadow-[0_6px_18px_rgba(15,40,60,.12)] backdrop-blur-md select-none'

  const buttonClass =
    'w-[48px] h-full flex items-center justify-center border-l border-[rgba(15,80,120,.09)] text-[#334155] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0891b2]/45'

  return (
    <div
      className={barClass}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      data-tauri-no-drag
    >
      {/* 最小化 */}
      <button
        onClick={handleMinimize}
        className={`${buttonClass} hover:bg-[rgba(8,145,178,.10)] active:bg-[rgba(8,145,178,.18)]`}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title={t('最小化')}
        aria-label={t('最小化')}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="1" y="5.4" width="10" height="1.2" rx="0.6" fill="currentColor" />
        </svg>
      </button>

      {/* 最大化/还原 */}
      <button
        onClick={handleMaximize}
        className={`${buttonClass} hover:bg-[rgba(8,145,178,.10)] active:bg-[rgba(8,145,178,.18)]`}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title={isMaximized ? t('还原') : t('最大化')}
        aria-label={isMaximized ? t('还原') : t('最大化')}
      >
        {isMaximized ? (
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
            <rect x="3.2" y="1.2" width="8" height="8" rx="0.8" />
            <rect x="1.2" y="3.2" width="8" height="8" rx="0.8" fill="white" />
            <rect x="1.2" y="3.2" width="8" height="8" rx="0.8" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
            <rect x="1.1" y="1.1" width="9.8" height="9.8" rx="0.8" />
          </svg>
        )}
      </button>

      {/* 关闭 */}
      <button
        onClick={handleClose}
        className={`${buttonClass} hover:bg-[#e81123] hover:text-white active:bg-[#bf0f1d] active:text-white`}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title={t('关闭')}
        aria-label={t('关闭')}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <line x1="1.3" y1="1.3" x2="10.7" y2="10.7" />
          <line x1="10.7" y1="1.3" x2="1.3" y2="10.7" />
        </svg>
      </button>
    </div>
  )
}
