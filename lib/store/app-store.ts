import { create } from 'zustand'
import { loadConfig } from '../config'
import type { BoardSide } from '../comm/types'

export interface BoardConn {
  ip: string
  port: string
}

interface AppStore {
  /** A/B 双板连接参数（默认下位机 STA 固定 IP） */
  boards: Record<BoardSide, BoardConn>
  setBoardIp: (side: BoardSide, ip: string) => void
  setBoardPort: (side: BoardSide, port: string) => void
  // 兼容旧页面：等价于 A 板
  ip: string
  port: string
  setIp: (ip: string) => void
  setPort: (port: string) => void
  initFromConfig: () => Promise<void>
}

const DEFAULT_BOARDS: Record<BoardSide, BoardConn> = {
  A: { ip: '192.168.8.88', port: '10001' },
  B: { ip: '192.168.8.89', port: '10001' },
}

export const useAppStore = create<AppStore>((set, get) => ({
  boards: { A: { ...DEFAULT_BOARDS.A }, B: { ...DEFAULT_BOARDS.B } },
  ip: DEFAULT_BOARDS.A.ip,
  port: DEFAULT_BOARDS.A.port,

  setBoardIp: (side, ip) =>
    set((s) => ({
      boards: { ...s.boards, [side]: { ...s.boards[side], ip } },
      ...(side === 'A' ? { ip } : {}),
    })),
  setBoardPort: (side, port) =>
    set((s) => ({
      boards: { ...s.boards, [side]: { ...s.boards[side], port } },
      ...(side === 'A' ? { port } : {}),
    })),

  initFromConfig: async () => {
    try {
      const c = await loadConfig()
      const a = { ip: c.device.ip, port: String(c.device.port) }
      set({ boards: { ...get().boards, A: a }, ip: a.ip, port: a.port })
    } catch (err) {
      console.warn('[AppStore] initFromConfig failed:', err)
    }
  },
  // 旧接口：写入 A 板
  setIp: (ip) => get().setBoardIp('A', ip),
  setPort: (port) => get().setBoardPort('A', port),
}))
