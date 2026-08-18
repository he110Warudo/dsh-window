'use strict'

/**
 * dsh-manager 单元测试。
 *
 * 通过注入 spawnImpl(fake 子进程)运行,不依赖真实子进程/管道,
 * 因此可以在任何受限沙箱中执行。真实端到端验证见 smoke-launch.js。
 */

const { test } = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DshManager, extractJsTarget, binEntryOf, scanNpxCache, bundledDshEntry, quoteCmdArg } = require('../electron/dsh-manager')

// ---------------------------------------------------------------- fake child

let pidCounter = 1000

function makeFakeChild() {
  const child = new EventEmitter()
  child.pid = pidCounter++
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killCalls = []
  child.kill = (...args) => {
    child.killCalls.push(args)
  }
  child.writeOut = (text) => process.nextTick(() => child.stdout.push(text))
  child.writeErr = (text) => process.nextTick(() => child.stderr.push(text))
  child.exit = (code, signal) => {
    process.nextTick(() => {
      child.emit('exit', code, signal)
      child.emit('close', code, signal)
    })
  }
  return child
}

/**
 * 构造 fake spawnImpl。约定:
 *  - where.exe:按查询名返回命中路径(node → 假 node.exe,其余空)
 *  - taskkill:触发最近一次业务子进程退出(模拟杀进程树生效)
 *  - 其余:视为 dsh 业务进程,记录并返回 fake child
 */
function makeFakeSpawn() {
  const calls = []
  const business = []
  // 必须真实存在:manager 用 isFile 过滤 where 结果
  const fakeNode = path.join(os.tmpdir(), 'dsh-test-node.exe')
  fs.writeFileSync(fakeNode, '')
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const child = makeFakeChild()
    if (String(cmd).toLowerCase().includes('where')) {
      const name = args[0]
      if (name === 'node') {
        child.writeOut(`${fakeNode}\r\n`)
        child.exit(0)
      } else {
        child.exit(1)
      }
      return child
    }
    if (String(cmd).toLowerCase().includes('taskkill')) {
      const target = business[business.length - 1]
      if (target) process.nextTick(() => target.exit(0))
      child.exit(0)
      return child
    }
    business.push(child)
    return child
  }
  /** 定位业务 spawn(kind:'node' 时 args[0] 是入口脚本路径)。 */
  const businessCall = (entry) => calls.find((c) => Array.isArray(c.args) && c.args[0] === entry)
  return { spawnImpl, calls, business, fakeNode, businessCall }
}

function waitEvent(emitter, name, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待事件 ${name} 超时`)), timeoutMs)
    emitter.once(name, (...args) => {
      clearTimeout(timer)
      resolve(args)
    })
  })
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

// ---------------------------------------------------------------- tests

test('就绪流程:解析 stdout URL、注入 --port 0、taskkill 停止', async () => {
  const { spawnImpl, calls, fakeNode, businessCall } = makeFakeSpawn()
  const fakeEntry = path.join(os.tmpdir(), 'fake-dsh-bin.js')
  fs.writeFileSync(fakeEntry, '')
  const manager = new DshManager({ command: fakeEntry, spawnImpl, timeoutMs: 5000 })

  const readyP = waitEvent(manager, 'ready')
  const child = await manager.start()
  assert.ok(child, 'start 返回子进程')
  child.writeOut('booting…\n')
  child.writeOut('dsh web: http://127.0.0.1:53241 (LAN: http://192.168.1.9:53241)\n')

  const [info] = await readyP
  assert.strictEqual(info.url, 'http://127.0.0.1:53241')
  assert.strictEqual(info.port, '53241')

  const spawnCall = businessCall(fakeEntry)
  assert.ok(spawnCall, '有业务 spawn 调用')
  assert.strictEqual(spawnCall.cmd, fakeNode)
  assert.strictEqual(spawnCall.args[0], fakeEntry)
  assert.deepStrictEqual(spawnCall.args.slice(1), ['web', '--host', '127.0.0.1', '--port', '0'])

  await manager.stop()
  const killCall = calls.find((c) => String(c.cmd).toLowerCase().includes('taskkill'))
  assert.ok(killCall, 'Windows 下调用 taskkill')
  assert.ok(killCall.args.includes('/T') && killCall.args.includes('/F'), '清理进程树')
  assert.strictEqual(manager.phase, 'stopped')
})

test('用户显式指定 --port 时不再注入默认端口', async () => {
  const { spawnImpl, businessCall } = makeFakeSpawn()
  const fakeEntry = path.join(os.tmpdir(), 'fake-dsh-bin2.js')
  fs.writeFileSync(fakeEntry, '')
  const manager = new DshManager({
    command: fakeEntry,
    args: ['--port', '3080', '--trusted-host', '127.0.0.1'],
    spawnImpl,
    timeoutMs: 5000
  })
  const readyP = waitEvent(manager, 'ready')
  const child = await manager.start()
  child.writeOut('dsh web: http://127.0.0.1:3080\n')
  await readyP
  const spawnCall = businessCall(fakeEntry)
  assert.deepStrictEqual(spawnCall.args.slice(1), ['web', '--port', '3080', '--trusted-host', '127.0.0.1', '--host', '127.0.0.1'])
})

test('就绪前退出 → error 事件并携带输出日志', async () => {
  const { spawnImpl } = makeFakeSpawn()
  const fakeEntry = path.join(os.tmpdir(), 'fake-dsh-bin3.js')
  fs.writeFileSync(fakeEntry, '')
  const manager = new DshManager({ command: fakeEntry, spawnImpl, timeoutMs: 5000 })

  const errP = waitEvent(manager, 'error')
  const child = await manager.start()
  child.writeErr('some fatal error\n')
  child.exit(1)
  const [info] = await errP
  assert.ok(info.message.includes('code=1'), info.message)
  assert.ok(info.logs.includes('[err] some fatal error'), info.logs)
})

test('无输出 → 超时 error 并强制清理', async () => {
  const { spawnImpl, calls } = makeFakeSpawn()
  const fakeEntry = path.join(os.tmpdir(), 'fake-dsh-bin4.js')
  fs.writeFileSync(fakeEntry, '')
  const manager = new DshManager({ command: fakeEntry, spawnImpl, timeoutMs: 250 })

  const errP = waitEvent(manager, 'error')
  await manager.start()
  const [info] = await errP
  assert.ok(info.message.includes('超时'), info.message)
  await tick()
  const killCall = calls.find((c) => String(c.cmd).toLowerCase().includes('taskkill'))
  assert.ok(killCall, '超时后强制杀进程树')
})

test('找不到任何 dsh → 抛出带排查建议的错误', async () => {
  const { spawnImpl } = makeFakeSpawn()
  const manager = new DshManager({ command: 'definitely-not-a-real-dsh', spawnImpl, timeoutMs: 5000 })
  const errP = waitEvent(manager, 'error')
  await manager.start()
  const [info] = await errP
  assert.ok(info.message.includes('找不到可用的 dsh'), info.message)
  assert.ok(info.message.includes('DSH_DESKTOP_DSH'), '包含解决办法提示')
})

test('restart:先停旧进程再拉起新进程', async () => {
  const { spawnImpl, business } = makeFakeSpawn()
  const fakeEntry = path.join(os.tmpdir(), 'fake-dsh-bin5.js')
  fs.writeFileSync(fakeEntry, '')
  const manager = new DshManager({ command: fakeEntry, spawnImpl, timeoutMs: 5000 })

  const first = await manager.start()
  first.writeOut('dsh web: http://127.0.0.1:11111\n')
  await waitEvent(manager, 'ready')
  assert.strictEqual(business.length, 1)

  const restartP = waitEvent(manager, 'ready')
  const second = await manager.restart()
  assert.notStrictEqual(second, first)
  assert.strictEqual(business.length, 2)
  second.writeOut('dsh web: http://127.0.0.1:22222\n')
  const [info] = await restartP
  assert.strictEqual(info.url, 'http://127.0.0.1:22222')
})

// ---------------------------------------------------------------- 解析辅助函数

test('extractJsTarget:解析 npm 生成的 .cmd/.ps1 shim', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shim-'))
  const cmdPath = path.join(dir, 'dsh.cmd')
  const ps1Path = path.join(dir, 'dsh.ps1')
  const target = path.join(dir, '..', 'pkg', 'lib', 'bin.js')

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, '')
  fs.writeFileSync(cmdPath, `@"%~dp0\\..\\pkg\\lib\\bin.js" %*\r\n`)
  fs.writeFileSync(ps1Path, `#!/usr/bin/env pwsh\n& "${path.join('..', 'pkg', 'lib', 'bin.js')}" $args\n`)

  assert.strictEqual(extractJsTarget(cmdPath), target)
  assert.strictEqual(extractJsTarget(ps1Path), target)

  // 无引号形式
  const loose = path.join(dir, 'loose.cmd')
  fs.writeFileSync(loose, `%~dp0\\..\\pkg\\lib\\bin.js %*\r\n`)
  assert.strictEqual(extractJsTarget(loose), target)

  // npm 12 形式:CALL :find_dp0 后的 %dp0% 变量
  const npm12 = path.join(dir, 'dsh12.cmd')
  fs.writeFileSync(
    npm12,
    '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\..\\pkg\\lib\\bin.js" %*\r\n'
  )
  assert.strictEqual(extractJsTarget(npm12), target)

  // 目标不存在 → null
  const dead = path.join(dir, 'dead.cmd')
  fs.writeFileSync(dead, `@"%~dp0\\..\\nope\\bin.js" %*\r\n`)
  assert.strictEqual(extractJsTarget(dead), null)
})

test('binEntryOf:从包目录读 bin 入口', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pkg-'))
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), '')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ bin: { dsh: 'lib/bin.js' } }))
  assert.strictEqual(binEntryOf(dir), path.join(dir, 'lib', 'bin.js'))
})

test('scanNpxCache:扫描缓存并按时间从新到旧排序', () => {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-npx-root-'))
  const base = path.join(fakeRoot, 'npm-cache', '_npx')
  const oldEnv = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = fakeRoot
  try {
    for (const [sub, t] of [
      ['aaa', 1000],
      ['bbb', 3000],
      ['ccc', 2000]
    ]) {
      const pkgDir = path.join(base, sub, 'node_modules', '@deepseek-ai', 'dsh')
      fs.mkdirSync(pkgDir, { recursive: true })
      const manifest = path.join(pkgDir, 'package.json')
      fs.writeFileSync(manifest, '{}')
      fs.utimesSync(manifest, new Date(t * 1000), new Date(t * 1000))
    }
    const dirs = scanNpxCache()
    assert.strictEqual(dirs.length, 3)
    assert.ok(dirs[0].includes(path.join('bbb', 'node_modules')), `最新在前,got ${dirs[0]}`)
    assert.ok(dirs[2].includes(path.join('aaa', 'node_modules')), `最旧在后,got ${dirs[2]}`)
  } finally {
    process.env.LOCALAPPDATA = oldEnv
  }
})

test('bundledDshEntry:依赖已安装时解析出真实入口', () => {
  let entry = null
  try {
    entry = bundledDshEntry()
  } catch {
    /* 未安装依赖时忽略 */
  }
  if (entry !== null) {
    assert.ok(fs.existsSync(entry), `入口存在: ${entry}`)
    assert.ok(entry.includes('@deepseek-ai'), '指向内置 dsh 包')
  }
})

test('quoteCmdArg:简单参数原样返回,含空格加引号,含引号抛错', () => {
  assert.strictEqual(quoteCmdArg('--port'), '--port')
  assert.strictEqual(quoteCmdArg('hello world'), '"hello world"')
  assert.throws(() => quoteCmdArg('a"b'))
})

// ---------------------------------------------------------------- guard 看门狗

test('guard:dsh 先消失时正常退出(父进程存活)', async () => {
  const { spawn } = require('node:child_process')
  const guardPath = path.join(__dirname, '..', 'electron', 'guard.js')
  let child
  try {
    child = spawn(process.execPath, [guardPath, String(process.pid), '987654321'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
  } catch (error) {
    // 环境禁止 spawn 时跳过(受限沙箱)
    assert.ok(String(error.message).includes('EPERM'), error.message)
    return
  }
  const code = await new Promise((resolve) => {
    child.on('exit', resolve)
    setTimeout(() => resolve('timeout'), 5000)
  })
  assert.strictEqual(code, 0, 'dsh 已死,guard 应自行退出')
  if (code === 'timeout') child.kill('SIGKILL')
})
