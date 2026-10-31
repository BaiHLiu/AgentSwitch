// AgentSwitch's window on a Linux desktop (docs/linux-app-v0.md): the node's own Terminals page in Electron, signed in
// with the local token, a tray item and desktop notifications from `GET /live`. The service stays the keeper's: closing
// the window or quitting it leaves the service and its terminals running.

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveNotes, pageOf, wordsOf } from "./lib/live.js";
import { markBitmap, stateOf } from "./lib/mark.js";
import { agentswitchHome, consoleLink, live, ownPage, readToken, serviceBase } from "./lib/service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = agentswitchHome();
const BASE = serviceBase(process.env, HOME);
const TERMINALS = "/ui/terminal.html";
const LIVE_MS = 1000;
const SIGN_IN_GAP_MS = 5000;
/** `--probe=<dir>`: the window drawn off screen, signed in, its page pictured and described into `dir`, then it ends —
 *  no tray, no notifications (how the window is checked without anyone's desktop). */
const PROBE = process.argv.find((a) => a.startsWith("--probe="))?.slice("--probe=".length) ?? null;

app.setName("AgentSwitch");
// Wayland where the session is one (GNOME's default), and its input methods (fcitx5, ibus) there.
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
app.commandLine.appendSwitch("enable-wayland-ime");

if (!app.requestSingleInstanceLock()) app.quit();

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;
let lastSignIn = 0;
let trayState = "";

const statePath = () => join(app.getPath("userData"), "window.json");
function savedBounds() {
  try { return JSON.parse(readFileSync(statePath(), "utf8")); } catch { return {}; }
}
function saveBounds() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
  try {
    mkdirSync(dirname(statePath()), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(win.getBounds()));
  } catch { /* the next start opens at the default size */ }
}

function icon(state, cell) {
  const { width, height, data } = markBitmap(state, { cell });
  return nativeImage.createFromBitmap(data, { width, height });
}

/** The page `path` of the service, signed in first (a one-time link; the cookie it sets lasts as long as the service).
 *  Without the service: a page that says so and tries again. */
async function signIn(path = TERMINALS) {
  if (!win) return;
  if (Date.now() - lastSignIn < SIGN_IN_GAP_MS) return;
  lastSignIn = Date.now();
  try {
    const link = await consoleLink({ base: BASE, token: readToken(HOME), next: path });
    await win.loadURL(link);
  } catch (err) {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(unreachable(err))}`);
    setTimeout(() => { lastSignIn = 0; void signIn(path); }, 3000);
  }
}

function unreachable(err) {
  const why = String(err?.message ?? err).replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"));
  return `<!doctype html><meta charset="utf-8"><title>AgentSwitch</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#d8d8d8;font:14px ui-monospace,monospace">
<div style="max-width:34em;line-height:1.6"><div style="color:#e8a33d">// AgentSwitch 服务未连接</div>
<p>无法连接 ${BASE} 上的本机服务：${why}</p>
<p style="color:#8a8a8a">请确认服务在运行（<code>systemctl --user status agentswitch</code>）。每 3 秒重试一次。</p></div></body>`;
}

/** The page at `path` in the window, brought to the front. */
function show(path) {
  if (!win) return createWindow(path);
  if (path) {
    const url = `${BASE}${path}`;
    if (ownPage(BASE, win.webContents.getURL())) void win.loadURL(url);
    else { lastSignIn = 0; void signIn(path); }
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(path = TERMINALS) {
  const bounds = savedBounds();
  win = new BrowserWindow({
    show: !PROBE, width: bounds.width ?? 1280, height: bounds.height ?? 820, x: bounds.x, y: bounds.y, minWidth: 640, minHeight: 420,
    title: "AgentSwitch", backgroundColor: "#0b0b0c", autoHideMenuBar: true, icon: icon("idle", 8),
    webPreferences: { preload: join(HERE, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} AgentSwitchLinux/${app.getVersion()}`);
  // Only the service's pages are opened here; anything else goes to the system's browser.
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (event, url) => {
    if (ownPage(BASE, url) || url.startsWith("data:")) return;
    event.preventDefault();
    openOutside(url);
  });
  win.on("resize", saveBounds);
  win.on("move", saveBounds);
  // Closed, it hides: the tray brings it back; Quit in the tray (or the second start's) really ends it.
  win.on("close", (event) => {
    if (quitting || !tray) return;
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => { win = null; });
  if (PROBE) probe(win);
  lastSignIn = 0;
  void signIn(path);
}

/** A link from the page: web pages in the system's browser; a file shown in its folder, never opened (as the Mac). */
function openOutside(url) {
  let u;
  try { u = new URL(url); } catch { return; }
  if (u.protocol === "http:" || u.protocol === "https:") void shell.openExternal(u.href);
  else if (u.protocol === "file:") shell.showItemInFolder(fileURLToPath(u.href));
}

/** A request from a page that is not the service's own is not answered. */
const fromService = (event) => ownPage(BASE, event.senderFrame?.url ?? "");

ipcMain.on("agentswitch:signIn", (event) => {
  if (!fromService(event)) return;
  const at = new URL(event.senderFrame.url);
  void signIn(`${at.pathname}${at.search}`.replace(/^\/ui\/login.*/, TERMINALS));
});
ipcMain.on("agentswitch:openURL", (event, url) => { if (fromService(event)) openOutside(url); });
ipcMain.handle("agentswitch:chooseFolder", async (event, path) => {
  if (!fromService(event) || !win) return null;
  const start = path.replace(/^~(?=\/|$)/, app.getPath("home"));
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], ...(existsSync(start) ? { defaultPath: start } : {}) });
  return r.canceled ? null : r.filePaths[0] ?? null;
});

// ---------- the tray and the notifications ----------

function makeTray() {
  try { tray = new Tray(icon("off", 2)); } catch { tray = null; return; }
  tray.setToolTip("AgentSwitch");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Terminals", click: () => show(TERMINALS) },
    { type: "separator" },
    { label: "Restart Service", click: restartService },
    { type: "separator" },
    { label: "Quit AgentSwitch", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", () => show());
}

function restartService() {
  execFile("systemctl", ["--user", "restart", "agentswitch"], (err) => {
    if (err) new Notification({ title: "AgentSwitch", body: `服务未能重启：${err.message}` }).show();
  });
}

const notes = new LiveNotes();
/** Notifications still on screen, by note: kept so a click on one still finds its page. */
const shown = new Map();

async function watchLive() {
  let snapshot = null;
  try { snapshot = await live({ base: BASE, token: readToken(HOME), signal: AbortSignal.timeout(LIVE_MS * 3) }); } catch { /* off */ }
  const state = stateOf(snapshot);
  if (tray && state !== trayState) { trayState = state; tray.setImage(icon(state, 2)); }
  if (snapshot) {
    const inFront = !!win && win.isVisible() && win.isFocused();
    for (const note of notes.next(snapshot, { quiet: inFront })) notify(note);
  }
  setTimeout(watchLive, LIVE_MS);
}

function notify(note) {
  if (!Notification.isSupported()) return;
  const { summary, body } = wordsOf(note);
  const n = new Notification({ title: summary, body, urgency: note.cue === "needsYou" ? "critical" : "normal", silent: note.cue === "done" });
  n.on("click", () => { show(pageOf(note)); shown.delete(note.key); });
  n.on("close", () => shown.delete(note.key));
  shown.set(note.key, n);
  n.show();
}

/** Once the service's page has loaded and settled: its picture and what it says of the window. */
function probe(w) {
  w.webContents.on("did-finish-load", () => {
    const url = w.webContents.getURL();
    if (!ownPage(BASE, url) || url.includes("/ui/login")) return;
    setTimeout(async () => {
      mkdirSync(PROBE, { recursive: true });
      writeFileSync(join(PROBE, "window.png"), (await w.webContents.capturePage()).toPNG());
      const said = await w.webContents.executeJavaScript(`JSON.stringify({
        host: typeof window.agentswitchHost, linux: document.documentElement.classList.contains("linux-app"), title: document.title,
        newTip: document.getElementById("newBtn")?.title ?? null, findKey: document.querySelector(".find kbd")?.textContent ?? null,
        choose: document.getElementById("chooseFolder")?.hidden ?? null })`);
      writeFileSync(join(PROBE, "window.json"), JSON.stringify({ url, ...JSON.parse(said) }, null, 2));
      quitting = true;
      app.quit();
    }, 2500);
  });
}

app.on("second-instance", () => show());
app.on("window-all-closed", () => { if (!tray) app.quit(); });
app.on("before-quit", () => { quitting = true; });
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  if (!PROBE) makeTray();
  createWindow(process.argv.includes("--hidden") ? undefined : TERMINALS);
  if (process.argv.includes("--hidden") && tray) win?.hide();
  if (!PROBE) void watchLive();
});
