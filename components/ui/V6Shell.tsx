'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useDevice, useForce } from '@/lib/comm'
import type { BoardSide } from '@/lib/comm/types'
import { useAppStore, useUserStore, type Permission } from '@/lib/store'
import ForceModal from './ForceModal'
import UpdateNotification from './UpdateNotification'
import { WindowControls } from './WindowControls'
import LoginScreen from '@/components/LoginScreen'
import { useI18nStore, useLocaleHydration, useT } from '@/lib/i18n'

interface NavItem {
  key: Permission
  label: string
  href: string
  icon: string
}

const NAV: NavItem[] = [
  { key: 'debug', label: '调试台', href: '/motor-debug', icon: 'dashboard' },
  { key: 'pedal', label: '踏板', href: '/pedal-test', icon: 'footprint' },
  { key: 'steer', label: '转盘', href: '/steering-test', icon: 'rotate_right' },
  { key: 'records', label: '记录', href: '/records', icon: 'article' },
  { key: 'settings', label: '设置', href: '/settings', icon: 'tune' },
  { key: 'help', label: '帮助', href: '/help', icon: 'help' },
]

/** 启动加载动画（WebView 内） */
function BootScreen() {
  return (
    <div className="fixed inset-0 z-[600] flex items-center justify-center bg-[radial-gradient(900px_500px_at_50%_0%,rgba(8,145,178,.16),transparent_62%),linear-gradient(180deg,#f7fbfe,#e3edf6)]">
      <div className="flex flex-col items-center gap-3 rounded-[20px] border border-white/95 bg-white/75 px-12 py-9 shadow-[0_24px_70px_rgba(31,86,130,.18)] backdrop-blur-xl">
        <img src="/icon.png" alt="" className="w-16 h-16 rounded-[18px] shadow-lg animate-pulse" />
        <div className="text-[19px] font-black text-[#0f2233]">智能驾驶舱检测系统</div>
        <div className="text-[10px] tracking-[3px] text-slate-400">DUAL-BOARD CONSOLE</div>
        <div className="mt-2 h-8 w-8 rounded-full border-[3px] border-[rgba(8,145,178,.18)] border-t-[#0891b2] animate-spin" />
        <div className="text-[11px] font-label-sm text-slate-500">正在初始化设备通信…</div>
        <div className="h-1 w-60 overflow-hidden rounded-full bg-[rgba(15,80,120,.09)]">
          <div className="h-full w-1/2 animate-[loadbar_1.2s_ease-in-out_infinite] bg-[linear-gradient(90deg,#0891b2,#2563eb)]" />
        </div>
      </div>
      <style jsx>{`
        @keyframes loadbar {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(220%); }
        }
      `}</style>
    </div>
  )
}

/**
 * V6 应用外壳：顶栏 + 左侧导航 + 页面 + 底部状态栏
 * 包含启动动画、登录、首次连接向导、用户权限、BLE/更新弹窗。
 */
export default function V6Shell({ children }: { children: React.ReactNode }) {
  const t = useT()
  const pathname = usePathname()
  const router = useRouter()
  const locale = useI18nStore((s) => s.locale)
  const setLocale = useI18nStore((s) => s.setLocale)
  useLocaleHydration()

  const { state, boards, actions } = useDevice()
  const { states: forceStates } = useForce()
  const conns = useAppStore((s) => s.boards)
  const setBoardIp = useAppStore((s) => s.setBoardIp)
  const setBoardPort = useAppStore((s) => s.setBoardPort)

  const currentUser = useUserStore((s) => s.currentUser)
  const logout = useUserStore((s) => s.logout)

  const [booting, setBooting] = useState(true)
  const [guideOpen, setGuideOpen] = useState(false)
  const [forceOpen, setForceOpen] = useState(false)
  const [connecting, setConnecting] = useState<Partial<Record<BoardSide, boolean>>>({})
  const [clock, setClock] = useState('--:--:--')

  useEffect(() => {
    const id = window.setTimeout(() => setBooting(false), 900)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [])

  const allowedNav = useMemo(
    () => (currentUser ? NAV.filter((n) => currentUser.perms.includes(n.key)) : []),
    [currentUser]
  )

  const isAboutPage = pathname === '/about' || pathname.startsWith('/about/')

  // 权限路由：无权限页面 / 命令监测根路由 → 第一个有权限的页面
  // 「关于」始终可访问，不受功能权限限制
  useEffect(() => {
    if (!currentUser || allowedNav.length === 0) return
    const current = allowedNav.find((n) => pathname === n.href || pathname.startsWith(n.href + '/'))
    if (!current && !isAboutPage) router.replace(allowedNav[0].href)
  }, [currentUser, pathname, allowedNav, router, isAboutPage])

  const connectedBoards = (['A', 'B'] as BoardSide[]).filter((s) => boards[s].is_connected).length
  const connectedModules = Object.values(forceStates).filter((s) => s.isConnected).length

  const handleConnect = async (side: BoardSide) => {
    setConnecting((p) => ({ ...p, [side]: true }))
    try {
      await actions.connect(side, conns[side].ip, Number(conns[side].port))
    } catch {
      /* useDevice 已显示错误 */
    } finally {
      setConnecting((p) => ({ ...p, [side]: false }))
    }
  }

  const handleLogin = () => {
    setGuideOpen(true)
  }

  const handleLogout = () => {
    setGuideOpen(false)
    setForceOpen(false)
    logout()
  }

  if (booting) return <BootScreen />
  if (!currentUser) return <LoginScreen onLogin={handleLogin} />

  const active = allowedNav.find((n) => pathname === n.href || pathname.startsWith(n.href + '/'))

  return (
    <div className="h-screen flex flex-col min-h-0 overflow-hidden relative">
      {/* ===== 顶栏 ===== */}
      <header
        className="draggable-region flex-shrink-0 h-[58px] z-50 flex items-center gap-4 px-4 bg-white/65 backdrop-blur-xl border-b border-[rgba(15,80,120,.10)] shadow-[0_6px_26px_rgba(31,86,130,.06)] select-none"
        data-tauri-drag-region
      >
        <button
          onClick={() => allowedNav[0] && router.push(allowedNav[0].href)}
          className="flex items-center gap-2.5 flex-shrink-0"
        >
          <img src="/icon.png" alt={t('智能驾驶舱检测系统')} className="w-8 h-8 rounded-[9px] shadow" />
          <span className="text-[14px] font-black text-[#0f2233] tracking-tight">{t('智能驾驶舱检测系统')}</span>
        </button>

        <div className="flex items-center gap-1.5 ml-1">
          {(['A', 'B'] as BoardSide[]).map((side) => (
            <button
              key={side}
              onClick={() => setGuideOpen(true)}
              title={t('设备连接')}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-white/90 bg-white/55 px-2.5 text-[11px] text-slate-500 hover:bg-white"
            >
              <span className={`led ${boards[side].is_connected ? 'on' : ''}`} />
              <b className="text-[11.5px] text-[#142639]">{side} 板</b>
              <span className={boards[side].is_connected ? 'text-emerald-600' : 'text-slate-400'}>
                {boards[side].is_connected ? t('在线') : t('离线')}
              </span>
            </button>
          ))}
          <button
            onClick={() => setForceOpen(true)}
            title={t('蓝牙模块联结')}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-white/90 bg-white/55 px-2.5 text-[11px] text-slate-500 hover:bg-white"
          >
            <span className={`led ${connectedModules > 0 ? 'on' : ''}`} />
            <b className="text-[11.5px] text-[#142639]">BLE</b>
            <span>{connectedModules}/5</span>
          </button>
        </div>

        {/* 空白区域用于拖动窗口；按钮本身由 draggable-region 的 no-drag 规则排除 */}
        <div className="flex min-w-4 flex-1 self-stretch items-center justify-center" data-tauri-drag-region>
          <span className="material-symbols-outlined pointer-events-none text-[16px] text-slate-300/70">drag_indicator</span>
        </div>

        <div className="flex items-center gap-1">
          <button onClick={() => setGuideOpen(true)} className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] text-slate-500 hover:bg-white/60">
            <span className="material-symbols-outlined text-[16px]">cable</span>
            {t('连接')}
          </button>
          {currentUser.perms.includes('settings') && (
            <Link href="/settings" className="hidden lg:flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] text-slate-500 hover:bg-white/60">
              <span className="material-symbols-outlined text-[16px]">tune</span>
              {t('参数')}
            </Link>
          )}
          <div className="hidden lg:flex rounded-lg overflow-hidden border border-[rgba(15,80,120,.12)] bg-white/55">
            {(['zh', 'en'] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLocale(l)}
                className={`h-8 px-2 text-[11px] font-label-bold ${locale === l ? 'bg-[#0891b2] text-white' : 'text-slate-500'}`}
              >
                {l === 'zh' ? '中' : 'EN'}
              </button>
            ))}
          </div>
          <span className="hidden xl:flex h-8 px-2.5 items-center rounded-lg bg-white/45 border border-white/80 font-mono text-[11px] text-slate-500">
            {clock}
          </span>
          <button
            onClick={() => actions.estop()}
            className="h-10 px-4 rounded-[10px] text-white text-[13px] font-extrabold tracking-wider flex items-center gap-1.5 bg-[linear-gradient(135deg,#fb7185,#e11d48)] shadow-[0_6px_18px_rgba(225,29,72,.28)]"
          >
            <span className="material-symbols-outlined text-[18px]">emergency_home</span>
            {t('急停')}
          </button>
          <WindowControls inline />
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        {/* ===== 左侧导航 ===== */}
        <aside className="w-[76px] flex-shrink-0 flex flex-col items-center gap-1.5 py-3 bg-white/45 backdrop-blur-lg border-r border-[rgba(15,80,120,.09)]">
          {allowedNav.map((item) => {
            const isActive = active?.key === item.key
            return (
              <button
                key={item.key}
                onClick={() => router.push(item.href)}
                className={`w-14 h-14 rounded-xl flex flex-col items-center justify-center gap-1 text-[10px] font-bold transition-colors ${
                  isActive
                    ? 'text-white bg-[linear-gradient(140deg,rgba(8,145,178,.95),rgba(37,99,235,.92))] shadow-[0_8px_20px_rgba(8,145,178,.26)]'
                    : 'text-slate-500 hover:bg-white/65 hover:text-[#0891b2]'
                }`}
              >
                <span className="material-symbols-outlined text-[20px]">{item.icon}</span>
                {t(item.label)}
              </button>
            )
          })}

          <div className="my-1 h-px w-8 bg-[rgba(15,80,120,.10)]" />
          <button
            onClick={() => router.push('/about')}
            title={t('关于')}
            className={`w-14 h-14 rounded-xl flex flex-col items-center justify-center gap-1 text-[10px] font-bold transition-colors ${
              isAboutPage
                ? 'text-white bg-[linear-gradient(140deg,rgba(8,145,178,.95),rgba(37,99,235,.92))] shadow-[0_8px_20px_rgba(8,145,178,.26)]'
                : 'text-slate-500 hover:bg-white/65 hover:text-[#0891b2]'
            }`}
          >
            <span className="material-symbols-outlined text-[20px]">info</span>
            {t('关于')}
          </button>

          <div className="flex-1" />
          <button
            onClick={handleLogout}
            title={`${currentUser.username} · ${currentUser.role} · ${t('退出登录')}`}
            className="w-14 min-h-[54px] rounded-xl border border-white/90 bg-white/65 flex flex-col items-center justify-center gap-0.5 text-[9px] font-bold text-[#0891b2] hover:bg-white/85 transition-colors"
          >
            <span className="w-6 h-6 rounded-full bg-[linear-gradient(135deg,#0891b2,#2563eb)] text-white flex items-center justify-center text-[9px] font-black">
              {currentUser.username.slice(0, 2).toUpperCase()}
            </span>
            <span>{t('退出')}</span>
          </button>
        </aside>

        {/* ===== 页面 ===== */}
        <main className="flex-1 min-w-0 min-h-0 overflow-hidden">{children}</main>
      </div>

      {/* ===== 底部状态栏 ===== */}
      <footer className="flex-shrink-0 h-[29px] flex items-center gap-3 px-4 bg-white/60 backdrop-blur border-t border-[rgba(15,80,120,.08)] font-mono text-[9.5px] text-slate-400">
        {(['A', 'B'] as BoardSide[]).map((side) => (
          <span key={side} className="flex items-center gap-1">
            {side}{' '}
            <b style={{ color: boards[side].is_connected ? 'var(--ok, #059669)' : '#8ea2b5' }}>
              {boards[side].is_connected ? 'ONLINE' : 'OFFLINE'}
            </b>
            <span className="text-slate-400">{boards[side].last_pong || '--'}</span>
          </span>
        ))}
        <span className="w-px h-2.5 bg-[rgba(15,80,120,.12)]" />
        <span>{t('心跳')} 5s · 15s</span>
        <span className="w-px h-2.5 bg-[rgba(15,80,120,.12)]" />
        <span>FW {state.fw_version || '--'}</span>
        <span className="w-px h-2.5 bg-[rgba(15,80,120,.12)]" />
        <span>AES-128-CTR · HMAC-MD5</span>
        <span className="flex-1" />
        <span>{currentUser.username} · {currentUser.role}</span>
      </footer>

      {/* ===== 首次连接向导 ===== */}
      {guideOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-5 bg-[rgba(15,40,60,.26)] backdrop-blur-[5px]">
          <div className="w-[880px] max-w-full rounded-[18px] border border-white/95 bg-[#f8fcff]/95 shadow-[0_28px_80px_rgba(15,40,60,.24)] backdrop-blur-2xl overflow-hidden">
            <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[rgba(15,80,120,.08)]">
              <img src="/icon.png" alt="" className="w-9 h-9 rounded-[10px]" />
              <div>
                <div className="text-[16px] font-bold text-[#0f2233]">{t('设备连接')}</div>
                <div className="text-[10px] text-slate-400">{t('可跳过，稍后在顶部「连接」中重新打开')}</div>
              </div>
            </div>
            <div className="grid md:grid-cols-3 gap-3 p-5">
              {(['A', 'B'] as BoardSide[]).map((side) => {
                const b = boards[side]
                const busy = !!connecting[side]
                return (
                  <div key={side} className="rounded-[12px] bg-white/60 border border-white/95 p-3 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <span className={`w-9 h-9 rounded-[10px] flex items-center justify-center text-white font-black text-[13px] ${side === 'A' ? 'bg-[linear-gradient(135deg,#0891b2,#2563eb)]' : 'bg-[linear-gradient(135deg,#a78bfa,#7c3aed)]'}`}>{side}</span>
                      <div><b className="text-[13px]">{side} {t('板')}</b><div className="font-mono text-[9.5px] text-slate-400">{conns[side].ip} : {conns[side].port}</div></div>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10.5px] text-slate-500">
                      <span className={`led ${b.is_connected ? 'on' : ''}`} />
                      {b.is_connected ? t('已连接') : t('未连接')}
                      <span className="ml-auto font-mono text-slate-400">{t('心跳')} {b.last_pong || '--'}</span>
                    </div>
                    <div className="flex gap-1.5">
                      <input value={conns[side].ip} onChange={(e) => setBoardIp(side, e.target.value)} disabled={b.is_connected} placeholder="192.168.8.88" className="ui-input flex-1 !py-1.5 !text-[11px]" />
                      <input value={conns[side].port} onChange={(e) => setBoardPort(side, e.target.value)} disabled={b.is_connected} placeholder="10001" className="ui-input w-16 !py-1.5 text-center !text-[11px]" />
                    </div>
                    {b.is_connected ? (
                      <button onClick={() => actions.disconnect(side).catch(() => {})} className="glass-btn danger !h-9 justify-center">{t('断开')}</button>
                    ) : (
                      <button onClick={() => handleConnect(side)} disabled={busy} className="glass-btn primary !h-9 justify-center">{busy ? t('连接中...') : t('连接') + ' ' + side}</button>
                    )}
                  </div>
                )
              })}
              <div className="rounded-[12px] bg-white/60 border border-white/95 p-3 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="w-9 h-9 rounded-[10px] flex items-center justify-center bg-[linear-gradient(135deg,#38bdf8,#0891b2)]">
                    <span className="material-symbols-outlined text-white text-[18px]">bluetooth</span>
                  </span>
                  <div><b className="text-[13px]">{t('蓝牙模块')}</b><div className="text-[9.5px] text-slate-400">{connectedModules}/5 {t('已连接')}</div></div>
                </div>
                <div className="flex items-center gap-1.5 text-[10.5px] text-slate-500">
                  <span className={`led ${connectedModules > 0 ? 'on' : ''}`} />
                  {t('力值 / 倾角 / 转向力 / 二路开关')}
                </div>
                <button onClick={() => setForceOpen(true)} className="glass-btn primary !h-9 justify-center">{t('蓝牙模块联结')}</button>
                <button onClick={() => setForceOpen(true)} className="glass-btn !h-9 justify-center">{t('详细设置')}</button>
              </div>
            </div>
            <div className="flex items-center gap-2 px-5 py-3 border-t border-[rgba(15,80,120,.08)]">
              <button onClick={() => setGuideOpen(false)} className="glass-btn !h-9">{t('跳过')}</button>
              <div className="flex-1" />
              <button onClick={() => setGuideOpen(false)} className="glass-btn primary !h-9 !px-6">{t('进入系统')}</button>
            </div>
          </div>
        </div>
      )}

      <ForceModal open={forceOpen} onClose={() => setForceOpen(false)} />
      <UpdateNotification />
    </div>
  )
}
