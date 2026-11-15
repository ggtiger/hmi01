/**
 * Xdesin 双板 mock 设备模拟器（A/B 两块板同时在线）
 *
 * 纯 Node（net + crypto），与 Rust crypto 层对拍：
 * - 帧: base64(nonce[2B BE] ‖ AES-128-CTR 密文 ‖ HMAC-MD5[16B]) + '\n'
 * - PSK: Xdesin0123456789；IV = 14×0x00 + nonce BE
 * - 明文调试入口: DEBUG PLAIN ON / OFF
 * - 每块板只上报本侧遥测（side / pedal_x_* / push_x_* / ang_cor_x）
 *
 * 默认启动：
 *   A 板 0.0.0.0:10001
 *   B 板 0.0.0.0:10002
 *
 * 用法：
 *   npm run mock:device
 *   MOCK_PORT_A=10001 MOCK_PORT_B=10002 node scripts/mock-device-server.js
 *   MOCK_SIDE=A MOCK_PORT_A=10001 node scripts/mock-device-server.js   # 仅单板
 *
 * 上位机本地联调：
 *   A: 127.0.0.1:10001
 *   B: 127.0.0.1:10002
 */
'use strict'

const net = require('net')
const crypto = require('crypto')

const PSK = Buffer.from('Xdesin0123456789', 'utf8')
const FW_VERSION = '1.1.0'
const HW_ID = 'esp32-s3'
const DEFAULT_SSID = 'Xdesin2016'
const DEFAULT_PASSWORD = '88888888'
const DATA_TIMEOUT_MS = 15000
const DEFAULT_PUSH_DIST = 80
const DEFAULT_PULSES_PER_MM = 787.4

const portA = Number(process.env.MOCK_PORT_A || process.env.MOCK_PORT || 10001)
const singleSide = (process.env.MOCK_SIDE || '').toUpperCase()
const portB = singleSide
  ? 0
  : Number(process.env.MOCK_PORT_B || (process.env.MOCK_PORT ? 0 : 10002))

// ============ 加密封装（协议 §1.2） ============

function makeIv(nonce) {
  const iv = Buffer.alloc(16)
  iv.writeUInt16BE(nonce & 0xFFFF, 14)
  return iv
}

function encryptLine(plainBuf, txNonce) {
  const nonceBuf = Buffer.alloc(2)
  nonceBuf.writeUInt16BE(txNonce & 0xFFFF, 0)
  const cipher = crypto.createCipheriv('aes-128-ctr', PSK, makeIv(txNonce))
  const ct = Buffer.concat([cipher.update(plainBuf), cipher.final()])
  const mac = crypto.createHmac('md5', PSK).update(nonceBuf).update(ct).digest()
  return Buffer.concat([nonceBuf, ct, mac]).toString('base64')
}

function decryptLine(line) {
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
  return { nonce, ct }
}

function decipher(nonce, ct) {
  const decipher = crypto.createDecipheriv('aes-128-ctr', PSK, makeIv(nonce))
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

function looksEncrypted(line) {
  return line.length >= 24 && /^[A-Za-z0-9+/=]+$/.test(line)
}

// ============ 板侧状态 ============

function newSideState() {
  return {
    flowRunning: false,
    leveling: false,
    pushing: false,
    homing: false,
    homed: true,
    pushDist: DEFAULT_PUSH_DIST,
    pedalMm: 0,
    pushSt: 2,                 // 推杆状态字：bit1=已回原点
    angleComp: 0,
    baseTiltX: 0.35 + Math.random() * 0.5,
    baseTiltY: -(0.2 + Math.random() * 0.5),
    baseLaser: 100 + Math.random() * 20,
    loadN: 0,
  }
}

class DeviceSession {
  constructor(socket, board) {
    this.socket = socket
    this.board = board
    this.side = board
    this.deviceId = `xdesin-s3-${board.toLowerCase()}`
    this.txNonce = 0
    this.lastRxNonce = null
    this.plainMode = false
    this.reportHz = 10
    this.pulsesPerMm = DEFAULT_PULSES_PER_MM
    this.pushFeed = 60
    this.levelSpeed = 120
    this.levelTol = 0.05
    this.levelRatio = 1.0
    this.levelMethod = 1
    this.ssid = DEFAULT_SSID
    this.password = DEFAULT_PASSWORD
    this.motorEnabled = true
    this.pedalSelect = 'NONE'
    this.fault = false
    this.steerRunning = false
    this.startMs = Date.now()
    this.lastRxAt = Date.now()
    this.s = newSideState()
    this.telemetryTimer = null
    this.timers = new Set()
    this.restartTelemetry()
  }

  log(...args) {
    console.log(`[mock:${this.side}] [${this.socket.remoteAddress || 'client'}]`, ...args)
  }

  // ---------- 收发 ----------

  sendPlain(line) {
    this.log('TX(plain)', line)
    if (!this.socket.destroyed) this.socket.write(line + '\n')
  }

  sendLine(line) {
    if (this.plainMode) {
      this.sendPlain(line)
      return
    }
    const nonce = this.txNonce
    this.txNonce = (this.txNonce + 1) & 0xFFFF
    const frame = encryptLine(Buffer.from(line, 'utf8'), nonce)
    this.log('TX', line)
    if (!this.socket.destroyed) this.socket.write(frame + '\n')
  }

  reply(line) {
    this.sendLine(line)
  }

  event(line) {
    this.sendLine(line)
  }

  later(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t)
      try { fn() } catch (e) { this.log('timer error', e.message) }
    }, ms)
    this.timers.add(t)
    return t
  }

  // ---------- 状态 ----------

  updateState() {
    if (this.fault) this.devState = 'FAULT'
    else if (this.steerRunning) this.devState = 'STEER_RUN'
    else if (this.s.flowRunning || this.s.pushing || this.s.homing || this.s.leveling) this.devState = 'PEDAL_RUN'
    else this.devState = 'IDLE'
  }

  stopMotion(reason = 'MANUAL_OVERRIDE') {
    const s = this.s
    if (s.pushing || s.homing) {
      s.pushing = false
      s.homing = false
      s.pushSt = s.homed ? 2 : 0
      this.event(`DEBUG PUSH ${this.side} STOPPED`)
    }
    if (s.leveling || s.flowRunning) {
      s.leveling = false
      s.flowRunning = false
      this.event(`DEBUG LEVEL ${this.side} ABORT ${reason}`)
    }
    this.updateState()
  }

  ownSideOrErr(tokens, head) {
    const side = (tokens[1] || '').toUpperCase()
    if (side === 'A' || side === 'B') {
      if (side !== this.side) {
        this.reply(`ERR ${head} E_RANGE 本板为 ${this.side} 侧`)
        return null
      }
      return side
    }
    this.reply(`ERR ${head} E_SYNTAX 侧别仅支持 A/B`)
    return null
  }

  // ---------- 接收 ----------

  handleLine(raw) {
    this.lastRxAt = Date.now()
    const line = raw.trim()
    if (!line) return

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
          this.dispatch(decipher(d.nonce, d.ct).toString('utf8'))
        } else {
          this.dispatch(line)
        }
      } else {
        this.dispatch(line)
      }
      return
    }

    // 加密模式：唯一允许的明文入口
    if (/^DEBUG PLAIN ON$/i.test(line)) {
      this.plainMode = true
      this.sendPlain('OK DEBUG PLAIN ON')
      return
    }

    const d = decryptLine(line)
    if (!d) {
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
    this.dispatch(decipher(d.nonce, d.ct).toString('utf8'))
  }

  dispatch(line) {
    this.log('RX', line)
    const tokens = line.split(/\s+/)
    const cmd = (tokens[0] || '').toUpperCase()

    switch (cmd) {
      case 'PING':
        return this.reply('PONG')
      case 'HELLO':
        // 新固件格式：HELLO OK <device_id>（不含 fw）
        return this.reply(`HELLO OK ${this.deviceId}`)
      case 'INFO':
        return this.reply(
          `INFO fw=${FW_VERSION} side=${this.side} hw=${HW_ID} uptime=${Math.floor((Date.now() - this.startMs) / 1000)} ssid=${this.ssid}`
        )
      case 'ESTOP':
        this.fault = true
        this.s.flowRunning = false
        this.s.leveling = false
        this.s.pushing = false
        this.s.homing = false
        this.s.pushSt = 0
        this.updateState()
        return this.reply('OK ESTOP')
      case 'RESET':
        if ((tokens[1] || '').toUpperCase() !== 'FAULT') {
          return this.reply('ERR RESET E_SYNTAX 仅支持 RESET FAULT')
        }
        this.fault = false
        this.motorEnabled = false
        this.s.flowRunning = false
        this.s.leveling = false
        this.s.pushing = false
        this.s.homing = false
        this.s.pushSt = 0
        this.updateState()
        return this.reply('OK RESET FAULT')
      case 'DEBUG':
        return this.handleDebug(tokens)
      case 'SET':
        return this.handleSet(tokens)
      case 'GET':
        return this.handleGet(tokens)
      case 'SCAN':
        return this.handleScan(tokens)
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

  handleDebug(tokens) {
    const sub = (tokens[1] || '').toUpperCase()
    if (sub === 'ON' || sub === 'OFF') return this.reply('OK DEBUG')
    if (sub === 'PLAIN') {
      const v = (tokens[2] || '').toUpperCase()
      if (v === 'ON') {
        const nonce = this.txNonce
        this.txNonce = (this.txNonce + 1) & 0xFFFF
        this.plainMode = true
        const frame = encryptLine(Buffer.from('OK DEBUG PLAIN ON', 'utf8'), nonce)
        this.log('TX(last-encrypted)', 'OK DEBUG PLAIN ON')
        if (!this.socket.destroyed) this.socket.write(frame + '\n')
        return
      }
      if (v === 'OFF') {
        this.plainMode = false
        return this.reply('OK DEBUG PLAIN OFF')
      }
      return this.reply('ERR DEBUG E_SYNTAX 参数缺失或非法值')
    }
    return this.reply('ERR DEBUG E_SYNTAX 参数缺失或非法值')
  }

  handleSet(tokens) {
    const key = (tokens[1] || '').toUpperCase()
    const raw = tokens[2]
    if (!key) return this.reply('ERR SET E_SYNTAX 参数缺失')

    const num = () => Number(raw)

    switch (key) {
      case 'REPORT': {
        const hz = num()
        if (!Number.isFinite(hz) || hz < 1 || hz > 50) return this.reply('ERR SET E_RANGE 频率 1-50Hz')
        this.reportHz = hz
        this.restartTelemetry()
        return this.reply(`OK SET REPORT ${hz}`)
      }
      case 'PUSH_PULSES_PER_MM': {
        const v = num()
        if (!Number.isFinite(v) || v < 10 || v > 10000) return this.reply('ERR SET E_RANGE 10-10000')
        this.pulsesPerMm = v
        return this.reply(`OK SET PUSH_PULSES_PER_MM ${v}`)
      }
      case 'PUSH_FEED': {
        const v = num()
        if (!Number.isFinite(v) || v < 1 || v > 500) return this.reply('ERR SET E_RANGE 1-500')
        this.pushFeed = v
        return this.reply(`OK SET PUSH_FEED ${v}`)
      }
      case 'LEVEL_SPEED': {
        const v = num()
        if (!Number.isFinite(v) || v < 1 || v > 360) return this.reply('ERR SET E_RANGE 1-360')
        this.levelSpeed = v
        return this.reply(`OK SET LEVEL_SPEED ${v}`)
      }
      case 'LEVEL_TOL': {
        const v = num()
        if (!Number.isFinite(v) || v < 0.001 || v > 5) return this.reply('ERR SET E_RANGE 0.001-5')
        this.levelTol = v
        return this.reply(`OK SET LEVEL_TOL ${v}`)
      }
      case 'LEVEL_RATIO': {
        const v = num()
        if (!Number.isFinite(v) || v < 0.01 || v > 100) return this.reply('ERR SET E_RANGE 0.01-100')
        this.levelRatio = v
        return this.reply(`OK SET LEVEL_RATIO ${v}`)
      }
      case 'LEVEL_METHOD': {
        const v = Math.round(num())
        if (v !== 1 && v !== 2) return this.reply('ERR SET E_RANGE 补正模式 1/2')
        this.levelMethod = v
        return this.reply(`OK SET LEVEL_METHOD ${v}`)
      }
      case 'MSH_ZERO_CLEAR':
        this.s.angleComp = 0
        return this.reply('OK SET MSH_ZERO_CLEAR')
      case 'SIDE': {
        const next = (raw || '').toUpperCase()
        if (next !== 'A' && next !== 'B') return this.reply('ERR SET E_RANGE 侧别仅支持 A/B')
        this.side = next
        this.deviceId = `xdesin-s3-${next.toLowerCase()}`
        this.updateState()
        return this.reply(`OK SET SIDE ${next}`)
      }
      default:
        return this.reply('ERR SET E_SYNTAX 未知参数')
    }
  }

  handleGet(tokens) {
    if ((tokens[1] || '').toUpperCase() !== 'PARAMS') {
      return this.reply('ERR GET E_SYNTAX 仅支持 GET PARAMS')
    }
    const params = [
      `report_hz=${this.reportHz}`,
      `push_pulses_per_mm=${this.pulsesPerMm}`,
      `push_feed_rpm=${this.pushFeed}`,
      `level_speed=${this.levelSpeed}`,
      `level_tol=${this.levelTol}`,
      `level_ratio=${this.levelRatio}`,
      `level_method=${this.levelMethod}`,
      `side=${this.side}`,
    ].join(' ')
    this.sendLine(`PARAMS ${params}`)
    return this.reply('OK GET')
  }

  handleScan(tokens) {
    const start = Number(tokens[1] || 1)
    const end = Number(tokens[2] || 32)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end > 32 || end < start) {
      return this.reply('ERR SCAN E_RANGE 扫描范围 1-32')
    }
    // 无固定 OK 应答：结果以异步日志行返回
    const found = [1, 10, 11].filter((x) => x >= start && x <= end)
    this.sendLine(`SCAN start=${start} end=${end} found=${found.join(',') || 'none'}`)
    this.sendLine(`SCAN side=${this.side} addr=${this.side === 'A' ? 10 : 11} type=push_driver`)
  }

  handleNet(tokens) {
    const sub = (tokens[1] || '').toUpperCase()
    if (sub === 'GETCFG') return this.reply(`NETCFG ssid=${this.ssid} pass=********`)
    if (sub === 'SETCFG') {
      const [, , oldPass, newSsid, ...rest] = tokens
      const newPass = rest.join(' ')
      if (!oldPass || !newSsid || !newPass) return this.reply('ERR NET E_SYNTAX 参数缺失')
      if (oldPass !== this.password) return this.reply('ERR NET E_RANGE 密码错误')
      if (newSsid.length < 1 || newSsid.length > 32 || newPass.length < 8 || newPass.length > 64) {
        return this.reply('ERR NET E_RANGE SSID/密码长度超范围')
      }
      this.ssid = newSsid
      this.password = newPass
      return this.reply('OK NET 已保存，重启后生效')
    }
    if (sub === 'RESET') {
      const pass = tokens[2]
      if (!pass) return this.reply('ERR NET E_SYNTAX 参数缺失')
      if (pass !== this.password && pass !== 'XDESIN2026') {
        return this.reply('ERR NET E_RANGE 密码错误')
      }
      this.ssid = DEFAULT_SSID
      this.password = DEFAULT_PASSWORD
      return this.reply('OK NET 已恢复默认，重启后生效')
    }
    return this.reply('ERR NET E_SYNTAX 参数缺失或未知操作')
  }

  handlePedal(tokens) {
    const second = (tokens[1] || '').toUpperCase()

    // PEDAL SELECT A/B/NONE
    if (second === 'SELECT') {
      const target = (tokens[2] || '').toUpperCase()
      if (!['A', 'B', 'NONE'].includes(target)) {
        return this.reply('ERR PEDAL E_SYNTAX 仅支持 A/B/NONE')
      }
      if (this.pedalSelect !== 'NONE' && target !== this.pedalSelect) {
        this.stopMotion('MANUAL_OVERRIDE')
      }
      this.pedalSelect = target
      this.updateState()
      return this.reply('OK PEDAL')
    }

    // 兼容旧协议：PEDAL TEST START / STOP
    if (second === 'TEST') {
      const op = (tokens[2] || '').toUpperCase()
      if (op === 'START') {
        if (this.fault) return this.reply('ERR PEDAL E_FAULT 故障态')
        this.s.flowRunning = true
        this.updateState()
        this.reply('OK PEDAL TEST START')
        this.later(1800, () => {
          if (!this.s.flowRunning) return
          this.s.baseTiltX = 0
          this.s.baseTiltY = 0
          this.event(`DEBUG PEDAL ${this.side} LEVELED`)
        })
        return
      }
      if (op === 'STOP') {
        this.stopMotion('MANUAL_OVERRIDE')
        return this.reply('OK PEDAL TEST STOP')
      }
      return this.reply('ERR PEDAL E_SYNTAX 缺少 START/STOP')
    }

    // 全局 PEDAL ZERO/CLEAR/RECORD
    if (['ZERO', 'CLEAR', 'RECORD'].includes(second)) {
      if (second === 'ZERO') this.s.angleComp = 0
      return this.reply('OK PEDAL')
    }

    const side = this.ownSideOrErr(tokens, 'PEDAL')
    if (!side) return
    const op = (tokens[2] || '').toUpperCase()
    const s = this.s

    switch (op) {
      case 'START': {
        if (this.fault) return this.reply('ERR PEDAL E_FAULT 故障态，请先 RESET FAULT')
        if (!this.motorEnabled) return this.reply('ERR PEDAL E_RANGE 运动前需 MOTOR ENABLE')
        if (this.pedalSelect !== 'NONE' && this.pedalSelect !== side) {
          return this.reply(`ERR PEDAL E_RANGE 当前选中 ${this.pedalSelect} 侧，无法启动 ${side}`)
        }
        this.reply(`OK PEDAL ${side} START`)
        s.flowRunning = true
        this.updateState()
        this.later(1800, () => {
          if (!s.flowRunning) return
          s.baseTiltX = 0
          s.baseTiltY = 0
          this.event(`DEBUG PEDAL ${side} LEVELED`)
        })
        return
      }
      case 'STOP': {
        this.reply(`OK PEDAL ${side} STOP`)
        this.stopMotion('MANUAL_OVERRIDE')
        return
      }
      case 'SETLOAD': {
        const n = Number(tokens[3])
        if (!Number.isFinite(n) || n < 0 || n > 500) return this.reply('ERR PEDAL E_RANGE 力值 0-500N')
        s.loadN = n
        return this.reply('OK PEDAL')
      }
      case 'LEVEL': {
        if (this.fault) return this.reply('ERR PEDAL E_FAULT 故障态，请先 RESET FAULT')
        if (!this.motorEnabled) return this.reply('ERR PEDAL E_RANGE 运动前需 MOTOR ENABLE')
        if (this.pedalSelect !== 'NONE' && this.pedalSelect !== side) {
          return this.reply(`ERR PEDAL E_RANGE 当前选中 ${this.pedalSelect} 侧，无法补偿 ${side}`)
        }
        this.reply(`OK PEDAL ${side} LEVEL`)
        s.leveling = true
        this.updateState()
        this.event(`DEBUG LEVEL ${side} START`)
        const comp = Number((-(s.baseTiltY) * this.levelRatio).toFixed(3))
        this.later(1200 + Math.random() * 600, () => {
          if (!s.leveling) return
          s.leveling = false
          s.baseTiltX = 0
          s.baseTiltY = 0
          s.angleComp += comp
          this.event(`DEBUG LEVEL ${side} DONE comp=${comp}`)
          this.updateState()
        })
        return
      }
      case 'PUSH': {
        const pv = (tokens[3] || '').toUpperCase()
        if (pv === 'STOP') {
          this.reply(`OK PEDAL ${side} PUSH STOP`)
          if (s.pushing || s.homing) {
            s.pushing = false
            s.homing = false
            s.pushSt = s.homed ? 2 : 0
            this.event(`DEBUG PUSH ${side} STOPPED`)
            this.event(`DEBUG PEDAL ${side} PUSH_STOPPED`)
          }
          this.updateState()
          return
        }
        if (pv !== 'START') return this.reply('ERR PEDAL E_SYNTAX 缺少 START/STOP')
        if (this.fault) return this.reply('ERR PEDAL E_FAULT 故障态，请先 RESET FAULT')
        if (!this.motorEnabled) return this.reply('ERR PEDAL E_RANGE 推杆电机未启用')
        if (s.pushDist <= 0) return this.reply('ERR PEDAL E_RANGE 请先设置推出距离')

        this.reply(`OK PEDAL ${side} PUSH START`)
        if (!s.homed) {
          s.homing = true
          s.pushSt = 0
          this.updateState()
          this.event(`DEBUG PUSH ${side} HOMING`)
          this.later(1400, () => {
            s.homing = false
            s.homed = true
            s.pushSt = 2
            this.event(`DEBUG PUSH ${side} STARTED`)
            this.runPush(side)
          })
        } else {
          this.event(`DEBUG PUSH ${side} STARTED`)
          this.runPush(side)
        }
        return
      }
      case 'SET': {
        const key = (tokens[3] || '').toUpperCase()
        const value = tokens[4]
        if (!key || value === undefined) return this.reply('ERR PEDAL E_SYNTAX 缺少参数名/值')
        const validKeys = ['PUSH_DIST', 'START_H', 'END_H', 'ANGLE_COMP', 'TILT_X', 'TILT_Y', 'LASER']
        if (!validKeys.includes(key)) return this.reply('ERR PEDAL E_SYNTAX 未知参数名')
        const v = Number(value)
        if (!Number.isFinite(v)) return this.reply('ERR PEDAL E_SYNTAX 数值格式错误')
        if (key === 'PUSH_DIST') {
          if (v < 0 || v > 500) return this.reply('ERR PEDAL E_RANGE 0-500 mm')
          s.pushDist = v
        }
        if (key === 'ANGLE_COMP') s.angleComp = v
        return this.reply('OK PEDAL')
      }
      case 'ZERO':
        s.angleComp = 0
        return this.reply('OK PEDAL')
      case 'CLEAR':
      case 'RECORD':
        return this.reply('OK PEDAL')
      default:
        return this.reply('ERR PEDAL E_SYNTAX')
    }
  }

  runPush(side) {
    const s = this.s
    const target = s.pushDist
    const steps = 12
    let i = 0
    s.pushing = true
    s.pushSt = 6
    this.updateState()
    const step = () => {
      if (!s.pushing) return
      i++
      s.pedalMm = Number(((target * i) / steps).toFixed(2))
      if (i < steps) {
        this.later(80, step)
      } else {
        s.pushing = false
        s.pushSt = 2
        this.event(`DEBUG PUSH ${side} DONE`)
        if (s.flowRunning) {
          this.later(1000, () => {
            if (!s.flowRunning) return
            this.event(`DEBUG PEDAL ${side} STABLE`)
            s.flowRunning = false
            this.updateState()
          })
        } else {
          this.updateState()
        }
      }
    }
    this.later(120, step)
  }

  handleMotor(tokens) {
    const first = (tokens[1] || '').toUpperCase()
    if (first === 'ENABLE') {
      if (this.fault) return this.reply('ERR MOTOR E_FAULT 故障态，请先 RESET FAULT')
      this.motorEnabled = true
      this.s.pushSt = this.s.homed ? 2 : 0
      return this.reply('OK MOTOR')
    }
    if (first === 'DISABLE') {
      this.motorEnabled = false
      this.stopMotion('MANUAL_OVERRIDE')
      this.s.pushSt = 0
      return this.reply('OK MOTOR')
    }
    if (first === 'STOP') {
      this.stopMotion('MANUAL_OVERRIDE')
      return this.reply('OK MOTOR')
    }

    const axis = first
    const op = (tokens[2] || '').toUpperCase()
    const angleAxis = this.side
    const pushAxis = `PUSH_${this.side}`
    if (axis !== angleAxis && axis !== pushAxis) {
      return this.reply(`ERR MOTOR E_AXIS 本板轴名为 ${angleAxis}/${pushAxis}`)
    }
    if (!op) return this.reply('ERR MOTOR E_SYNTAX 缺少操作')
    if (this.fault && ['HOME', 'MOVE', 'MOVEABS', 'ENABLE'].includes(op)) {
      return this.reply('ERR MOTOR E_FAULT 故障态，请先 RESET FAULT')
    }
    if (!this.motorEnabled && ['HOME', 'MOVE', 'MOVEABS'].includes(op)) {
      return this.reply('ERR MOTOR E_RANGE 运动前需 MOTOR ENABLE')
    }

    const s = this.s
    const isPush = axis === pushAxis

    // 协议 §6.2：手动 MOVE/HOME/STOP 自动中止该侧自动流程，避免闭环抢占
    if (['HOME', 'MOVE', 'MOVEABS', 'STOP'].includes(op) && (s.flowRunning || s.leveling)) {
      this.stopMotion('MANUAL_OVERRIDE')
    }

    switch (op) {
      case 'HOME': {
        this.reply('OK MOTOR')
        if (isPush) {
          s.homing = true
          s.pushSt = 0
          this.updateState()
          this.event(`DEBUG PUSH ${this.side} HOMING`)
          this.later(1400, () => {
            // 手动回零没有 DONE 事件：完成状态通过 TELEMETRY.push_*_st Bit1 上报
            s.homing = false
            s.homed = true
            s.pedalMm = 0
            s.pushSt = 2
            this.updateState()
          })
        } else {
          this.event(`DEBUG HOME ${this.side} START`)
          this.later(900, () => {
            s.angleComp = 0
            this.event(`DEBUG HOME ${this.side} DONE`)
          })
        }
        return
      }
      case 'MOVE':
      case 'MOVEABS': {
        const pos = Number(tokens[3])
        if (!Number.isFinite(pos)) return this.reply('ERR MOTOR E_SYNTAX 缺少位置值')
        this.reply('OK MOTOR')
        if (isPush) {
          s.pedalMm = op === 'MOVEABS' ? Math.max(0, pos) : Math.max(0, s.pedalMm + pos)
          s.pushSt = 6
          this.updateState()
          this.later(250, () => {
            if (!s.pushing && !s.homing) {
              s.pushSt = s.homed ? 2 : 0
              this.updateState()
            }
          })
        } else {
          s.angleComp = op === 'MOVEABS' ? pos : s.angleComp + pos
        }
        return
      }
      case 'STOP': {
        if (s.pushing || s.homing) {
          s.pushing = false
          s.homing = false
          s.pushSt = s.homed ? 2 : 0
          this.event(`DEBUG PUSH ${this.side} STOPPED`)
        }
        this.updateState()
        return this.reply('OK MOTOR')
      }
      case 'ZERO': {
        if (isPush) {
          s.pedalMm = 0
          s.homed = true
          s.pushSt = 2
          return this.reply('OK MOTOR ZERO raw=0')
        }
        s.angleComp = 0
        return this.reply('OK MOTOR')
      }
      default:
        return this.reply('ERR MOTOR E_SYNTAX 未知操作')
    }
  }

  handleSteer(tokens) {
    const op = (tokens[1] || '').toUpperCase()
    if (op === 'START') {
      if (this.fault) return this.reply('ERR STEER E_FAULT 故障态，请先 RESET FAULT')
      this.steerRunning = true
      this.updateState()
      return this.reply('OK STEER')
    }
    if (op === 'STOP') {
      this.steerRunning = false
      this.updateState()
      return this.reply('OK STEER')
    }
    return this.reply('ERR STEER E_SYNTAX 缺少 START/STOP')
  }

  // ---------- 遥测 ----------

  telemetryLine() {
    const t = Date.now() - this.startMs
    const s = this.s
    const noise = () => (Math.random() - 0.5) * 0.02
    const suf = this.side.toLowerCase()
    const f = (v, d = 3) => (v === null || v === undefined ? 'nan' : Number(v).toFixed(d))

    let tx = s.baseTiltX + Math.sin(t / 7000) * 0.04 + noise()
    let ty = s.baseTiltY + Math.cos(t / 9000) * 0.03 + noise()
    if (s.leveling) {
      tx *= 0.35
      ty *= 0.35
    }
    if (this.fault) {
      tx = 0.85
      ty = -0.62
    }
    const laser = s.baseLaser + Math.sin(t / 5000) * 0.8 + noise() * 4
    const pedalMm = Math.max(0, s.pedalMm)
    const pushRaw = Math.round(pedalMm * this.pulsesPerMm)
    const steerActive = this.steerRunning
    const steerX = steerActive ? 30 * Math.sin(t / 3000) : 0
    const steerY = steerActive ? 20 * Math.cos(t / 4000) : 0

    const parts = [
      `TELEMETRY t=${t}`,
      `side=${this.side}`,
      `pedal_${suf}_tilt_x=${f(tx)}`,
      `pedal_${suf}_tilt_y=${f(ty)}`,
      `laser_${suf}=${f(laser, 2)}`,
      `pedal_${suf}=${f(pedalMm, 2)}`,
      `push_${suf}_raw=${pushRaw}`,
      `push_${suf}_st=${s.pushSt}`,
      `ang_cor_${suf}=${f(s.angleComp)}`,
      `steer_x=${f(steerX, 2)}`,
      `steer_y=${f(steerY, 2)}`,
      `steer_free=0`,
      `sensor=OK`,
      `state=${this.devState}`,
      `pedal_select=${this.pedalSelect}`,
    ]
    return parts.join(' ')
  }

  restartTelemetry() {
    if (this.telemetryTimer) clearInterval(this.telemetryTimer)
    this.telemetryTimer = setInterval(() => {
      this.sendLine(this.telemetryLine())
    }, 1000 / this.reportHz)
  }

  destroy() {
    if (this.telemetryTimer) clearInterval(this.telemetryTimer)
    this.telemetryTimer = null
    this.timers.forEach((t) => clearTimeout(t))
    this.timers.clear()
  }
}

// ============ 服务器 ============

function startBoard(side, port) {
  const server = net.createServer((socket) => {
    console.log(`[mock:${side}] 客户端接入 ${socket.remoteAddress}:${socket.remotePort}`)
    const session = new DeviceSession(socket, side)
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

    const watchdog = setInterval(() => {
      if (Date.now() - session.lastRxAt > DATA_TIMEOUT_MS) {
        console.log(`[mock:${side}] 心跳超时，断开 ${socket.remoteAddress}`)
        socket.end()
      }
    }, 3000)

    socket.on('error', (e) => console.log(`[mock:${side}] socket error:`, e.message))
    socket.on('close', () => {
      clearInterval(watchdog)
      session.destroy()
      console.log(`[mock:${side}] 客户端断开`)
    })
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`[mock:${side}] 已启动 tcp://0.0.0.0:${port}`)
  })
  server.on('error', (e) => {
    console.error(`[mock:${side}] 启动失败 (${port}):`, e.message)
  })
  return server
}

const servers = []
if (singleSide) {
  servers.push(startBoard(singleSide, portA))
} else {
  servers.push(startBoard('A', portA))
  if (portB && portB !== portA) servers.push(startBoard('B', portB))
}

console.log('')
console.log('[mock] 上位机本地联调参数：')
console.log(`[mock]   A 板: 127.0.0.1:${portA}`)
if (!singleSide && portB && portB !== portA) console.log(`[mock]   B 板: 127.0.0.1:${portB}`)
console.log('[mock] 注意：App 的 B 板端口默认 10001，本地联调请把 B 板端口改成上面打印的端口。')
console.log('')

process.on('SIGINT', () => {
  servers.forEach((s) => s.close())
  process.exit(0)
})
