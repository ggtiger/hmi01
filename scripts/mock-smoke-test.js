#!/usr/bin/env node
/**
 * 双板 mock 冒烟测试：真实 TCP + 明文协议，覆盖 plain_test_host.py 用到的全部命令。
 *
 * 用法：node scripts/mock-smoke-test.js
 * 会自动在 19201/19202 启动 mock，跑完自动退出；不需要先运行 npm run mock:device。
 */
'use strict'

const { spawn } = require('child_process')
const path = require('path')
const net = require('net')

const PORT_A = 19201
const PORT_B = 19202
const TIMEOUT = 6000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function startMock() {
  const child = spawn(process.execPath, [path.join(__dirname, 'mock-device-server.js')], {
    env: { ...process.env, MOCK_SIDE: '', MOCK_PORT_A: String(PORT_A), MOCK_PORT_B: String(PORT_B) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (d) => { output += d.toString() })
  child.stderr.on('data', (d) => { output += d.toString() })

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000
    const poll = () => {
      if (output.includes(`已启动 tcp://0.0.0.0:${PORT_A}`) && output.includes(`已启动 tcp://0.0.0.0:${PORT_B}`)) {
        return resolve(child)
      }
      if (Date.now() > deadline) {
        child.kill()
        return reject(new Error('mock 启动超时:\n' + output))
      }
      setTimeout(poll, 50)
    }
    child.once('error', reject)
    poll()
  })
}

function createClient(side, port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port })
    const lines = []
    let cursor = 0
    let buf = ''
    const waiters = []

    const isReply = (l) =>
      !l.startsWith('TELEMETRY') &&
      !l.startsWith('DEBUG ') &&
      !l.startsWith('PARAMS ') &&
      !l.startsWith('SCAN ')

    sock.on('data', (d) => {
      buf += d.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        const idx = lines.length
        lines.push(line)
        for (let j = waiters.length - 1; j >= 0; j--) {
          if (waiters[j].pred(line)) {
            const [w] = waiters.splice(j, 1)
            clearTimeout(w.timer)
            cursor = idx + 1
            w.resolve(line)
          }
        }
      }
    })
    sock.on('error', reject)

    const send = (line) => sock.write(line + '\n')

    function waitFrom(pred, label, timeout = TIMEOUT, consume = true) {
      for (let i = cursor; i < lines.length; i++) {
        if (pred(lines[i])) {
          if (consume) cursor = i + 1
          return Promise.resolve(lines[i])
        }
      }
      return new Promise((res, rej) => {
        const w = {
          pred,
          resolve: (line) => {
            if (!consume) cursor = lines.indexOf(line) + 1
            res(line)
          },
          timer: setTimeout(() => {
            const at = waiters.indexOf(w)
            if (at >= 0) waiters.splice(at, 1)
            rej(new Error(`[${side}] 等待 ${label} 超时\n最近日志:\n${lines.slice(-14).join('\n')}`))
          }, timeout),
        }
        waiters.push(w)
      })
    }

    async function cmd(line, expect = null) {
      send(line)
      const reply = await waitFrom(expect || isReply, line)
      if (reply.startsWith('ERR')) throw new Error(`[${side}] ${line} => ${reply}`)
      return reply
    }

    async function cmdErr(line, code) {
      send(line)
      const reply = await waitFrom((l) => l.startsWith('ERR '), `${line} ERR`)
      assert(reply.includes(code), `[${side}] ${line} 期望 ${code}，实际 ${reply}`)
      return reply
    }

    async function event(pred, label, timeout = TIMEOUT) {
      return waitFrom(pred, label, timeout)
    }

    async function telemetry(pred, label, timeout = TIMEOUT) {
      return waitFrom(pred, label, timeout)
    }

    async function close() {
      sock.end()
      await sleep(50)
    }

    ;(async () => {
      await new Promise((res, rej) => {
        sock.once('connect', res)
        sock.once('error', rej)
      })
      resolve({ side, cmd, cmdErr, event, telemetry, send, waitFrom, close, lines })
    })().catch(reject)
  })
}

async function runBoard(side, port, full) {
  const c = await createClient(side, port)
  const l = side.toLowerCase()
  const suffix = `${side}`

  // 明文握手 + 基础命令
  c.send('DEBUG PLAIN ON')
  await c.waitFrom((x) => x === 'OK DEBUG PLAIN ON', 'PLAIN ON')
  await sleep(100)
  await c.cmd('PING')
  const hello = await c.cmd('HELLO xdesin-host')
  assert(hello === `HELLO OK xdesin-s3-${l}`, `HELLO 异常: ${hello}`)
  const info = await c.cmd('INFO')
  assert(info.includes(`side=${suffix}`), `INFO 缺少 side: ${info}`)
  await c.cmd('INFO GET') // 旧固件兼容形式
  await c.cmd('DEBUG ON')
  await c.cmd('DEBUG OFF')
  const net = await c.cmd('NET GETCFG')
  assert(net.startsWith('NETCFG ssid='), `NET GETCFG 异常: ${net}`)
  await c.cmdErr('NET RESET 00000000', 'E_RANGE')
  await c.cmd('NET SETCFG 88888888 MockNet newpass123')
  const net2 = await c.cmd('NET GETCFG')
  assert(net2.includes('MockNet'), `NET SETCFG 未生效: ${net2}`)
  await c.cmd('NET RESET XDESIN2026')

  // 参数：Python 工具用到的 + 完整 SET 覆盖
  await c.cmd('SET REPORT 20')
  await c.cmd('SET REPORT 10')
  c.send('GET PARAMS')
  const params = await c.waitFrom((x) => x.startsWith('PARAMS '), 'PARAMS')
  assert(params.includes('push_pulses_per_mm='), `PARAMS 缺字段: ${params}`)
  assert(params.includes(`side=${suffix}`), `PARAMS 缺 side: ${params}`)
  await c.waitFrom((x) => x === 'OK GET', 'OK GET')
  await c.cmd('SET LEVEL_METHOD 2')
  await c.cmd('SET PUSH_PULSES_PER_MM 800')
  await c.cmd('SET PUSH_FEED 80')
  await c.cmd('SET LEVEL_SPEED 180')
  await c.cmd('SET LEVEL_TOL 0.1')
  await c.cmd('SET LEVEL_RATIO 1.1')
  await c.cmd('SET SIDE ' + side)
  await c.cmd('SET MSH_ZERO_CLEAR')
  await c.cmdErr('SET PUSH_FEED 999', 'E_RANGE')
  await c.cmdErr('SET NOPE 1', 'E_SYNTAX')

  // 侧别 + 单步命令
  await c.cmd('PEDAL SELECT NONE')
  await c.cmd('PEDAL SELECT ' + side)
  await c.cmd('PEDAL SELECT ' + (side === 'A' ? 'B' : 'A')) // mock 允许改选，自动中止
  await c.cmd('PEDAL SELECT ' + side)
  await c.cmd(`PEDAL ${side} SET PUSH_DIST 100`)
  await c.cmd(`PEDAL ${side} SETLOAD 20`)
  await c.cmd(`PEDAL ${side} CLEAR`)
  await c.cmd(`PEDAL ${side} RECORD`)
  await c.cmd(`PEDAL ${side} ZERO`)
  await c.cmd('PEDAL CLEAR')
  await c.cmd('PEDAL RECORD')
  await c.cmd('PEDAL ZERO')
  await c.cmd(`PEDAL ${side} PUSH STOP`)
  await c.cmd(`MOTOR ${side} MOVE 0.1`)
  await c.cmd(`MOTOR PUSH_${side} MOVE 1`)
  await c.cmd(`MOTOR PUSH_${side} MOVEABS 10`)
  await c.cmd(`MOTOR PUSH_${side} ZERO`)
  await c.cmd(`MOTOR ${side} HOME`)
  await c.event((x) => x === `DEBUG HOME ${side} START`, 'HOME START')
  await c.event((x) => x === `DEBUG HOME ${side} DONE`, 'HOME DONE')
  await c.cmd(`MOTOR ${side} ZERO`)
  await c.cmd(`MOTOR PUSH_${side} ZERO`)
  await c.cmd('MOTOR DISABLE')
  await c.cmd('MOTOR ENABLE')
  await c.cmd('MOTOR STOP')
  await c.cmd(`MOTOR PUSH_${side} STOP`)
  await c.cmd('STEER START')
  await c.telemetry((x) => x.startsWith('TELEMETRY') && x.includes('state=STEER_RUN'), 'STEER telemetry')
  await c.cmd('STEER STOP')

  // 推杆回零（手动回零无 DONE 事件，看状态字 Bit1）
  await c.cmd(`MOTOR PUSH_${side} HOME`)
  await c.event((x) => x === `DEBUG PUSH ${side} HOMING`, 'PUSH HOMING')
  await c.telemetry((x) => x.startsWith('TELEMETRY') && x.includes(`push_${l}_st=2`), 'push homed')

  // 手动调平
  await c.cmd(`PEDAL ${side} LEVEL`)
  await c.event((x) => x === `DEBUG LEVEL ${side} START`, 'LEVEL START')
  await c.event((x) => x.startsWith(`DEBUG LEVEL ${side} DONE comp=`), 'LEVEL DONE')

  // 自动流程 + 推出 + STABLE
  await c.cmd(`PEDAL ${side} START`)
  await c.event((x) => x === `DEBUG PEDAL ${side} LEVELED`, 'LEVELED', 5000)
  await c.cmd(`PEDAL ${side} PUSH START`)
  await c.event((x) => x === `DEBUG PUSH ${side} STARTED`, 'PUSH STARTED')
  await c.event((x) => x === `DEBUG PUSH ${side} DONE`, 'PUSH DONE', 5000)
  await c.event((x) => x === `DEBUG PEDAL ${side} STABLE`, 'STABLE', 5000)
  const t = await c.telemetry(
    (x) => x.startsWith('TELEMETRY') && x.includes(`push_${l}_raw=`) && /push_[ab]_raw=(\d+)/.test(x),
    'push telemetry'
  )
  const raw = Number(/push_[ab]_raw=(\d+)/.exec(t)[1])
  assert(raw >= 70000, `推出后原始脉冲异常: ${raw}`)
  assert(t.includes(`side=${suffix}`), `TELEMETRY 缺 side: ${t}`)
  assert(t.includes(`pedal_${l}=100`), `TELEMETRY pedal 不是 mm: ${t}`)
  assert(t.includes('sensor=OK'), `TELEMETRY sensor 异常: ${t}`)

  // SCAN / PEDAL TEST / STOP
  c.send('SCAN 1 32')
  await c.waitFrom((x) => x.startsWith('SCAN start=1 end=32'), 'SCAN result')
  await c.waitFrom((x) => x.startsWith('SCAN side='), 'SCAN side')
  await c.cmd('PEDAL TEST START')
  await c.event((x) => x === `DEBUG PEDAL ${side} LEVELED`, 'TEST LEVELED', 5000)
  await c.cmd('PEDAL TEST STOP')
  await c.cmd(`PEDAL ${side} START`)
  await c.cmd(`PEDAL ${side} STOP`)

  // 故障态：ESTOP → 运动拒绝 → RESET → 显式使能
  await c.cmd('ESTOP')
  await c.telemetry((x) => x.startsWith('TELEMETRY') && x.includes('state=FAULT'), 'FAULT state')
  await c.cmdErr(`PEDAL ${side} START`, 'E_FAULT')
  await c.cmdErr(`PEDAL ${side} LEVEL`, 'E_FAULT')
  await c.cmdErr(`PEDAL ${side} PUSH START`, 'E_FAULT')
  await c.cmdErr('MOTOR ENABLE', 'E_FAULT')
  await c.cmd('RESET FAULT')
  await c.telemetry((x) => x.startsWith('TELEMETRY') && x.includes('state=IDLE'), 'IDLE state')
  await c.cmd('MOTOR ENABLE')
  await c.cmd(`PEDAL ${side} START`)
  await c.cmd(`PEDAL ${side} STOP`)
  await c.cmdErr('NOPE 1', 'E_SYNTAX')

  if (full) {
    // 第二块板也做一遍核心业务，确认双板独立
    await c.cmd(`PEDAL ${side} SET PUSH_DIST 50`)
    await c.cmd(`PEDAL ${side} LEVEL`)
    await c.event((x) => x.startsWith(`DEBUG LEVEL ${side} DONE comp=`), 'B LEVEL DONE')
  }

  await c.close()
  console.log(`[smoke:${side}] PASS (${c.lines.length} lines)`) // eslint-disable-line no-console
  return c.lines.length
}

;(async () => {
  let child = null
  try {
    child = await startMock()
    // 两块板并发跑完整流程，验证双板独立连接、心跳与遥测互不干扰
    const [a, b] = await Promise.all([
      runBoard('A', PORT_A, false),
      runBoard('B', PORT_B, true),
    ])
    assert(a > 0 && b > 0, '客户端未收到数据')
    console.log('[smoke] ALL PASS') // eslint-disable-line no-console
  } catch (e) {
    console.error('[smoke] FAIL:', e.message) // eslint-disable-line no-console
    process.exitCode = 1
  } finally {
    if (child) child.kill()
    await sleep(100)
  }
})()
