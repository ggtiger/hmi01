#!/usr/bin/env node
/**
 * 把 GitHub Release 资产同步到七牛云，并把 latest.json 内的下载地址改写为 CDN 地址。
 *
 * 用法：
 *   node scripts/sync-cdn.mjs --mode full --tag v0.1.1
 *   node scripts/sync-cdn.mjs --mode server --tag v0.1.1
 *   node scripts/sync-cdn.mjs --healthcheck
 *
 * 环境变量：
 *   GH_TOKEN
 *   GITHUB_REPOSITORY
 *   QINIU_ACCESS_KEY
 *   QINIU_SECRET_KEY
 *   QINIU_BUCKET          例如 gjapp（业务/别名 bucket）
 *   QINIU_S3_BUCKET       可选，七牛 S3 API 实际源 bucket；不填则等于 QINIU_BUCKET
 *   QINIU_CDN_BASE        例如 https://o09u11p5v.qnssl.com/hmi
 *   QINIU_S3_ENDPOINT     默认 https://s3.cn-east-1.qiniucs.com
 *   QINIU_S3_REGION       默认 cn-east-1
 *
 * CDN key 结构：
 *   <CDN_BASE 的 path>/releases/<version>/<asset>
 *   <CDN_BASE 的 path>/latest.json
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs() {
  const out = { mode: 'full', tag: '', healthcheck: false }
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) out.mode = args[++i]
    else if (args[i] === '--tag' && args[i + 1]) out.tag = args[++i]
    else if (args[i] === '--healthcheck') out.healthcheck = true
  }
  if (!['full', 'server'].includes(out.mode)) throw new Error('--mode 仅支持 full / server')
  return out
}

function env(name) {
  const v = process.env[name] || ''
  if (!v) throw new Error(`缺少环境变量 ${name}`)
  return v
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

function urlsafeBase64(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest()
}

function awsSigningKey(secretKey, date, region, service) {
  const kDate = hmacSha256(Buffer.from(`AWS4${secretKey}`), date)
  const kRegion = hmacSha256(kDate, region)
  const kService = hmacSha256(kRegion, service)
  return hmacSha256(kService, 'aws4_request')
}

function encodeS3Path(value) {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/')
}

async function uploadS3(file, key, cfg) {
  const body = fs.readFileSync(file)
  const bodyHash = sha256Hex(body)
  const endpoint = new URL(cfg.endpoint)
  const canonicalUri = `/${cfg.bucket}/${encodeS3Path(key)}`
  const host = endpoint.host
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const headers = {
    host,
    'x-amz-content-sha256': bodyHash,
    'x-amz-date': amzDate,
  }
  const sortedKeys = Object.keys(headers).sort()
  const signedHeaders = sortedKeys.join(';')
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join('')
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, bodyHash].join('\n')
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = awsSigningKey(cfg.secretKey, dateStamp, cfg.region, 's3')
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const url = `${cfg.endpoint.replace(/\/+$/, '')}${canonicalUri}`
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      ...headers,
      Authorization: authorization,
      'Content-Type': 'application/octet-stream',
    },
    body,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`S3 上传失败 ${key}: HTTP ${res.status} ${text.slice(0, 500)}`)
  }
  return text
}

function cdnConfig() {
  const base = env('QINIU_CDN_BASE').replace(/\/+$/, '')
  const parsed = new URL(base)
  const keyPrefix = parsed.pathname.replace(/^\/+|\/+$/g, '')
  if (!keyPrefix) throw new Error('QINIU_CDN_BASE 必须包含 key 路径，例如 https://cdn.example.com/hmi')
  return {
    base,
    keyPrefix,
    accessKey: env('QINIU_ACCESS_KEY'),
    secretKey: env('QINIU_SECRET_KEY'),
    bucket: process.env.QINIU_S3_BUCKET || env('QINIU_BUCKET'),
    bucketAlias: env('QINIU_BUCKET'),
    endpoint: (process.env.QINIU_S3_ENDPOINT || 'https://s3.cn-east-1.qiniucs.com').replace(/\/+$/, ''),
    region: process.env.QINIU_S3_REGION || 'cn-east-1',
  }
}

function ghJson(args) {
  const proc = gh(args)
  return JSON.parse(proc.stdout)
}

function findLatestAppRelease(repo) {
  const releases = ghJson([
    'release', 'list', '--repo', repo, '--limit', '100',
    '--json', 'tagName,isDraft,createdAt',
  ])
  const app = releases
    .filter((r) => !r.isDraft && /^v\d+\.\d+\.\d+$/.test(r.tagName))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]
  if (!app) throw new Error('没有找到已发布的 v* 应用 Release，无法确定 server 资产上传目标')
  return app.tagName
}

function assetUrl(base, version, fileName) {
  return `${base}/releases/${encodeURIComponent(version)}/${encodeURIComponent(fileName)}`
}

function cdKey(cfg, version, fileName) {
  return `${cfg.keyPrefix}/releases/${version}/${fileName}`
}

function latestKey(cfg) {
  return `${cfg.keyPrefix}/latest.json`
}

async function healthcheck(cfg) {
  const tmp = path.join(os.tmpdir(), `xdesin-qiniu-${Date.now()}.txt`)
  fs.writeFileSync(tmp, `xdesin-hmi qiniu healthcheck ${new Date().toISOString()}\n`)
  const key = `${cfg.keyPrefix}/.healthcheck`
  try {
    await uploadS3(tmp, key, cfg)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  const url = `${cfg.base}/.healthcheck`
  const res = await fetch(`${url}?t=${Date.now()}`)
  if (!res.ok) throw new Error(`CDN 读取失败 ${url}: HTTP ${res.status}`)
  console.log(`[cdn] healthcheck OK: ${url}`)
}

async function main() {
  const args = parseArgs()
  const cfg = cdnConfig()

  if (args.healthcheck) {
    await healthcheck(cfg)
    return
  }

  const repo = env('GITHUB_REPOSITORY')
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) throw new Error('缺少 GH_TOKEN / GITHUB_TOKEN')
  let tag = args.tag || ''
  if (args.mode === 'server') {
    // server-v* 只是版本 tag，不创建 Release；资产统一上传到最近一个 v* 应用 Release
    if (!tag || /^server-v/.test(tag)) tag = findLatestAppRelease(repo)
  } else if (!tag) {
    tag = process.env.GITHUB_REF_NAME || ''
  }
  if (!tag) throw new Error('缺少 --tag 或 GITHUB_REF_NAME')

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xdesin-cdn-'))
  const assetsDir = path.join(tmpRoot, 'assets')
  fs.mkdirSync(assetsDir, { recursive: true })

  console.log(`[cdn] 下载 Release 资产: ${tag}`)
  if (args.mode === 'full') {
    gh(['release', 'download', tag, '--repo', repo, '--dir', assetsDir, '--clobber'])
  } else {
    gh(['release', 'download', tag, '--repo', repo, '--pattern', 'server-*.tar.gz', '--dir', assetsDir, '--clobber'])
    gh(['release', 'download', tag, '--repo', repo, '--pattern', 'latest.json', '--dir', assetsDir, '--clobber'])
  }

  const latestPath = path.join(assetsDir, 'latest.json')
  if (!fs.existsSync(latestPath)) throw new Error(`latest.json 不存在: ${latestPath}`)
  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'))
  const appVersion = latest.version
  const serverVersion = latest.serverVersion || appVersion
  if (!appVersion || !serverVersion) throw new Error('latest.json 缺少 version/serverVersion')

  const files = fs.readdirSync(assetsDir).filter((f) => f !== 'latest.json')
  let uploaded = 0

  // 全量发布：所有资产放在 app version 目录
  // server-only 发布：只有 server tar / patch 放在 server version 目录
  const assetVersion = args.mode === 'full' ? appVersion : serverVersion
  for (const file of files) {
    const isServerAsset = /^server-(patch-)?\d+\.\d+\.\d+.*\.tar\.gz$/.test(file) || /^server-.*\.tar\.gz$/.test(file)
    if (args.mode === 'server' && !isServerAsset) continue
    const full = path.join(assetsDir, file)
    if (!fs.statSync(full).isFile()) continue
    const key = cdKey(cfg, assetVersion, file)
    await uploadS3(full, key, cfg)
    uploaded += 1
    console.log(`[cdn] 上传 ${file} -> ${key}`)
  }

  // 重写 latest.json 里的所有下载 URL
  const platformVersion = latest.version
  if (latest.platforms && typeof latest.platforms === 'object') {
    for (const entry of Object.values(latest.platforms)) {
      if (!entry || typeof entry !== 'object' || !entry.url) continue
      const fileName = decodeURIComponent(String(entry.url).split('/').pop() || '')
      if (fileName) entry.url = assetUrl(cfg.base, platformVersion, fileName)
    }
  }
  if (latest.serverFullUrl && latest.serverFullUrl.url) {
    const fileName = decodeURIComponent(String(latest.serverFullUrl.url).split('/').pop() || '')
    if (fileName) {
      latest.serverFullUrl.url = assetUrl(cfg.base, serverVersion, fileName)
      delete latest.serverFullUrl.cdnUrl
    }
  }
  if (latest.serverDeltas && typeof latest.serverDeltas === 'object') {
    for (const deltas of Object.values(latest.serverDeltas)) {
      if (!Array.isArray(deltas)) continue
      for (const d of deltas) {
        if (!d || typeof d !== 'object' || !d.url) continue
        const fileName = decodeURIComponent(String(d.url).split('/').pop() || '')
        if (fileName) d.url = assetUrl(cfg.base, serverVersion, fileName)
      }
    }
  }
  fs.writeFileSync(latestPath, JSON.stringify(latest, null, 2) + '\n')

  await uploadS3(latestPath, latestKey(cfg), cfg)
  console.log(`[cdn] 上传 latest.json -> ${latestKey(cfg)}`)
  uploaded += 1

  // GitHub Release 上的 latest.json 也改写成 CDN 地址，作为旧客户端回退清单
  gh(['release', 'upload', tag, latestPath, '--repo', repo, '--clobber'])
  console.log(`[cdn] 已回写 GitHub latest.json: ${tag}`)
  console.log(`[cdn] CDN latest: ${cfg.base}/latest.json`)
  console.log(`[cdn] 完成，上传 ${uploaded} 个文件`)
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[cdn] 失败:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}

export { uploadS3, healthcheck, cdnConfig }
