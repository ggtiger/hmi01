'use client'

import { useEffect, useRef, useState } from 'react'
import { useDevice } from '@/lib/comm'
import { checkForUpdate } from '@/lib/updater'
import { useUpdaterStore } from '@/lib/store'
import { useT } from '@/lib/i18n'

interface HelpPage {
  title: string
  paragraphs: string[]
  tips?: string[]
}

const HELP_PAGES: HelpPage[] = [
  {
    title: '连接双板',
    paragraphs: [
      '在顶部「连接」中分别连接 A/B 板；默认地址 192.168.8.88:10001 与 192.168.8.89:10001。',
      '板卡 LED 变绿并显示心跳时间，表示连接正常。已连接状态下 IP/端口锁定，需先断开再修改。',
    ],
    tips: ['A/B 独立心跳，15 秒无数据自动标记离线'],
  },
  {
    title: '选择目标板',
    paragraphs: [
      '在踏板/调试页面点击 A 模块 / B 模块切换目标板，所有动作按钮只作用于目标板。',
      '切换目标板时同步对应板的 PEDAL SELECT，避免命令发错侧。',
    ],
    tips: ['急停、总停止类命令会同时下发两块板'],
  },
  {
    title: '调平',
    paragraphs: [
      '在调试台或踏板数据面板点击「开始角度补偿」执行闭环调平；完成后日志显示 DEBUG LEVEL DONE。',
      '目标倾角 X = 0°，进入死区并确认后判定完成，流程自动进入推出步骤。',
    ],
    tips: ['调平过程中手动操作电机会中止自动流程', '故障态下运动命令会被拒绝'],
  },
  {
    title: '推出',
    paragraphs: [
      '先设置推出距离（0–500 mm），再点击「启动加载」。未回原点时固件会自动回零后推出。',
      'STOP 只停止目标板流程，不影响另一侧。',
    ],
    tips: ['推出前请确认安全区域无人'],
  },
  {
    title: '记录与导出',
    paragraphs: [
      '测试完成后在「记录」中查看调平、推杆与测量点数据；记录可展开查看明细。',
      '每条记录和全部记录均可导出，导出内容包含测量点明细与结果。',
    ],
    tips: ['自动流程记录稳定点快照', '趋势仅在测试中采集'],
  },
  {
    title: '蓝牙与校准',
    paragraphs: [
      '点击「蓝牙模块联结」打开模块管理：倾角、转向力、加载 A/B、二路开关。',
      '力值通道：空载「清零」记录零点；施加标准载荷后填写标准 N，点击「校准」。',
    ],
    tips: ['系数默认 1.00000，按通道独立保存', '设备不支持重量输出时自动使用 AD 内码换算'],
  },
  {
    title: '故障恢复',
    paragraphs: [
      '急停后设备进入 FAULT，所有运动命令被拒绝。必须先执行「故障复位」RESET FAULT，再总使能继续操作。',
      '急停命令同时下发 A/B 两块板，故障未复位时开始测试会被拦截。',
    ],
    tips: ['故障复位不自动使能电机'],
  },
  {
    title: '版本与设备信息',
    paragraphs: [],
    tips: [],
  },
]

/** 操作指引（V6 原型）：左右轮播切换，支持键盘/滑动 */
export default function HelpPage() {
  const t = useT()
  const { state } = useDevice()
  const [index, setIndex] = useState(0)
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const updateInfo = useUpdaterStore((s) => s.updateInfo)
  const stage = useUpdaterStore((s) => s.stage)
  const touchX = useRef(0)

  useEffect(() => {
    import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then(setVersion)
      .catch(() => setVersion('（浏览器模式）'))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1))
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(HELP_PAGES.length - 1, i + 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const page = HELP_PAGES[index]
  const isLast = index === HELP_PAGES.length - 1

  const handleCheck = async () => {
    setChecking(true)
    setMessage(null)
    try {
      const info = await checkForUpdate()
      if (!info) setMessage(t('当前已是最新版本'))
    } catch (e) {
      setMessage(`${t('检查更新失败')}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="h-full flex flex-col gap-2 p-3 overflow-hidden">
      <div className="flex items-center gap-2 flex-shrink-0">
        <h1 className="text-[21px] font-black text-primary whitespace-nowrap">{t('操作指引')}</h1>
        <span className="px-2 py-0.5 rounded-full bg-[#0891b2]/8 border border-[#0891b2]/20 text-[9px] font-extrabold text-[#0891b2]">
          GUIDE
        </span>
        <div className="ml-auto font-label-sm text-slate-400">{index + 1} / {HELP_PAGES.length}</div>
      </div>

      <div className="flex-1 min-h-0 flex items-stretch gap-3">
        <button
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          disabled={index === 0}
          className="self-center w-11 h-11 rounded-full border border-white/95 bg-white/65 text-[#0891b2] text-[26px] leading-none shadow flex items-center justify-center disabled:opacity-30"
          aria-label={t('上一页')}
        >
          ‹
        </button>

        <div
          className="flex-1 min-w-0 min-h-0 overflow-hidden rounded-2xl"
          onTouchStart={(e) => { touchX.current = e.touches[0].clientX }}
          onTouchEnd={(e) => {
            const dx = e.changedTouches[0].clientX - touchX.current
            if (Math.abs(dx) > 50) setIndex((i) => Math.max(0, Math.min(HELP_PAGES.length - 1, i + (dx < 0 ? 1 : -1))))
          }}
        >
          <div
            className="flex h-full transition-transform duration-300 ease-out"
            style={{ transform: `translateX(-${index * 100}%)` }}
          >
            {HELP_PAGES.map((p, i) => (
              <article
                key={p.title}
                className={`flex-[0_0_100%] min-w-0 h-full flex flex-col justify-center gap-4 px-12 py-8 rounded-2xl border shadow-[0_16px_40px_rgba(31,86,130,.10)] ${
                  p.title === '故障恢复'
                    ? 'border-red-200/70 bg-[linear-gradient(135deg,rgba(255,245,245,.8),rgba(255,255,255,.6))]'
                    : 'border-white/95 bg-white/60'
                }`}
              >
                <div
                  className={`w-12 h-12 rounded-[13px] flex items-center justify-center text-white font-black text-[18px] ${
                    p.title === '故障恢复'
                      ? 'bg-[linear-gradient(135deg,#fb7185,#e11d48)]'
                      : 'bg-[linear-gradient(135deg,#0891b2,#2563eb)]'
                  }`}
                >
                  {p.title === '故障恢复' ? '!' : String(i + 1).padStart(2, '0')}
                </div>
                <h3 className="text-[25px] font-black text-[#0e2133] tracking-tight">{t(p.title)}</h3>

                {p.title === '版本与设备信息' ? (
                  <div className="max-w-2xl w-full space-y-3">
                    <div className="flex items-center gap-3">
                      <img src="/icon.png" alt="" className="w-16 h-16 rounded-2xl shadow-md" />
                      <div>
                        <div className="text-[17px] font-black text-primary">{t('智能驾驶舱检测系统')}</div>
                        <div className="font-label-sm text-slate-500">{t('智能驾驶舱检测系统 · 踏板 / 转盘综合检测')}</div>
                      </div>
                    </div>
                    <div className="rounded-xl overflow-hidden border border-white/90">
                      <div className="glass-row !min-h-[36px] rounded-none border-0 border-b border-white/60"><span className="k">{t('应用版本')}</span><span className="v">{version ? t(version) : '--'}</span></div>
                      <div className="glass-row !min-h-[36px] rounded-none border-0 border-b border-white/60"><span className="k">{t('设备 ID')}</span><span className="v">{state.device_id || t('未连接')}</span></div>
                      <div className="glass-row !min-h-[36px] rounded-none border-0 border-b border-white/60"><span className="k">{t('固件版本')}</span><span className="v">{state.info?.fw || state.fw_version || '--'}</span></div>
                      <div className="glass-row !min-h-[36px] rounded-none border-0"><span className="k">{t('通信协议')}</span><span className="v !text-[12px]">Xdesin TCP · AES-128-CTR</span></div>
                    </div>
                    {updateInfo && stage !== 'idle' && (
                      <div className="rounded-xl border border-white/90 bg-white/60 p-3">
                        <div className="font-label-bold text-[13px]">
                          {t('发现新版本')} <span className="monospaced-data">{updateInfo.version}</span>
                        </div>
                        {updateInfo.body && <div className="font-label-sm text-slate-500 mt-1">{updateInfo.body}</div>}
                        {updateInfo.canAutoInstall === false && updateInfo.downloadUrl && (
                          <a href={updateInfo.downloadUrl} className="text-[#0891b2] underline mt-2 inline-block font-label-sm">
                            {t('手动下载安装包')}
                          </a>
                        )}
                      </div>
                    )}
                    <div className="flex items-center gap-3">
                      <button onClick={handleCheck} disabled={checking} className="glass-btn primary !h-9 !px-4">
                        <span className="material-symbols-outlined text-[17px]">system_update</span>
                        {checking ? t('检查中...') : t('检查全量更新')}
                      </button>
                      {message && <span className="font-label-sm text-slate-500">{message}</span>}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2 max-w-3xl">
                      {p.paragraphs.map((line, idx) => (
                        <p key={idx} className="text-[14px] leading-relaxed text-slate-600">{t(line)}</p>
                      ))}
                    </div>
                    {p.tips && p.tips.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {p.tips.map((tip) => (
                          <span key={tip} className="px-2.5 py-1 rounded-full border border-white/90 bg-white/55 text-[10.5px] text-slate-500">
                            {t(tip)}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </article>
            ))}
          </div>
        </div>

        <button
          onClick={() => setIndex((i) => Math.min(HELP_PAGES.length - 1, i + 1))}
          disabled={isLast}
          className="self-center w-11 h-11 rounded-full border border-white/95 bg-white/65 text-[#0891b2] text-[26px] leading-none shadow flex items-center justify-center disabled:opacity-30"
          aria-label={t('下一页')}
        >
          ›
        </button>
      </div>

      <div className="flex-shrink-0 flex items-center justify-center gap-2.5 pb-1">
        {HELP_PAGES.map((p, i) => (
          <button
            key={p.title}
            onClick={() => setIndex(i)}
            className={`h-[7px] rounded-full transition-all ${i === index ? 'w-[18px] bg-[linear-gradient(90deg,#0891b2,#2563eb)]' : 'w-[7px] bg-[rgba(15,80,120,.16)]'}`}
            aria-label={`${i + 1}`}
          />
        ))}
      </div>
    </div>
  )
}
