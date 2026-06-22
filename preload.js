const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("glance", {
  ask: (question, history) => ipcRenderer.invoke("ask", { question, history }),
  resize: (height) => ipcRenderer.send("resize", height),
  hide: () => ipcRenderer.send("hide"),
  onFocusInput: (cb) => ipcRenderer.on("focus-input", cb),
  onHidden: (cb) => ipcRenderer.on("widget-hidden", cb),
  onShown: (cb) => ipcRenderer.on("widget-shown", cb),
  onNowPlaying: (cb) => ipcRenderer.on("nowplaying", (_e, info) => cb(info)),
  mediaControl: (command) => ipcRenderer.invoke("media-control", command),
});
