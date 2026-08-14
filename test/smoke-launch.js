'use strict'

/**
 * smoke-launch — 端到端冒烟:真实启动 dsh web 并验证 HTTP 可访问。
 *
 *   用法:
 *     node test/smoke-launch.js          默认模式:经 DshManager 解析 stdout URL
 *     node test/smoke-launch.js --stdio  沙箱兼容模式:探测空闲端口 + stdio 继承 + HTTP 轮询
 *
 * DSH_HOME 未设置时指向 <项目>/.smoke/dsh-home(避免污染 ~/.dsh)。
 * 可通过环境变量 DSH_DESKTOP_DSH / DSH_DESKTOP_NODE 指定 dsh 入口与 node。
 */

const { spawn } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SMOKE_HOME = path.join(ROOT, '.smoke', 'dsh-home')
const { DshManager, scanNpxCache, bundledDshEntry } = require('../electron/dsh-manager')

const USE_STDIO = process.argv.includes('--stdio')
const TIMEOUT_MS = 120_000

function setupEnv() {
  if (!process.env.DSH_HOME) {
    fs.mkdirSync(SMOKE_HOME, { recursive: true })
    process.env.DSH_HOME = SMOKE_HOME
  }
  if (process.env.DSH_TELEMETRY_DISABLED === undefined) {
    process.env.DSH_TELEMETRY_DISABLED = '1'
  }
}

/** 只依赖文件系统的 dsh 入口解析(沙箱内不能用 where.exe)。 */
function findDshEntry() {
  if (process.env.DSH_DESKTOP_DSH && fs.existsSync(process.env.DSH_DESKTOP_DSH)) {
    return process.env.DSH_DESKTOP_DSH
  }
  const dirs = scanNpxCache()
  for (const dir of dirs) {
    const entry = path.join(dir, 'lib', 'bin.js')
    if (fs.existsSync(entry)) return entry
  }
  return bundledDshEntry()
}

function findNode() {
  if (process.env.DSH_DESKTOP_NODE && fs.existsSync(process.env.DSH_DESKTOP_NODE)) {
    return process.env.DSH_DESKTOP_NODE
  }
  return process.execPath
}

function probeFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function pollHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (res.status < 500) return res.status
      lastError = new Error(`HTTP ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(500)
  }
  throw new Error(`HTTP 探测超时: ${lastError ? lastError.message : 'no response'}`)
}

async function runManaged() {
  const entry = findDshEntry()
  if (!entry) throw new Error('未找到 dsh 入口(尝试:DSH_DESKTOP_DSH / npx 缓存 / 内置依赖)')
  console.log(`[smoke] dsh 入口: ${entry}`)
  process.env.DSH_DESKTOP_NODE = findNode()
  const manager = new DshManager({ command: entry, timeoutMs: TIMEOUT_MS })
  manager.on('log', ({ line }) => process.stderr.write(`  ${line}\n`))
  const readyP = manager.waitReady()
  const child = await manager.start()
  if (!child) throw new Error('启动失败,详见日志')
  const info = await readyP
  console.log(`[smoke] READY ${info.url}`)
  const status = await pollHttp(info.url, 10_000)
  console.log(`[smoke] HTTP ${status}`)
  await manager.stop()
  console.log('[smoke] STOPPED')
}

async function runStdio() {
  const entry = findDshEntry()
  if (!entry) throw new Error('未找到 dsh 入口(尝试:DSH_DESKTOP_DSH / npx 缓存 / 内置依赖)')
  console.log(`[smoke] dsh 入口: ${entry}`)
  const nodePath = findNode()
  const port = await probeFreePort()
  console.log(`[smoke] 探测到空闲端口 ${port},stdio=inherit 启动 dsh web`)
  const child = spawn(nodePath, [entry, 'web', '--host', '127.0.0.1', '--port', String(port)], {
    stdio: 'inherit',
    env: process.env
  })
  const url = `http://127.0.0.1:${port}`
  const status = await pollHttp(url, TIMEOUT_MS)
  console.log(`[smoke] HTTP ${status} @ ${url}`)
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(8000).then(() => {
      child.kill('SIGKILL')
    })
  ])
  console.log('[smoke] STOPPED')
}

async function main() {
  setupEnv()
  console.log(`[smoke] DSH_HOME=${process.env.DSH_HOME}`)
  try {
    if (USE_STDIO) await runStdio()
    else await runManaged()
    console.log('[smoke] PASS')
  } catch (error) {
    console.error(`[smoke] FAIL: ${error.message}`)
    process.exit(1)
  }
}

main()
