'use client'

import { create } from 'zustand'
import { useCallback, useEffect } from 'react'
import { EN } from './messages'

export type Locale = 'zh' | 'en'

const STORAGE_KEY = 'xdesin-locale'

interface I18nState {
  locale: Locale
  hydrated: boolean
  setLocale: (locale: Locale) => void
  hydrate: () => void
}

export const useI18nStore = create<I18nState>((set, get) => ({
  locale: 'zh',
  hydrated: false,
  setLocale: (locale) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, locale)
    } catch {
      // localStorage 不可用时仅本次会话生效
    }
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN'
      document.title = translate(locale, '智能驾驶舱检测系统')
    }
    set({ locale })
  },
  hydrate: () => {
    if (get().hydrated) return
    let locale: Locale = 'zh'
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY)
      if (saved === 'en' || saved === 'zh') locale = saved
    } catch {
      // 忽略
    }
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN'
      document.title = translate(locale, '智能驾驶舱检测系统')
    }
    set({ locale, hydrated: true })
  },
}))

/** 中文原文直接显示；英文模式查词典，缺词回退中文 */
export function translate(locale: Locale, zh: string): string {
  if (locale === 'zh') return zh
  return EN[zh] ?? zh
}

/** 组件内使用：const t = useT(); t('开始测试') */
export function useT() {
  const locale = useI18nStore((s) => s.locale)
  return useCallback((zh: string) => translate(locale, zh), [locale])
}

/** 应用启动时从 localStorage 恢复语言（放在布局中挂载一次） */
export function useLocaleHydration() {
  const hydrate = useI18nStore((s) => s.hydrate)
  useEffect(() => {
    hydrate()
  }, [hydrate])
}
