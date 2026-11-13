'use client'

import { useEffect, useState } from 'react'
import {
  getAllTestRecords, deleteTestRecord, type TestRecord,
} from '@/lib/db/test-records'
import { useT, useI18nStore } from '@/lib/i18n'

function recordToCsv(records: TestRecord[], t: (zh: string) => string): string {
  const lines: string[] = ['#', '时间', '侧', '摘要', '记录点 JSON'].map((h) => t(h))
  for (const r of records) {
    lines.push([r.id, r.timestamp, r.side, r.summary, JSON.stringify(r.measureData)].join(','))
  }
  return lines.join('\n')
}

function downloadCsv(name: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** 数据记录（V6 原型）：卡片列表、展开明细、逐条/全部导出 */
export default function RecordsPage() {
  const t = useT()
  const locale = useI18nStore((s) => s.locale)
  const [records, setRecords] = useState<TestRecord[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)
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

  const exportOne = (r: TestRecord) => {
    downloadCsv(`test-record-${r.id}.csv`, recordToCsv([r], t))
  }

  const exportAll = () => {
    downloadCsv(`test-records-${Date.now()}.csv`, recordToCsv(records, t))
  }

  return (
    <div className="h-full flex flex-col gap-2 p-3 overflow-hidden">
      <div className="flex items-center gap-2 flex-shrink-0">
        <h1 className="text-[21px] font-black text-primary whitespace-nowrap">{t('数据记录')}</h1>
        <span className="px-2 py-0.5 rounded-full bg-[#0891b2]/8 border border-[#0891b2]/20 text-[9px] font-extrabold text-[#0891b2]">
          {records.length} {t('条')}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={refresh} className="glass-btn !h-9 !px-3 !text-[12px]">{t('刷新')}</button>
          <button onClick={exportAll} disabled={records.length === 0} className="glass-btn primary !h-9 !px-3 !text-[12px]">
            {t('导出全部')}
          </button>
        </div>
      </div>

      <section className="glass-panel flex-1 min-h-0 flex flex-col">
        <div className="glass-panel-header">
          {t('最近记录')}
          <span className="ml-auto font-label-sm font-normal normal-case tracking-normal text-slate-500">
            {t('按时间倒序')}
          </span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-2">
          {!available && (
            <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-[11px]">
              {t('本地数据库不可用（需在 Tauri 桌面应用中运行）')}
            </div>
          )}
          {records.length === 0 && available && (
            <div className="text-center text-slate-400 text-[11px] py-10">
              {t('暂无测试记录——在「踏板测试」页完成测试后保存')}
            </div>
          )}
          {records.map((r) => {
            const open = expanded === r.id
            return (
              <div key={r.id} className="rounded-[12px] border border-white/95 bg-white/50 overflow-hidden">
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <span className={`w-9 h-9 rounded-[10px] flex items-center justify-center text-white font-black text-[12px] ${
                    r.side === 'A' ? 'bg-[linear-gradient(135deg,#0891b2,#2563eb)]' : 'bg-[linear-gradient(135deg,#a78bfa,#7c3aed)]'
                  }`}>
                    {r.side}
                  </span>
                  <div className="min-w-0 flex-1">
                    <b className="block text-[12.5px] text-slate-800">
                      {locale === 'zh' ? `${r.side} 侧` : r.side} · {r.summary}
                    </b>
                    <span className="block font-mono text-[9.5px] text-slate-400">{r.timestamp}</span>
                  </div>
                  <div className="hidden lg:flex items-center gap-4 text-right">
                    <div>
                      <span className="block text-[9px] text-slate-400">{t('记录点')}</span>
                      <b className="font-mono text-[11px] text-slate-700">{r.measureData.length}</b>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => setExpanded(open ? null : r.id)} className="glass-btn !h-8 !px-3 !text-[11px]">
                      {open ? t('收起') : t('详情')}
                    </button>
                    <button onClick={() => exportOne(r)} className="glass-btn !h-8 !px-3 !text-[11px]">{t('导出')}</button>
                    {confirmId === r.id ? (
                      <>
                        <button
                          onClick={async () => {
                            await deleteTestRecord(r.id)
                            setConfirmId(null)
                            refresh()
                          }}
                          className="h-8 px-2 rounded-md text-[11px] font-bold text-red-600 hover:bg-red-50"
                        >
                          {t('确认')}
                        </button>
                        <button onClick={() => setConfirmId(null)} className="h-8 px-2 rounded-md text-[11px] text-slate-500 hover:bg-white/60">
                          {t('取消')}
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmId(r.id)}
                        className="material-symbols-outlined text-[17px] text-slate-400 hover:text-red-600 px-1"
                      >
                        delete
                      </button>
                    )}
                  </div>
                </div>
                {open && (
                  <div className="border-t border-[rgba(15,80,120,.08)] p-2 overflow-x-auto bg-white/35">
                    <table className="w-full border-collapse text-[10px]">
                      <thead>
                        <tr className="text-left text-slate-400">
                          {['#', '时间', '倾角 X °', '倾角 Y °', '激光 mm', '推杆(脉冲)', '校正角 °'].map((h) => (
                            <th key={h} className="px-2 py-1.5 font-bold border-b border-[rgba(15,80,120,.08)]">{t(h)}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {r.measureData.map((m) => (
                          <tr key={m.index} className="hover:bg-white/60">
                            <td className="px-2 py-1 font-mono">{m.index}</td>
                            <td className="px-2 py-1 font-mono">{m.timestamp}</td>
                            <td className="px-2 py-1 font-mono">{m.tilt_x == null ? '--' : m.tilt_x.toFixed(3)}</td>
                            <td className="px-2 py-1 font-mono">{m.tilt_y == null ? '--' : m.tilt_y.toFixed(3)}</td>
                            <td className="px-2 py-1 font-mono">{m.laser == null ? '--' : m.laser.toFixed(1)}</td>
                            <td className="px-2 py-1 font-mono">{m.pedal_pos == null ? '--' : m.pedal_pos.toFixed(0)}</td>
                            <td className="px-2 py-1 font-mono">{m.ang_cor == null ? '--' : m.ang_cor.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
