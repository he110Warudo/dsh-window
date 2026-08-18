# DSH Desktop

> 仓库:<https://github.com/he110Warudo/dsh-desktop> · Topic:`dsh-plugin` · License:MIT

DeepSeek Harness 桌面 GUI 客户端。**双击启动,自动拉起 `dsh web`,并在桌面窗口中打开 DSH Web 界面**;退出应用时自动停止 dsh(包括整个子进程树)。

- 零端口冲突:以 `--port 0` 启动,由系统分配空闲端口,从 dsh 输出中解析真实地址
- dsh 命令自动解析:环境变量 → PATH → npm `_npx` 缓存 → 内置依赖 → `npx` 兜底,找不到时给出排查建议
- 崩溃自愈:dsh 意外退出后窗口自动切回状态页,可一键重启(会话数据保存在 `$DSH_HOME`,不丢失)
- 单实例:重复启动只会聚焦已有窗口(避免两个 dsh 同时写 profile)
- 界面与 DSH Web GUI 一致:启动页/状态页使用同一套设计 token(亮/暗跟随系统);系统标题栏隐藏,窗口按钮浮于界面右上角且颜色跟随 DSH 主题;内容区顶部注入透明拖拽条用于移动窗口
- 看门狗:主进程被任务管理器等强杀时,guard 进程自动清理 dsh 进程树,不留孤儿
- 完整日志:启动日志实时展示,可复制、可打开日志文件(`%APPDATA%/dsh-desktop/dsh-desktop.log`)

## 快速开始(开发模式)

要求:Node.js ≥ 20(本机开发时还需要 npm 可联网安装依赖)。

```powershell
npm install          # 安装 electron 与内置的 @deepseek-ai/dsh 兜底依赖
npm start            # 启动桌面客户端
```

> 首次 `npm install` 会下载 Electron 运行时(约 100MB)。

## 打包

```powershell
npm run dist:dir     # 免安装目录版,输出到 dist/win-unpacked/
npm run dist         # NSIS 安装包 + 便携版 exe,输出到 dist/
```

打包产物自带 `@deepseek-ai/dsh` 依赖,即使目标机器没装 dsh 也能运行(默认优先使用系统里已有的 dsh)。

## 配置

运行一次后,设置文件位于 `%APPDATA%/dsh-desktop/settings.json`(参考 `settings.example.json`):

| 字段 | 说明 |
|---|---|
| `dshCommand` | 显式指定 dsh 入口:可填 `.js` 路径、包目录、shim(`dsh.cmd`)或命令名。`null` 时自动解析 |
| `dshArgs` | 追加给 `dsh web` 的参数,如 `["--trusted-host", "192.168.1.5"]`。已含 `--port`/`--host` 时不再注入默认值 |
| `startupTimeoutSec` | 等待 dsh 就绪的超时(默认 90s) |
| `openDevTools` | 启动时打开开发者工具(默认 `false`) |
| `windowBounds` | 窗口位置/大小(自动保存,一般不用手改) |

等价环境变量:`DSH_DESKTOP_DSH`(dsh 入口)、`DSH_DESKTOP_NODE`(运行入口用的 node 可执行文件)。

## 验证

```powershell
npm test                          # 单元测试(注入式 mock,无需真实子进程)
node test/smoke-launch.js         # 端到端冒烟:真实启动 dsh web 并验证 HTTP
node test/smoke-launch.js --stdio # 受限环境下的冒烟模式(stdio 继承 + HTTP 轮询)
```

冒烟脚本默认把 `DSH_HOME` 指向项目内 `.smoke/dsh-home`,不会动 `~/.dsh`。

## 目录结构

```
electron/
  main.js          主进程:窗口、生命周期、IPC、菜单、设置、标题栏融合
  preload.js       状态页桥接(contextIsolation + sandbox)
  dsh-manager.js   dsh 子进程管理(纯 Node,可独立测试)
  guard.js         dsh 看门狗(主进程被强杀时兜底清理进程树)
splash/            启动/状态/错误页(与 DSH Web GUI 同款视觉,主窗口与启动窗口共用)
test/              单元测试与冒烟脚本
```

## 常见问题

- **找不到 dsh**:确认 `npm install` 已执行(内置兜底依赖);或在设置里把 `dshCommand` 指向 `dsh` 的 `lib/bin.js`;或全局安装 `npm i -g @deepseek-ai/dsh`。
- **dsh 起来了但界面打不开**:查看状态页日志;`--trusted-host` 仅在非本机访问时需要,本客户端始终走 `127.0.0.1`。
- **退出应用后 dsh 还在跑**:正常退出会自动清理进程树;即使客户端进程被任务管理器强杀,内置看门狗也会在数秒内清理 dsh。若仍残留(如看门狗也被杀),可用 `taskkill /IM node.exe /F`(注意会杀掉所有 node 进程)。
- **窗口顶部拖拽区**:内容区顶部约 32px 的透明条带是拖拽区(用于移动窗口);侧边栏与窗口按钮区域不受影响。布局校准数据会写入日志(`[layout]` 行),便于后续调整。
- **端口**:本客户端始终使用随机空闲端口,不会与 `dsh web` 命令行实例或其他实例冲突。

## 路线图

- [ ] 托盘图标与后台常驻(关闭窗口不停止 dsh)
- [ ] 应用图标与安装包签名
- [ ] 多 profile 切换(web / headless 快捷启动)
- [ ] 自动更新
