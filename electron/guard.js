'use strict'

/**
 * guard — dsh 子进程看门狗。
 *
 * 由 dsh-desktop 主进程拉起,监视两个 PID:
 *   1. 父进程(electron)先消失 → 立即 taskkill 清理 dsh 进程树,然后自杀。
 *      (覆盖任务管理器强杀 / 主进程崩溃等 before-quit 无法执行的情况)
 *   2. dsh 先消失 → 正常退出。
 *
 * 用法: node guard.js <parentPid> <dshPid>
 */

const { spawnSync } = require('node:child_process')

const parentPid = Number(process.argv[2])
const dshPid = Number(process.argv[3])

if (!Number.isInteger(parentPid) || !Number.isInteger(dshPid) || parentPid <= 0 || dshPid <= 0) {
  process.exit(2)
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// 退出时兜底:父进程已死就清理 dsh(覆盖进程内 kill 无法执行的情况)
function cleanupIfOrphaned() {
  if (!alive(parentPid) && alive(dshPid)) {
    try {
      spawnSync('taskkill', ['/pid', String(dshPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      /* ignore */
    }
  }
}

const timer = setInterval(() => {
  if (!alive(parentPid)) {
    cleanupIfOrphaned()
    process.exit(0)
  }
  if (!alive(dshPid)) {
    process.exit(0)
  }
}, 1500)
timer.unref && timer.unref()

process.on('exit', cleanupIfOrphaned)
