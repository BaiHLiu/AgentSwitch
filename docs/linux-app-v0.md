# linux-app-v0：Linux 桌面窗口——有桌面的 Linux 节点也有一个窗口

2026-10-31 用户（catop）：随后我们来规划 linux 端 GUI client 的设计。看过三条路线（薄壳装服务自带的网页 / GTK 原生重写 / 与 Android 共用的 Compose Desktop）之后：能否先开发 linux 客户端。

**本文是草案。** 路线按推荐的 A（Electron 薄壳）先做第 1 步（§6）；标“已定”的是用户定的，其余是提议，等协作者（项目主人）看过。相关：`docs/mesh-v0.md` §4（Linux 无头节点）、§5.2（界面只连本机服务）；`docs/app-v0.md` §4（Mac 应用）；`docs/terminal-v0.md` §1（终端页）；`docs/tui-v0.md`（`agentswitch config`）。

## 0. 要点

- **还是同一个节点，多一个窗口。** mesh-v0 里 Linux 节点“没有窗口，其余和 Mac 节点一样”；有桌面的 Linux（catop 的 Arch + GNOME）可以多一个窗口，其余不变：服务照旧由 systemd 跑、看护进程照旧是 `agentswitch node run`，窗口关了、退出了，服务和终端都不受影响。没有桌面的机器什么也不多装。
- **窗口只连本机服务**（mesh-v0 §5.2）：`127.0.0.1` 上的本机接口，凭 `~/.agentswitch/local-token`。用别的节点，照旧经本机服务的 `/nodes/<id>/…`，窗口自己不配对、不存别人的东西。
- **薄壳，页面是服务自带的网页。** Mac 的 Terminals 页本来就是 WKWebView 装着服务的 `ui/terminal.html`（只是屏幕换成原生 SwiftTerm）；网页版是完整的：分屏、目录树、确认卡、提问卡、yazi。Linux 窗口直接装这些网页，屏幕用网页自己的 xterm.js。壳只做网页做不了的事：登录、托盘、系统通知、选文件夹、开外部链接、单实例、开机自启。
- **网页补的东西各处都受益。** 以后给网页补 Dispatch 页、简略视图，浏览器里的控制台和 Mac 的网页版终端页也一起有。
- **用 Electron**：现有网页都是在 Chrome 里验的（ui-v0 的截图验证用无头 Chrome）；xterm.js 在 WebKitGTK 上的 WebGL 与性能不稳；Wayland 下 fcitx5 输入法 Electron 有现成开关。代价是体积（系统 Electron 时没有这个代价，§5）。

## 1. 组成

```
packages/linux-app/            Electron 主进程与预加载脚本，纯 JavaScript（ESM），不经构建
  main.js                      窗口、登录、托盘、通知、单实例
  preload.cjs                  给网页的 window.agentswitchHost（contextBridge）
  lib/                         不依赖 Electron 的部分（地址、令牌、实时活动的提醒规则），vitest 测
  agentswitch.desktop          桌面启动项
  scripts/run.sh               用系统的 electron 启动
```

- **登录**：读 `local-token`，`POST /local/console-link {next}` 换一次性链接（一分钟、一次），窗口打开它，服务种下会话 cookie。服务重启后 cookie 失效，网页说 `signIn`，壳再换一次（和 Mac 一样，五秒内不重复）。令牌只在主进程里，网页拿不到。
- **服务的地址**：`node.json` 里的本机端口（`agentswitch config` 的 Node 页改的那个），没有就是 4711。
- **网页认得壳**：网页看 `window.agentswitchHost`（预加载脚本放进去）。有它时：登录失效不提示“从 AgentSwitch 重新打开”，交给壳；外部链接交给壳（`shell.openExternal`，即 `xdg-open`）；`Choose…` 打开系统的选文件夹对话框。别的照浏览器里的样子。不复用 Mac 的 `window.webkit.messageHandlers`：那条路上很多消息（原生屏幕的位置、窗口顶栏）Linux 用不上。

## 2. 窗口

- 一个主窗口，内容就是终端页 `ui/terminal.html`（第 1 步）。第 2 步加一列侧栏切页：Terminals、Dispatch（先用现有的网页控制台 `ui/`，之后照 Mac 的 Dispatch 页补网页版）。Browser、设置在第 3 步（§6）。
- 窗口大小、位置、在哪一页记在 `~/.config/AgentSwitch/window.json`。
- 关窗口不退出（托盘还在）；托盘的 `Quit AgentSwitch` 只退出窗口，服务照跑。
- 菜单栏：Linux 上隐藏（`autoHideMenuBar`），快捷键照网页自己的（网页里写的是 ⌘，Linux 上是 Ctrl，§7.1）。

## 3. 托盘与系统通知

- **窗口里的菜单**（2026-10-31，catop：似乎并没有托盘菜单？）：GNOME 的托盘要扩展、图标也不显眼，所以点终端页右上角的标记弹出同一个菜单（托盘的那一份）。
- **托盘**（StatusNotifierItem）：像素外观的 AgentSwitch 标记；有事等你时换成带亮点的那一张。菜单照 Mac 菜单栏面板：`Open Terminals`、`Appearance ▸ Pixel / Classic`（Mac 设置 › General 的那一项）、`Open Dispatch`（第 2 步）、`Pair Device…`（第 3 步，先在终端里跑 `agentswitch pair`）、`Restart Service`（`systemctl --user restart agentswitch`）、`Quit AgentSwitch`。GNOME 默认没有托盘区，要 AppIndicator 扩展；没有扩展时托盘不出现，其余照常（`doctor` 可以说一句）。
- **系统通知**：每秒一次 `GET /live`（和 Mac 的实时活动同一个数据源），终端等你确认、问你问题、任务结束时发一条桌面通知。提醒规则照 Mac 的 `LivePresenter`（同一件事只提醒一次，窗口在前面且正看着那个终端时不提醒），移植成 `lib/` 里有测试的一段。
  - 点通知打开窗口并切到那个终端（`terminal.html?id=`）。
  - 通知上直接 `Allow` / `Deny`：Electron 在 Linux 上的通知不带按钮，第 2 步改为经 D-Bus 直接调 `org.freedesktop.Notifications`（带 actions），按了就发 `/terminals/:id/permissions/:pid`。第 1 步只有“点了打开”。

## 4. 剪贴板、拖放与输入法

- 文本粘贴、拖进文件路径：网页的 xterm.js 已有。图片粘贴（Mac 的 ⌘V 贴图，terminal-v0 §1 Mac）网页还没有：第 2 步在网页里补（`paste` 事件里有图片时走 `POST /uploads` + `/terminals/:id/attach`，浏览器里的控制台一并受益）。
- Wayland：`--ozone-platform-hint=auto`，fcitx5 用 `--enable-wayland-ime`；X11 下照常。

## 5. 安装

- **第 1 步：用系统的 Electron。** Arch 有 `electron` 包（这台机器是 44）；`scripts/run.sh` 找 `electron`，没有就说怎么装。`packages/linux/scripts/install.sh` 把 `linux-app/` 拷进运行时旁边，并装 `~/.local/share/applications/agentswitch.desktop`（`--with-window`，默认不装；没有桌面的机器不装）。
- **之后：自带 Electron 的包**（AppImage 或 tar），给没有系统 Electron 的发行版；CI 在 Linux runtime 那一步旁边造它，并用 xvfb 起一次（窗口能登录、能打开终端页）。

## 6. 分步

1. **壳 + 终端页 + 托盘 + 通知（点了打开）。** 网页认得壳（§1）。验证：在 dellarch 上真的开、登录、开终端、服务重启后自己重新登录；托盘菜单每项；一个假的等确认让通知出来、点开到那个终端。
2. **侧栏切页 + Dispatch（先用网页控制台）+ 通知上的 Allow / Deny + 网页里的图片粘贴。**
3. **Browser 页（看画面流，手机已有这种看法）、设置（先在一个终端里开 `agentswitch config`）、配对。** 打包与 CI。
4. 网页版 Dispatch 页与简略视图（照 Mac 原生页、演示页 `docs/design/implemented/mac-window.html`、`docs/design/concepts/simple-view.html`）：这一步是给网页补页面，做了 Linux 窗口、浏览器、Mac 的网页版终端页都有。

## 7. 要定的

1. 快捷键：网页里写的是 ⌘（Mac 的），Linux 上 Super 键归 GNOME；终端里 Ctrl+字母是给程序的（Ctrl+C、Ctrl+D、Ctrl+B……），不能被窗口拿走。第 1 步照 GNOME Terminal 先这样做了；分屏的键是 catop 定的（2026-10-31：ctrl+shift+d 左右分屏，+b则上下分屏。其他的可以）：

   | Mac | Linux 窗口 | |
   |---|---|---|
   | ⌘T ⌘W ⌘F | Ctrl+Shift+T W F | 新终端、关闭、搜索 |
   | ⌘B | Ctrl+Shift+L | 列表（B 给了分屏） |
   | ⌘D ⌘⇧D | Ctrl+Shift+D、Ctrl+Shift+B | 左右、上下分屏（已定） |
   | ⌘⇧↩ | Ctrl+Shift+Z | 这一块单独占满 |
   | ⌘⌥ 方向键 | Ctrl+Alt+方向键 | 到相邻的一块 |
   | ⌘1–9 | Alt+1–9 | 切终端（GNOME Terminal 切标签页的键） |
   | ⌘⇧V | Ctrl+Shift+S | 加密回复（Ctrl+Shift+V 在 Linux 终端里是粘贴，留给粘贴） |
   | ⌘↩ ⌘⌫ | Ctrl+Shift+↩、Ctrl+Shift+⌫ | 确认卡的允许、拒绝 |
   | ⌘C ⌘V | Ctrl+Shift+C、Ctrl+Shift+V | 复制终端里选中的字、粘贴 |
   | ⌘ 点链接 | Ctrl 点链接 | |

   网页上写出来的键名（提示、按钮、菜单）在 Linux 窗口里换成这一列；浏览器里和 Mac 上不变。
2. 是否需要和 Mac 一样的外观切换（像素 / 经典）：网页已有，壳只需记住。
3. 协作者是否同意 mesh-v0 的“Linux 无头版”多出有窗口这一种（本文 §0 第一条）。

## 8. 实现记录

### 第 1 步（2026-10-31，catop，分支 `linux-app`）

- **`packages/linux-app/`**：`main.js`（窗口、登录、托盘、通知、单实例）、`preload.cjs`（`window.agentswitchHost`：`signIn`、`openURL`、`chooseFolder`；主进程只认服务自己页面发来的请求）、`lib/`（服务地址与令牌、一次性登录链接、`/live` 的提醒规则、托盘图标的像素）。纯 JavaScript，不经构建，没有依赖；`npm test` 用 `node --test` 跑 `lib/` 的 12 个测试，CI 的 daemon 一项里跑。
- **登录**：`node.json` 的本机端口（或 `AGENTSWITCH_URL`），`POST /local/console-link?next=` 换一次性链接后打开；服务不答时窗口里说明并每 3 秒重试；网页说登录失效（服务重启后）时再换一次，五秒内不重复。只有服务自己的页面在窗口里打开，其余链接交给系统浏览器，`file://` 只在文件夹里显示、不打开。
- **网页**（`ui/terminal.js`）：有 `window.agentswitchHost` 时加 `linux-app` 类；登录失效交给壳；`Choose…` 用系统的选文件夹对话框（`folderChosen` 从 Mac 那一段里提出来两边共用）；键按 §7.1 的表取，提示、按钮、菜单里的键名一起换。Mac 和浏览器里不变。
- **托盘**：和 Mac 菜单栏同一个像素标记（`PixelArt.stackRows`，`lib/mark.js` 里抄了一份，两边要一起改），按 `/live` 的 idle / busy / waiting 换样子，服务不答时是 off（抖成一半）。菜单：`Open Terminals`、`Restart Service`（`systemctl --user restart agentswitch`）、`Quit AgentSwitch`。关窗口只是藏起来；没有托盘时关窗口即退出。
- **通知**：每秒一次 `GET /live`。启动时已在等的、已结束的算知道了；之后新的等待（按请求的 id）、新的结果各说一次；窗口在前面时不说，那段时间来的算知道了。等你的是 critical，完成的不响。点了打开窗口并切到那个终端（任务则是控制台的那条任务；别的节点的只打开页面）。
- **安装**：`build-runtime.sh` 把 `linux-app/` 拷进运行时；`install.sh --with-window` 生成图标、写菜单项与登录项（`--hidden`，在托盘里起）。
- **验证**：从这份代码另起一个服务（临时数据目录、端口 5799、没有远程与浏览器），用 `--probe` 在屏幕外开窗口：登录成功、打开终端页，网页认出壳（`agentswitchHost`、`linux-app` 类）、键名换成 `Ctrl+Shift+T`、`Ctrl+Shift+F`，`Choose…` 出现；截图对过。daemon 的界面测试 100 个通过。**还没在桌面上实际点过**：托盘菜单每项、通知与点开、服务重启后自己重新登录、Wayland 下的输入法、复制粘贴，要 catop 在 dellarch 的桌面上试。
- 注意：从代码另起服务时，它会照常为 Codex 终端的 hook 在 `~/.codex/config.toml` 里写信任（同样的键、它自己命令的哈希），把已装服务的那几项覆盖掉；已装的服务下次开 Codex 终端前会自己写回来（`ensure({ fresh: true })`）。

### 第 2 步：终端页照 Mac 1:1（2026-10-31，catop）

catop：需要加上简略视图和另一种theme，让其基本与mac app 1：1复刻，像列表里筛选active之类的功能很实用，但目前缺失。dispatch和代理切换还有设置菜单之类的暂时不需要，只需要主功能即可。看过两批的划分后：两批一次性做完并测试。

只改浏览器和 Linux 窗口里的终端页；Mac 应用里这一页的屏幕与简略视图是原生的，它走的路径（`NATIVE`）一行没动。

- **分屏**（`ui/lib/webScreens.js`）：网页原来只有在 Mac 里才分屏——页面管布局，原生屏幕负责画。现在浏览器和 Linux 窗口里由“网页版屏幕”照同一个约定做：每块一个 xterm，各自跟着自己终端的流（带本页的屏幕 id）、各自持有尺寸；被别处占用时那一块显示 `On iPhone` 等，点一下接管。页面原有的分屏逻辑（布局、拖行进某一块、拖分隔线、放大、标题栏、最多 4 块）照旧用。窄屏（手机浏览器）仍是一块。Ctrl+Shift+D / B 分屏，Ctrl+Shift+Z 放大，Ctrl+Alt+方向键切块。
- **简略视图**（`ui/recordView.js`，规则在 `ui/lib/record.js`，照 Mac 的 SessionRecord / RecordDisplay / ReplyHints 等逐条移植，测试 18 个）：Ctrl+Shift+E、顶栏和每块标题栏的按钮、右键菜单切换，按终端记住。
  - 记录：你的话（右侧，图片缩略图可点开看大图、复制）、别的会话转来的话、回答（Markdown，代码块带 Copy，长的 `Show More`，思考过程淡一些）、`Worked 1m 12s · Read 2 · Ran 1` 折叠行（展开是每一步；命令再展开是整条命令，按 shell 着色，带输出；带图的步骤显示图）、`+N −M` 点开 Changes 面板、屏幕上对命令的回应、`Earlier`、`↓ Latest`。
  - 正在写的字（带光标）、正在做什么的那一行（工具、目标、token 数、计时，子代理各一行，流光效果）、Exited。
  - 卡片：它自己屏幕上的列表（点一行等于在终端里选中回车）、Codex 结尾的问题（点一个作为回复）、程序自己画的等待界面（切到终端视图）。确认卡与提问卡仍是页面原有的浮层卡（在获得焦点的那一块右上），不是 Mac 那样排在记录末尾。
  - 回复框：浮在记录上；`/` 命令、`@` 文件（↑↓ tab ↩ esc）、`!` `$` 的说明；附件以 `[Image #n]` / `[File #n]` 占位，删占位即删文件，最多 10 个；拖进来、粘贴、`+ › Files…`（Linux 窗口用系统对话框、按路径给；浏览器上传）、`+ › Paste Image`；权限方式（Claude Code，Bypass 红色）、模型（含 Older）、思考强度滑块、Codex 的 Daybreak；不能改时是淡字，悬停说原因；`Context 62%`；↩ 发送、⇧↩ 换行、工作中空框 esc 或 ■ 停止；建议的下一句 tab 填入。回复框右键：`Transcript: Verbose`、`Changes of the Last Turn`、`Show Side Pane`。
  - 右侧栏（窗格 ≥ 980 宽、打开时）：Context 进度条、Tasks、Changes 文件列表（点开看这个文件最近一次的 diff）。
  - 深浅色：简略视图跟随系统；获得焦点的那一块是简略视图且系统是浅色时，列表、顶栏也变浅色（经典外观即白色）；终端画面始终深色——同 Mac。
- **列表与顶栏**：顶栏补上 Mac 主栏有的 `Open yazi Beside`、`Open in VS Code`（Linux 窗口：本机的 `code`，没有就 `vscode://`）、简略视图 / 终端视图、两个分屏按钮；会话行右键：`Resume`、`Resume As <配置>`、`Delete`；新建终端面板补上 Profile 与 Effort。
- **Linux 窗口**：权限请求的通知上直接 `Allow` / `Deny`（经 `notify-send` 的 actions；点通知本身打开那个终端；没有 notify-send 时退回普通通知）；终端里粘贴图片（只有图片时上传并把路径贴进终端，同 Mac 的 ⌘V）；拖文件到终端或回复框按路径给。
- **验证**：用这份代码另起一个服务（临时数据目录、端口 5799），把一个假的 `claude`（只回显，不调模型）恢复到一段真实会话上，用 `packages/linux-app/scripts/shoot.js` 在屏幕外驱动页面并截图：终端视图、简略视图、展开工作行与命令、模型菜单、思考强度、`/` 命令提示、分屏、Active 筛选、像素与经典外观各自的深浅色；从简略视图发出的回复到达终端并立即出现在记录末尾。daemon 测试 1949 个、linux-app 测试 15 个通过。**没在桌面上实际点过**：拖放、粘贴图片、通知上的 Allow / Deny、输入法。
