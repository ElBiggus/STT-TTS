import { app, BrowserWindow, dialog, shell } from 'electron'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

let backendProcess = null
const backendPort = 8000

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

async function waitForHttp(url, timeoutMs = 30000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      // The service is still starting up.
    }
    await sleep(500)
  }

  throw new Error(`Timed out waiting for ${url}`)
}

function clearStaleBackendProcess() {
  if (process.platform !== 'win32') {
    return
  }

  try {
    const pid = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-NetTCPConnection -LocalPort ${backendPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
      ],
      { encoding: 'utf8' },
    ).trim()

    if (!pid) {
      return
    }

    const commandLine = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine)`,
      ],
      { encoding: 'utf8' },
    ).trim()

    if (!commandLine.includes('uvicorn backend.app.main:app')) {
      return
    }

    execFileSync('taskkill.exe', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // If the stale-process cleanup fails, the startup health check will surface the real issue.
  }
}

function startBackend() {
  if (backendProcess) {
    return
  }

  clearStaleBackendProcess()

  const workingDirectory = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const venvPython = path.join(workingDirectory, 'backend', '.venv', 'Scripts', 'python.exe')
  const hasVenv = fs.existsSync(venvPython)
  const command = hasVenv ? venvPython : 'py'
  const args = hasVenv
    ? ['-m', 'uvicorn', 'backend.app.main:app', '--host', '127.0.0.1', '--port', String(backendPort)]
    : ['-3.11', '-m', 'uvicorn', 'backend.app.main:app', '--host', '127.0.0.1', '--port', String(backendPort)]

  backendProcess = spawn(command, args, {
    cwd: workingDirectory,
    windowsHide: true,
    stdio: 'ignore',
  })
}

function stopBackend() {
  if (!backendProcess) {
    return
  }

  backendProcess.kill()
  backendProcess = null
}

async function createWindow() {
  startBackend()
  await waitForHttp(`http://127.0.0.1:${backendPort}/health`)

  const isDev = !app.isPackaged
  if (isDev) {
    await waitForHttp('http://127.0.0.1:5173')
  }

  const mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1100,
    minHeight: 760,
    show: false,
    backgroundColor: '#efe7d9',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    await mainWindow.loadURL('http://127.0.0.1:5173')
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })
}

app.whenReady().then(async () => {
  try {
    await createWindow()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox(
      'Local Voice Studio startup failed',
      `The desktop shell could not start its local services. Run \"npm run setup:backend\" from the project root, then try again.\n\n${message}`,
    )
    app.quit()
  }
})

app.on('window-all-closed', () => {
  stopBackend()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopBackend()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow()
  }
})