#!/usr/bin/env node
/**
 * 生成 CI / 本地 Windows 发布用的 Tauri 配置覆盖文件。
 *
 * 需要环境变量：
 *   GITHUB_REPOSITORY        owner/repo
 *   TAURI_UPDATER_PUBKEY     minisign 公钥（tauri signer generate 的 .pub 内容）
 *
 * 产物：
 *   src-tauri/tauri.release.conf.json
 *
 * Tauri CLI 用 --config 合并该文件；不要把私钥写进仓库。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = (process.env.GITHUB_REPOSITORY || '').trim()
const pubkey = (process.env.TAURI_UPDATER_PUBKEY || '').trim()

if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
  console.error('[release] GITHUB_REPOSITORY 缺失或格式错误（需要 owner/repo）')
  process.exit(1)
}
if (!pubkey || pubkey === 'REPLACE_WITH_MINISIGN_PUBKEY') {
  console.error('[release] TAURI_UPDATER_PUBKEY 缺失；请先运行 tauri signer generate 并配置 GitHub Secret')
  process.exit(1)
}

const config = {
  plugins: {
    updater: {
      pubkey,
      endpoints: [`https://github.com/${repo}/releases/latest/download/latest.json?t={{current_version}}`],
    },
  },
}
const outFile = path.join(ROOT, 'src-tauri', 'tauri.release.conf.json')
fs.writeFileSync(outFile, JSON.stringify(config, null, 2) + '\n')
console.log(`[release] 已生成 ${path.relative(ROOT, outFile)}`)

// CI 中直接写入基础 tauri.conf.json，避免 --config 相对路径/合并行为在不同 Tauri 版本上产生偏差
if (process.env.CI === 'true') {
  const baseFile = path.join(ROOT, 'src-tauri', 'tauri.conf.json')
  const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'))
  base.plugins = base.plugins || {}
  base.plugins.updater = { ...(base.plugins.updater || {}), ...config.plugins.updater }
  fs.writeFileSync(baseFile, JSON.stringify(base, null, 2) + '\n')
  console.log('[release] CI 模式：已将 updater 公钥/端点写入 tauri.conf.json')
}
console.log(`[release] 更新端点: https://github.com/${repo}/releases/latest/download/latest.json`)
