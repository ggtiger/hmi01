/**
 * 多 Sheet Excel 导出工具（SheetJS）
 *
 * - Tauri 桌面：系统保存对话框选路径 → invoke save_file_content 写盘
 * - 浏览器：触发普通下载
 */

import { isTauri } from './tauri'

export interface SheetSpec {
  /** Sheet 名称 */
  name: string
  /** 二维表数据（首行为表头）；null 显示为 "--" */
  rows: (string | number | null)[][]
}

/** 生成多 Sheet Excel 并保存；用户取消返回 false */
export async function exportWorkbook(filename: string, sheets: SheetSpec[]): Promise<boolean> {
  // 动态加载，避免 xlsx 进入首屏 bundle
  const XLSX = await import('xlsx')

  const wb = XLSX.utils.book_new()
  for (const sheet of sheets) {
    const aoa = sheet.rows.map((row) => row.map((v) => (v === null ? '--' : v)))
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    XLSX.utils.book_append_sheet(wb, ws, sheet.name)
  }

  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({
      defaultPath: filename,
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    })
    if (!path) return false
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('save_file_content', {
      path,
      content: Array.from(new Uint8Array(buf)),
    })
    return true
  }

  XLSX.writeFile(wb, filename)
  return true
}
