// What the page may ask of the Linux window (docs/linux-app-v0.md §1): sign in again, a link, a folder. Nothing else
// of Electron reaches the page; the main process checks that each request comes from the service's own pages.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

/** The desktop's monospace font, as the main process read it (`--agentswitch-font=<json>`). */
const font = (() => {
  try { return JSON.parse(process.argv.find((a) => a.startsWith("--agentswitch-font="))?.slice("--agentswitch-font=".length) ?? "null"); } catch { return null; }
})();

contextBridge.exposeInMainWorld("agentswitchHost", {
  // The terminal's font: the desktop's monospace one (GNOME's), its size in CSS pixels; null to keep the service's.
  terminalFont: font,
  signIn: () => ipcRenderer.send("agentswitch:signIn"),
  openURL: (url) => ipcRenderer.send("agentswitch:openURL", String(url)),
  chooseFolder: (path) => ipcRenderer.invoke("agentswitch:chooseFolder", String(path ?? "")),
  // Files of this machine: a dropped or pasted file's path (empty for one that has none, a picture off the clipboard);
  // files and folders chosen in the system's dialog; a folder in the code editor.
  pathOf: (file) => { try { return webUtils.getPathForFile(file) || ""; } catch { return ""; } },
  chooseFiles: () => ipcRenderer.invoke("agentswitch:chooseFiles"),
  openEditor: (path) => ipcRenderer.send("agentswitch:openEditor", String(path ?? "")),
  // The look chosen in the tray's Appearance (pixel or classic), told to each page as it loads and when it changes.
  // The window's menu (the tray's), under the page's mark at x, y.
  menu: (x, y) => ipcRenderer.send("agentswitch:menu", Number(x) || 0, Number(y) || 0),
  onLook: (fn) => ipcRenderer.on("agentswitch:look", (_event, look) => fn(String(look))),
});
