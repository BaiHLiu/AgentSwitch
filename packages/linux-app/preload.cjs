// What the page may ask of the Linux window (docs/linux-app-v0.md §1): sign in again, a link, a folder. Nothing else
// of Electron reaches the page; the main process checks that each request comes from the service's own pages.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentswitchHost", {
  signIn: () => ipcRenderer.send("agentswitch:signIn"),
  openURL: (url) => ipcRenderer.send("agentswitch:openURL", String(url)),
  chooseFolder: (path) => ipcRenderer.invoke("agentswitch:chooseFolder", String(path ?? "")),
  // The look chosen in the tray's Appearance (pixel or classic), told to each page as it loads and when it changes.
  onLook: (fn) => ipcRenderer.on("agentswitch:look", (_event, look) => fn(String(look))),
});
