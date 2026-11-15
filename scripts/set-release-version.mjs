#!/usr/bin/env node
/**
 * 同步发布版本号。
 *
 * 用法：
 *   node scripts/set-release-version.mjs 0.2.0 app
 *   node scripts/set-release-version.mjs 0.2.1 server
 *
 * app    -> package.json + src-tauri/tauri.conf.json + src-tauri/Cargo.toml
 * server -> package.json（server bundle 版本由 bundle-sidecar 从根版本同步）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = process.argv[2]
const mode = (process.argv[3] || 'app').toLowerCase()

if (!version || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('用法: node scripts/set-release-version.mjs <semver> [app|server]')
  process.exit(1)
}
if (!['app', 'server'].includes(mode)) {
  console.error('模式仅支持 app / server')
  process.exit(1)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
}

const pkgFile = path.join(ROOT, 'package.json')
const pkg = readJson(pkgFile)
pkg.version = version
writeJson(pkgFile, pkg)
console.log(`[release] package.json -> ${version}`)

const lockFile = path.join(ROOT, 'package-lock.json')
if (fs.existsSync(lockFile)) {
  const lock = readJson(lockFile)
  lock.version = version
  if (lock.packages && lock.packages['']) lock.packages[''].version = version
  writeJson(lockFile, lock)
  console.log(`[release] package-lock.json -> ${version}`)
}

if (mode === 'app') {
  const tauriFile = path.join(ROOT, 'src-tauri', 'tauri.conf.json')
  const tauri = readJson(tauriFile)
  tauri.version = version
  writeJson(tauriFile, tauri)
  console.log(`[release] tauri.conf.json -> ${version}`)

  const cargoFile = path.join(ROOT, 'src-tauri', 'Cargo.toml')
  const cargo = fs.readFileSync(cargoFile, 'utf8')
  const updated = cargo.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`)
  if (updated === cargo) {
    console.warn('[release] Cargo.toml 未找到 package version，跳过')
  } else {
    fs.writeFileSync(cargoFile, updated)
    console.log(`[release] Cargo.toml -> ${version}`)
  }

  const cargoLockFile = path.join(ROOT, 'src-tauri', 'Cargo.lock')
  if (fs.existsSync(cargoLockFile)) {
    const lock = fs.readFileSync(cargoLockFile, 'utf8')
    const next = lock.replace(
      /(\[\[package\]\]\nname = "xdesin-hmi"\nversion = ")[^"]+(")/,
      `$1${version}$2`
    )
    if (next !== lock) {
      fs.writeFileSync(cargoLockFile, next)
      console.log(`[release] Cargo.lock -> ${version}`)
    }
  }
}

const serverPkg = path.join(ROOT, 'src-tauri', 'server', 'package.json')
if (fs.existsSync(serverPkg)) {
  const sp = readJson(serverPkg)
  sp.version = version
  writeJson(serverPkg, sp)
  console.log(`[release] src-tauri/server/package.json -> ${version}`)
}

console.log(`[release] 完成（${mode}）`)
