'use client'

import { useState } from 'react'
import { useDevice, useForce } from '@/lib/comm'
import { fmtNum, type ForceChannel, type ForceChannelState } from '@/lib/comm/types'
import { useSettingsStore, channelForceN, forceCoefficient, type AdCalibration } from '@/lib/store'
import IndustrialCard from '@/components/ui/IndustrialCard'
import Button from '@/components/ui/Button'
import ForceModal from '@/components/ui/ForceModal'

/** 按业务场景分组的蓝牙模块 */
const BLUETOOTH_GROUPS: { title: string; desc: string; channels: ForceChannel[] }[] = [
  { title: '转盘测试', desc: '倾角 + 转向力采集', channels: ['STEER', 'TORQUE'] },
  { title: '踏板测试', desc: 'A / B 侧加载力采集', channels: ['A', 'B'] },
  { title: '辅助设备', desc: '继电器开关控制', channels: ['SWITCH'] },
]

const CHANNEL_SHORT: Record<ForceChannel, string> = {
  A: '模块 A · 踏板 A 加载力',
  B: '模块 B · 踏板 B 加载力',
  STEER: '倾角模块 · 转盘 X/Y',
  TORQUE: '转向力 · 转盘力值',
  SWITCH: '二路开关 · 加载控制',
}

/** 模块数值块 */
function ValueBox({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <span className="ui-data-box !py-1.5 !px-3 min-w-[92px]">
      <span className="ui-label text-[12px]">{label}</span>
      <span className={`ui-value !text-[14px] ${accent ?? ''}`}>{value}</span>
    </span>
  )
}

interface ModuleRowProps {
  channel: ForceChannel
  st: ForceChannelState
  /** 当前显示力值（N，已应用 AD 标定与校正系数） */
  displayN: number | null
  /** 校正系数（默认 1，仅显示） */
  coefficient: number
  /** AD 标定（零点） */
  adCal: AdCalibration | undefined
  calWeight: string
  onCalWeightChange: (v: string) => void
  /** 清零：记录空载零点 AD + 设备零点命令 */
  onZero: () => void
  /** AD 标定：standardN 施加载荷 + zeroAd 零点，计算 nPerAd */
  onAdCalibrate: (standardN: number, zeroAd: number) => void
  /** 软件校正系数（设备读数可用时） */
  onSetCoefficient: (coef: number) => void
}

/** 单个蓝牙模块行：状态 / 设备名 / 业务数值 / 操作 */
function ModuleRow({
  channel, st, displayN, coefficient, adCal, calWeight, onCalWeightChange, onZero,
  onAdCalibrate, onSetCoefficient,
}: ModuleRowProps) {
  const isAngle = channel === 'STEER'
  const isSwitch = channel === 'SWITCH'
  const isForce = !isAngle && !isSwitch
  const adCode = st.isConnected ? st.latest?.adCode ?? null : null
  const rawN = st.isConnected ? st.latest?.weightN ?? null : null
  /** 输入的施加载荷（N） */
  const standardN = Number(calWeight)
  /** 校准失败提示（点击后显示） */
  const [hint, setHint] = useState<string | null>(null)

  /** 设备重量是否有效（mg 换算后非零） */
  const weightValid = rawN !== null && Math.abs(rawN) >= 0.01
  const adValid = adCal !== undefined && adCal.nPerAd !== 0
  /** 是否可显示力值（设备重量有效 / AD 已标定 / 软件系数已调整） */
  const calibrated = weightValid || adValid || Math.abs(coefficient - 1) > 1e-9

  /**
   * 力值校准（SSTS 单按钮流程）：
   * 施加标准载荷 N 后点击——
   * 1) 设备重量有效 → 软件系数 = 标准值 ÷ 当前读数（SSTS 方式）
   * 2) 重量无效但 AD 有变化 → AD 内码标定兜底
   */
  const handleCalibrate = () => {
    if (!Number.isFinite(standardN) || standardN <= 0) {
      setHint('请填写大于 0 的标准载荷（N）')
      return
    }
    setHint(null)
    // 1) 设备读数系数（SSTS 方式，优先）
    if (weightValid && rawN !== null) {
      const coef = standardN / rawN
      if (Number.isFinite(coef) && coef > 0 && coef <= 1000) {
        onSetCoefficient(Number(coef.toFixed(5)))
        return
      }
    }
    // 2) AD 内码标定兜底
    if (adCal !== undefined && adCode !== null && Math.abs(adCode - adCal.zeroAd) >= 1) {
      onAdCalibrate(standardN, adCal.zeroAd)
      return
    }
    setHint(
      adCal === undefined
        ? '当前读数≈0：请加力后重试（或先清零记录 AD 零点）'
        : `AD 与零点差值不足（Δ${adCode === null ? '--' : adCode - adCal.zeroAd}），请先加力`
    )
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border border-surface-variant bg-white px-4 py-3">
      <span
        className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
          st.isConnected ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.55)]' : 'bg-slate-300'
        }`}
      />
      <div className="min-w-0 w-[210px] flex-shrink-0">
        <div className="font-label-bold text-[14px] text-on-surface">{CHANNEL_SHORT[channel]}</div>
        <div className="font-label-sm text-outline truncate" title={st.deviceName}>
          {st.isConnected ? st.deviceName : '未连接'}
        </div>
        {/* 原始诊断：AD / AD 增量 / 换算比例 / 设备原始重量 / 零点 */}
        {isForce && st.isConnected && (
          <div className="font-label-sm monospaced-data text-outline/80">
            AD {adCode ?? '--'}
            {adCode !== null && adCal && <> · Δ{adCode - adCal.zeroAd}</>}
            {' · '}N/AD{' '}
            {adCal && adCal.nPerAd !== 0 ? adCal.nPerAd.toExponential(4) : '--'}
            {' · '}原始 {st.latest?.weightRaw ?? '--'} mg
            {' · '}零点 {adCal?.zeroAd ?? '--'}
          </div>
        )}
        {/* 校准提示：失败原因 / 未标定说明 */}
        {isForce && st.isConnected && (hint || !calibrated) && (
          <div className="font-label-sm text-amber-700 leading-tight mt-0.5">
            ⚠ {hint ?? '未标定：施加标准载荷（N）后点「校准」'}
          </div>
        )}
      </div>

      <div className="flex-1" />

      {/* 业务数值区 */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {isAngle && (
          <>
            <ValueBox label="倾角 X" value={`${fmtNum(st.isConnected ? st.latestAngle?.angleX ?? null : null, 3)}°`} />
            <ValueBox label="倾角 Y" value={`${fmtNum(st.isConnected ? st.latestAngle?.angleY ?? null : null, 3)}°`} />
          </>
        )}
        {isForce && (
          <>
            <ValueBox
              label="实时"
              value={calibrated ? `${fmtNum(displayN, 2)} N` : '未标定'}
              accent={calibrated ? '' : '!text-amber-600'}
            />
            <ValueBox label="系数" value={coefficient.toFixed(5)} />
          </>
        )}
        {isSwitch &&
          [1, 2].map((relay) => {
            const relayState = st.switchState?.relay === relay ? st.switchState : null
            const on = relayState?.on ?? false
            return (
              <ValueBox
                key={relay}
                label={`第${relay}路`}
                value={relayState ? (on ? '开' : '关') : '--'}
                accent={relayState ? (on ? '!text-emerald-600' : '!text-slate-400') : ''}
              />
            )
          })}
      </div>

      {/* 操作区（仅力值模块：零点校准 + 设备标定 + 系数校准） */}
      {isForce && (
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={onZero}
            disabled={!st.isConnected}
            className="ui-action-btn ui-action-btn-ghost !px-3 !py-1.5 !text-[12px]"
            title="零点校准：当前负载视为 0 N"
          >
            清零
          </button>
          <input
            value={calWeight}
            onChange={(e) => onCalWeightChange(e.target.value)}
            inputMode="decimal"
            placeholder="标准 N"
            disabled={!st.isConnected}
            className="ui-input w-24 !py-1.5 text-center !text-[12px]"
            title="施加已知载荷（N）后填写"
          />
          <button
            onClick={handleCalibrate}
            disabled={!st.isConnected}
            className="ui-action-btn !px-3 !py-1.5 !text-[12px]"
            title="施加标准载荷（N）后点击：系统自动按当前读数完成标定"
          >
            校准
          </button>
        </div>
      )}
    </div>
  )
}

/** 设备参数行 */
function SettingRow({
  label, hint, unit, value, onChange, onApply, applyLabel, disabled,
}: {
  label: string
  hint: string
  unit: string
  value: string
  onChange: (v: string) => void
  onApply: () => void
  applyLabel: string
  disabled: boolean
}) {
  return (
    <div className="flex items-center gap-4 py-3 border-b border-surface-variant last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="font-label-bold text-[14px] text-on-surface">{label}</div>
        <div className="font-label-sm text-outline">{hint}</div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          disabled={disabled}
          className="ui-input w-28 text-center !text-[14px]"
        />
        <span className="font-label-sm text-outline w-8">{unit}</span>
        <button onClick={onApply} disabled={disabled} className="ui-action-btn !px-4 !py-2 !text-[13px]">
          {applyLabel}
        </button>
      </div>
    </div>
  )
}

export default function SettingsPage() {
  const { state, actions, error } = useDevice()
  const { states: forceStates, actions: forceActions } = useForce()
  const {
    reportHz, pulsesPerMm, levelRatio,
    forceCoefficients, adCalibration,
    setForceCoefficient, setAdZero, setAdCalibration,
    setReportHz, setPulsesPerMm, setLevelRatio,
  } = useSettingsStore()

  const [plainConfirm, setPlainConfirm] = useState(false)
  const [forceModalOpen, setForceModalOpen] = useState(false)
  const [calWeights, setCalWeights] = useState<Record<ForceChannel, string>>({
    A: '', B: '', STEER: '', SWITCH: '', TORQUE: '',
  })
  const [netSsid, setNetSsid] = useState('')
  const [netNewPass, setNetNewPass] = useState('')
  const [netOldPass, setNetOldPass] = useState('')
  const [netResetPass, setNetResetPass] = useState('')
  const [netcfg, setNetcfg] = useState<{ ssid: string; pass: string } | null>(null)

  const connected = state.is_connected
  const bleChannels: ForceChannel[] = BLUETOOTH_GROUPS.flatMap((g) => g.channels)
  const bleConnected = bleChannels.filter((c) => forceStates[c].isConnected).length

  const handleQueryNet = async () => {
    try {
      const cfg = await actions.netGetcfg()
      setNetcfg(cfg)
      setNetSsid(cfg.ssid)
    } catch { /* 错误已由 useDevice 记录 */ }
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4 max-w-4xl mx-auto">
      {error && (
        <div className="flex items-center justify-between px-4 py-2 rounded-[10px] bg-red-50 border border-red-200 text-red-700 font-label-bold">
          <span className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px]">error</span>
            {error}
          </span>
          <button onClick={actions.clearError} className="material-symbols-outlined text-[18px]">close</button>
        </div>
      )}

      {/* ===== 状态概览 ===== */}
      <div className="flex items-center gap-3 rounded-xl border border-surface-variant bg-white px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[20px] text-primary">bluetooth</span>
          <span className="font-label-bold text-[14px]">蓝牙模块</span>
          <span className={`font-label-bold text-[14px] ${bleConnected > 0 ? 'text-emerald-600' : 'text-slate-400'}`}>
            {bleConnected}/{bleChannels.length} 已连接
          </span>
        </div>
        <div className="w-px h-5 bg-surface-variant" />
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[20px] text-primary">lan</span>
          <span className="font-label-bold text-[14px]">WiFi 设备</span>
          <span className={`font-label-bold text-[14px] ${connected ? 'text-emerald-600' : 'text-slate-400'}`}>
            {connected ? '已连接' : '未连接'}
          </span>
        </div>
        <div className="flex-1" />
        <span className="font-label-sm text-outline">蓝牙采集不依赖 WiFi 连接</span>
      </div>

      {/* ===== 蓝牙采集模块（按业务场景分组） ===== */}
      <IndustrialCard
        title="蓝牙采集模块"
        headerRight={
          <Button variant="ghost" onClick={() => setForceModalOpen(true)} className="!py-1.5">
            蓝牙模块联结
          </Button>
        }
      >
        <div className="p-4 space-y-4">
          {BLUETOOTH_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="font-label-bold text-[13px] text-primary tracking-wide">{group.title}</span>
                <span className="font-label-sm text-outline">{group.desc}</span>
              </div>
              <div className="space-y-2">
                {group.channels.map((ch) => (
                  <ModuleRow
                    key={ch}
                    channel={ch}
                    st={forceStates[ch]}
                    displayN={channelForceN(
                      forceStates[ch],
                      ch,
                      forceCoefficients,
                      adCalibration
                    )}
                    coefficient={forceCoefficient(forceCoefficients, ch)}
                    adCal={adCalibration[ch]}
                    calWeight={calWeights[ch]}
                    onCalWeightChange={(v) => setCalWeights((p) => ({ ...p, [ch]: v }))}
                    onZero={() => {
                      // 记录空载 AD 零点，同时下发设备零点校准
                      const ad = forceStates[ch].latest?.adCode
                      if (ad !== undefined) setAdZero(ch, ad)
                      forceActions.zero(ch).catch(() => {})
                    }}
                    onAdCalibrate={(standardN, zeroAd) => {
                      const ad = forceStates[ch].latest?.adCode
                      if (ad === undefined) return
                      const delta = ad - zeroAd
                      if (Math.abs(delta) < 1) return
                      const nPerAd = standardN / delta
                      if (!Number.isFinite(nPerAd) || nPerAd === 0) return
                      setAdCalibration(ch, { zeroAd, nPerAd })
                    }}
                    onSetCoefficient={(c) => setForceCoefficient(ch, String(c))}
                  />
                ))}
              </div>
            </div>
          ))}
          <div className="rounded-[10px] bg-surface-container-low px-3 py-2.5 space-y-1">
            <div className="font-label-bold text-[12px] text-on-surface-variant">力值校准使用说明</div>
            <div className="font-label-sm text-outline leading-relaxed">
              ① <span className="font-label-bold text-on-surface">清零</span>：空载状态下点击，当前负载视为 0。
              <br />
              ② <span className="font-label-bold text-on-surface">校准</span>：施加已知载荷（N）→ 填写标准 N → 点击「校准」，
              系统自动按当前读数完成标定（SSTS 同款流程，一步完成）。
              <br />
              ③ <span className="font-label-bold text-on-surface">系数</span>：标定后所有力值 = 当前读数 × 换算比例 × 系数；标定参数按通道保存，重启后保留。
            </div>
            <button
              onClick={() => {
                for (const ch of ['A', 'B', 'TORQUE'] as ForceChannel[]) {
                  setForceCoefficient(ch, '1')
                  const existing = adCalibration[ch]
                  if (existing) setAdCalibration(ch, { zeroAd: existing.zeroAd, nPerAd: 0 })
                }
              }}
              className="font-label-sm text-primary hover:underline"
            >
              重置全部力值系数为 1
            </button>
          </div>
        </div>
      </IndustrialCard>

      {/* ===== 设备参数（SET，需 WiFi 连接） ===== */}
      <IndustrialCard
        title="设备参数（SET）"
        headerRight={
          <span className={`font-label-sm ${connected ? 'text-emerald-600' : 'text-amber-600'}`}>
            {connected ? '已连接设备' : '未连接设备 · 修改将在连接后生效'}
          </span>
        }
      >
        <div className="px-4">
          <SettingRow
            label="遥测上报频率"
            hint="设备向主机上报遥测的周期，1–50 Hz"
            unit="Hz"
            value={reportHz}
            onChange={setReportHz}
            onApply={() => actions.setReport(Number(reportHz)).catch(() => {})}
            applyLabel="应用"
            disabled={!connected}
          />
          <SettingRow
            label="推杆脉冲当量"
            hint="推杆位置脉冲换算毫米的比例，10–10000 脉冲/mm"
            unit="P/mm"
            value={pulsesPerMm}
            onChange={setPulsesPerMm}
            onApply={() => actions.setPushPulsesPerMm(Number(pulsesPerMm)).catch(() => {})}
            applyLabel="应用（NVS）"
            disabled={!connected}
          />
          <SettingRow
            label="调平传动比"
            hint="倾角补偿量与电机角度的换算系数，0.01–100"
            unit=""
            value={levelRatio}
            onChange={setLevelRatio}
            onApply={() => actions.setLevelRatio(Number(levelRatio)).catch(() => {})}
            applyLabel="应用（NVS）"
            disabled={!connected}
          />
        </div>
      </IndustrialCard>

      {/* ===== 通信调试 ===== */}
      <IndustrialCard title="通信调试">
        <div className="px-4 py-3 space-y-3">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="font-label-bold text-[14px]">传输加密模式</div>
              <div className="font-label-sm text-outline">
                当前：{state.plain_mode ? '明文（无加密，仅联调抓包使用）' : '加密（AES-128-CTR + HMAC-MD5）'}
                ；断开重连后自动复位为加密
              </div>
            </div>
            {!state.plain_mode ? (
              plainConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="font-label-bold text-critical text-[13px]">确认切换明文？</span>
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
        </div>
      </IndustrialCard>

      {/* ===== 网络配置（NET，需 WiFi 连接） ===== */}
      <IndustrialCard
        title="网络配置（NET）"
        headerRight={
          <Button variant="ghost" onClick={handleQueryNet} disabled={!connected} className="!py-1.5">
            查询当前配置
          </Button>
        }
      >
        <div className="p-4 space-y-4">
          {netcfg && (
            <div className="rounded-[10px] bg-surface-container-low px-3 py-2 font-label-sm monospaced-data text-on-surface-variant">
              当前 SSID：<span className="font-label-bold text-on-surface">{netcfg.ssid}</span>
              　密码：{netcfg.pass}
            </div>
          )}
          <div className="grid grid-cols-3 gap-3 items-end">
            <div>
              <label className="font-label-sm text-on-surface-variant">旧密码</label>
              <input
                value={netOldPass}
                onChange={(e) => setNetOldPass(e.target.value)}
                type="password"
                disabled={!connected}
                className="ui-input mt-1 w-full !py-2"
              />
            </div>
            <div>
              <label className="font-label-sm text-on-surface-variant">新 SSID（1–32）</label>
              <input
                value={netSsid}
                onChange={(e) => setNetSsid(e.target.value)}
                disabled={!connected}
                className="ui-input mt-1 w-full !py-2"
              />
            </div>
            <div>
              <label className="font-label-sm text-on-surface-variant">新密码（8–64）</label>
              <input
                value={netNewPass}
                onChange={(e) => setNetNewPass(e.target.value)}
                type="password"
                disabled={!connected}
                className="ui-input mt-1 w-full !py-2"
              />
            </div>
          </div>
          <Button
            onClick={() => actions.netSetcfg(netOldPass, netSsid, netNewPass).catch(() => {})}
            disabled={!connected || !netOldPass || !netSsid || !netNewPass}
          >
            保存网络配置（重启后生效）
          </Button>

          <div className="border-t border-surface-variant pt-4">
            <div className="font-label-bold text-[14px] text-critical">恢复默认配置</div>
            <div className="font-label-sm text-outline mb-2">
              清空 WiFi 配置并恢复出厂网络设置（需当前密码或紧急密码 XDESIN2026）
            </div>
            <div className="flex items-end gap-3">
              <div className="w-56">
                <input
                  value={netResetPass}
                  onChange={(e) => setNetResetPass(e.target.value)}
                  type="password"
                  placeholder="密码"
                  disabled={!connected}
                  className="ui-input w-full !py-2"
                />
              </div>
              <Button
                variant="critical"
                onClick={() => actions.netReset(netResetPass).catch(() => {})}
                disabled={!connected || !netResetPass}
              >
                恢复默认
              </Button>
            </div>
          </div>
        </div>
      </IndustrialCard>

      <ForceModal open={forceModalOpen} onClose={() => setForceModalOpen(false)} />
    </div>
  )
}
