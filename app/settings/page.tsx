'use client'

import { useState } from 'react'
import { useDevice, useForce } from '@/lib/comm'
import { fmtNum, FORCE_CHANNEL_LABELS, type ForceChannel } from '@/lib/comm/types'
import { useSettingsStore } from '@/lib/store'
import IndustrialCard from '@/components/ui/IndustrialCard'
import Button from '@/components/ui/Button'
import ForceModal from '@/components/ui/ForceModal'

const FORCE_CHANNELS: ForceChannel[] = ['A', 'B', 'STEER']

export default function SettingsPage() {
  const { state, actions, error } = useDevice()
  const { states: forceStates, actions: forceActions } = useForce()
  const {
    reportHz, pulsesPerMm, levelRatio,
    setReportHz, setPulsesPerMm, setLevelRatio,
  } = useSettingsStore()

  const [plainConfirm, setPlainConfirm] = useState(false)
  const [forceModalOpen, setForceModalOpen] = useState(false)
  const [calWeights, setCalWeights] = useState<Record<ForceChannel, string>>({ A: '', B: '', STEER: '' })
  const [netSsid, setNetSsid] = useState('')
  const [netNewPass, setNetNewPass] = useState('')
  const [netOldPass, setNetOldPass] = useState('')
  const [netResetPass, setNetResetPass] = useState('')
  const [netcfg, setNetcfg] = useState<{ ssid: string; pass: string } | null>(null)

  const connected = state.is_connected

  const handleQueryNet = async () => {
    try {
      const cfg = await actions.netGetcfg()
      setNetcfg(cfg)
      setNetSsid(cfg.ssid)
    } catch { /* */ }
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4 max-w-3xl mx-auto">
      {error && (
        <div className="flex items-center justify-between px-4 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 font-label-bold">
          <span className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px]">error</span>
            {error}
          </span>
          <button onClick={actions.clearError} className="material-symbols-outlined text-[18px]">close</button>
        </div>
      )}
      {!connected && (
        <div className="px-4 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 font-label-sm">
          未连接设备——设置将在连接后生效
        </div>
      )}

      {/* 力值模块（BLE，slide 5 设置模块） */}
      <IndustrialCard
        title="力值模块（蓝牙）"
        headerRight={
          <Button variant="ghost" onClick={() => setForceModalOpen(true)} className="!py-1">
            蓝牙模块联结
          </Button>
        }
      >
        <div className="p-4 space-y-2">
          {FORCE_CHANNELS.map((ch) => {
            const st = forceStates[ch]
            return (
              <div key={ch} className="flex items-center gap-3 rounded-[10px] border border-surface-variant px-3 py-2">
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${st.isConnected ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                <span className="font-label-bold text-[13px] w-44 flex-shrink-0">{FORCE_CHANNEL_LABELS[ch]}</span>
                <span className="font-label-sm text-on-surface-variant flex-1 truncate">
                  {st.isConnected ? st.deviceName : '未连接'}
                </span>
                <span className="monospaced-data font-label-bold text-[13px]">
                  实时 {fmtNum(st.isConnected ? st.latest?.weightN ?? null : null, 2)} N
                </span>
                <span className="monospaced-data font-label-sm text-outline">
                  系数 {st.isConnected && st.latest ? (st.latest.weightN / (st.latest.weightG / 1000 * 9.80665 || 1)).toFixed(4) : '--'}
                </span>
                <button
                  onClick={() => forceActions.zero(ch).catch(() => {})}
                  disabled={!st.isConnected}
                  className="ui-action-btn ui-action-btn-ghost !px-2 !py-0.5 !text-[11px]"
                >
                  清零
                </button>
                <input
                  value={calWeights[ch]}
                  onChange={(e) => setCalWeights((p) => ({ ...p, [ch]: e.target.value }))}
                  inputMode="numeric"
                  placeholder="砝码 g"
                  disabled={!st.isConnected}
                  className="ui-input w-20 !py-0.5 text-center"
                />
                <button
                  onClick={() => {
                    const w = Number(calWeights[ch])
                    if (Number.isFinite(w) && w > 0) forceActions.calibrate(ch, Math.round(w)).catch(() => {})
                  }}
                  disabled={!st.isConnected || !calWeights[ch]}
                  className="ui-action-btn !px-2 !py-0.5 !text-[11px]"
                >
                  校准
                </button>
              </div>
            )
          })}
          <div className="font-label-sm text-outline">
            三个 BLE 力值模块独立连接；清零 = 零点校准，校准 = 砝码标定（需放置对应重量砝码后执行）
          </div>
        </div>
      </IndustrialCard>

      {/* SET 参数 */}
      <IndustrialCard title="设备参数（SET）">
        <div className="p-4 space-y-3">
          <div className="flex items-end gap-3">
            <div className="w-40">
              <label className="font-label-sm text-on-surface-variant">遥测上报频率 (1-50)</label>
              <input
                value={reportHz}
                onChange={(e) => setReportHz(e.target.value)}
                inputMode="numeric"
                className="mt-0.5 w-full px-3 py-2 rounded-lg border border-outline-variant monospaced-data text-body-md focus:outline-none focus:border-primary"
              />
            </div>
            <Button onClick={() => actions.setReport(Number(reportHz)).catch(() => {})} disabled={!connected}>
              应用
            </Button>
          </div>

          <div className="flex items-end gap-3">
            <div className="w-40">
              <label className="font-label-sm text-on-surface-variant">推杆脉冲当量 (10-10000)</label>
              <input
                value={pulsesPerMm}
                onChange={(e) => setPulsesPerMm(e.target.value)}
                inputMode="decimal"
                className="mt-0.5 w-full px-3 py-2 rounded-lg border border-outline-variant monospaced-data text-body-md focus:outline-none focus:border-primary"
              />
            </div>
            <Button onClick={() => actions.setPushPulsesPerMm(Number(pulsesPerMm)).catch(() => {})} disabled={!connected}>
              应用（NVS 保存）
            </Button>
          </div>

          <div className="flex items-end gap-3">
            <div className="w-40">
              <label className="font-label-sm text-on-surface-variant">调平传动比 (0.01-100)</label>
              <input
                value={levelRatio}
                onChange={(e) => setLevelRatio(e.target.value)}
                inputMode="decimal"
                className="mt-0.5 w-full px-3 py-2 rounded-lg border border-outline-variant monospaced-data text-body-md focus:outline-none focus:border-primary"
              />
            </div>
            <Button onClick={() => actions.setLevelRatio(Number(levelRatio)).catch(() => {})} disabled={!connected}>
              应用（NVS 保存）
            </Button>
          </div>
        </div>
      </IndustrialCard>

      {/* 明文调试模式 */}
      <IndustrialCard title="明文调试模式">
        <div className="p-4 space-y-3">
          <div className="font-label-sm text-on-surface-variant">
            当前模式：<span className="font-label-bold text-on-surface">{state.plain_mode ? '明文（无加密）' : '加密（AES-128-CTR + HMAC-MD5）'}</span>
            <br />
            明文模式仅用于联调抓包分析；断开重连后自动复位为加密模式。
          </div>
          {!state.plain_mode ? (
            plainConfirm ? (
              <div className="flex items-center gap-3">
                <span className="font-label-bold text-critical">确认切换为明文传输？</span>
                <Button
                  variant="critical"
                  onClick={async () => {
                    setPlainConfirm(false)
                    await actions.plainModeSet(true)
                  }}
                  disabled={!connected}
                >
                  确认开启
                </Button>
                <Button variant="ghost" onClick={() => setPlainConfirm(false)}>取消</Button>
              </div>
            ) : (
              <Button variant="ghost" icon="warning" onClick={() => setPlainConfirm(true)} disabled={!connected}>
                开启明文模式
              </Button>
            )
          ) : (
            <Button onClick={() => actions.plainModeSet(false)} disabled={!connected} icon="lock">
              切回加密模式
            </Button>
          )}
        </div>
      </IndustrialCard>

      {/* NET 网络配置 */}
      <IndustrialCard
        title="网络配置（NET）"
        headerRight={
          <Button variant="ghost" onClick={handleQueryNet} disabled={!connected} className="!py-1">
            查询当前配置
          </Button>
        }
      >
        <div className="p-4 space-y-3">
          {netcfg && (
            <div className="font-label-sm monospaced-data text-on-surface-variant">
              当前 SSID：{netcfg.ssid} · 密码：{netcfg.pass}
            </div>
          )}
          <div className="grid grid-cols-3 gap-3 items-end">
            <div>
              <label className="font-label-sm text-on-surface-variant">旧密码</label>
              <input
                value={netOldPass}
                onChange={(e) => setNetOldPass(e.target.value)}
                type="password"
                className="mt-0.5 w-full px-3 py-2 rounded-lg border border-outline-variant monospaced-data text-body-md focus:outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="font-label-sm text-on-surface-variant">新 SSID (1-32)</label>
              <input
                value={netSsid}
                onChange={(e) => setNetSsid(e.target.value)}
                className="mt-0.5 w-full px-3 py-2 rounded-lg border border-outline-variant monospaced-data text-body-md focus:outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="font-label-sm text-on-surface-variant">新密码 (8-64，支持空格)</label>
              <input
                value={netNewPass}
                onChange={(e) => setNetNewPass(e.target.value)}
                className="mt-0.5 w-full px-3 py-2 rounded-lg border border-outline-variant monospaced-data text-body-md focus:outline-none focus:border-primary"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={() => actions.netSetcfg(netOldPass, netSsid, netNewPass).catch(() => {})}
              disabled={!connected || !netOldPass || !netSsid || !netNewPass}
            >
              保存网络配置（重启后生效）
            </Button>
          </div>

          <div className="border-t border-surface-variant pt-3 flex items-end gap-3">
            <div className="w-56">
              <label className="font-label-sm text-on-surface-variant">恢复默认（当前密码或紧急密码 XDESIN2026）</label>
              <input
                value={netResetPass}
                onChange={(e) => setNetResetPass(e.target.value)}
                type="password"
                className="mt-0.5 w-full px-3 py-2 rounded-lg border border-outline-variant monospaced-data text-body-md focus:outline-none focus:border-primary"
              />
            </div>
            <Button
              variant="critical"
              onClick={() => actions.netReset(netResetPass).catch(() => {})}
              disabled={!connected || !netResetPass}
            >
              恢复默认配置
            </Button>
          </div>
        </div>
      </IndustrialCard>

      <ForceModal open={forceModalOpen} onClose={() => setForceModalOpen(false)} />
    </div>
  )
}
