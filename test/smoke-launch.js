'use strict'

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const smokeRoot = path.join(root, '.smoke')
const dshHome = path.join(smokeRoot, 'dsh-home')
const outputPath = path.join(smokeRoot, 'tauri-smoke.log')
const timeoutMs = 180_000

fs.rmSync(smokeRoot, { recursive: true, force: true })
fs.mkdirSync(dshHome, { recursive: true })

const isWindows = process.platform === 'win32'
const command = isWindows ? process.env.ComSpec || 'cmd.exe' : 'npm'
const args = isWindows ? ['/d', '/s', '/c', 'npm start'] : ['start']
const child = spawn(command, args, {
  cwd: root,
  windowsHide: true,
  env: {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_WINDOW_SMOKE: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let output = ''
let ready = false
let loaded = false
let finished = false

function append(chunk) {
  const text = String(chunk)
  output += text
  process.stdout.write(text)
  ready ||= text.includes('DSH_WINDOW_SMOKE_READY')
  loaded ||= text.includes('DSH_WINDOW_SMOKE_PAGE_LOADED')
}

child.stdout.on('data', append)
child.stderr.on('data', append)

function finish(error) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  fs.writeFileSync(outputPath, output)
  if (error) {
    console.error(`\n冒烟失败：${error.message}`)
    process.exitCode = 1
  } else {
    console.log(`\n冒烟通过：dsh ready=${ready}, page loaded=${loaded}`)
  }
}

child.on('error', finish)
child.on('exit', (code) => {
  if (!ready || !loaded) {
    finish(new Error(`Tauri 提前退出(code=${code})，未观察到完整就绪标记`))
    return
  }
  if (code !== 0) {
    finish(new Error(`Tauri 退出码为 ${code}`))
    return
  }
  finish()
})

const timer = setTimeout(() => {
  if (isWindows && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    child.kill('SIGKILL')
  }
  finish(new Error(`等待 ${timeoutMs / 1000}s 超时`))
}, timeoutMs)
