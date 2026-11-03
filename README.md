# rtunnel 管理器

一个 Linear 风格的 SSH 隧道管理面板，用来运行 / 关闭 / 管理多个
[`rtunnel`](https://github.com/yangxikun/rtunnel) 隧道。

不提供预构建下载，请自行从源码构建（见下方）。

## Inspire Notebook 一键连接

在顶部点击 **连接 Notebook**，选择已登录的 Inspire 账号、工作空间和 Notebook，
然后点击 **一键连接**。已停止的机器会显示 **启动并连接**。
本地端口留空会自动分配；已有自动连接会复用原端口。

App 直接调用 Inspire CLI 完成机器查询、启动、远端 sshd/rtunnel 初始化和当前代理地址获取，
由 App 管理本地隧道并验证 SSH 连通性。
连接进度会显示在窗口内，失败后可以重试；关闭选择窗口后仍可重新打开查看进度。
外部运行依赖为 **Inspire CLI (`inspire-skill >= 7.1.14`)**，见 `requirements-cli.txt`。
Inspire CLI 是独立的 Python 命令行工具，需要单独安装；`npm install` 只安装 APP 构建依赖。
当前版本已使用 Inspire CLI 7.1.14 验证。

按 [InspireSkill 官方安装说明](https://github.com/realZillionX/InspireSkill) 安装 CLI 及浏览器运行时，
然后完成一次账号配置和登录：

```bash
inspire --version
inspire account add my-account
inspire account use my-account
inspire init
```

已有账号可直接使用。App 从 `~/.local/bin`、Homebrew 目录和 `PATH` 查找 `inspire`；
自定义安装路径可以通过启动环境变量 `RT_INSPIRE_BIN` 指定可执行文件。
缺少 CLI、版本过低或登录失败时，连接窗口会显示原因。
CLI 步骤超时会先终止本次独立进程组，再强制清理仍未退出的子进程；退出 App 时也会清理正在执行的 CLI。

自动连接以 `bw:账号:工作空间:Notebook` 命名，刷新地址时更新同一条连接。
已有手动连接保留，其他任务占用的端口不会被自动关闭。
H100/H200 的 SSH 限制由 Inspire CLI 执行，这些机器使用 Jupyter Terminal。

## 前提

- 已安装 `rtunnel` 并在 `PATH` 中（`which rtunnel` 能找到）；如用 WebSocket 隧道也可装 `wstunnel`
- 已安装 Node.js（CLI 模式和 App 构建都需要）

## 两种用法

### 桌面 App（推荐）

```bash
npm install        # 安装 electron + electron-builder
npm run dist       # 产出 dist/rtunnel-*.dmg 与 dist/mac-arm64/rtunnel.app
```

- `dist/mac-arm64/rtunnel.app` 可直接双击运行，或拖进 `/Applications`
- 只构建 .app 不打 DMG：`npm run dist:dir`（更快）
- ad-hoc 签名，首次被 Gatekeeper 拦时在「系统设置 → 隐私与安全性」点「仍要打开」，
  或执行 `xattr -dr com.apple.quarantine /Applications/rtunnel.app`
- 关闭窗口即退出 App 并释放端口；已运行的 `rtunnel` 子进程不受影响

桌面 App 模式下数据写在用户目录：

```
~/Library/Application Support/rtunnel-manager/tunnels.json   # 隧道列表
~/Library/Application Support/rtunnel-manager/runtime.json   # 运行状态
~/Library/Application Support/rtunnel-manager/logs/          # 各隧道日志
```

### CLI 模式

```bash
./start.sh                       # 后台常驻
node server.js                   # 前台运行
RT_MANAGER_PORT=8090 ./start.sh  # 换 Web 端口
```

启动后浏览器打开 **http://127.0.0.1:7070**。CLI 模式下 `tunnels.json` 写在脚本同目录
（便于放进 iCloud / Dropbox 同步）。

## 使用

1. 「新建隧道」填写：
   - **远程 URL**、**用户名**（默认 `root`）、**本地端口**（之后用它 ssh 进去）
   - **额外参数**（可选，如 `--secure`）
   - **隧道命令**（可选）：自定义 `rtunnel` 路径或命令名，留空自动从 PATH 搜索；填 `wstunnel` 走兼容模式
   - **使用 sudo 启动**（可选）：启动 / 停止 / 重启时弹密码框，密码只用于本次请求、不保存
   - **跳过启动前直连校验**（可选）：DNS / 网络环境会误伤直连探测时使用
2. 点「添加」→「启动」。
3. 状态变「运行中」后，条目里出现高亮的 `ssh -p <端口> root@127.0.0.1`，点一下复制。

命令等价关系：

```bash
# 默认
rtunnel <远程URL> <本地端口> [额外参数]
# 自定义命令
<rtunnel命令> <远程URL> <本地端口> [额外参数]
# wstunnel（显式绑定 127.0.0.1，避免只监听 ::1 导致 ssh 连不上）
wstunnel -t 127.0.0.1:<本地端口>:127.0.0.1:22 [额外参数] <远程URL>
```

每条隧道都有「编辑」按钮，可改全部字段。未运行时保存后下次生效；运行中会多出
「保存并重启」按钮。sudo 隧道在「启动」/「停止」/「保存并重启」时询问密码。
启动时如果本地端口已被旧的 `rtunnel` / `wstunnel` / 当前隧道命令占用，界面会提示
是否停止占用该端口的进程后重试；若占用者是其它任务，只提示占用，不提供停止操作。

## 工作机制

- **直连保证**：启动 `rtunnel` 时剔除 `HTTP_PROXY / HTTPS_PROXY / ALL_PROXY`（含小写），
  保证 rtunnel 直连而不影响你 shell 的全局代理；启动前会对远程 URL 做一次直连探测，
  连不上则拒绝。可在编辑页勾选「跳过启动前直连校验」绕过。
- **CPU / 内存监控**：CPU 监控模式优先读取远端 cgroup v2/v1 的 CPU quota、cpuset
  和 memory limit/current；调度系统或容器环境下显示的是实际分配额度，而不是宿主机总核数
  或总内存。没有 cgroup 限额时再回退到 `/proc` 的整机数据。
- **远程健康检查**：每 15 秒做一次端到端 SSH 探测（连本地端口、读 `SSH-2.0-` 协议头），
  整条链路都通才算可达；拿不到 banner 显示红色「已断开」徽章，仅作显示不会自动停隧道。
  启动后 2 秒会主动探一次。
- **后台存活**：`rtunnel` 进程 `detached + unref` 完全脱离管理器，关掉前端甚至管理器，
  隧道仍在后台运行；管理器重启后自动接管并刷新状态。顶部「退出管理器」可优雅关闭并释放 7070 端口。

## 数据位置

配置拆成两份分开放，专为跨设备同步设计：

| 文件 | 位置 | 跨设备同步 | 内容 |
|---|---|---|---|
| `tunnels.json` | 脚本同目录 | ✅（若在 iCloud/Dropbox 目录） | 隧道列表 |
| `runtime.json` | `~/Library/Application Support/rtunnel-manager/` | ❌ 本机独占 | pid / status / startedAt |
| 各隧道日志 | `…/rtunnel-manager/logs/<id>.log` | ❌ | 单条隧道输出 |
| 管理器日志 | `…/rtunnel-manager/manager.log` | ❌ | manager 的 stdout/stderr |

`runtime.json` 不跟同步是因为 `pid` 是机器本地编号——若整目录同步，另一台机器会把
对方仍存活的隧道误判为 stopped 并写回，导致下次启动撞 `EADDRINUSE`。拆开后多台 Mac
可共享隧道列表、各管各的运行状态。注意删除会同步删除其它机器的条目。
历史版本的数据首次启动会自动迁移到上述布局。

配置和日志可能包含访问凭据，请只在可信设备间同步。构建仅包含程序文件，
用户配置保留在本机数据目录；发布前不要将配置、日志、环境变量文件或登录状态加入 Git。

## 开发验证

```bash
npm test
git diff --check
```

测试覆盖 Notebook 连接流程、端口保护、CLI 超时清理、错误信息脱敏和打包文件边界。
本地测试可用 `RT_SHARED_CONFIG` 和 `RT_DATA_DIR` 指定独立配置及运行状态目录，
并通过 `RT_MANAGER_PORT` 选择空闲端口。

## 停止管理器

点前端右上角「退出管理器」，或命令行：

```bash
pkill -f "node server.js"   # 不影响已脱离的 rtunnel 隧道
```

## 文件结构

```
rtunnel-manager/
├── server.js          # 主程序：HTTP server + 前端 + 子进程管理（CLI / Electron 共用）
├── electron-main.js   # Electron 主进程：拉起 server.js + BrowserWindow
├── inspire.js         # Notebook 连接流程
├── inspire-cli.js     # CLI 调用、超时清理及错误信息脱敏
├── inspire-ui.js      # Notebook 选择及连接进度界面
├── inspire-ui.css     # Notebook 界面样式
├── requirements-cli.txt # 外部 CLI 依赖
├── tests/             # 自动化回归测试
├── package.json       # npm + electron-builder 构建配置
├── start.sh           # CLI 模式后台启动脚本
├── build/             # App 图标源与产物（icon.svg / icon.icns）
├── scripts/           # 图标构建脚本
└── tunnels.json       # 隧道列表（CLI 模式落在此处）
```
