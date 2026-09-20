/**
 * Xdesin 踏板测试台 mock 设备模拟器
 *
 * 纯 Node 实现（net + crypto），与上位机 Rust crypto 层对拍：
 * - 帧格式: base64( nonce[2B BE] ‖ AES-128-CTR 密文 ‖ HMAC-MD5[16B] ) + '\n'
 * - PSK: 'Xdesin0123456789'，IV = 14×0x00 + nonce BE
 * - 重放保护: nonce ≤ last 丢弃（回绕放行）
 * - 明文调试模式（DEBUG PLAIN ON/OFF）+ 加密模式明文入口白名单
 *
 * 用法: npm run mock:device   （默认 0.0.0.0:10001，可用 MOCK_PORT 覆盖）
 */
'use strict'

const net = require('net')
const crypto = require('crypto')

const PSK = Buffer.from('Xdesin0123456789', 'utf8')
const PORT = Number(process.env.MOCK_PORT || 10001)
const DEVICE_ID = 'xdesin-s3-001'
const FW_VERSION = '1.0.0'
const HW_ID = 'esp32-s3'
const SSID = 'XDESIN'

const DATA_TIMEOUT_MS = 15000
const REPORT_HZ_DEFAULT = 10

// ============ 加密封装（协议 §1.2） ============

function makeIv(nonce) {
  const iv = Buffer.alloc(16)
  iv.writeUInt16BE(nonce, 14)
  return iv
}

function encryptLine(plainBuf, txNonce) {
  const nonceBuf = Buffer.alloc(2)
  nonceBuf.writeUInt16BE(txNonce, 0)
  const cipher = crypto.createCipheriv('aes-128-ctr', PSK, makeIv(txNonce))
  const ct = Buffer.concat([cipher.update(plainBuf), cipher.final()])
  const mac = crypto.createHmac('md5', PSK).update(nonceBuf).update(ct).digest()
  return Buffer.concat([nonceBuf, ct, mac]).toString('base64')
}

function decryptLine(line) {
  // 返回 { nonce, plaintext } | null（非加密帧）| { replay: true }
  let frame
  try {
    frame = Buffer.from(line, 'base64')
  } catch {
    return null
  }
  if (frame.length < 18) return null
  const nonce = frame.readUInt16BE(0)
  const ct = frame.slice(2, frame.length - 16)
  const tag = frame.slice(frame.length - 16)
  const nonceBuf = Buffer.alloc(2)
  nonceBuf.writeUInt16BE(nonce, 0)
  const expect = crypto.createHmac('md5', PSK).update(nonceBuf).update(ct).digest()
  if (!crypto.timingSafeEqual(expect, tag)) return null
  return { nonce, _ct: ct }
}

function decipher(nonce, ct) {
  const decipher = crypto.createDecipheriv('aes-128-ctr', PSK, makeIv(nonce))
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

function looksEncrypted(line) {
  return line.length >= 24 && /^[A-Za-z0-9+/=]+$/.test(line)
}

// ============ 设备状态机 ============

function newSide() {
  return {
    flowRunning: false,   // 自动流程（AF_LEVELING）
    leveling: false,      // 手动调平中
    pushing: false,       // 推出中
    homing: false,        // 回零中
    pushDist: 0,          // mm
    angleComp: 0,         // deg
    endH: 0,              // mm（终末高度）
    pedalPos: 0,          // 脉冲
    angCor: 0,            // deg
    baseTiltX: 0.4 + Math.random() * 0.4,  // 初始倾角偏差
    baseTiltY: -(0.3 + Math.random() * 0.4),
    baseLaser: 100 + Math.random() * 20,
  }
}

class DeviceSession {
  constructor(socket) {
    this.socket = socket
    this.txNonce = 0
    this.lastRxNonce = null
    this.plainMode = false
    this.reportHz = REPORT_HZ_DEFAULT
    this.pulsesPerMm = 320
    this.levelRatio = 1.0
    this.motorEnabled = true
    this.pedalSelect = 'NONE'
    this.devState = 'IDLE'
    this.commonTiltX = 0.05
    this.commonTiltY = -0.02
    this.sides = { A: newSide(), B: newSide() }
    this.lastRxAt = Date.now()
    this.startMs = Date.now()
    this.telemetryTimer = null
    this.timers = new Set()
  }

  log(...args) {
    console.log(`[mock] [${this.socket.remoteAddress || 'client'}]`, ...args)
  }

  // ---- 收发 ----

  sendPlain(line) {
    this.log('TX(plain)', line)
    this.socket.write(line + '\n')
  }

  sendLine(line) {
    if (this.plainMode) {
      this.sendPlain(line)
    } else {
      const nonce = this.txNonce
      this.txNonce = (this.txNonce + 1) & 0xFFFF
      const frame = encryptLine(Buffer.from(line, 'utf8'), nonce)
      this.log('TX', line)
      this.socket.write(frame + '\n')
    }
  }

  reply(line) {
    this.sendLine(line)
  }

  sendEvent(line) {
    this.sendLine(line)
  }

  abortSide(side, reason) {
    const s = this.sides[side]
    if (!s) return
    if (s.flowRunning || s.leveling) {
      s.flowRunning = false
      s.leveling = false
      this.sendEvent(`DEBUG LEVEL ${side} ABORT ${reason}`)
    }
    if (s.pushing) {
      s.pushing = false
      this.sendEvent(`DEBUG PEDAL ${side} PUSH_STOPPED`)
    }
  }

  anyFlowRunning() {
    return this.sides.A.flowRunning || this.sides.B.flowRunning
  }

  updateDevState() {
    const running = this.anyFlowRunning() || this.sides.A.pushing || this.sides.B.pushing
    this.devState = running ? 'PEDAL_RUN' : this.devState === 'FAULT' ? 'FAULT' : 'IDLE'
  }

  later(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t)
      fn()
    }, ms)
    this.timers.add(t)
    return t
  }

  // ---- 命令处理 ----

  handleLine(raw) {
    this.lastRxAt = Date.now()
    const line = raw.trim()
    if (!line) return

    // 收包模式判定
    if (this.plainMode) {
      if (looksEncrypted(line)) {
        const d = decryptLine(line)
        if (d) {
          if (this.lastRxNonce !== null) {
            const wrappedOk = this.lastRxNonce > 0xF000 && d.nonce < 0x0FFF
            if (d.nonce <= this.lastRxNonce && !wrappedOk) {
              this.log('DROP replay nonce', d.nonce)
              return
            }
          }
          this.lastRxNonce = d.nonce
          const pt = decipher(d.nonce, d._ct)
          this.dispatch(Buffer.from(pt).toString('utf8'))
        } else {
          this.dispatch(line) // 假加密帧 → 明文
        }
      } else {
        this.dispatch(line)
      }
    } else {
      // 加密模式：仅白名单明文入口
      if (/^DEBUG PLAIN ON$/i.test(line)) {
        this.log('TX-entry(plain)', line)
        this.plainMode = true
        this.sendPlain('OK DEBUG PLAIN ON')
        return
      }
      const d = decryptLine(line)
      if (!d || d.replay) {
        this.log('DROP undecryptable line')
        return
      }
      if (this.lastRxNonce !== null) {
        const wrappedOk = this.lastRxNonce > 0xF000 && d.nonce < 0x0FFF
        if (d.nonce <= this.lastRxNonce && !wrappedOk) {
          this.log('DROP replay nonce', d.nonce)
          return
        }
      }
      this.lastRxNonce = d.nonce
      this.dispatch(decipher(d.nonce, d._ct).toString('utf8'))
    }
  }

  dispatch(line) {
    this.log('RX', line)
    const tokens = line.split(/\s+/)
    const cmd = tokens[0].toUpperCase()
    const sub = (tokens[1] || '').toUpperCase()

    switch (cmd) {
      case 'PING':
        return this.reply('PONG')
      case 'ESTOP':
        this.abortSide('A', 'STOPPED')
        this.abortSide('B', 'STOPPED')
        this.devState = 'FAULT'
        return this.reply('OK ESTOP')
      case 'HELLO':
        return this.reply(`HELLO OK ${DEVICE_ID} ${FW_VERSION}`)
      case 'INFO':
        return this.reply(
          `INFO fw=${FW_VERSION} hw=${HW_ID} uptime=${Math.floor((Date.now() - this.startMs) / 1000)} ssid=${SSID}`
        )
      case 'DEBUG':
        return this.handleDebug(tokens)
      case 'SET':
        return this.handleSet(tokens)
      case 'NET':
        return this.handleNet(tokens)
      case 'PEDAL':
        return this.handlePedal(tokens)
      case 'MOTOR':
        return this.handleMotor(tokens)
      case 'STEER':
        return this.handleSteer(tokens)
      default:
        return this.reply(`ERR ${cmd || '?'} E_SYNTAX 未知命令`)
    }
  }

  // STEER START / STOP（协议 §2.9）
  handleSteer(tokens) {
    const op = (tokens[1] || '').toUpperCase()
    if (!op) return this.reply('ERR STEER E_SYNTAX 参数缺失')
    if (op === 'START') {
      this.devState = 'STEER_RUN'
      return this.reply('OK STEER')
    }
    if (op === 'STOP') {
      this.devState = 'IDLE'
      return this.reply('OK STEER')
    }
    return this.reply('ERR STEER E_SYNTAX 未知操作')
  }

  handleDebug(tokens) {
    const sub = (tokens[1] || '').toUpperCase()
    if (sub === 'ON') return this.reply('OK DEBUG')
    if (sub === 'OFF') return this.reply('OK DEBUG')
    if (sub === 'PLAIN') {
      const v = (tokens[2] || '').toUpperCase()
      if (v === 'ON') {
        // 收到此命令时仍是加密模式，OK 为最后一帧加密
        const nonce = this.txNonce
        this.txNonce = (this.txNonce + 1) & 0xFFFF
        this.plainMode = true
        this.log('TX(last-encrypted)', 'OK DEBUG PLAIN ON')
        const frame = encryptLine(Buffer.from('OK DEBUG PLAIN ON', 'utf8'), nonce)
        this.socket.write(frame + '\n')
        return
      }
      if (v === 'OFF') {
        // 明文发出后链路立即切回加密：本应答为加密帧
        this.plainMode = false
        return this.reply('OK DEBUG PLAIN OFF')
      }
      return this.reply('ERR DEBUG E_SYNTAX 参数缺失或非法值')
    }
    return this.reply('ERR DEBUG E_SYNTAX 参数缺失或非法值')
  }

  handleSet(tokens) {
    const key = (tokens[1] || '').toUpperCase()
    if (!key) return this.reply('ERR SET E_SYNTAX 参数缺失')
    if (key === 'REPORT') {
      const hz = Number(tokens[2])
      if (!Number.isFinite(hz) || hz < 1 || hz > 50) {
        return this.reply('ERR SET E_RANGE 频率 1-50Hz')
      }
      this.reportHz = hz
      this.restartTelemetry()
      return this.reply('OK SET')
    }
    if (key === 'PUSH_PULSES_PER_MM') {
      const v = Number(tokens[2])
      if (!Number.isFinite(v) || v < 10 || v > 10000) {
        return this.reply('ERR SET E_RANGE 10-10000')
      }
      this.pulsesPerMm = v
      return this.reply(`OK SET PUSH_PULSES_PER_MM ${v}`)
    }
    if (key === 'LEVEL_RATIO') {
      const v = Number(tokens[2])
      if (!Number.isFinite(v) || v < 0.01 || v > 100) {
        return this.reply('ERR SET E_RANGE 0.01-100')
      }
      this.levelRatio = v
      return this.reply(`OK SET LEVEL_RATIO ${v}`)
    }
    return this.reply('ERR SET E_SYNTAX 未知操作')
  }

  handleNet(tokens) {
    const sub = (tokens[1] || '').toUpperCase()
    if (sub === 'GETCFG') return this.reply(`NETCFG ssid=${SSID} pass=********`)
    if (sub === 'SETCFG') {
      const [, , oldPass, newSsid, ...rest] = tokens
      const newPass = rest.join(' ')
      if (!oldPass || !newSsid || !newPass) return this.reply('ERR NET E_SYNTAX 参数缺失')
      if (oldPass !== '88888888') return this.reply('ERR NET E_RANGE 密码错误')
      if (newSsid.length < 1 || newSsid.length > 32 || newPass.length < 8 || newPass.length > 64) {
        return this.reply('ERR NET E_RANGE SSID/密码长度超范围')
      }
      return this.reply('OK NET 已保存，重启后生效')
    }
    if (sub === 'RESET') {
      const pass = tokens[2]
      if (!pass) return this.reply('ERR NET E_SYNTAX 参数缺失')
      if (pass !== '88888888' && pass !== 'XDESIN2026') {
        return this.reply('ERR NET E_RANGE 密码错误')
      }
      return this.reply('OK NET 已恢复默认，重启后生效')
    }
    return this.reply('ERR NET E_SYNTAX 参数缺失或未知操作')
  }

  handlePedal(tokens) {
    // PEDAL SELECT <A|B|NONE>
    if ((tokens[1] || '').toUpperCase() === 'SELECT') {
      const target = (tokens[2] || '').toUpperCase()
      if (!['A', 'B', 'NONE'].includes(target)) {
        return this.reply('ERR PEDAL E_SYNTAX 仅支持 A/B/NONE')
      }
      if (this.pedalSelect !== 'NONE' && target !== this.pedalSelect) {
        this.abortSide(this.pedalSelect, 'SELECT_CHANGED')
      }
      this.pedalSelect = target
      this.updateDevState()
      return this.reply('OK PEDAL')
    }

    // PEDAL ZERO / CLEAR / RECORD（全局）
    if (!tokens[1]) {
      return this.reply('ERR PEDAL E_SYNTAX 缺少 A/B/NONE')
    }
    const second = tokens[1].toUpperCase()

    // PEDAL <side> ...
    if (second === 'A' || second === 'B') {
      const side = second
      const s = this.sides[side]
      const other = side === 'A' ? 'B' : 'A'
      const op = (tokens[2] || '').toUpperCase()

      switch (op) {
        case 'START': {
          if (this.pedalSelect !== 'NONE' && this.pedalSelect !== side) {
            return this.reply(`ERR PEDAL E_RANGE 当前选中 ${this.pedalSelect} 侧，无法启动 ${side}`)
          }
          this.reply(`OK PEDAL ${side} START`)
          s.flowRunning = true
          this.devState = 'PEDAL_RUN'
          // 模拟调平：2~5s 后 LEVELED
          this.later(2000 + Math.random() * 3000, () => {
            if (s.flowRunning) {
              s.baseTiltY = 0
              this.sendEvent(`DEBUG PEDAL ${side} LEVELED`)
            }
          })
          return
        }
        case 'STOP': {
          this.reply(`OK PEDAL ${side} STOP`)
          this.abortSide(side, 'PEDAL_STOP')
          this.updateDevState()
          return
        }
        case 'SETLOAD': {
          const n = Number(tokens[3])
          if (!Number.isFinite(n) || n < 0 || n > 500) {
            return this.reply('ERR PEDAL E_RANGE 力值 0-500N')
          }
          return this.reply('OK PEDAL')
        }
        case 'LEVEL': {
          if (s.flowRunning) {
            return this.reply('ERR PEDAL E_RANGE 测试流程进行中，实时补正已启用')
          }
          if (this.pedalSelect !== 'NONE' && this.pedalSelect !== side) {
            return this.reply(`ERR PEDAL E_RANGE 当前选中 ${other} 侧，无法补偿 ${side}`)
          }
          this.reply(`OK PEDAL ${side} LEVEL`)
          s.leveling = true
          const target = -s.baseTiltY * this.levelRatio
          this.later(1200 + Math.random() * 800, () => {
            if (s.leveling) {
              s.leveling = false
              s.baseTiltY = 0
              s.angCor += target
              this.sendEvent(`DEBUG LEVEL ${side} DONE comp=${target.toFixed(3)}`)
            }
          })
          return
        }
        case 'PUSH': {
          const pv = (tokens[3] || '').toUpperCase()
          if (pv !== 'START' && pv !== 'STOP') {
            return this.reply('ERR PEDAL E_SYNTAX 缺少 START/STOP')
          }
          if (pv === 'STOP') {
            this.reply(`OK PEDAL ${side} PUSH STOP`)
            // 协议 §3.3.1：PUSH_STOPPED 在推出中或回零中被打断时均须上报
            if (s.pushing || s.homing) {
              s.pushing = false
              s.homing = false
              this.sendEvent(`DEBUG PEDAL ${side} PUSH_STOPPED`)
            }
            return
          }
          // PUSH START
          if (!this.motorEnabled) return this.reply('ERR PEDAL E_RANGE 该侧推杆电机未启用')
          if (s.pushDist <= 0) return this.reply('ERR PEDAL E_RANGE 请先设置推出距离')
          this.reply(`OK PEDAL ${side} PUSH START`)
          s.homing = true
          // 回零 2s → 推出 → 稳定 3s → STABLE
          this.later(2000, () => {
            s.homing = false
            if (s.flowRunning || true) {
              s.pushing = true
              s.pedalPos = 0
              const targetPulses = s.pushDist * this.pulsesPerMm
              this.later(2000, () => {
                if (s.pushing) {
                  s.pedalPos = targetPulses
                  this.later(3000, () => {
                    if (s.pushing) {
                      s.pushing = false
                      this.sendEvent(`DEBUG PEDAL ${side} STABLE`)
                    }
                  })
                }
              })
            }
          })
          return
        }
        case 'SET': {
          const key = (tokens[3] || '').toUpperCase()
          const value = tokens[4]
          if (!key || value === undefined) {
            return this.reply('ERR PEDAL E_SYNTAX 缺少参数名/值')
          }
          const validKeys = ['LASER_X', 'TILT_X', 'LASER_Y', 'TILT_Y', 'LASER', 'ANGLE_COMP', 'START_H', 'END_H', 'PUSH_DIST']
          if (!validKeys.includes(key)) {
            return this.reply('ERR PEDAL E_SYNTAX 未知参数名')
          }
          const num = Number(value)
          if (!Number.isFinite(num)) {
            return this.reply('ERR PEDAL E_SYNTAX 数值格式错误')
          }
          if (key === 'PUSH_DIST' && (num < 0 || num > 500)) {
            return this.reply('ERR PEDAL E_RANGE 数值超范围')
          }
          if (key === 'PUSH_DIST') s.pushDist = num
          // 协议 §2.8.7：仅 ANGLE_COMP 写入 angleComp；LASER_X/TILT_X/LASER/START_H 均为不使用预留位
          if (key === 'ANGLE_COMP') s.angleComp = num
          if (key === 'END_H') s.endH = num
          return this.reply('OK PEDAL')
        }
        case 'ZERO': {
          s.angleComp = 0
          return this.reply('OK PEDAL')
        }
        case 'CLEAR':
        case 'RECORD':
          return this.reply('OK PEDAL')
        default:
          return this.reply('ERR PEDAL E_SYNTAX')
      }
    }

    // PEDAL ZERO / CLEAR / RECORD（无侧别，全局）
    if (['ZERO', 'CLEAR', 'RECORD'].includes(second)) {
      return this.reply('OK PEDAL')
    }
    return this.reply('ERR PEDAL E_SYNTAX 缺少 A/B/NONE')
  }

  handleMotor(tokens) {
    const first = (tokens[1] || '').toUpperCase()
    // 全局操作
    if (first === 'ENABLE') {
      this.motorEnabled = true
      return this.reply('OK MOTOR')
    }
    if (first === 'DISABLE') {
      this.motorEnabled = false
      return this.reply('OK MOTOR')
    }
    if (first === 'STOP') {
      this.abortSide('A', 'STOPPED')
      this.abortSide('B', 'STOPPED')
      this.updateDevState()
      return this.reply('OK MOTOR')
    }
    // 单轴
    const axis = first
    const op = (tokens[2] || '').toUpperCase()
    const AXES = ['A', 'B', 'PUSH_A', 'PUSH_B']
    if (!AXES.includes(axis)) {
      return this.reply('ERR MOTOR E_AXIS 未知轴名')
    }
    if (!op) return this.reply('ERR MOTOR E_SYNTAX 缺少操作')

    // 手动操作中止该侧自动流程
    const side = axis === 'A' || axis === 'PUSH_A' ? 'A' : 'B'
    const s = this.sides[side]
    const wasFlow = s.flowRunning || s.leveling
    if (wasFlow) {
      this.abortSide(side, 'MANUAL_OVERRIDE')
      this.updateDevState()
    }

    switch (op) {
      case 'MOVE':
      case 'MOVEABS': {
        const pos = Number(tokens[3])
        if (!Number.isFinite(pos)) return this.reply('ERR MOTOR E_SYNTAX 缺少位置值')
        this.reply('OK MOTOR')
        if (axis === 'A' || axis === 'B') {
          s.angCor = op === 'MOVEABS' ? pos : s.angCor + pos
        } else {
          s.pedalPos = op === 'MOVEABS' ? pos * this.pulsesPerMm : Math.max(0, s.pedalPos + pos * this.pulsesPerMm)
        }
        return
      }
      case 'HOME': {
        this.reply('OK MOTOR')
        if (axis === 'A' || axis === 'B') {
          this.later(1000, () => { s.angCor = 0 })
        } else {
          this.later(2000, () => { s.pedalPos = 0 })
        }
        return
      }
      case 'STOP':
        s.pushing = false
        s.homing = false
        return this.reply('OK MOTOR')
      case 'ZERO':
        return this.reply('OK MOTOR')
      default:
        return this.reply('ERR MOTOR E_SYNTAX 未知操作')
    }
  }

  // ---- 遥测（协议 §3.2） ----

  telemetryLine() {
    const t = Date.now() - this.startMs
    const noise = () => (Math.random() - 0.5) * 0.02
    const f = (v, digits = 2) => (v === null ? 'nan' : v.toFixed(digits))

    const sel = this.pedalSelect
    const sides = { A: this.sides.A, B: this.sides.B }

    const field = (side) => {
      if (sel !== 'NONE' && sel !== side) return { tx: null, ty: null, laser: null, pedal: null, ang: 0 }
      const s = sides[side]
      const tSec = t / 1000
      let tx = s.baseTiltX + Math.sin(tSec / 7 + side.charCodeAt(0)) * 0.05 + noise()
      let ty = s.baseTiltY + Math.cos(tSec / 9) * 0.04 + noise()
      // 调平后趋零
      if (s.flowRunning) {
        ty *= Math.max(0, 1 - (tSec % 10) / 8)
      }
      let pedal = s.pedalPos
      if (s.pushing) pedal = Math.max(0, pedal + this.pulsesPerMm * 0.012)
      if (s.homing) pedal = Math.max(0, pedal - this.pulsesPerMm * 0.02)
      return {
        tx,
        ty,
        laser: s.baseLaser + Math.sin(tSec / 5) * 0.5 + noise() * 5,
        pedal,
        ang: s.angCor,
      }
    }

    const a = field('A')
    const b = field('B')

    // 转盘遥测：STEER_RUN 时方向盘 X/Y 做缓速正弦扫描（°）
    const steerActive = this.devState === 'STEER_RUN'
    const steerT = t / 1000
    const steerX = steerActive ? 30 * Math.sin(steerT / 3) : 0
    const steerY = steerActive ? 20 * Math.cos(steerT / 4) : 0

    return (
      `TELEMETRY t=${t}` +
      ` tilt_x=${f(this.commonTiltX + noise())} tilt_y=${f(this.commonTiltY + noise())}` +
      ` pedal_a_tilt_x=${f(a.tx, 3)} pedal_a_tilt_y=${f(a.ty, 3)}` +
      ` pedal_b_tilt_x=${f(b.tx, 3)} pedal_b_tilt_y=${f(b.ty, 3)}` +
      ` laser_a=${f(a.laser)} laser_b=${f(b.laser)}` +
      ` pedal_a=${f(a.pedal, 0)} pedal_b=${f(b.pedal, 0)}` +
      ` ang_cor_a=${f(a.ang, 3)} ang_cor_b=${f(b.ang, 3)}` +
      ` motor_a=0 motor_b=0 steer_x=${f(steerX)} steer_y=${f(steerY)} steer_free=0` +
      ` sensor=OK state=${this.devState} pedal_select=${this.pedalSelect}`
    )
  }

  restartTelemetry() {
    if (this.telemetryTimer) clearInterval(this.telemetryTimer)
    this.telemetryTimer = setInterval(() => {
      this.sendLine(this.telemetryLine())
    }, 1000 / this.reportHz)
  }

  destroy() {
    if (this.telemetryTimer) clearInterval(this.telemetryTimer)
    this.timers.forEach((t) => clearTimeout(t))
    this.timers.clear()
  }
}

// ============ TCP Server ============

const server = net.createServer((socket) => {
  console.log(`[mock] 客户端接入: ${socket.remoteAddress}:${socket.remotePort}`)
  const session = new DeviceSession(socket)
  session.restartTelemetry()

  let buf = ''
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r/g, '')
      buf = buf.slice(idx + 1)
      if (line.trim()) session.handleLine(line)
    }
  })

  // 15s 无数据断连（协议 §1.1）
  const watchdog = setInterval(() => {
    if (Date.now() - session.lastRxAt > DATA_TIMEOUT_MS) {
      console.log(`[mock] 心跳超时（15s 无数据），断开 ${socket.remoteAddress}`)
      socket.end()
    }
  }, 3000)

  socket.on('error', (e) => console.log('[mock] socket error:', e.message))
  socket.on('close', () => {
    clearInterval(watchdog)
    session.destroy()
    console.log('[mock] 客户端断开')
  })
})

server.listen(PORT, () => {
  console.log(`[mock] Xdesin mock 设备已启动: tcp://0.0.0.0:${PORT}（上位机连 192.168.4.1:${PORT} 或 127.0.0.1:${PORT}）`)
  console.log('[mock] 提示: 上位机连接时 host 填 127.0.0.1（本机模拟）')
})
