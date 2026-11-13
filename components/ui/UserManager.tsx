'use client'

import { useState } from 'react'
import IndustrialCard from './IndustrialCard'
import Button from './Button'
import {
  useUserStore,
  ALL_PERMISSIONS,
  PERMISSION_LABELS,
  type AppUser,
  type Permission,
  type UserRole,
} from '@/lib/store'
import { useT } from '@/lib/i18n'

const ROLES: UserRole[] = ['管理员', '操作员', '调试员', '计量员']

interface EditorState {
  id: string | null
  username: string
  password: string
  role: UserRole
  perms: Permission[]
}

const EMPTY_EDITOR: EditorState = {
  id: null,
  username: '',
  password: '',
  role: '操作员',
  perms: ['pedal', 'steer', 'records', 'help'],
}

/** 设置页用户管理：用户名、密码、角色、功能权限 */
export default function UserManager() {
  const t = useT()
  const users = useUserStore((s) => s.users)
  const currentUser = useUserStore((s) => s.currentUser)
  const addUser = useUserStore((s) => s.addUser)
  const updateUser = useUserStore((s) => s.updateUser)
  const deleteUser = useUserStore((s) => s.deleteUser)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isAdmin = currentUser?.role === '管理员'

  const openEdit = (u: AppUser | null) => {
    if (!isAdmin) return
    setError(null)
    setEditor(
      u
        ? { id: u.id, username: u.username, password: u.password, role: u.role, perms: [...u.perms] }
        : { ...EMPTY_EDITOR, perms: [...EMPTY_EDITOR.perms] }
    )
  }

  const togglePerm = (perm: Permission) => {
    setEditor((p) => {
      if (!p) return p
      return {
        ...p,
        perms: p.perms.includes(perm)
          ? p.perms.filter((x) => x !== perm)
          : [...p.perms, perm],
      }
    })
  }

  const save = () => {
    if (!editor) return
    if (!editor.username.trim() || !editor.password) {
      setError(t('用户名和密码不能为空'))
      return
    }
    if (editor.perms.length === 0) {
      setError(t('至少选择一项可用功能'))
      return
    }
    const payload = {
      username: editor.username.trim(),
      password: editor.password,
      role: editor.role,
      perms: editor.perms,
    }
    const res = editor.id
      ? updateUser(editor.id, payload)
      : addUser(payload)
    if (!res.ok) {
      setError(t(res.error ?? '保存失败'))
      return
    }
    setEditor(null)
  }

  const remove = (u: AppUser) => {
    const res = deleteUser(u.id)
    if (!res.ok) setError(t(res.error ?? '删除失败'))
  }

  return (
    <>
      <IndustrialCard
        title={t('用户管理')}
        headerRight={
          isAdmin ? (
            <Button variant="ghost" onClick={() => openEdit(null)} className="!py-1.5">
              {t('新增用户')}
            </Button>
          ) : undefined
        }
      >
        <div className="p-3 space-y-2">
          {users.map((u) => (
            <div
              key={u.id}
              className="flex items-center gap-2.5 rounded-[10px] border border-surface-variant bg-white/50 px-3 py-2"
            >
              <span className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-[11px] font-black bg-[linear-gradient(135deg,#0891b2,#2563eb)]">
                {u.username.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-label-bold text-[12.5px] text-on-surface">
                  {u.username}
                  {currentUser?.id === u.id && (
                    <span className="ml-1.5 text-[10px] text-[#0891b2]">{t('当前用户')}</span>
                  )}
                </div>
                <div className="font-label-sm text-outline">{t(u.role)}</div>
              </div>
              <div className="hidden xl:flex flex-wrap gap-1 max-w-[210px]">
                {u.perms.length === ALL_PERMISSIONS.length ? (
                  <span className="font-label-sm px-1.5 py-0.5 rounded-full bg-[#0891b2]/10 text-[#0891b2]">
                    {t('全部功能')}
                  </span>
                ) : (
                  u.perms.map((p) => (
                    <span
                      key={p}
                      className="font-label-sm px-1.5 py-0.5 rounded-full bg-[#0891b2]/10 text-[#0891b2]"
                    >
                      {t(PERMISSION_LABELS[p])}
                    </span>
                  ))
                )}
              </div>
              {isAdmin && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => openEdit(u)}
                    className="font-label-sm text-primary hover:underline px-1"
                  >
                    {t('编辑')}
                  </button>
                  {currentUser?.id !== u.id && (
                    <button
                      onClick={() => remove(u)}
                      className="font-label-sm text-critical hover:underline px-1"
                    >
                      {t('删除')}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          <p className="font-label-sm text-outline pt-1">
            {t('用户名 / 密码 / 可用功能均可修改；修改当前登录用户后立即生效。')}
          </p>
        </div>
      </IndustrialCard>

      {editor && (
        <div className="fixed inset-0 z-[220] flex items-center justify-center p-4" onClick={() => setEditor(null)}>
          <div className="absolute inset-0 bg-black/35 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-[520px] rounded-xl bg-white border border-slate-200 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-slate-50">
              <h3 className="font-label-bold text-[15px] text-primary">
                {editor.id ? t('编辑用户') : t('新增用户')}
              </h3>
              <button
                onClick={() => setEditor(null)}
                className="material-symbols-outlined text-slate-400 hover:text-slate-600"
              >
                close
              </button>
            </div>
            <div className="p-5 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="font-label-sm text-slate-500">{t('用户名')}</span>
                  <input
                    value={editor.username}
                    onChange={(e) => setEditor({ ...editor, username: e.target.value })}
                    className="ui-input mt-1 w-full !py-2"
                  />
                </label>
                <label className="block">
                  <span className="font-label-sm text-slate-500">{t('密码')}</span>
                  <input
                    value={editor.password}
                    onChange={(e) => setEditor({ ...editor, password: e.target.value })}
                    className="ui-input mt-1 w-full !py-2"
                  />
                </label>
              </div>
              <label className="block">
                <span className="font-label-sm text-slate-500">{t('角色')}</span>
                <select
                  value={editor.role}
                  onChange={(e) => setEditor({ ...editor, role: e.target.value as UserRole })}
                  className="ui-input mt-1 w-full !py-2"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{t(r)}</option>
                  ))}
                </select>
              </label>
              <div>
                <span className="font-label-sm text-slate-500">{t('可用功能')}</span>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  {ALL_PERMISSIONS.map((p) => (
                    <label
                      key={p}
                      className="flex items-center gap-2 font-label-sm text-slate-600 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={editor.perms.includes(p)}
                        onChange={() => togglePerm(p)}
                        className="accent-[#0891b2]"
                      />
                      {t(PERMISSION_LABELS[p])}
                    </label>
                  ))}
                </div>
              </div>
              {error && <div className="font-label-sm text-red-500">{error}</div>}
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50">
              <Button variant="ghost" onClick={() => setEditor(null)}>{t('取消')}</Button>
              <Button onClick={save}>{t('保存')}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
