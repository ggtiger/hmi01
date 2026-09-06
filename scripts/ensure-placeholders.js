#!/usr/bin/env node
/**
 * ensure-placeholders.js
 *
 * dev 模式下确保 src-tauri/server/ 占位资源存在：
 * tauri.conf.json 的 bundle.resources 引用了这些路径，
 * cargo 构建脚本（tauri-build）在 dev 编译时也会做资源存在性校验。
 * 真实 server 产物由 scripts/bundle-sidecar.js 在 tauri build 前生成。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const SERVER_DIR = path.join(__dirname, '..', 'src-tauri', 'server')
const FRONTEND_DIR = path.join(__dirname, '..', 'src-tauri', 'frontend')

function ensureFile(filePath, content) {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content)
    console.log('[ensure-placeholders] created:', path.relative(process.cwd(), filePath))
  }
}

const isPlaceholder = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').includes('placeholder')
  } catch {
    return false
  }
}

const serverJs = path.join(SERVER_DIR, 'server.js')
const pkgJson = path.join(SERVER_DIR, 'package.json')

// 已有真实 bundle（bundle-sidecar 产物）则不覆盖
if (fs.existsSync(serverJs) && !isPlaceholder(serverJs)) {
  console.log('[ensure-placeholders] real server bundle exists, skip')
  process.exit(0)
}

ensureFile(serverJs, '// placeholder — real server bundled by scripts/bundle-sidecar.js\n')
ensureFile(pkgJson, '{"name":"xdesin-hmi-server","private":true}\n')
for (const dir of ['.next', 'node_modules', 'public']) {
  ensureFile(path.join(SERVER_DIR, dir, 'placeholder'), 'placeholder\n')
}
ensureFile(path.join(FRONTEND_DIR, 'index.html'), '<!DOCTYPE html>\n<html><body>Loading...</body></html>\n')
console.log('[ensure-placeholders] done')
