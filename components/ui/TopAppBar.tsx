"use client"

import { useState, useEffect, useRef, useCallback } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { invoke } from '@tauri-apps/api/core'
import { WindowControls } from './WindowControls'
import SettingsModal from './SettingsModal'
import UpdateNotification from './UpdateNotification'
import { AutoUpdater, checkServerDelta, checkForUpdate } from '@/lib/updater'
import { useUpdaterStore } from '@/lib/store'

const navItems = [
  { label: '命令监测', icon: 'terminal', href: '/' },
  { label: '踏板测试', icon: 'footprint', href: '/pedal-test' },
  { label: '转盘测试', icon: 'rotate_right', href: '/steering-test' },
  { label: '电机调试', icon: 'settings_input_component', href: '/motor-debug' },
  { label: '数据记录', icon: 'storage', href: '/records' },
  { label: '设置', icon: 'tune', href: '/settings' },
  { label: '帮助', icon: 'help', href: '/about' },
]

export default function TopAppBar() {
  const pathname = usePathname()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const setAvailable = useUpdaterStore((s) => s.setAvailable)
  const setServerReady = useUpdaterStore((s) => s.setServerReady)
  const showServerUpdatedToast = useUpdaterStore((s) => s.showServerUpdatedToast)
  const updaterRef = useRef<AutoUpdater | null>(null)

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const closeMenu = useCallback(() => setContextMenu(null), [])

  // Close on Escape key
  useEffect(() => {
    if (!contextMenu) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu() }
    const onClick = () => closeMenu()
    window.addEventListener('keydown', onKey)
    window.addEventListener('click', onClick)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('click', onClick) }
  }, [contextMenu, closeMenu])

  const menuItems = [
    { label: '刷新页面', action: () => window.location.reload() },
    { label: '开发者工具', action: () => invoke('open_devtools') },
    { label: '检查热更新', action: () => checkServerDelta() },
    { label: '检查全量更新', action: () => checkForUpdate() },
  ]

  useEffect(() => {
    const updater = new AutoUpdater()
    updaterRef.current = updater
    updater.start({
      onTauriUpdate: (info) => {
        console.log('[TopAppBar] 发现全量更新:', info.version)
        setAvailable(info)
      },
      onUpdateReady: (version, localPath) => {
        console.log('[TopAppBar] 热更新已下载:', version, localPath)
        setServerReady(version, localPath)
      },
      onServerUpdated: (newVersion) => {
        console.log('[TopAppBar] Server 已更新到:', newVersion)
        showServerUpdatedToast(newVersion)
      },
      onError: (err) => {
        console.warn('[TopAppBar] 更新检查出错:', err)
      },
    })
    return () => updater.stop()
  }, [setAvailable, setServerReady, showServerUpdatedToast])

  return (
    <header
      className="flex-shrink-0 z-50 flex items-center justify-between px-4 h-14 w-full bg-white border-b border-slate-200 shadow-sm font-inter text-body-md text-primary antialiased select-none draggable-region relative"
      data-tauri-drag-region
      onContextMenu={handleContextMenu}
    >
      <span className="text-lg font-black text-primary tracking-tighter flex items-center flex-shrink-0">
        <img src="/icon.png" alt="XdesinHMI" className="w-7 h-7 mr-2 rounded" />
        Xdesin 踏板测试台
      </span>

      {/* 导航胶囊（右对齐，参考 PPT 设计稿） */}
      <div className="flex items-center gap-2">
        <nav className="hidden md:flex items-center gap-1.5">
          {navItems.map((item) => {
            const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
            return (
              <Link
                key={item.href + item.label}
                href={item.href}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-[10px] font-label-bold text-[13px] transition-colors ${
                  isActive
                    ? 'bg-primary text-on-primary shadow-sm'
                    : 'text-slate-600 hover:bg-surface-container hover:text-primary'
                }`}
              >
                <span className="material-symbols-outlined text-[16px]">{item.icon}</span>
                {item.label}
              </Link>
            )
          })}
        </nav>
        <WindowControls />
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <UpdateNotification />
      {contextMenu && (
        <div
          className="fixed z-[9999] min-w-[160px] rounded-lg bg-slate-800 border border-slate-700 shadow-xl py-1 text-sm text-slate-100"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menuItems.map((item) => (
            <button
              key={item.label}
              className="w-full text-left px-4 py-2 hover:bg-slate-700 transition-colors"
              onClick={() => { item.action(); closeMenu() }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </header>
  )
}
