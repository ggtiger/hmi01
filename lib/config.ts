import { isTauri } from './tauri'

// 与 Rust 端 AppConfig 结构对应（camelCase 匹配 serde rename_all）
export interface AppConfig {
  device: {
    ip: string
    port: number
  }
  update: {
    cdnUrl: string
    githubRepo: string
  }
  app: {
    closeToTray: boolean
    theme: string
  }
}

const BUILD_GITHUB_REPO =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_GITHUB_REPO?.trim()) ||
  'ggtiger/hmi01'
const BUILD_CDN_URL =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_UPDATE_CDN_URL?.trim()) ||
  'https://o09u11p5v.qnssl.com/hmi'

export const DEFAULT_CONFIG: AppConfig = {
  device: {
    // 新固件：A 板 STA 固定 IP（B 板 192.168.8.89）
    ip: '192.168.8.88',
    port: 10001,
  },
  update: {
    cdnUrl: BUILD_CDN_URL,
    githubRepo: BUILD_GITHUB_REPO,
  },
  app: {
    closeToTray: false,
    theme: 'light',
  },
}

const STORAGE_KEY = 'xdesinhmi-config'

/**
 * 早期模板遗留的占位更新源。
 * Rust 端旧版本会把它们写入 config.json；即使当前 Next 构建已指向七牛，
 * get_app_config 返回的旧值仍会覆盖 BUILD_CDN_URL，因此在读取时统一纠正。
 */
const LEGACY_CDN_PREFIX = 'https://cdn.example.com'
const LEGACY_GITHUB_REPO = 'xdesin/xdesin-hmi'

function normalizeUpdate(update: Partial<AppConfig['update']> | undefined): AppConfig['update'] {
  const merged = { ...DEFAULT_CONFIG.update, ...update }

  const cdnUrl = (merged.cdnUrl || '').trim().replace(/\/+$/, '')
  merged.cdnUrl =
    !cdnUrl || cdnUrl === LEGACY_CDN_PREFIX || cdnUrl.startsWith(`${LEGACY_CDN_PREFIX}/`)
      ? DEFAULT_CONFIG.update.cdnUrl
      : cdnUrl

  const githubRepo = (merged.githubRepo || '').trim()
  merged.githubRepo =
    !githubRepo || githubRepo.toLowerCase() === LEGACY_GITHUB_REPO
      ? DEFAULT_CONFIG.update.githubRepo
      : githubRepo

  return merged
}

/** 深度合并，确保缺失字段回退到默认值 */
function mergeConfig(partial: Partial<AppConfig>): AppConfig {
  return {
    device: { ...DEFAULT_CONFIG.device, ...partial.device },
    update: normalizeUpdate(partial.update),
    app: { ...DEFAULT_CONFIG.app, ...partial.app },
  }
}

export async function loadConfig(): Promise<AppConfig> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const raw = await invoke<AppConfig>('get_app_config')
      return mergeConfig(raw)
    } catch (err) {
      console.warn('[Config] Failed to load from Tauri:', err)
      return { ...DEFAULT_CONFIG }
    }
  }
  // 非 Tauri 环境 fallback
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return mergeConfig(JSON.parse(stored))
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const normalized = mergeConfig(config)
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('set_app_config', { config: normalized })
    } catch (err) {
      console.warn('[Config] Failed to save to Tauri:', err)
    }
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  }
}
