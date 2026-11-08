'use client'

import { useEffect, useState } from 'react'
import IndustrialCard from '@/components/ui/IndustrialCard'
import {
  getAllTestRecords, deleteTestRecord, type TestRecord,
} from '@/lib/db/test-records'

function recordToCsv(records: TestRecord[]): string {
  const lines: string[] = ['#', '时间', '侧', '摘要', '记录点 JSON']
  for (const r of records) {
    lines.push([r.id, r.timestamp, r.side, r.summary, JSON.stringify(r.measureData)].join(','))
  }
  return lines.join('\n')
}

export default function RecordsPage() {
  const [records, setRecords] = useState<TestRecord[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)
  /** 删除二次确认的记录 id（行内确认，避免 Tauri 未授权的 window.confirm） */
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [available, setAvailable] = useState(false)

  const refresh = async () => {
    try {
      setRecords(await getAllTestRecords())
      setAvailable(true)
    } catch {
      setAvailable(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <IndustrialCard
        title="测试数据记录"
        headerRight={
          <div className="flex gap-3">
            <button onClick={refresh} className="font-label-sm text-primary hover:underline">
              刷新
            </button>
            <button
              onClick={() => {
                const blob = new Blob([recordToCsv(records)], { type: 'text/csv;charset=utf-8' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `test-records-${Date.now()}.csv`
                a.click()
                URL.revokeObjectURL(url)
              }}
              disabled={records.length === 0}
              className="font-label-sm text-primary hover:underline disabled:text-outline"
            >
              导出 CSV
            </button>
          </div>
        }
      >
        {!available && (
          <div className="px-4 py-3 font-label-sm text-amber-700 bg-amber-50">
            本地数据库不可用（需在 Tauri 桌面应用中运行）
          </div>
        )}
        <div className="p-4 space-y-3">
          {records.length === 0 && (
            <div className="text-center text-outline py-10 font-label-sm">
              暂无测试记录——在「踏板测试」页完成测试后保存
            </div>
          )}
          {records.map((r) => (
            <div key={r.id} className="rounded-lg border border-surface-variant overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 bg-surface-container-low">
                <div className="flex items-center gap-4">
                  <span className="monospaced-data font-label-bold text-outline">#{r.id}</span>
                  <span className="font-label-bold">{r.timestamp}</span>
                  <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary font-label-bold text-label-sm">
                    {r.side} 侧
                  </span>
                  <span className="font-label-sm text-on-surface-variant">{r.summary}</span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                    className="font-label-sm text-primary hover:underline"
                  >
                    {expanded === r.id ? '收起' : '详情'}
                  </button>
                  {/* 行内二次确认：Tauri WebView 中 window.confirm 未授权 */}
                  {confirmId === r.id ? (
                    <>
                      <span className="font-label-sm text-critical">确认删除？</span>
                      <button
                        onClick={async () => {
                          await deleteTestRecord(r.id)
                          setConfirmId(null)
                          refresh()
                        }}
                        className="font-label-sm font-label-bold text-critical hover:underline"
                      >
                        确认
                      </button>
                      <button
                        onClick={() => setConfirmId(null)}
                        className="font-label-sm text-outline hover:text-primary"
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmId(r.id)}
                      className="material-symbols-outlined text-[18px] text-outline hover:text-critical"
                    >
                      delete
                    </button>
                  )}
                </div>
              </div>
              {expanded === r.id && (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="bg-slate-50 text-left">
                        {['#', '时间', '倾角 X °', '倾角 Y °', '激光 mm', '推杆(脉冲)', '校正角 °'].map((h) => (
                          <th key={h} className="border-b border-slate-200 px-3 py-1.5 font-label-bold text-label-sm text-on-surface-variant">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {r.measureData.map((m) => (
                        <tr key={m.index} className="hover:bg-slate-50">
                          <td className="px-3 py-1 monospaced-data">{m.index}</td>
                          <td className="px-3 py-1 monospaced-data">{m.timestamp}</td>
                          <td className="px-3 py-1 monospaced-data">{m.tilt_x == null ? '--' : m.tilt_x.toFixed(3)}</td>
                          <td className="px-3 py-1 monospaced-data">{m.tilt_y == null ? '--' : m.tilt_y.toFixed(3)}</td>
                          <td className="px-3 py-1 monospaced-data">{m.laser == null ? '--' : m.laser.toFixed(1)}</td>
                          <td className="px-3 py-1 monospaced-data">{m.pedal_pos == null ? '--' : m.pedal_pos.toFixed(0)}</td>
                          <td className="px-3 py-1 monospaced-data">{m.ang_cor == null ? '--' : m.ang_cor.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      </IndustrialCard>
    </div>
  )
}
