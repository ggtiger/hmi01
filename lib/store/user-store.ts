import { create } from 'zustand'

/** 可授权功能（与左侧导航对应） */
export type Permission = 'debug' | 'pedal' | 'steer' | 'records' | 'settings' | 'help'

export type UserRole = '管理员' | '操作员' | '调试员' | '计量员'

export interface AppUser {
  id: string
  username: string
  password: string
  role: UserRole
  perms: Permission[]
}

export const ALL_PERMISSIONS: Permission[] = [
  'debug', 'pedal', 'steer', 'records', 'settings', 'help',
]

export const PERMISSION_LABELS: Record<Permission, string> = {
  debug: '调试台',
  pedal: '踏板测试',
  steer: '转盘测试',
  records: '数据记录',
  settings: '设置',
  help: '帮助',
}

const USERS_KEY = 'xdesin-users'

/** 首次运行内置账户（本地单机版） */
function defaultUsers(): AppUser[] {
  return [
    { id: 'u-admin', username: 'admin', password: 'admin123', role: '管理员', perms: [...ALL_PERMISSIONS] },
    { id: 'u-operator', username: 'operator', password: '123456', role: '操作员', perms: ['pedal', 'steer', 'records', 'help'] },
    { id: 'u-debug', username: 'debug', password: 'debug123', role: '调试员', perms: ['debug', 'records', 'help'] },
  ]
}

function loadUsers(): AppUser[] {
  if (typeof window === 'undefined') return defaultUsers()
  try {
    const raw = localStorage.getItem(USERS_KEY)
    if (!raw) return defaultUsers()
    const parsed = JSON.parse(raw) as AppUser[]
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : defaultUsers()
  } catch {
    return defaultUsers()
  }
}

function saveUsers(users: AppUser[]) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(USERS_KEY, JSON.stringify(users))
  } catch {
    // 本地存储不可用时仅在本次会话生效
  }
}

interface UserState {
  users: AppUser[]
  currentUser: AppUser | null
  login: (username: string, password: string) => { ok: boolean; error?: string }
  logout: () => void
  addUser: (user: Omit<AppUser, 'id'>) => { ok: boolean; error?: string }
  updateUser: (id: string, patch: Partial<Omit<AppUser, 'id'>>) => { ok: boolean; error?: string }
  deleteUser: (id: string) => { ok: boolean; error?: string }
  can: (perm: Permission) => boolean
}

export const useUserStore = create<UserState>((set, get) => ({
  users: loadUsers(),
  currentUser: null,

  login: (username, password) => {
    const user = get().users.find(
      (u) => u.username.toLowerCase() === username.trim().toLowerCase() && u.password === password
    )
    if (!user) return { ok: false, error: '用户名或密码错误' }
    set({ currentUser: user })
    return { ok: true }
  },

  logout: () => set({ currentUser: null }),

  addUser: (data) => {
    const username = data.username.trim()
    if (!username) return { ok: false, error: '用户名不能为空' }
    if (get().users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      return { ok: false, error: '用户名已存在' }
    }
    const user: AppUser = {
      ...data,
      username,
      id: `u-${Date.now().toString(36)}`,
      perms: [...new Set(data.perms)],
    }
    const users = [...get().users, user]
    saveUsers(users)
    set({ users })
    return { ok: true }
  },

  updateUser: (id, patch) => {
    const current = get().users.find((u) => u.id === id)
    if (!current) return { ok: false, error: '用户不存在' }
    if (patch.username !== undefined) {
      const username = patch.username.trim()
      if (!username) return { ok: false, error: '用户名不能为空' }
      if (get().users.some((u) => u.id !== id && u.username.toLowerCase() === username.toLowerCase())) {
        return { ok: false, error: '用户名已存在' }
      }
      patch = { ...patch, username }
    }
    if (patch.perms) patch = { ...patch, perms: [...new Set(patch.perms)] }
    const users = get().users.map((u) => (u.id === id ? { ...u, ...patch } : u))
    saveUsers(users)
    const currentUser = get().currentUser?.id === id
      ? users.find((u) => u.id === id) ?? null
      : get().currentUser
    set({ users, currentUser })
    return { ok: true }
  },

  deleteUser: (id) => {
    if (get().currentUser?.id === id) return { ok: false, error: '不能删除当前登录用户' }
    const users = get().users.filter((u) => u.id !== id)
    if (users.length === 0) return { ok: false, error: '至少保留一个用户' }
    saveUsers(users)
    set({ users })
    return { ok: true }
  },

  can: (perm) => {
    const u = get().currentUser
    return !!u && u.perms.includes(perm)
  },
}))
