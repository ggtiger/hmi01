/**
 * Excel 导出工具（ExcelJS）
 *
 * - 多 Sheet 数据导出
 * - 可选在 Sheet 顶部嵌入 Canvas 绘制的曲线图（图片置于数据上方）
 * - Tauri 桌面：系统保存对话框 → invoke save_file_content 写盘
 * - 浏览器：Blob 下载
 */

import { isTauri } from './tauri'

export interface SheetSpec {
  /** Sheet 名称 */
  name: string
  /** 二维表数据（首行为表头）；null 显示为 "--" */
  rows: (string | number | null)[][]
  /** 可选：顶部曲线图（PNG data URL），数据自动下移到图下方 */
  chartImage?: string
}

/** 曲线图高度（px）与对应的 Excel 行数（默认行高 20px） */
const CHART_HEIGHT = 420
const CHART_ROWS = Math.ceil(CHART_HEIGHT / 20) + 3

export interface ChartSeries {
  name: string
  color: string
  values: (number | null)[]
  /** 使用独立缩放（如力值，与角度量级不同） */
  separateScale?: boolean
}

/** Canvas 绘制多曲线 PNG（data URL），用于嵌入 Excel；无数据返回 null */
export function renderLineChartPng(
  labels: string[],
  series: ChartSeries[]
): string | null {
  if (typeof document === 'undefined') return null
  const n = labels.length
  if (n === 0) return null

  const W = 1200
  const H = CHART_HEIGHT
  const pad = { l: 78, r: 92, t: 56, b: 52 }
  const plotW = W - pad.l - pad.r
  const plotH = H - pad.t - pad.b

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)

  // ---- 计算量程 ----
  const rangeOf = (list: ChartSeries[]) => {
    let min = Infinity
    let max = -Infinity
    for (const s of list) {
      for (const v of s.values) {
        if (v === null || Number.isNaN(v)) continue
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 }
    if (Math.abs(max - min) < 1e-9) {
      return { min: min - 1, max: max + 1 }
    }
    const padV = (max - min) * 0.1
    return { min: min - padV, max: max + padV }
  }
  const primary = series.filter((s) => !s.separateScale)
  const secondary = series.filter((s) => s.separateScale)
  const pRange = rangeOf(primary)
  const sRange = rangeOf(secondary)

  const xAt = (i: number) => pad.l + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const yAt = (v: number, r: { min: number; max: number }) =>
    pad.t + plotH - ((v - r.min) / (r.max - r.min)) * plotH
  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2))

  // ---- 网格 + 左右轴刻度 ----
  ctx.font = '18px -apple-system, "PingFang SC", sans-serif'
  ctx.textBaseline = 'middle'
  const GRID = 4
  for (let g = 0; g <= GRID; g++) {
    const y = pad.t + (plotH / GRID) * g
    ctx.strokeStyle = g === GRID ? '#94a3b8' : '#e2e8f0'
    ctx.lineWidth = g === GRID ? 1.5 : 1
    ctx.beginPath()
    ctx.moveTo(pad.l, y)
    ctx.lineTo(pad.l + plotW, y)
    ctx.stroke()

    if (primary.length > 0) {
      const v = pRange.max - ((pRange.max - pRange.min) / GRID) * g
      ctx.fillStyle = '#475569'
      ctx.textAlign = 'right'
      ctx.fillText(fmt(v), pad.l - 10, y)
    }
    if (secondary.length > 0) {
      const v = sRange.max - ((sRange.max - sRange.min) / GRID) * g
      ctx.fillStyle = '#16a34a'
      ctx.textAlign = 'left'
      ctx.fillText(fmt(v), pad.l + plotW + 10, y)
    }
  }

  // ---- X 轴标签（首/中/尾） ----
  ctx.fillStyle = '#64748b'
  ctx.textAlign = 'center'
  const tickIdx = n <= 1 ? [0] : [0, Math.floor(n / 2), n - 1]
  for (const i of tickIdx) {
    ctx.fillText(labels[i], xAt(i), pad.t + plotH + 26)
  }

  // ---- 曲线 ----
  for (const s of series) {
    const r = s.separateScale ? sRange : pRange
    ctx.strokeStyle = s.color
    ctx.lineWidth = 2.5
    ctx.lineJoin = 'round'
    ctx.beginPath()
    let started = false
    for (let i = 0; i < n; i++) {
      const v = s.values[i]
      if (v === null || Number.isNaN(v)) {
        started = false
        continue
      }
      const x = xAt(i)
      const y = yAt(v, r)
      if (!started) {
        ctx.moveTo(x, y)
        started = true
      } else {
        ctx.lineTo(x, y)
      }
    }
    ctx.stroke()
  }

  // ---- 标题 + 图例 ----
  ctx.fillStyle = '#041627'
  ctx.font = 'bold 20px -apple-system, "PingFang SC", sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('实时曲线', pad.l, 28)

  ctx.font = '18px -apple-system, "PingFang SC", sans-serif'
  let lx = pad.l + 120
  for (const s of series) {
    ctx.fillStyle = s.color
    ctx.fillRect(lx, 19, 26, 4)
    ctx.fillStyle = '#334155'
    ctx.textAlign = 'left'
    ctx.fillText(s.name, lx + 34, 28)
    lx += 34 + ctx.measureText(s.name).width + 28
  }

  // 右轴单位提示
  if (secondary.length > 0) {
    ctx.fillStyle = '#16a34a'
    ctx.textAlign = 'left'
    ctx.fillText('N', pad.l + plotW + 10, pad.t - 18)
  }

  return canvas.toDataURL('image/png')
}

/** 生成 Excel 并保存；用户取消返回 false */
export async function exportWorkbook(filename: string, sheets: SheetSpec[]): Promise<boolean> {
  // 动态加载，避免进入首屏 bundle
  const mod = await import('exceljs')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExcelJS = ((mod as any).default ?? mod) as typeof import('exceljs')

  const wb = new ExcelJS.Workbook()
  wb.creator = 'XdesinHMI'
  wb.created = new Date()

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name)

    // 曲线图置顶：图片锚定 A1，数据行下移
    if (sheet.chartImage) {
      const imageId = wb.addImage({ base64: sheet.chartImage, extension: 'png' })
      ws.addImage(imageId, {
        tl: { col: 0, row: 0 },
        ext: { width: 1200, height: CHART_HEIGHT },
      })
      for (let i = 0; i < CHART_ROWS; i++) ws.addRow([])
    }

    for (const row of sheet.rows) {
      ws.addRow(row.map((v) => (v === null ? '--' : v)))
    }

    // 基础列宽与表头加粗
    const headerRowNum = sheet.chartImage ? CHART_ROWS + 1 : 1
    ws.getRow(headerRowNum).font = { bold: true }
    const colCount = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0)
    for (let c = 1; c <= colCount; c++) {
      ws.getColumn(c).width = c === 1 ? 10 : 18
    }
  }

  const buffer = (await wb.xlsx.writeBuffer()) as ArrayBuffer
  const bytes = new Uint8Array(buffer)

  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({
      defaultPath: filename,
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    })
    if (!path) return false
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('save_file_content', { path, content: Array.from(bytes) })
    return true
  }

  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  return true
}
