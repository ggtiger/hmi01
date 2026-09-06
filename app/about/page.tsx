'use client'

import { useEffect, useState } from 'react'
import IndustrialCard from '@/components/ui/IndustrialCard'
import Button from '@/components/ui/Button'
import { useDevice } from '@/lib/comm'
import { checkForUpdate } from '@/lib/updater'
import { useUpdaterStore } from '@/lib/store'

export default function AboutPage() {
  const { state } = useDevice()
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const updateInfo = useUpdaterStore((s) => s.updateInfo)
  const stage = useUpdaterStore((s) => s.stage)

  useEffect(() => {
    import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then(setVersion)
      .catch(() => setVersion('(浏览器模式)'))
  }, [])

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
    <div className="h-full overflow-y-auto p-6 max-w-2xl mx-auto space-y-4">
      <IndustrialCard title="关于">
        <div className="p-6 flex flex-col items-center gap-2 text-center">
          <img src="/icon.png" alt="XdesinHMI" className="w-20 h-20 rounded-2xl shadow-md" />
          <h2 className="text-headline-lg font-bold text-primary mt-2">Xdesin 踏板测试台上位机</h2>
          <p className="font-label-sm text-on-surface-variant">
            XdesinHMI · 对 A/B 双侧踏板总成执行自动调平/推出测试
          </p>
          <div className="mt-3 grid grid-cols-2 gap-x-10 gap-y-1 font-label-sm text-left">
            <span className="text-on-surface-variant">应用版本</span>
            <span className="monospaced-data font-label-bold">{version || '--'}</span>
            <span className="text-on-surface-variant">设备 ID</span>
            <span className="monospaced-data font-label-bold">{state.device_id || '未连接'}</span>
            <span className="text-on-surface-variant">固件版本</span>
            <span className="monospaced-data font-label-bold">{state.info?.fw || state.fw_version || '--'}</span>
            <span className="text-on-surface-variant">协议</span>
            <span className="monospaced-data font-label-bold">Xdesin TCP · AES-128-CTR</span>
          </div>
        </div>
      </IndustrialCard>

      <IndustrialCard title="软件升级">
        <div className="p-4 space-y-3">
          <div className="font-label-sm text-on-surface-variant">
            支持双通道升级：Tauri 全量更新（CDN 优先 + GitHub 兜底）与 server 热更新（顶栏右键「检查热更新」）。
          </div>
          {updateInfo && stage !== 'idle' && (
            <div className="rounded-lg bg-surface-container-low px-3 py-2 font-label-sm">
              发现新版本 <span className="monospaced-data font-label-bold">{updateInfo.version}</span>
              {updateInfo.body && <div className="text-on-surface-variant mt-1">{updateInfo.body}</div>}
              {updateInfo.canAutoInstall === false && updateInfo.downloadUrl && (
                <a href={updateInfo.downloadUrl} className="text-primary underline mt-1 inline-block">
                  手动下载安装包
                </a>
              )}
            </div>
          )}
          <div className="flex items-center gap-3">
            <Button onClick={handleCheck} disabled={checking} icon="system_update">
              {checking ? '检查中...' : '检查全量更新'}
            </Button>
            {message && <span className="font-label-sm text-on-surface-variant">{message}</span>}
          </div>
        </div>
      </IndustrialCard>
    </div>
  )
}
