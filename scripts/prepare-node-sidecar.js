'use strict'

const fs = require('node:fs')
const path = require('node:path')

if (process.platform !== 'win32') {
  console.error('当前打包配置仅支持 Windows。')
  process.exit(1)
}

const source = process.env.DSH_WINDOW_NODE || process.execPath
const target = path.join(__dirname, '..', 'src-tauri', 'bin', 'node.exe')
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.copyFileSync(source, target)
console.log(`Node sidecar: ${source} -> ${target}`)
