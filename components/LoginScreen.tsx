'use client'

import { useState } from 'react'
import { useUserStore } from '@/lib/store'
import { useI18nStore, useT } from '@/lib/i18n'

/** 登录页：启动动画结束后显示，登录成功进入系统和连接向导 */
export default function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const t = useT()
  const locale = useI18nStore((s) => s.locale)
  const setLocale = useI18nStore((s) => s.setLocale)
  const login = useUserStore((s) => s.login)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password) {
      setError(t('请输入用户名和密码'))
      return
    }
    const res = login(username, password)
    if (!res.ok) {
      setError(t(res.error ?? '用户名或密码错误'))
      return
    }
    setError(null)
    setPassword('')
    onLogin()
  }

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center p-5 bg-[radial-gradient(900px_500px_at_50%_0%,rgba(8,145,178,.16),transparent_62%),rgba(15,40,60,.25)] backdrop-blur-md">
      <div className="absolute right-5 top-5 flex rounded-[10px] overflow-hidden border border-white/80 bg-white/60">
        {(['zh', 'en'] as const).map((l) => (
          <button
            key={l}
            onClick={() => setLocale(l)}
            className={`px-3 py-1.5 text-[12px] font-label-bold ${
              locale === l ? 'bg-[#0891b2] text-white' : 'text-slate-600'
            }`}
          >
            {l === 'zh' ? '简体中文' : 'English'}
          </button>
        ))}
      </div>

      <form
        onSubmit={handleSubmit}
        className="w-[410px] rounded-[18px] border border-white/95 bg-[#f9fdff]/95 p-8 shadow-[0_28px_80px_rgba(15,40,60,.24)] backdrop-blur-2xl"
      >
        <div className="flex flex-col items-center gap-2 mb-6">
          <img src="/icon.png" alt={t('智能驾驶舱检测系统')} className="w-14 h-14 rounded-[14px] shadow-md" />
          <h2 className="text-[17px] font-black text-[#0f2233]">{t('智能驾驶舱检测系统')}</h2>
          <span className="text-[10px] tracking-widest text-slate-400">DUAL-BOARD CONSOLE</span>
        </div>

        <label className="block text-[11px] font-bold text-slate-500 mb-1">{t('用户名')}</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          className="w-full h-11 rounded-lg border border-[rgba(15,80,120,.14)] bg-white/80 px-3 text-[13px] outline-none focus:border-[#0891b2] mb-3"
          placeholder={t('请输入用户名')}
        />
        <label className="block text-[11px] font-bold text-slate-500 mb-1">{t('密码')}</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="w-full h-11 rounded-lg border border-[rgba(15,80,120,.14)] bg-white/80 px-3 text-[13px] outline-none focus:border-[#0891b2]"
          placeholder={t('请输入密码')}
        />
        <div className="min-h-[18px] mt-1 text-[10px] text-red-500">{error ?? ''}</div>
        <button
          type="submit"
          className="w-full h-11 rounded-[10px] text-white text-[14px] font-extrabold bg-[linear-gradient(135deg,#0891b2,#2563eb)] shadow-[0_7px_20px_rgba(8,145,178,.24)]"
        >
          {t('登录')}
        </button>
        <div className="mt-3 rounded-lg border border-dashed border-[rgba(8,145,178,.18)] bg-[rgba(8,145,178,.05)] px-3 py-2 text-[9px] leading-relaxed text-slate-400">
          {t('演示账户：admin / admin123（管理员）· operator / 123456（操作员）· debug / debug123（调试员）')}
        </div>
      </form>
    </div>
  )
}
