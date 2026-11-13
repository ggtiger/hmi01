'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useDevice } from '@/lib/comm'
import { checkForUpdate } from '@/lib/updater'
import { useUpdaterStore } from '@/lib/store'

interface HelpPage {
  title: string
  paragraphs: string[]
  tips?: string[]
}

const HELP_PAGES: HelpPage[] = [
  {
    title: '转盘测试操作指引',
    paragraphs: [
      '① 蓝牙模块联结：分别连接「倾角模块」与「转向力模块」；',
      '② 空载清零：传感器不受力时点击「自由转角 · 清零」；',
      '③ 施加标准载荷并校准：输入标准 N 后点击「校准」；',
      '④ 开始测试：记录趋势曲线与峰值；',
      '⑤ 记录峰值与力值，最后「导出 Excel」。',
    ],
    tips: ['倾角来源：Modbus 10Hz 轮询', '力值来源：转向力蓝牙模块', '趋势清空会同时清空记录表'],
  },
  {
    title: '踏板测试操作指引',
    paragraphs: [
      '① 通过「蓝牙模块联结」连接对应侧的力值模块；',
      '② 选择 A / B 模块进入对应侧数据面板；',
      '③ 采集倾角、垂直测距、起始/终末高度与高度差；',
      '④ 观察实时/最大/均匀力值，按需「记录」；',
      '⑤ 底部「开始测试 / 停止测试」控制调平与加载流程；',
      '⑥ 「导出」保存记录（CSV）。',
    ],
    tips: ['高度差 = 终末高度 − 起始高度', '均匀力值为最近采样的滑动平均'],
  },
  {
    title: '蓝牙模块联结',
    paragraphs: [
      '点击页面工具条「蓝牙模块联结」打开模块管理窗口。',
      '扫描后选择设备并指定通道后连接：倾角模块、转向力模块、加载模块 A/B、二路开关。',
      '连接状态以 LED 指示：绿色为已连接，灰色为未连接。',
    ],
    tips: ['macOS 设备标识为系统 UUID，地址显示为 —', '连接失败自动清理状态，可直接重试'],
  },
  {
    title: '力值校准',
    paragraphs: [
      '① 空载点击「清零」，将当前负载标定为 0；',
      '② 施加已知标准载荷（N）；',
      '③ 在「标准 N」输入框填写载荷值，点击「校准」；',
      '④ 系数自动更新，所有力值显示 = 读数 × 系数。',
    ],
    tips: ['系数默认 1.00000', '系数按通道独立保存，重启后保留', '设备不支持重量输出时自动使用 AD 内码换算'],
  },
  {
    title: '网络设置与恢复出厂',
    paragraphs: [
      '「设置 → 设备参数」可配置遥测频率、推杆脉冲当量与调平传动比（NVS 保存）。',
      '「网络配置（NET）」支持查询与修改 WiFi SSID / 密码，恢复默认需当前密码或紧急密码。',
      '力值模块行提供「恢复出厂设置」（Modbus 写 0x00FE），执行前需行内确认。',
    ],
    tips: ['恢复出厂后请重新清零与标定', '修改网络配置后需重启设备生效'],
  },
  {
    title: '版本与设备信息',
    paragraphs: [],
    tips: [],
  },
]

/** 帮助页（对齐《软件UI》PPT 第 4 页）：帮助 / 上一页 / 下一页 / 主页 + 内容区 */
export default function HelpPage() {
  const router = useRouter()
  const { state } = useDevice()
  const [index, setIndex] = useState(0)
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const updateInfo = useUpdaterStore((s) => s.updateInfo)
  const stage = useUpdaterStore((s) => s.stage)

  useEffect(() => {
    import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then(setVersion)
      .catch(() => setVersion('（浏览器模式）'))
  }, [])

  const page = HELP_PAGES[index]
  const isLast = index === HELP_PAGES.length - 1

  const handleCheck = async () => {
    setChecking(true)
    setMessage(null)
    try {
      const info = await checkForUpdate()
      if (!info) setMessage('当前已是最新版本')
    } catch (e) {
      setMessage(`检查更新失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="h-full flex flex-col gap-3 p-4 overflow-hidden">
      {/* ===== 帮助导航按钮（PPT：帮助 / 上一页 / 下一页 / 主页） ===== */}
      <div className="flex items-center gap-2">
        <button onClick={() => setIndex(0)} className="glass-btn primary !h-10 !px-5">
          <span className="material-symbols-outlined text-[18px]">help</span>
          帮助
        </button>
        <button
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          disabled={index === 0}
          className="glass-btn !h-10 !px-5"
        >
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          上一页
        </button>
        <button
          onClick={() => setIndex((i) => Math.min(HELP_PAGES.length - 1, i + 1))}
          disabled={isLast}
          className="glass-btn !h-10 !px-5"
        >
          下一页
          <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
        </button>
        <button onClick={() => router.push('/')} className="glass-btn !h-10 !px-5">
          <span className="material-symbols-outlined text-[18px]">home</span>
          主页
        </button>
        <div className="flex-1" />
        <span className="font-label-sm text-slate-500">第 {index + 1} / {HELP_PAGES.length} 页</span>
      </div>

      {/* ===== 内容区 ===== */}
      <div className="glass-panel flex-1 min-h-0 flex flex-col">
        <div className="glass-panel-header">{page.title}</div>
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          {!isLast ? (
            <div className="max-w-3xl mx-auto">
              <div className="space-y-3">
                {page.paragraphs.map((line, i) => (
                  <p key={i} className="text-[14px] leading-relaxed text-on-surface">{line}</p>
                ))}
              </div>
              {page.tips && page.tips.length > 0 && (
                <div className="mt-6 flex flex-wrap gap-2">
                  {page.tips.map((tip) => (
                    <span key={tip} className="glass-row !min-h-[30px] !text-[12px] text-slate-600">
                      {tip}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* 版本与设备信息页 */
            <div className="max-w-2xl mx-auto space-y-4">
              <div className="flex flex-col items-center gap-3 py-4">
                <img src="/icon.png" alt="XdesinHMI" className="w-20 h-20 rounded-2xl shadow-md" />
                <h2 className="text-2xl font-bold text-primary">Xdesin 踏板测试台上位机</h2>
                <p className="font-label-sm text-slate-500">XdesinHMI · A/B 双侧踏板自动调平与推出测试</p>
              </div>

              <div className="glass-panel overflow-hidden">
                <div className="glass-row !min-h-[38px] rounded-none border-0 border-b border-white/60">
                  <span className="k">应用版本</span>
                  <span className="v">{version || '--'}</span>
                </div>
                <div className="glass-row !min-h-[38px] rounded-none border-0 border-b border-white/60">
                  <span className="k">设备 ID</span>
                  <span className="v">{state.device_id || '未连接'}</span>
                </div>
                <div className="glass-row !min-h-[38px] rounded-none border-0 border-b border-white/60">
                  <span className="k">固件版本</span>
                  <span className="v">{state.info?.fw || state.fw_version || '--'}</span>
                </div>
                <div className="glass-row !min-h-[38px] rounded-none border-0">
                  <span className="k">通信协议</span>
                  <span className="v !text-[12px]">Xdesin TCP · AES-128-CTR</span>
                </div>
              </div>

              {updateInfo && stage !== 'idle' && (
                <div className="glass-panel p-3">
                  <div className="font-label-bold text-[13px]">
                    发现新版本 <span className="monospaced-data">{updateInfo.version}</span>
                  </div>
                  {updateInfo.body && (
                    <div className="font-label-sm text-slate-500 mt-1">{updateInfo.body}</div>
                  )}
                  {updateInfo.canAutoInstall === false && updateInfo.downloadUrl && (
                    <a href={updateInfo.downloadUrl} className="text-[#0891b2] underline mt-2 inline-block font-label-sm">
                      手动下载安装包
                    </a>
                  )}
                </div>
              )}

              <div className="flex items-center gap-3">
                <button onClick={handleCheck} disabled={checking} className="glass-btn primary !h-10 !px-5">
                  <span className="material-symbols-outlined text-[18px]">system_update</span>
                  {checking ? '检查中...' : '检查全量更新'}
                </button>
                {message && <span className="font-label-sm text-slate-500">{message}</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
