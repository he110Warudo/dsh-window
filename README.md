# DSH Window

> DeepSeek Harness 的 Windows 桌面客户端。应用启动后自动运行 `dsh web`，再通过 Tauri WebView 打开本机界面；退出时清理完整 dsh 进程树。

<p align="center">
  <a href="https://github.com/he110Warudo/dsh-window"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-dsh--window-181717?logo=github"></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow"></a>
  <a href="https://tauri.app/"><img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white"></a>
  <a href="#"><img alt="Platform: Windows" src="https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows11&logoColor=white"></a>
</p>

## 特性

- **轻量窗口层**：采用 Tauri 2 + Rust，界面由系统 WebView2 承载。
- **自动启动 dsh**：按环境变量、PATH、npm `_npx` 缓存、内置依赖、`npx` 依次解析 dsh。
- **零端口冲突**：默认使用 `--host 127.0.0.1 --port 0`，从输出解析实际地址。
- **无白屏交接**：启动页持续显示到 DSH 的 `#root` 真正渲染完成，再显示主窗口。
- **桌面生命周期**：支持单实例、托盘常驻、窗口状态保存、崩溃后重启和主题同步。
- **进程树清理**：正常退出使用 `taskkill /T /F`；应用被强杀时由同一 Rust 可执行文件的 guard 模式兜底。
- **离线运行兜底**：安装包携带 Node sidecar 与 `@deepseek-ai/dsh` 生产依赖，目标机器无需预装 Node 或 dsh。

## 环境要求

| 依赖 | 说明 |
| :--- | :--- |
| Windows 10 或更高版本 | 目标平台，需要 WebView2 Runtime |
| Node.js 20 或更高版本 | 安装前端依赖、准备打包用 Node sidecar |
| Rust stable + MSVC Build Tools | 开发和构建 Tauri 应用 |

## 开发

```powershell
npm install
npm start
```

首次运行会编译 Rust/Tauri 依赖，耗时明显长于后续增量构建。

## 配置

应用继续读取既有版本使用的 `%APPDATA%/dsh-window/settings.json`，升级无需迁移配置。模板见 [`settings.example.json`](./settings.example.json)。

| 字段 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `dshCommand` | `string \| null` | `null` | 指定 dsh 的 JS 入口、包目录、shim、命令或可执行文件 |
| `dshArgs` | `string[]` | `[]` | 追加给 `dsh web` 的参数；显式设置 host/port 后不注入默认值 |
| `startupTimeoutSec` | `number` | `90` | 等待 dsh 就绪的超时秒数，最小为 10 |
| `openDevTools` | `boolean` | `false` | 开发构建中，主界面启动后打开 WebView2 开发者工具 |
| `closeToTray` | `boolean` | `true` | 关闭窗口时隐藏到托盘并保持 dsh 运行 |
| `windowBounds` | `object \| null` | `null` | 自动保存的窗口位置和大小 |

支持的环境变量：

| 环境变量 | 作用 |
| :--- | :--- |
| `DSH_WINDOW_DSH` | 覆盖 `dshCommand` |
| `DSH_WINDOW_NODE` | 指定运行 dsh JS 入口的 Node 可执行文件 |
| `DSH_WINDOW_SMOKE` | 开启自动退出与冒烟标记输出 |
| `DSH_HOME` | 指定 dsh 数据目录 |

## 构建

```powershell
npm run dist:dir  # 生成 src-tauri/target/release/dsh-window.exe
npm run dist      # 生成 src-tauri/target/release/bundle/nsis/ 下的安装包
```

构建前脚本会把当前 Node 可执行文件复制为 `src-tauri/bin/node.exe`，并由 Tauri 与生产 `node_modules` 一起打入安装包。该 sidecar 是生成物，不提交到 Git。

## 验证

```powershell
npm test   # Rust 单元测试
npm smoke  # 隔离 DSH_HOME，真实启动 Tauri + dsh web 并等待页面完成渲染
```

冒烟数据写入项目内 `.smoke/`，不会污染用户的 `~/.dsh`。

## 目录结构

```text
DSH-Window/
├── src-tauri/
│   ├── src/lib.rs       Tauri 生命周期、窗口、托盘、单实例与命令桥
│   ├── src/dsh.rs       dsh 解析、启动、监控、日志与进程树清理
│   ├── src/settings.rs  兼容旧版的设置和主题解析
│   └── tauri.conf.json  应用、资源和 NSIS 打包配置
├── splash/              启动/错误页与远程页面初始化桥
├── scripts/             Node sidecar 准备脚本
├── assets/              DeepSeek 官方图标源文件
└── test/                GUI 冒烟脚本
```

## 常见问题

- **首次构建很慢**：Tauri、WebView2 和 Windows API crate 首次需要完整编译，后续会使用 Cargo 缓存。
- **找不到 dsh**：先运行 `npm install`；也可以设置 `DSH_WINDOW_DSH`，或在设置中指定 dsh 的 `lib/bin.js`。
- **关闭窗口后仍有进程**：默认行为是隐藏到托盘。请从托盘菜单选择“退出”，或把 `closeToTray` 设置为 `false`。
- **日志位置**：`%APPDATA%/dsh-window/dsh-window.log`，超过 512 KB 后轮转为 `.old`。

## 许可

[MIT](./LICENSE) © 2026 dsh-window contributors
