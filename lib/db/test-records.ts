import { isTauri } from '@/lib/tauri'
import type { MeasurePoint } from '@/lib/store/pedal-store'

/** 测试记录（SQLite 宽表 + JSON 测量数据） */
export interface TestRecord {
  id: number
  timestamp: string
  side: string
  summary: string           // 摘要（如「A 侧 · 5 个记录点」）
  measureData: MeasurePoint[]
  createdAt: string
}

// 数据库单例
let db: any = null

// 初始化数据库连接 + 建表
export async function initTestDB(): Promise<void> {
  if (!isTauri() || db) return
  const Database = (await import('@tauri-apps/plugin-sql')).default
  db = await Database.load('sqlite:xdesin_records.db')
  await db.execute(`
    CREATE TABLE IF NOT EXISTS test_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      side TEXT NOT NULL,
      summary TEXT NOT NULL,
      measure_data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `)
}

// 保存一条记录
export async function saveTestRecord(record: {
  timestamp: string
  side: string
  summary: string
  measureData: MeasurePoint[]
}): Promise<number | null> {
  if (!db) await initTestDB()
  if (!db) return null
  const result = await db.execute(
    'INSERT INTO test_records (timestamp, side, summary, measure_data) VALUES (?, ?, ?, ?)',
    [record.timestamp, record.side, record.summary, JSON.stringify(record.measureData)]
  )
  return result.lastInsertId ?? null
}

// 获取所有记录（时间倒序）
export async function getAllTestRecords(): Promise<TestRecord[]> {
  if (!db) await initTestDB()
  if (!db) return []
  const rows: any[] = await db.select('SELECT * FROM test_records ORDER BY id DESC')
  return rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    side: row.side,
    summary: row.summary,
    measureData: JSON.parse(row.measure_data),
    createdAt: row.created_at,
  }))
}

// 删除指定记录
export async function deleteTestRecord(id: number): Promise<boolean> {
  if (!db) await initTestDB()
  if (!db) return false
  const result = await db.execute('DELETE FROM test_records WHERE id = ?', [id])
  return result.rowsAffected > 0
}
