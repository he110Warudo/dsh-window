# DSH Window 开发指南

> 面向后续接手本仓库的 coding agent。项目是基于 Tauri 2 + Rust 的 Windows 桌面客户端：自动启动 `dsh web`，在系统 WebView2 中打开本机界面，关闭窗口后可驻留托盘，退出时清理 dsh 进程树。
>
> 仓库：`https://github.com/he110Warudo/dsh-window` · License：MIT · 当前版本：0.1.0

动手前至少阅读「架构概览」「关键机制」和「验证清单」。不要按旧 Electron 架构添加主进程、preload 或 electron-builder 配置。

## 架构概览

```text
src-tauri/
  src/main.rs       程序入口；优先识别 guard 模式，再启动 Tauri
  src/lib.rs        窗口、托盘、单实例、命令桥、主题、退出流程
  src/dsh.rs        dsh 解析、启动、日志采集、超时、重启与进程树清理
  src/settings.rs   settings.json 兼容读取/保存、DSH 主题偏好解析
  src/logging.rs    运行日志与 512 KB 轮转
  capabilities/    Tauri 权限；仅本地 splash 获得 core 命令权限
  icons/            Tauri 应用及安装包图标
  tauri.conf.json   窗口、资源和 NSIS 打包配置
splash/
  index.html        启动、错误和崩溃状态页
  splash.js         状态渲染与重试/退出/日志操作
  tauri-bridge.js   本地状态页的 window.dshWindow 命令桥
scripts/
  prepare-node-sidecar.js  打包前复制当前 Node 到 src-tauri/bin/node.exe
test/
  smoke-launch.js   隔离 DSH_HOME 的真实 Tauri + dsh GUI 冒烟
```

主要配置：

- npm 仅负责 Tauri CLI、dsh 生产依赖和辅助脚本。
- Rust crate 定义在 `src-tauri/Cargo.toml`，入口为 `src-tauri/src/main.rs`。
- 用户数据目录为 `%APPDATA%/dsh-window/`。
- 设置文件为 `%APPDATA%/dsh-window/settings.json`。
- 日志文件为 `%APPDATA%/dsh-window/dsh-window.log`，超过 512 KB 后轮转为 `.old`。
- 安装包携带 `bin/node.exe` 和生产 `node_modules`，目标机器无需预装 Node 或 dsh。

## 关键机制

### 1. 双窗口启动交接

- Tauri 配置只静态创建 `splash` 窗口；Rust 启动 dsh 后动态创建 `main` 窗口。
- `main` 初始 `visible(false)`，避免 DSH 空壳页面造成白屏闪烁。
- WebView 收到 `PageLoadEvent::Finished` 后延迟 750 ms 调用 `finish_main_window()`：显示主窗口、聚焦，并隐藏 splash。
- `frontend_ready` 使用 `AtomicBool` 保证交接只执行一次。
- 修改启动流程时必须保留“splash 覆盖到主页面加载完成”的行为。

### 2. 远程页面安全边界

- DSH 主页面来自动态回环地址，例如 `http://127.0.0.1:8176/`。
- `src-tauri/capabilities/default.json` 只允许 `splash` 使用 Tauri core 权限。
- 不要给远程 `main` 页面开放通用 Tauri IPC，也不要重新注入可执行任意本地命令的桥。
- 主窗口使用系统原生标题栏，不再向 DSH 页面注入自绘窗口按钮。
- 主窗口导航限制在启动时解析出的同源地址；跨源 HTTP(S) 导航和 `window.open` 交给系统浏览器。

### 3. dsh 解析和启动

解析顺序位于 `src-tauri/src/dsh.rs`：

1. `DSH_WINDOW_DSH` 或设置中的 `dshCommand`；
2. PATH 中的 `dsh`；
3. npm `_npx` 缓存；
4. 随包 `node_modules/@deepseek-ai/dsh/lib/bin.js`；
5. PATH 中的 `npx --yes @deepseek-ai/dsh` 兜底。

启动规则：

- 用户参数未包含 `web` 时自动补上。
- 未显式设置 host 时补 `--host 127.0.0.1`。
- 未显式设置 port 时补 `--port 0`，由系统分配空闲端口。
- 从 stdout 的 `dsh web: http://127.0.0.1:<port>` 解析实际 URL。
- 等待时间使用 `startupTimeoutSec`，最小 10 秒。

### 4. Node sidecar 与打包资源

- Tauri 不自带 Node；dsh 是 Node 应用，因此发布包必须携带 Node sidecar。
- `npm run prepare:sidecar` 将 `DSH_WINDOW_NODE` 或当前 `process.execPath` 复制到 `src-tauri/bin/node.exe`。
- `src-tauri/bin/node.exe` 是生成物，已忽略，不要提交。
- `tauri.conf.json` 将 sidecar 和生产 `node_modules` 复制到发布资源目录。
- Windows 发布资源路径可能带 `\\?\` 前缀；传给 Node 前必须经过 `normalize_resource_path()`。删除该规范化会导致打包版报 `EISDIR ... lstat 'C:'`。
- 验证发布包时必须至少做一次隔离 PATH 与 LOCALAPPDATA 的测试，确认没有误用系统 Node 或 npm 缓存。

### 5. 进程生命周期与 guard

- `DshRuntime` 用 generation 编号废弃旧启动任务，避免重启竞争。
- Windows 停止 dsh 使用 `taskkill /PID <pid> /T /F` 清理整棵进程树。
- dsh 启动后，同一应用可执行文件以 `--dsh-guard <parent-pid> <dsh-pid>` 模式启动看门狗。
- guard 检测到主应用消失后清理 dsh；检测到 dsh 已退出则自行结束。
- 正常退出走 `graceful_quit()`：设置 quitting 标记、停止 dsh、写日志，然后 `app.exit(0)`。
- 不要在退出路径中直接跳过 `runtime.stop()`。

### 6. 托盘、单实例与关闭行为

- `tauri-plugin-single-instance` 保证单实例，二次启动只恢复并聚焦已有窗口。
- 托盘菜单包含：显示窗口、重新启动 dsh、退出。
- `closeToTray=true` 时，窗口关闭事件被拦截并隐藏窗口。
- `closeToTray=false` 时，关闭窗口触发完整退出流程。
- 主窗口关闭前保存非最大化状态下的位置和大小。

### 7. 设置与主题

设置字段与既有版本兼容，见 `settings.example.json`：

- `dshCommand: string | null`
- `dshArgs: string[]`
- `startupTimeoutSec: number`
- `openDevTools: boolean`，仅 debug 构建生效
- `closeToTray: boolean`
- `windowBounds: object | null`

主题规则：

- 从 `$DSH_HOME/settings.yaml` 或 `~/.dsh/settings.yaml` 读取 `ui-theme.preference`。
- 支持 `light`、`dark`、`system`，缺失或解析失败时使用 `system`。
- 后台每秒重新解析一次，变化后向 splash 推送 `dsh:theme`。
- DSH 主页面自行管理主题，不应由本应用覆盖页面主题 DOM。

## 环境变量

| 变量 | 用途 |
| :--- | :--- |
| `DSH_WINDOW_DSH` | 覆盖 dsh 入口或命令 |
| `DSH_WINDOW_NODE` | 指定运行 dsh JS 入口或准备 sidecar 的 Node |
| `DSH_WINDOW_SMOKE` | 开启冒烟标记、60 秒硬超时和自动退出 |
| `DSH_HOME` | 指定 dsh 数据目录；测试时必须隔离 |

## 开发命令

```powershell
npm install
npm start                 # tauri dev
npm test                  # cargo test
npm run smoke             # 真实 Tauri + dsh GUI 冒烟
npm run prepare:sidecar   # 生成 src-tauri/bin/node.exe
npm run dist:dir          # release exe，不生成安装包
npm run dist              # release exe + NSIS 安装包
```

产物位置：

- 裸 exe：`src-tauri/target/release/dsh-window.exe`
- NSIS：`src-tauri/target/release/bundle/nsis/DSH Window_<version>_x64-setup.exe`

## 验证清单

提交前至少执行：

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm test
node --check splash/tauri-bridge.js
node --check splash/splash.js
node --check test/smoke-launch.js
git diff --check
npm run smoke
```

涉及打包、资源目录、dsh 解析或 sidecar 时，额外执行：

```powershell
npm run dist:dir
npm run dist
```

发布版严格冒烟需要：

- 将 `APPDATA`、`LOCALAPPDATA`、`DSH_HOME` 指向临时目录；
- 将 PATH 缩减为 Windows 系统目录，隐藏系统 Node、dsh 和 npx；
- 运行 `src-tauri/target/release/dsh-window.exe`；
- 日志必须显示随包 `node_modules/@deepseek-ai/dsh/lib/bin.js`；
- stdout 必须出现 `DSH_WINDOW_SMOKE_READY` 和 `DSH_WINDOW_SMOKE_PAGE_LOADED`。

### 冒烟与诊断注意事项

- `test/smoke-launch.js` 会先删除并重建项目内 `.smoke/`，避免污染真实 `~/.dsh`。
- Windows 下 Node 24 直接 spawn `npm.cmd` 可能报 `EINVAL`，脚本已改为经 `cmd.exe /d /s /c` 启动。
- 冒烟脚本等待上限为 180 秒；应用在 smoke 模式下有 60 秒硬上限。
- 主要诊断来源是 `%APPDATA%/dsh-window/dsh-window.log`。
- WebView2 退出时偶尔输出 `Failed to unregister class Chrome_WidgetWin_0, Error = 1412`，当前不影响退出码和进程清理。
- 编译器可能输出 Windows 链接器“正在创建库 ... dll.lib”的 warning，该信息不是测试失败。

## 编辑约定

- 注释和文档使用中文；代码标识符、命令和路径保持半角。
- 优先沿用现有 Tauri/Rust 模块边界，不重新引入 Electron 目录或依赖。
- `src-tauri/target/`、`.smoke/`、`node_modules/`、`src-tauri/bin/node.exe` 和日志均为生成物，不提交。
- 不要手工编辑 `src-tauri/gen/schemas/`；它由 Tauri CLI 生成。
- 图标使用 `src-tauri/icons/`。重新生成可运行 `npx tauri icon <source.png>`。
- 提交信息使用 `feat:`、`fix:`、`refactor:` 或 `docs:` 前缀。
- 不要自动推送远端；只有用户明确要求时才 commit 或 push。

## 当前状态（2026-08-19）

已完成：

- Tauri 2 + Rust 重构；
- dsh 自动解析、随机端口启动、超时和崩溃恢复；
- Node sidecar 与随包 dsh；
- splash 到主页面的延迟交接；
- 单实例、托盘常驻和窗口状态保存；
- 正常退出与强杀兜底的进程树清理；
- 亮暗主题同步；
- release exe、NSIS 和无系统 Node 场景的真实冒烟验证。

路线图：

- [ ] 安装包签名
- [ ] 多 profile 切换
- [ ] 自动更新
