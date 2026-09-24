const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('assistantRuntime', {
  apiBaseUrl: 'http://127.0.0.1:8000',
  getNetworkExposure: () => ipcRenderer.invoke('network-exposure:get'),
  platform: process.platform,
  setNetworkExposure: (value) => ipcRenderer.invoke('network-exposure:set', value),
})