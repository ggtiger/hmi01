#!/usr/bin/env node
/**
 * 生成并发布 server 全量包 + Windows x64 文件级增量包，并更新 latest.json。
 *
 * 用法：
 *   node scripts/publish-server-update.mjs --mode full --tag v0.2.0
 *   node scripts/publish-server-update.mjs --mode server
 *
 * 环境变量：
 *   GH_TOKEN / GITHUB_TOKEN    GitHub token（contents: write）
 *   GITHUB_REPOSITORY          owner/repo
 *
 * full   : 当前 tag 的 Windows 全量安装包已由 tauri-action 创建（draft）
 * server : 只发布 server 更新到最近一个已发布的 v* 应用 Release
 *
 * 依赖：node 22、git、gh、tar（GitHub Windows runner 自带）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_DIR = path.join(ROOT, 'src-tauri', 'server')
const DIST_DIR = path.join(ROOT, 'dist')
const PLATFORM = 'windows-x86_64'
const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm'
// Windows Git Bash 的 GNU tar 会把 D:\... 误判为远程主机，必须强制本地路径
const TAR_FLAGS = process.platform === 'win32' ? ['--force-local'] : []
const MAX_DELTAS = 3
const MAX_RELEASES_TO_SCAN = 10
const PATCH_RATIO_LIMIT = 0.8
const FORCE_MANIFESTS = [
  '.next/routes-manifest.json',
  '.next/build-manifest.json',
  '.next/app-build-manifest.json',
  '.next/server/middleware-manifest.json',
  '.next/server/app-paths-manifest.json',
  '.next/prerender-manifest.json',
]

function parseArgs() {
  const out = { mode: 'full', tag: '' }
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) out.mode = args[++i]
    else if (args[i] === '--tag' && args[i + 1]) out.tag = args[++i]
  }
  if (!['full', 'server'].includes(out.mode)) {
    throw new Error('--mode 仅支持 full / server')
  }
  return out
}

function run(cmd, args, opts = {}) {
  const proc = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
  })
  if (proc.error) throw new Error(`${cmd} 执行失败: ${proc.error.message}`)
  if (proc.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} 失败 (${proc.status}): ${(proc.stderr || '').slice(-1200)}`)
  }
  return proc
}

function gh(args, opts = {}) {
  return run('gh', args, opts)
}

function ghJson(args) {
  const proc = gh(args)
  return JSON.parse(proc.stdout)
}

function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(1024 * 1024)
  try {
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function semverParts(v) {
  return v.split(/[.-]/).slice(0, 3).map((x) => Number(x) || 0)
}

function compareSemver(a, b) {
  const pa = semverParts(a)
  const pb = semverParts(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

function walkFiles(root, rel = '') {
  const dir = rel ? path.join(root, rel) : root
  const result = []
  if (!fs.existsSync(dir)) return result
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    const full = path.join(root, childRel)
    if (entry.isDirectory()) {
      result.push(...walkFiles(root, childRel))
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      result.push(childRel)
    }
  }
  return result.sort()
}

function hashOf(root, rel) {
  const full = path.join(root, rel)
  const stat = fs.lstatSync(full)
  if (stat.isSymbolicLink()) {
    return crypto.createHash('sha256').update(`link:${fs.readlinkSync(full)}`).digest('hex')
  }
  return sha256File(full)
}

function copyInto(srcRoot, rel, destRoot) {
  const src = path.join(srcRoot, rel)
  const dest = path.join(destRoot, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
}

function collectManifestAssets(file) {
  if (!fs.existsSync(file)) return []
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const found = new Set()
    const walk = (v) => {
      if (typeof v === 'string') {
        if (v.startsWith('static/')) found.add(v)
      } else if (Array.isArray(v)) {
        v.forEach(walk)
      } else if (v && typeof v === 'object') {
        Object.values(v).forEach(walk)
      }
    }
    walk(data)
    return [...found]
  } catch {
    return []
  }
}

function tarCreate(out, dir) {
  fs.mkdirSync(path.dirname(out), { recursive: true })
  try { fs.rmSync(out, { force: true }) } catch { /* ignore */ }
  run('tar', [...TAR_FLAGS, '-czf', out, '-C', dir, '.'])
}

function tarExtract(file, dest) {
  fs.mkdirSync(dest, { recursive: true })
  run('tar', [...TAR_FLAGS, '-xzf', file, '-C', dest])
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

function makePatch(oldRoot, newRoot, oldVersion, newVersion, fullSize, patchFile) {
  const oldFiles = new Set(walkFiles(oldRoot))
  const newFiles = walkFiles(newRoot)
  const modified = new Set()
  const added = new Set()
  const deleted = []

  for (const rel of newFiles) {
    if (rel === '__manifest.json') continue
    if (!oldFiles.has(rel)) {
      added.add(rel)
    } else if (hashOf(oldRoot, rel) !== hashOf(newRoot, rel)) {
      modified.add(rel)
    }
  }
  for (const rel of oldFiles) {
    if (rel !== '__manifest.json' && !newFiles.includes(rel)) deleted.push(rel)
  }

  for (const manifest of FORCE_MANIFESTS) {
    if (fs.existsSync(path.join(newRoot, manifest)) && !modified.has(manifest) && !added.has(manifest)) {
      modified.add(manifest)
    }
  }

  // Next 的静态 chunk 哈希在不同平台/构建机上可能变化，强制把 manifest 引用到的 static 文件带上
  for (const manifest of ['.next/build-manifest.json', '.next/app-build-manifest.json']) {
    for (const asset of collectManifestAssets(path.join(newRoot, manifest))) {
      const rel = `.next/${asset}`
      if (fs.existsSync(path.join(newRoot, rel)) && !modified.has(rel) && !added.has(rel)) {
        modified.add(rel)
      }
    }
  }

  if (modified.size === 0 && added.size === 0 && deleted.length === 0) {
    return null
  }

  const patchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdesin-patch-'))
  try {
    for (const rel of [...added, ...modified]) copyInto(newRoot, rel, patchDir)
    const manifest = {
      from: oldVersion,
      to: newVersion,
      modified: [...modified].sort(),
      added: [...added].sort(),
      deleted: deleted.sort(),
    }
    fs.writeFileSync(path.join(patchDir, '__manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    tarCreate(patchFile, patchDir)
  } finally {
    fs.rmSync(patchDir, { recursive: true, force: true })
  }

  const size = fs.statSync(patchFile).size
  if (size > fullSize * PATCH_RATIO_LIMIT) {
    fs.rmSync(patchFile, { force: true })
    console.log(`[release] ${path.basename(patchFile)} 超过全量包 80%（${formatBytes(size)}），跳过`)
    return null
  }
  return {
    size,
    hash: sha256File(patchFile),
    modified: modified.size,
    added: added.size,
    deleted: deleted.length,
  }
}

function listReleaseServerAssets(repo) {
  const releases = ghJson(['release', 'list', '--repo', repo, '--limit', '100', '--json', 'tagName,isDraft,createdAt'])
  return releases
    .filter((r) => !r.isDraft && /^v\d+\.\d+\.\d+$/.test(r.tagName))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
}

function findLatestAppRelease(repo) {
  const release = listReleaseServerAssets(repo)[0]
  if (!release) throw new Error('没有找到已发布的 v* Windows 应用 Release')
  return release.tagName
}

function downloadOldServerTars(repo, releases, currentVersion, tmpRoot) {
  const candidates = new Map()
  for (const rel of releases.slice(0, MAX_RELEASES_TO_SCAN)) {
    const dir = path.join(tmpRoot, `old-${rel.tagName.replace(/[^0-9A-Za-z.-]/g, '_')}`)
    fs.mkdirSync(dir, { recursive: true })
    const proc = gh(
      ['release', 'download', rel.tagName, '--repo', repo, '--pattern', 'server-*.tar.gz', '--dir', dir, '--clobber'],
      { allowFail: true }
    )
    if (proc.status !== 0) continue
    for (const name of fs.readdirSync(dir)) {
      const m = /^server-(\d+\.\d+\.\d+)\.tar\.gz$/.exec(name)
      if (!m) continue
      const version = m[1]
      if (compareSemver(version, currentVersion) >= 0) continue
      if (!candidates.has(version)) {
        candidates.set(version, { version, file: path.join(dir, name), tag: rel.tagName })
      }
    }
  }
  return [...candidates.values()]
    .sort((a, b) => compareSemver(b.version, a.version))
    .slice(0, MAX_DELTAS)
}

async function main() {
  const { mode, tag } = parseArgs()
  const repo = process.env.GITHUB_REPOSITORY || ''
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY 缺失（owner/repo）')
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) throw new Error('缺少 GH_TOKEN / GITHUB_TOKEN')
  if (!fs.existsSync(path.join(SERVER_DIR, 'package.json'))) {
    console.log('[release] server bundle 不存在，重新执行 npm run tauri:bundle...')
    run(NPM_CMD, ['run', 'tauri:bundle'], { inherit: true })
  }
  if (!fs.existsSync(path.join(SERVER_DIR, 'package.json'))) {
    throw new Error(`server bundle 不存在: ${SERVER_DIR}，请先运行 npm run tauri:bundle`)
  }

  const version = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'package.json'), 'utf8')).version
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) throw new Error(`server 版本无效: ${version}`)

  const uploadTag = mode === 'full'
    ? tag || process.env.GITHUB_REF_NAME
    : findLatestAppRelease(repo)
  if (!uploadTag) throw new Error('full 模式必须提供 --tag 或 GITHUB_REF_NAME')

  console.log(`[release] mode=${mode}, server=${version}, uploadTag=${uploadTag}, repo=${repo}`)

  fs.mkdirSync(DIST_DIR, { recursive: true })
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xdesin-server-release-'))
  const serverTarName = `server-${version}.tar.gz`
  const serverTar = path.join(DIST_DIR, serverTarName)
  tarCreate(serverTar, SERVER_DIR)
  const serverSize = fs.statSync(serverTar).size
  const serverHash = sha256File(serverTar)
  console.log(`[release] 全量 server 包: ${serverTarName} (${formatBytes(serverSize)})`)

  const releases = listReleaseServerAssets(repo)
  const oldTars = downloadOldServerTars(repo, releases, version, tmpRoot)
  console.log(`[release] 可用于增量的旧版本: ${oldTars.map((x) => x.version).join(', ') || '无'}`)

  const deltas = []
  for (const old of oldTars) {
    const oldRoot = path.join(tmpRoot, `old-server-${old.version}`)
    tarExtract(old.file, oldRoot)
    const patchName = `server-patch-${old.version}-${version}.tar.gz`
    const patchFile = path.join(DIST_DIR, patchName)
    const result = makePatch(oldRoot, SERVER_DIR, old.version, version, serverSize, patchFile)
    if (!result) {
      console.log(`[release] ${old.version} -> ${version} 无有效差异，跳过`)
      continue
    }
    const url = `https://github.com/${repo}/releases/download/${uploadTag}/${patchName}`
    deltas.push({ from: old.version, url, size: result.size, hash: `sha256:${result.hash}` })
    console.log(
      `[release] 增量 ${old.version} -> ${version}: ${patchName} (${formatBytes(result.size)}, ` +
      `modified=${result.modified}, added=${result.added}, deleted=${result.deleted})`
    )
  }

  // 下载 tauri-action 生成的 latest.json（保留平台签名信息），注入 server 字段
  const latestDir = path.join(tmpRoot, 'latest')
  fs.mkdirSync(latestDir, { recursive: true })
  let latestOk = false
  for (let attempt = 1; attempt <= 5; attempt++) {
    const proc = gh(
      ['release', 'download', uploadTag, '--repo', repo, '--pattern', 'latest.json', '--dir', latestDir, '--clobber'],
      { allowFail: true }
    )
    if (proc.status === 0 && fs.existsSync(path.join(latestDir, 'latest.json'))) {
      latestOk = true
      break
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  if (!latestOk) throw new Error(`无法从 ${uploadTag} 下载 latest.json（Tauri 构建是否成功？）`)

  const latestFile = path.join(latestDir, 'latest.json')
  const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'))
  const fullUrl = `https://github.com/${repo}/releases/download/${uploadTag}/${serverTarName}`
  const notes = (run('git', ['log', '-20', '--pretty=format:- %s']).stdout || '').trim().slice(0, 8000) || `server ${version}`
  latest.serverVersion = version
  latest.notes = notes
  latest.serverFullUrl = {
    url: fullUrl,
    size: serverSize,
    hash: `sha256:${serverHash}`,
  }
  latest.serverDeltas = {
    [PLATFORM]: deltas,
  }
  fs.writeFileSync(latestFile, JSON.stringify(latest, null, 2) + '\n')
  console.log(`[release] latest.json: serverVersion=${version}, deltas=${deltas.length}`)

  const assets = [serverTar, ...deltas.map((d) => path.join(DIST_DIR, d.url.split('/').pop())), latestFile]
  gh(['release', 'upload', uploadTag, ...assets, '--repo', repo, '--clobber'])
  console.log(`[release] 已上传 ${assets.length} 个 server 资产到 ${uploadTag}`)

  fs.rmSync(tmpRoot, { recursive: true, force: true })
  console.log('[release] 完成')
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[release] 失败:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}

export { makePatch, tarCreate, tarExtract, walkFiles, hashOf }
