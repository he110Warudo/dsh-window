'use strict'

/**
 * splash — 状态页逻辑:根据主进程推送的 phase 切换视图。
 * 该页面同时承担"启动页"与"崩溃/错误页"两个角色。
 * 颜色主题与客户端当前主题对齐(见 applyTheme)。
 */

/** 应用主题,与 DSH 客户端同一套约定:html 上的 data-ds-dark-theme 属性 + color-scheme。 */
function applyTheme(dark) {
  document.documentElement.toggleAttribute('data-ds-dark-theme', Boolean(dark))
}

// 主进程在 loadFile 时写入主题查询参数,脚本在首帧前同步应用,避免闪色
const themeQuery = new URLSearchParams(location.search).get('theme')
if (themeQuery === 'dark' || themeQuery === 'light') applyTheme(themeQuery === 'dark')

const $ = (id) => document.getElementById(id)

const viewLoading = $('view-loading')
const viewError = $('view-error')
const statusLine = $('status-line')
const hintLine = $('hint-line')
const errorTitle = $('error-title')
const errorMessage = $('error-message')
const errorLog = $('error-log')
const footLog = $('foot-log')
const versionEl = $('version')

const PHASE_TEXT = {
  idle: '空闲',
  resolving: '正在定位 dsh 命令…',
  starting: '正在启动 dsh web…',
  waiting: '等待 web 服务就绪…',
  ready: 'dsh 已就绪',
  navigating: '正在打开界面…',
  stopping: '正在停止 dsh…',
  stopped: '已停止',
  error: '启动失败',
  crashed: 'dsh 进程已退出'
}

const HINT_TEXT = {
  resolving: '自动解析 dsh 命令,也可通过设置文件或环境变量 DSH_WINDOW_DSH 指定',
  starting: '使用 --port 0 由系统分配空闲端口,避免冲突',
  waiting: '首次启动需要初始化 profile,可能稍慢',
  crashed: '可以重启 dsh,或查看日志排查',
  error: '详见下方日志'
}

let logs = []
let lastPhase = 'resolving'
let lastMessage = ''

function render() {
  const text = PHASE_TEXT[lastPhase] || lastPhase
  if (lastPhase === 'error' || lastPhase === 'crashed') {
    viewLoading.hidden = true
    viewError.hidden = false
    errorTitle.textContent = lastPhase === 'error' ? 'dsh 启动失败' : 'dsh 进程已退出'
    errorMessage.textContent = lastMessage || ''
    errorLog.textContent = logs.slice(-40).join('\n')
    $('btn-retry').textContent = lastPhase === 'error' ? '重试' : '重启 dsh'
  } else {
    viewLoading.hidden = false
    viewError.hidden = true
    statusLine.textContent = text
    hintLine.textContent = HINT_TEXT[lastPhase] || 'DeepSeek Harness 窗口客户端'
    if (lastPhase === 'ready') {
      statusLine.textContent = 'dsh 已就绪'
      hintLine.textContent = '正在打开界面…'
    }
  }
  footLog.textContent = logs.slice(-60).join('\n')
}

function applyStatus(payload) {
  if (payload.kind === 'log') {
    logs.push(payload.line)
    if (logs.length > 200) logs.shift()
    render()
    return
  }
  if (payload.kind === 'state') {
    lastPhase = payload.phase
    if (payload.message) lastMessage = payload.message
    render()
  }
}

async function init() {
  const state = await window.dshWindow.getState()
  if (typeof state.theme === 'boolean') applyTheme(state.theme)
  logs = state.logs || []
  lastPhase = state.phase || 'resolving'
  if (state.message) lastMessage = state.message
  if (state.version) versionEl.textContent = `v${state.version}`
  render()
  window.dshWindow.onStatus(applyStatus)
  window.dshWindow.onTheme(applyTheme)

  $('btn-retry').addEventListener('click', () => {
    logs = []
    lastPhase = 'starting'
    render()
    window.dshWindow.restart()
  })
  $('btn-quit').addEventListener('click', () => window.dshWindow.quit())
  $('link-copy').addEventListener('click', async (e) => {
    e.preventDefault()
    const ok = await window.dshWindow.copyLogs()
    const el = $('link-copy')
    el.textContent = ok ? '已复制 ✓' : '无日志'
    setTimeout(() => {
      el.textContent = '复制日志'
    }, 1500)
  })
  $('link-open').addEventListener('click', (e) => {
    e.preventDefault()
    window.dshWindow.openLogs()
  })
}

init()
