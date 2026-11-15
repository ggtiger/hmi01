'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useDevice, useForce } from '@/lib/comm'
import { checkForUpdate, getCurrentServerVersion } from '@/lib/updater'
import { useUpdaterStore, useUserStore } from '@/lib/store'
import { useT } from '@/lib/i18n'

const UPDATE_CDN = 'https://o09u11p5v.qnssl.com/hmi'
const SUPPORT_EMAIL = 'support@xdesin.local'

function InfoTile({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/95 bg-white/55 px-3 py-2">
      <div className="text-[10px] text-slate-400">{label}</div>
      <div
        className={`mt-0.5 truncate text-[13px] font-bold text-[#142639] ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </div>
    </div>
  )
}

/** 关于：产品信息、版本、设备状态与更新入口 */
export default function AboutPage() {
  const t = useT()
  const { state, boards } = useDevice()
  const { states: forceStates } = useForce()
  const currentUser = useUserStore((s) => s.currentUser)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [serverVersion, setServerVersion] = useState('--')
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((version) => {
        if (alive) setAppVersion(version)
      })
      .catch(() => {
        if (alive) setAppVersion(null)
      })

    getCurrentServerVersion()
      .then((version) => {
        if (alive && version && version !== 'unknown') setServerVersion(version)
      })
      .catch(() => {
        /* 非 Tauri 环境保持 -- */
      })

    return () => {
      alive = false
    }
  }, [t])

  const handleCheck = useCallback(async () => {
    setChecking(true)
    setMessage(null)
    try {
      const info = await checkForUpdate()
      if (info) {
        useUpdaterStore.getState().setAvailable(info)
        setMessage(`${t('发现新版本')} v${info.version}，${t('请按右下角提示完成更新')}`)
      } else {
        setMessage(t('当前已是最新版本'))
      }
    } catch (err) {
      setMessage(`${t('检查更新失败')}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setChecking(false)
    }
  }, [t])

  const firmware = state.info?.fw || state.fw_version || '--'
  const deviceId = state.device_id || '--'
  const appVersionLabel = appVersion ? `v${appVersion}` : t('浏览器模式')
  const onlineBoards = (['A', 'B'] as const).filter((side) => boards[side].is_connected).length
  const onlineModules = Object.values(forceStates).filter((st) => st.isConnected).length

  return (
    <div className="h-full flex flex-col gap-3 p-4 overflow-hidden">
      <div className="flex flex-shrink-0 items-center gap-2">
        <h1 className="whitespace-nowrap text-[21px] font-black text-primary">{t('关于')}</h1>
        <span className="rounded-full border border-[#0891b2]/20 bg-[#0891b2]/8 px-2 py-0.5 text-[9px] font-extrabold text-[#0891b2]">
          ABOUT
        </span>
        <span className="ml-auto rounded-full border border-white/90 bg-white/55 px-2.5 py-1 font-mono text-[10px] text-slate-500">
          {appVersionLabel}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] gap-3">
        <section className="flex min-h-0 flex-col rounded-2xl border border-white/95 bg-white/60 p-5 shadow-[0_16px_40px_rgba(31,86,130,.10)]">
          <div className="flex items-center gap-3">
            <img src="/icon.png" alt="" className="h-16 w-16 rounded-[16px] shadow-md" />
            <div className="min-w-0">
              <div className="text-[20px] font-black tracking-tight text-[#0e2133]">
                {t('智能驾驶舱检测系统')}
              </div>
              <div className="mt-0.5 text-[11.5px] text-slate-500">
                {t('机动车角度综合校准装置')}
              </div>
              <div className="mt-1 text-[9.5px] tracking-[2.5px] text-slate-400">
                DUAL-BOARD CONSOLE
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <InfoTile label={t('应用版本')} value={appVersion ? `v${appVersion}` : '--'} />
            <InfoTile label={t('Server 版本')} value={serverVersion} />
            <InfoTile label={t('固件版本')} value={firmware} />
            <InfoTile label={t('设备 ID')} value={deviceId} />
          </div>

          <div className="mt-2 rounded-xl border border-white/95 bg-white/45 px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] text-slate-400">{t('更新源')}</span>
              <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-600">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {t('七牛 CDN')}
              </span>
            </div>
            <div className="mt-1 truncate font-mono text-[10.5px] text-slate-500" title={UPDATE_CDN}>
              {UPDATE_CDN}
            </div>
          </div>

          <div className="mt-4">
            <div className="text-[10px] font-bold tracking-[1.5px] text-slate-400">{t('产品特性')}</div>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              {t('面向机动车踏板 / 转盘综合检测的双板上位机，支持并行测试、蓝牙力值采集与本地记录导出。')}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {['双板并行检测', 'AES-128-CTR 加密', '增量热更新', '本地记录导出'].map((feature) => (
                <span
                  key={feature}
                  className="rounded-full border border-white/95 bg-white/55 px-2.5 py-1 text-[9.5px] font-bold text-slate-500"
                >
                  {t(feature)}
                </span>
              ))}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <InfoTile label={t('通信链路')} value={t('WiFi TCP · Client')} />
            <InfoTile label={t('数据存储')} value={t('本地 SQLite')} />
          </div>

          <div className="mt-auto flex min-h-[42px] flex-wrap items-center gap-3 pt-4">
            <button
              onClick={handleCheck}
              disabled={checking}
              className="glass-btn primary !h-9 !px-4"
            >
              <span className={`material-symbols-outlined text-[17px] ${checking ? 'animate-spin' : ''}`}>
                {checking ? 'progress_activity' : 'system_update'}
              </span>
              {checking ? t('检查中...') : t('检查更新')}
            </button>
            {message && <span className="text-[11px] text-slate-500">{message}</span>}
          </div>
        </section>

        <div className="flex min-h-0 flex-col gap-3">
          <section className="min-h-0 flex-1 rounded-2xl border border-white/95 bg-white/60 p-4 shadow-[0_16px_40px_rgba(31,86,130,.10)]">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-[#0891b2]">monitor_heart</span>
              <h2 className="text-[13px] font-black text-[#142639]">{t('运行状态')}</h2>
              <span className="ml-auto text-[10px] text-slate-400">
                {onlineBoards}/2 {t('板在线')} · {onlineModules}/5 {t('模块')}
              </span>
            </div>

            <div className="mt-3 space-y-2">
              {(['A', 'B'] as const).map((side) => {
                const board = boards[side]
                return (
                  <div
                    key={side}
                    className="flex items-center gap-2 rounded-xl border border-white/95 bg-white/55 px-3 py-2"
                  >
                    <span
                      className={`h-2 w-2 rounded-full ${board.is_connected ? 'bg-emerald-500' : 'bg-slate-300'}`}
                    />
                    <b className="text-[12px] text-[#142639]">{side} {t('板')}</b>
                    <span className={`text-[10.5px] ${board.is_connected ? 'text-emerald-600' : 'text-slate-400'}`}>
                      {board.is_connected ? t('在线') : t('离线')}
                    </span>
                    <span className="ml-auto font-mono text-[9.5px] text-slate-400">
                      {board.last_pong || '--'}
                    </span>
                  </div>
                )
              })}
            </div>

            <div className="mt-3 rounded-xl border border-white/95 bg-white/45 px-3 py-2">
              <div className="flex items-center justify-between text-[10.5px]">
                <span className="text-slate-400">{t('通信协议')}</span>
                <span className="font-mono text-slate-600">AES-128-CTR · HMAC-MD5</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[10.5px]">
                <span className="text-slate-400">{t('心跳')}</span>
                <span className="font-mono text-slate-600">5s · 15s</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[10.5px]">
                <span className="text-slate-400">{t('蓝牙模块')}</span>
                <span className="font-mono text-slate-600">{onlineModules}/5</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[10.5px]">
                <span className="text-slate-400">{t('当前用户')}</span>
                <span className="text-slate-600">
                  {currentUser ? `${currentUser.username} · ${currentUser.role}` : '--'}
                </span>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-white/95 bg-white/60 p-4 shadow-[0_16px_40px_rgba(31,86,130,.10)]">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-[#0891b2]">support_agent</span>
              <h2 className="text-[13px] font-black text-[#142639]">{t('帮助与支持')}</h2>
            </div>
            <div className="mt-2 space-y-1.5 text-[10.5px]">
              <div className="flex justify-between gap-3">
                <span className="text-slate-400">{t('技术支持')}</span>
                <span className="truncate font-mono text-slate-600" title={SUPPORT_EMAIL}>
                  {SUPPORT_EMAIL}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-slate-400">{t('运行平台')}</span>
                <span className="text-slate-600">Tauri · Next.js 15</span>
              </div>
            </div>
            {currentUser?.perms.includes('help') && (
              <Link
                href="/help"
                className="mt-3 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-[rgba(8,145,178,.22)] bg-white/60 text-[11px] font-bold text-[#0891b2] hover:bg-white"
              >
                <span className="material-symbols-outlined text-[16px]">menu_book</span>
                {t('查看操作指引')}
              </Link>
            )}
          </section>
        </div>
      </div>

      <div className="flex flex-shrink-0 items-center justify-between px-1 text-[9.5px] text-slate-400">
        <span>© 2026 {t('智能驾驶舱检测系统')}</span>
        <span>{t('保留所有权利')} · DUAL-BOARD CONSOLE</span>
      </div>
    </div>
  )
}
