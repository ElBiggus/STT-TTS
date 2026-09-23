import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('assistantRuntime', {
  apiBaseUrl: 'http://127.0.0.1:8000',
  platform: process.platform,
})
