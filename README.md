# DSH Window

> DeepSeek Harness 窗口 GUI 客户端：双击启动，自动拉起 `dsh web`，并在应用窗口中打开 DSH Web 界面；退出应用时自动停止 dsh（含整个子进程树）。

<p align="center">
  <a href="https://github.com/he110Warudo/dsh-window"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-dsh--window-181717?logo=github"></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow"></a>
  <a href="https://www.electronjs.org/"><img alt="Electron" src="https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white"></a>
  <a href="https://nodejs.org/"><img alt="Node.js ≥ 20" src="https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=nodedotjs&logoColor=white"></a>
  <a href="#"><img alt="Platform: Windows" src="https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows11&logoColor=white"></a>
  <a href="https://github.com/topics/dsh-plugin"><img alt="Topic: dsh-plugin" src="https://img.shields.io/badge/Topic-dsh--plugin-0969DA"></a>
</p>

## 目录

- [特性](#特性)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [使用](#使用)
- [配置](#配置)
- [打包](#打包)
- [验证](#验证)
- [目录结构](#目录结构)
- [常见问题](#常见问题)
- [路线图](#路线图)
- [许可](#许可)

## 特性

- ✅ **零端口冲突**：以 `--port 0` 启动，由系统分配空闲端口，并从 dsh 输出中解析真实地址。
- 🔍 **dsh 命令自动解析**：环境变量 → PATH → npm `_npx` 缓存 → 内置依赖 → `npx` 兜底；找不到时给出排查建议。
- 🔄 **崩溃自愈**：dsh 意外退出后窗口自动切回状态页，可一键重启；会话数据保存在 `$DSH_HOME`，不丢失。
- 🪟 **界面与 DSH Web GUI 一致**：启动页/状态页使用同一套设计 token（亮/暗跟随系统）；隐藏系统标题栏，窗口按钮浮于界面右上角且颜色跟随 DSH 主题；内容区顶部注入透明拖拽条用于移动窗口。
- 🖥️ **单实例**：重复启动只会聚焦已有窗口，避免两个 dsh 同时写 profile。
- 📌 **托盘常驻**：关闭窗口后应用驻留系统托盘，dsh 继续后台运行；托盘菜单可显示窗口、重启 dsh、退出应用。
- 👁️ **看门狗**：主进程被任务管理器等强杀时，guard 进程自动清理 dsh 进程树，不留孤儿。
- 📄 **完整日志**：启动日志实时展示，可复制、可打开日志文件（`%APPDATA%/dsh-window/dsh-window.log`）。

## 环境要求

| 依赖 | 版本 | 说明 |
| :--- | :--- | :--- |
| Node.js | ≥ 20 | 开发与运行环境 |
| npm | — | 首次 `npm install` 需要联网 |
| Windows | 10 及以上 | 目标平台 |

## 快速开始

```powershell
git clone https://github.com/he110Warudo/dsh-window
cd dsh-window
npm install   # 安装 Electron 与内置的 @deepseek-ai/dsh 兜底依赖
npm start     # 启动窗口客户端
```

> **注意**：首次 `npm install` 会下载 Electron 运行时（约 100 MB）。

## 使用

- 打包版双击 `DSH Window.exe` 即可运行；开发版使用 `npm start`。
- 单实例运行：重复启动不会开新实例，而是聚焦已有窗口。
- 关闭窗口不会退出应用：dsh 继续在后台运行，应用驻留系统托盘；单击托盘图标或从托盘菜单选择「显示窗口」即可恢复。若希望关闭即退出，可在设置里将 `closeToTray` 设为 `false`。
- 快捷键：
  - `Ctrl+Shift+R`：重新启动 dsh；
  - `Ctrl+Shift+O`：在系统浏览器中打开当前界面；
  - 菜单「帮助」中可打开日志文件。
- 窗口顶部约 32px 的透明条带是拖拽区，可拖动窗口；侧边栏与右上角窗口按钮区域不受影响。

## 配置

首次运行后，设置文件位于 `%APPDATA%/dsh-window/settings.json`（模板见 [`settings.example.json`](./settings.example.json)）：

| 字段 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `dshCommand` | `string \| null` | `null` | 显式指定 dsh 入口：可填 `.js` 路径、包目录、shim（`dsh.cmd`）或命令名；`null` 时自动解析 |
| `dshArgs` | `string[]` | `[]` | 追加给 `dsh web` 的参数，如 `["--trusted-host", "192.168.1.5"]`；已含 `--port`/`--host` 时不再注入默认值 |
| `startupTimeoutSec` | `number` | `90` | 等待 dsh 就绪的超时（秒） |
| `openDevTools` | `boolean` | `false` | 启动时打开开发者工具 |
| `closeToTray` | `boolean` | `true` | 关闭窗口时隐藏到托盘并保持 dsh 运行；设为 `false` 则关闭窗口即退出应用 |
| `windowBounds` | `object \| null` | `null` | 窗口位置/大小（自动保存，一般不用手改） |

等价环境变量：

| 环境变量 | 作用 |
| :--- | :--- |
| `DSH_WINDOW_DSH` | 指定 dsh 入口（等价于 `dshCommand`） |
| `DSH_WINDOW_NODE` | 指定运行 dsh 入口所用的 node 可执行文件 |

## 打包

```powershell
npm run dist:dir   # 免安装目录版，输出到 dist/win-unpacked/
npm run dist       # NSIS 安装包 + 便携版 exe，输出到 dist/
```

打包产物自带 `@deepseek-ai/dsh` 依赖，目标机器未安装 dsh 也能运行（默认优先使用系统里已有的 dsh）。

## 验证

```powershell
npm test                          # 单元测试（注入式 mock，无需真实子进程）
node test/smoke-launch.js         # 端到端冒烟：真实启动 dsh web 并验证 HTTP
node test/smoke-launch.js --stdio # 受限环境冒烟模式（stdio 继承 + HTTP 轮询）
```

冒烟脚本默认将 `DSH_HOME` 指向项目内 `.smoke/dsh-home`，不会污染 `~/.dsh`。

## 目录结构

```text
DSH-Window/
├── electron/
│   ├── main.js          主进程：窗口、生命周期、IPC、菜单、设置、标题栏融合
│   ├── preload.js       状态页桥接（contextIsolation + sandbox）
│   ├── dsh-manager.js   dsh 子进程管理（纯 Node，可独立测试）
│   └── guard.js         dsh 看门狗（主进程被强杀时兜底清理进程树）
├── splash/              启动/状态/错误页（与 DSH Web GUI 同款视觉）
├── assets/              托盘图标与应用图标
├── test/                单元测试与冒烟脚本
├── package.json
└── settings.example.json
```

## 常见问题

- **找不到 dsh**：确认 `npm install` 已执行（内置兜底依赖）；或在设置里把 `dshCommand` 指向 dsh 的 `lib/bin.js`；或全局安装 `npm i -g @deepseek-ai/dsh`。
- **dsh 起来了但界面打不开**：查看状态页日志；`--trusted-host` 仅在非本机访问时需要，本客户端始终走 `127.0.0.1`。
- **退出应用后 dsh 还在跑**：正常退出会自动清理进程树；即使客户端进程被任务管理器强杀，内置看门狗也会在数秒内清理 dsh。若仍残留（如看门狗也被杀），可用 `taskkill /IM node.exe /F`（注意会杀掉所有 node 进程）。
- **窗口顶部拖拽区**：内容区顶部约 32px 的透明条带是拖拽区（用于移动窗口）；侧边栏与窗口按钮区域不受影响。布局校准数据会写入日志（`[layout]` 行），便于后续调整。
- **端口**：本客户端始终使用随机空闲端口，不会与 `dsh web` 命令行实例或其他实例冲突。

## 路线图

- [x] 托盘图标与后台常驻（关闭窗口不停止 dsh）
- [ ] 应用图标与安装包签名
- [ ] 多 profile 切换（web / headless 快捷启动）
- [ ] 自动更新

## 许可

[MIT](./LICENSE) © 2026 dsh-window contributors
