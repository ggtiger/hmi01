import { create } from 'zustand'
import { loadConfig } from '../config'

interface AppStore {
  // 连接信息
  ip: string
  port: string
  setIp: (ip: string) => void
  setPort: (port: string) => void
  initFromConfig: () => Promise<void>
}

export const useAppStore = create<AppStore>((set) => ({
  ip: '192.168.4.1',
  port: '10001',

  initFromConfig: async () => {
    try {
      const c = await loadConfig()
      set({ ip: c.device.ip, port: String(c.device.port) })
    } catch (err) {
      console.warn('[AppStore] initFromConfig failed:', err)
    }
  },
  setIp: (ip) => set({ ip }),
  setPort: (port) => set({ port }),
}))
