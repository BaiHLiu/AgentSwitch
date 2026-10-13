# 功能展示页

`index.html`：Mac 与 iPhone 两端的全部界面、实时活动、动效录屏，以及可操作的演示（嵌入 `docs/design/` 的 `terminal.html?bare`、`phone.html?bare&dark`，构建时复制到 `demo/`：Safari 打开本地网页时只读得到它所在文件夹及子文件夹里的文件）。所有数据都是演示数据：截图来自 Mac 应用的 `-designPreview` 和 iPhone 应用的 `-uiDemo` 画面，录屏来自 iOS 模拟器。

素材不进 git，由 `build.sh` 生成到 `media/`：

```bash
docs/showcase/build.sh capture   # Mac 出图、实时活动出图、模拟器截图与录屏，写入 .src/（要 Xcode 和 iPhone 17 模拟器）
docs/showcase/build.sh media     # .src/ → media/（网页尺寸的 JPEG、mp4）
docs/showcase/build.sh zip       # 展示页和演示页打成 ~/Desktop/AgentSwitch-showcase.zip，解压后打开 showcase/index.html
```

## 根目录 README 里的图（`docs/readme/`）

这十七张**进 git**（用户 2026-10-09：应该在readme上弄一些功能展示；2026-10-13：更新一下readme里面的图，用最新修复过的，把classic的图也放上），是本页“素材不进 git”的例外，所以只留少数几张、压到网页尺寸（共约 2.4 MB）。全是演示数据。像素外观九张（名字不带后缀），经典外观八张（同名加 `-classic`；Mac 的 Clash 页两种外观只差图标栏和状态栏，只放一张）。重新出图的办法：

- Mac（深色，宽 1600、JPEG 82；外观用 `-appearance pixel` / `-appearance classic`，只对这一次运行生效）：`.build/debug/AgentSwitchMac -designPreview <目录> -designPreviewOnly window` 的 `main-dispatch-dark`；`-designPreviewOnly terminals` 的 `terminals-record`、`-designPreviewOnly browsers` 的 `main-browser-profiles`、`-designPreviewOnly clash` 的 `main-clash`。`terminals-record` 里记录停在末尾（2026-10-13 起简略视图整段排版，simple-view-v0 §5.2），所以图上看不到会话的标题那几行，右边有一条刚滚动过的滚动条。
- iPhone（模拟器，`simctl ui … appearance dark`，状态栏 9:41，`-appearance pixel` / `-appearance classic`，宽 600、JPEG 82）：`-uiDemoScreen home`、`terminals`、`simple`、`browserpage`、`clashservice`。换外观后第一次启动会弹“图标已更换”，先空启动一次再截。截完把模拟器的深浅和状态栏放回去（`simctl ui … appearance light`、`simctl status_bar … clear`），再用默认外观空启动一次把图标换回来。模拟器构建会改 `packages/ios-app/Package.resolved`，不要提交。
- 转换：`sips -s format jpeg -s formatOptions 82 --resampleWidth <宽> <png> --out docs/readme/<名字>.jpg`。
