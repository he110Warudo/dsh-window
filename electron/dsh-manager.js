'use strict'

/**
 * dsh-manager — 拉起、监控、停止 `dsh web` 子进程。
 *
 * 不依赖 Electron,可在纯 Node 环境下运行与测试。职责:
 *   1. 解析 dsh 命令(环境变量 → PATH → npx 缓存 → 内置依赖 → npx 兜底)
 *   2. 以 `web --host 127.0.0.1 --port 0` 启动(端口 0 = 由系统分配,规避冲突)
 *   3. 从 stdout 的 `dsh web: http://127.0.0.1:<port>` 行解析真实 URL
 *   4. 超时/提前退出/崩溃的检测与日志保留
 *   5. 停止时按进程树清理(Windows 下 taskkill /T /F)
 *
 * 事件:
 *   'state'  {phase, message}   状态迁移(resolving/starting/waiting/ready/
 *                                navigating/stopping/stopped/error/crashed)
 *   'log'    {line}             子进程输出行(含 stderr)
 *   'ready'  {url, port, spec}  解析到 web 地址
 *   'exit'   {code, signal}     子进程退出(就绪之后)
 *   'error'  {message, logs}    启动失败/超时/启动前退出
 */

const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_TIMEOUT_MS = 90_000
const MAX_LOG_LINES = 500

/** dsh-web-app 就绪后打印的地址行(可能带 "(LAN: ...)" 后缀)。 */
const URL_LINE_RE = /dsh web:\s+(https?:\/\/\S+)/
/** 兜底:任意 127.0.0.1:port 形式的地址。 */
const LOOPBACK_URL_RE = /https?:\/\/127\.0\.0\.1:\d+/

function isWindows() {
  return process.platform === 'win32'
}

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** 从 npm 生成的 shim(.cmd/.ps1)里提取真实 .js 入口路径。 */
function extractJsTarget(shimPath) {
  let text
  try {
    text = fs.readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }
  const dir = path.dirname(shimPath)
  const resolveTarget = (target) => {
    // npm 11 及更早:%~dp0 前缀;npm 12:经 CALL :find_dp0 后的 %dp0% 变量
    for (const prefix of ['%~dp0', '%dp0%']) {
      if (target.startsWith(prefix)) {
        const resolved = path.join(dir, target.slice(prefix.length).replace(/^[\\/]+/, ''))
        if (isFile(resolved)) return resolved
      }
    }
    if (path.isAbsolute(target)) {
      if (isFile(target)) return target
    } else if (isFile(path.resolve(dir, target))) {
      return path.resolve(dir, target)
    }
    return null
  }
  const matches = [...text.matchAll(/"((?:%~dp0|%dp0%|[^"\r\n])+?\.js)"/g)]
  for (const m of matches) {
    const resolved = resolveTarget(m[1])
    if (resolved) return resolved
  }
  // 无引号形式:%~dp0\..\foo\bin.js
  const loose = text.match(/((?:%~dp0|%dp0%)[^"'^\s]+\.js)/)
  if (loose) {
    const resolved = resolveTarget(loose[1])
    if (resolved) return resolved
  }
  return null
}

/** 读取一个目录里 package.json 的 bin 入口(优先 lib/bin.js)。 */
function binEntryOf(pkgDir) {
  const manifestPath = path.join(pkgDir, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
  const bin = manifest && manifest.bin
  if (!bin) return null
  const rel = typeof bin === 'string' ? bin : bin.dsh
  if (typeof rel !== 'string') return null
  const preferred = path.join(pkgDir, 'lib', 'bin.js')
  if (isFile(preferred)) return preferred
  const entry = path.resolve(pkgDir, rel)
  return isFile(entry) ? entry : null
}

/** 扫描 npm 的 _npx 缓存目录,返回按 mtime 从新到旧排序的 dsh 包目录。 */
function scanNpxCache() {
  const base = path.join(localAppData(), 'npm-cache', '_npx')
  let subs = []
  try {
    subs = fs.readdirSync(base)
  } catch {
    return []
  }
  const found = []
  for (const sub of subs) {
    const pkgDir = path.join(base, sub, 'node_modules', '@deepseek-ai', 'dsh')
    if (!isDir(pkgDir)) continue
    let mtime = 0
    try {
      mtime = fs.statSync(path.join(pkgDir, 'package.json')).mtimeMs
    } catch {
      /* 无 package.json 的目录直接跳过 */
    }
    if (mtime) found.push({ pkgDir, mtime })
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return found.map((f) => f.pkgDir)
}

/** 内置兜底依赖:本应用 node_modules 里的 @deepseek-ai/dsh。 */
function bundledDshEntry() {
  try {
    const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
    return binEntryOf(path.dirname(manifestPath))
  } catch {
    return null
  }
}

/** 为 cmd.exe 构造整体命令串(仅用于 shim/npx 兜底路径)。 */
function quoteCmdArg(arg) {
  if (/^[A-Za-z0-9_@.\/:\\=+-]+$/.test(arg)) return arg
  // 保守处理:嵌入引号的参数在此兜底路径中直接拒绝
  if (arg.includes('"')) throw new Error(`参数包含无法安全转义的引号: ${arg}`)
  return `"${arg}"`
}

class DshManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string|null} [opts.command]     显式 dsh 命令(路径/目录/可执行名);null 走自动解析
   * @param {string[]}   [opts.args]         追加给 dsh web 的用户参数
   * @param {number}     [opts.timeoutMs]    等待就绪超时
   * @param {Function}   [opts.spawnImpl]    注入式 spawn(测试用),签名同 child_process.spawn
   */
  constructor(opts = {}) {
    super()
    this.command = opts.command || null
    this.userArgs = Array.isArray(opts.args) ? [...opts.args] : []
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS
    this.spawnImpl = opts.spawnImpl || spawn
    this.child = null
    this.spec = null
    this.url = null
    this.port = null
    this.phase = 'idle'
    this.ready = false
    this.manualStop = false
    this.timedOut = false
    this.logs = []
    this._readyTimer = null
    this._resolvePromise = null
  }

  _setPhase(phase, message) {
    this.phase = phase
    this.emit('state', { phase, message })
  }

  _pushLog(source, chunk) {
    const text = String(chunk)
    for (const line of text.split(/\r?\n/)) {
      if (line === '') continue
      this.logs.push(`[${source}] ${line}`)
      if (this.logs.length > MAX_LOG_LINES) this.logs.shift()
      this.emit('log', { line: `[${source}] ${line}` })
    }
  }

  _scanForUrl(line) {
    let m = line.match(URL_LINE_RE)
    if (m) return m[1]
    m = line.match(LOOPBACK_URL_RE)
    if (m) return m[0]
    return null
  }

  /**
   * 解析可执行的 dsh。返回 spec:
   *   {kind:'node', nodePath, entry, label}   用 node 直接跑 bin.js(首选)
   *   {kind:'exe',  entry, label}             直接执行可执行文件
   *   {kind:'cmd',  entry, label}             经 cmd.exe 跑 shim
   *   {kind:'ps1',  entry, label}             经 powershell 跑 shim
   * 失败抛错(错误信息会展示在启动页)。
   */
  async resolve() {
    if (this._resolvePromise) return this._resolvePromise
    this._resolvePromise = this._resolve()
    try {
      return await this._resolvePromise
    } finally {
      this._resolvePromise = null
    }
  }

  async _resolve() {
    this._setPhase('resolving', '正在定位 dsh 命令…')
    const tried = []

    const candidates = []
    if (this.command) candidates.push(this.command)
    else {
      candidates.push('dsh')
      for (const pkgDir of scanNpxCache()) candidates.push(pkgDir)
      const bundled = bundledDshEntry()
      if (bundled) candidates.push(bundled)
    }

    for (const cand of candidates) {
      const spec = await this._resolveCandidate(cand, tried)
      if (spec) return spec
    }

    // 兜底:npx --yes @deepseek-ai/dsh
    const npxHits = await this._findAllOnPath('npx')
    const npx =
      npxHits.find((p) => /\.(cmd|exe)$/i.test(p)) || npxHits.find((p) => /\.(bat|ps1)$/i.test(p)) || npxHits[0] || null
    if (npx) {
      return {
        kind: /\.(cmd|bat)$/i.test(npx) ? 'cmd' : 'exe',
        entry: npx,
        label: `npx 兜底 (${npx})`,
        npx: true
      }
    }

    const detail = tried.map((t) => `  - ${t}`).join('\n')
    throw new Error(
      `找不到可用的 dsh 命令。已尝试:\n${detail || '  (无)'}\n\n` +
        '解决办法:\n' +
        '  1. 在设置文件里配置 "dshCommand" 指向 dsh 的 bin.js 或命令名;\n' +
        '  2. 或设置环境变量 DSH_WINDOW_DSH;\n' +
        '  3. 或全局安装:npm install -g @deepseek-ai/dsh'
    )
  }

  async _resolveCandidate(cand, tried) {
    tried.push(cand)
    if (isDir(cand)) {
      const entry = binEntryOf(cand)
      if (entry) return this._nodeSpec(entry, `包目录 ${cand}`)
      return null
    }
    const ext = path.extname(cand).toLowerCase()
    if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
      if (isFile(cand)) return this._nodeSpec(cand, `入口脚本 ${cand}`)
      return null
    }
    if (ext === '.cmd' || ext === '.bat') {
      const target = extractJsTarget(cand)
      if (target) return this._nodeSpec(target, `shim ${cand}`)
      if (isFile(cand)) return { kind: 'cmd', entry: cand, label: `shim ${cand}` }
      return null
    }
    if (ext === '.ps1') {
      const target = extractJsTarget(cand)
      if (target) return this._nodeSpec(target, `shim ${cand}`)
      if (isFile(cand)) return { kind: 'ps1', entry: cand, label: `shim ${cand}` }
      return null
    }
    if (ext === '.exe' || ext === '.com') {
      if (isFile(cand)) return { kind: 'exe', entry: cand, label: cand }
      return null
    }
    // 裸命令名 → PATH 查找
    const found = await this._findAllOnPath(cand)
    for (const f of found) {
      if (f.toLowerCase() === cand.toLowerCase()) continue // 避免自引用
      const spec = await this._resolveCandidate(f, tried)
      if (spec) return spec
    }
    return null
  }

  /** 构造 node 直跑 spec:优先系统 node,其次 ELECTRON_RUN_AS_NODE。 */
  async _nodeSpec(entry, label) {
    const nodePath = await this._findNode()
    return { kind: 'node', nodePath: nodePath.path, extraEnv: nodePath.extraEnv, entry, label }
  }

  async _findNode() {
    if (process.env.DSH_WINDOW_NODE && isFile(process.env.DSH_WINDOW_NODE)) {
      return { path: process.env.DSH_WINDOW_NODE, extraEnv: null }
    }
    const onPath = await this._findOnPath('node')
    if (onPath) return { path: onPath, extraEnv: null }
    // Electron 环境兜底:process.execPath 是 electron.exe,以 RUN_AS_NODE 运行
    return {
      path: process.execPath,
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' }
    }
  }

  /** 返回 where/which 的第一个结果,失败返回 null。 */
  async _findOnPath(name) {
    const found = await this._findAllOnPath(name)
    return found.length ? found[0] : null
  }

  /** 返回 PATH 中某命令的全部命中路径(顺序 = 系统解析顺序)。 */
  async _findAllOnPath(name) {
    try {
      const tool = isWindows() ? 'where.exe' : 'which'
      const out = await this._capture(tool, [name])
      const lines = String(out || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.toLowerCase().endsWith(':') && !l.includes('not found') && !l.includes('Could not find'))
      const dedup = [...new Set(lines)]
      return dedup.filter((l) => isFile(l) || isDir(l))
    } catch {
      return []
    }
  }

  /** 经 spawnImpl 捕获命令 stdout(仅用于 where/which 探测)。 */
  _capture(cmd, args) {
    return new Promise((resolve, reject) => {
      let out = ''
      const child = this.spawnImpl(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout.on('data', (c) => {
        out += String(c)
      })
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`))))
    })
  }

  /**
   * 启动 dsh web。重复调用返回当前子进程。
   * 参数规则:用户参数优先;仅当用户未显式给出 --host/--port 时注入
   * `--host 127.0.0.1 --port 0`。
   */
  async start() {
    if (this.child) return this.child
    this.manualStop = false
    this.timedOut = false
    this.ready = false
    this.url = null
    this.port = null

    let spec
    try {
      spec = await this.resolve()
    } catch (error) {
      this._fail(error.message)
      return null
    }
    this.spec = spec

    const hasFlag = (flag) => this.userArgs.some((a) => a === flag || a.startsWith(`${flag}=`))
    const baseArgs = this.userArgs.some((a) => a === 'web') ? [] : ['web']
    const args = [...baseArgs, ...this.userArgs]
    if (!hasFlag('--host')) args.push('--host', '127.0.0.1')
    if (!hasFlag('--port')) args.push('--port', '0')

    this._setPhase('starting', `正在启动 dsh web…(${spec.label})`)
    this._pushLog('dsh-window', `启动命令: ${JSON.stringify(args)} (${spec.label})`)

    const env = { ...process.env, ...(spec.extraEnv || {}) }
    let child
    if (spec.kind === 'node') {
      child = this.spawnImpl(spec.nodePath, [spec.entry, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env
      })
    } else if (spec.kind === 'exe') {
      const execArgs = spec.npx ? ['--yes', '@deepseek-ai/dsh', ...args] : args
      child = this.spawnImpl(spec.entry, execArgs, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env
      })
    } else if (spec.kind === 'cmd') {
      const cmdArgs = spec.npx ? ['--yes', '@deepseek-ai/dsh', ...args] : args
      const commandLine = `""${spec.entry}" ${cmdArgs.map(quoteCmdArg).join(' ')}"`
      // windowsVerbatimArguments:整体命令串原样交给 cmd.exe /s 解析,
      // 避免 Node 的 CreateProcess 参数拼接二次转义引号。
      child = this.spawnImpl(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env
      })
    } else if (spec.kind === 'ps1') {
      child = this.spawnImpl(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', spec.entry, ...args],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env }
      )
    } else {
      this._fail(`内部错误:未知的启动方式 ${spec.kind}`)
      return null
    }

    this.child = child
    this._setPhase('waiting', '等待 web 服务就绪…(首次启动可能需要十几秒)')

    const onData = (source) => (chunk) => {
      const text = String(chunk)
      this._pushLog(source, text)
      if (!this.ready) {
        for (const line of text.split(/\r?\n/)) {
          const url = this._scanForUrl(line)
          if (url) {
            this.ready = true
            this.url = url
            this.port = (url.match(/:(\d+)\/?$/) || [])[1] || null
            if (this._readyTimer) clearTimeout(this._readyTimer)
            this._setPhase('ready', `dsh 已就绪:${url}`)
            this.emit('ready', { url: this.url, port: this.port, spec })
            return
          }
        }
      }
    }

    child.stdout && child.stdout.on('data', onData('out'))
    child.stderr && child.stderr.on('data', onData('err'))

    child.on('error', (error) => {
      if (!this.ready) this._fail(`无法启动 dsh 子进程:${error.message}`)
    })

    child.on('exit', (code, signal) => {
      if (this._readyTimer) clearTimeout(this._readyTimer)
      this.child = null
      if (this.manualStop) {
        if (this.phase !== 'stopped' && this.phase !== 'stopping') this._setPhase('stopped', '已停止')
        return
      }
      if (!this.ready) {
        // 超时路径已发过 error,或其它错误已先行上报 → 避免重复事件
        if (this.timedOut || this.phase === 'error') return
        const tail = this.logs.slice(-12).join('\n')
        this._setPhase('error', `dsh 在就绪前退出(code=${code}, signal=${signal})`)
        this.emit('error', {
          message: `dsh 进程在 web 服务就绪前退出(code=${code}, signal=${signal})`,
          logs: tail
        })
        return
      }
      this.ready = false
      this._setPhase('crashed', `dsh 进程已退出(code=${code}, signal=${signal})`)
      this.emit('exit', { code, signal })
    })

    if (!this.ready) {
      this._readyTimer = setTimeout(() => {
        if (this.ready || !this.child) return
        this.timedOut = true
        this._pushLog('dsh-window', `等待就绪超过 ${this.timeoutMs}ms,强制停止。`)
        this._forceKill(child)
        const tail = this.logs.slice(-12).join('\n')
        this._setPhase('error', `等待 dsh 就绪超时(${Math.round(this.timeoutMs / 1000)}s)`)
        this.emit('error', { message: `等待 dsh 就绪超时(${Math.round(this.timeoutMs / 1000)}s)`, logs: tail })
      }, this.timeoutMs)
    }
    return child
  }

  /** 等待就绪的 Promise 形态,失败 reject。 */
  waitReady() {
    return new Promise((resolve, reject) => {
      if (this.ready) return resolve({ url: this.url, port: this.port })
      const onReady = (info) => {
        cleanup()
        resolve(info)
      }
      const onError = (info) => {
        cleanup()
        reject(new Error(info.message))
      }
      const onExit = (info) => {
        cleanup()
        reject(new Error(`dsh 已退出(code=${info.code})`))
      }
      const cleanup = () => {
        this.removeListener('ready', onReady)
        this.removeListener('error', onError)
        this.removeListener('exit', onExit)
      }
      this.on('ready', onReady)
      this.on('error', onError)
      this.on('exit', onExit)
    })
  }

  /** 重启:先停旧进程再启动。 */
  async restart() {
    await this.stop()
    return this.start()
  }

  /** 停止 dsh:Windows 下 taskkill /T /F 清进程树,其余平台 SIGTERM→SIGKILL。 */
  async stop() {
    if (!this.child) return
    this.manualStop = true
    this._setPhase('stopping', '正在停止 dsh…')
    const child = this.child
    this.child = null
    if (this._readyTimer) clearTimeout(this._readyTimer)

    if (isWindows()) {
      try {
        this.spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
      } catch {
        /* 忽略:taskkill 失败时继续等待子进程退出 */
      }
    } else {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      const forceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, 3000)
      forceTimer.unref && forceTimer.unref()
    }

    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      child.on('exit', finish)
      child.on('close', finish)
      const t = setTimeout(finish, 8000)
      t.unref && t.unref()
    })
    this._setPhase('stopped', '已停止')
  }

  _forceKill(child) {
    try {
      if (isWindows()) {
        this.spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
      } else {
        child.kill('SIGKILL')
      }
    } catch {
      /* ignore */
    }
  }

  _fail(message) {
    this._setPhase('error', message)
    this.emit('error', { message, logs: this.logs.slice(-12).join('\n') })
  }

  getLogs() {
    return [...this.logs]
  }

  isRunning() {
    return this.child !== null
  }
}

module.exports = { DshManager, extractJsTarget, binEntryOf, scanNpxCache, bundledDshEntry, quoteCmdArg }
