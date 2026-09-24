import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let backendProcess = null
let backendStartupPromise = null
let windowCreationPromise = null
const backendPort = 8000
const localApiBaseUrl = `http://127.0.0.1:${backendPort}`
const exposureConfigFileName = 'network-exposure.json'
const packagedBackendRuntimeDirName = 'backend-runtime'
const backendLogFileName = 'backend.log'
let networkExposure = { openToLan: false, openToWan: false }

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
}

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

function normalizeNetworkExposure(value = {}) {
  const openToWan = Boolean(value.openToWan)
  const openToLan = openToWan || Boolean(value.openToLan)
  return { openToLan, openToWan }
}

function getBackendLogPath() {
  return path.join(app.getPath('userData'), backendLogFileName)
}

function appendBackendLog(message) {
  const logPath = getBackendLogPath()
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
}

function resetBackendLog() {
  const logPath = getBackendLogPath()
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.writeFileSync(logPath, '', 'utf8')
}

function getExposureConfigPath() {
  return path.join(app.getPath('userData'), exposureConfigFileName)
}

function getPackagedBackendRoot() {
  return path.join(process.resourcesPath, 'backend')
}

function getPackagedBackendRuntimeDir() {
  return path.join(app.getPath('userData'), packagedBackendRuntimeDirName)
}

function getPackagedRuntimePythonPath() {
  return path.join(getPackagedBackendRuntimeDir(), '.venv', 'Scripts', 'python.exe')
}

function getPackagedBackendRequirementsPath() {
  return path.join(getPackagedBackendRoot(), 'requirements.txt')
}

function getPackagedBackendStampPath() {
  return path.join(getPackagedBackendRuntimeDir(), 'requirements.sha256')
}

function getFileHash(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function getInstalledRequirementsHash() {
  try {
    return fs.readFileSync(getPackagedBackendStampPath(), 'utf8').trim()
  } catch {
    return ''
  }
}

function writeInstalledRequirementsHash(hashValue) {
  fs.mkdirSync(getPackagedBackendRuntimeDir(), { recursive: true })
  fs.writeFileSync(getPackagedBackendStampPath(), hashValue, 'utf8')
}

function formatCommandFailure(error) {
  const stdout = typeof error.stdout === 'string' ? error.stdout.trim() : ''
  const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : ''
  const detail = stderr || stdout || error.message || String(error)
  return detail.slice(0, 4000)
}

function execCommand(command, args, errorContext) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    throw new Error(`${errorContext}\n${formatCommandFailure(error)}`)
  }
}

function resolveSystemPythonLauncher() {
  const launchers = [
    { command: 'py', prefix: ['-3.11'], label: 'py -3.11' },
    { command: 'python', prefix: [], label: 'python' },
  ]

  for (const launcher of launchers) {
    try {
      execCommand(
        launcher.command,
        [...launcher.prefix, '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'],
        `Unable to query Python via ${launcher.label}.`,
      )
      return launcher
    } catch {
      // Try the next launcher.
    }
  }

  throw new Error('Python 3.11 was not found. Install Python 3.11 so the desktop app can provision its backend runtime.')
}

function ensurePackagedBackendRuntime() {
  const runtimePython = getPackagedRuntimePythonPath()
  const requirementsPath = getPackagedBackendRequirementsPath()
  const requiredHash = getFileHash(requirementsPath)
  const installedHash = getInstalledRequirementsHash()

  if (fs.existsSync(runtimePython) && installedHash === requiredHash) {
    return runtimePython
  }

  const launcher = resolveSystemPythonLauncher()
  const runtimeDir = getPackagedBackendRuntimeDir()
  fs.mkdirSync(runtimeDir, { recursive: true })

  appendBackendLog(`Preparing packaged backend runtime in ${runtimeDir}`)
  if (!fs.existsSync(runtimePython)) {
    execCommand(
      launcher.command,
      [...launcher.prefix, '-m', 'venv', path.join(runtimeDir, '.venv')],
      'Unable to create the packaged backend virtual environment.',
    )
  }

  execCommand(
    runtimePython,
    ['-m', 'pip', 'install', '--upgrade', 'pip'],
    'Unable to upgrade pip in the packaged backend virtual environment.',
  )
  execCommand(
    runtimePython,
    ['-m', 'pip', 'install', '-r', requirementsPath],
    'Unable to install packaged backend requirements.',
  )
  writeInstalledRequirementsHash(requiredHash)
  appendBackendLog('Packaged backend runtime is ready.')
  return runtimePython
}

function resolveBackendLaunch() {
  const workingDirectory = app.isPackaged ? process.resourcesPath : app.getAppPath()

  if (app.isPackaged) {
    return {
      command: ensurePackagedBackendRuntime(),
      commandLabel: getPackagedRuntimePythonPath(),
      prefix: [],
      workingDirectory,
    }
  }

  const venvPython = path.join(workingDirectory, 'backend', '.venv', 'Scripts', 'python.exe')
  if (fs.existsSync(venvPython)) {
    return {
      command: venvPython,
      commandLabel: venvPython,
      prefix: [],
      workingDirectory,
    }
  }

  return {
    command: 'py',
    commandLabel: 'py -3.11',
    prefix: ['-3.11'],
    workingDirectory,
  }
}

function loadNetworkExposure() {
  try {
    const rawValue = fs.readFileSync(getExposureConfigPath(), 'utf8')
    return normalizeNetworkExposure(JSON.parse(rawValue))
  } catch {
    return { openToLan: false, openToWan: false }
  }
}

function saveNetworkExposure() {
  const configPath = getExposureConfigPath()
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(networkExposure, null, 2), 'utf8')
}

function isNetworkExposureEnabled() {
  return networkExposure.openToLan || networkExposure.openToWan
}

function getBackendHost() {
  return isNetworkExposureEnabled() ? '0.0.0.0' : '127.0.0.1'
}

function getFrontendDistPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'dist')
    : path.join(app.getAppPath(), 'dist')
}

function isRemoteUiAvailable() {
  return fs.existsSync(path.join(getFrontendDistPath(), 'index.html'))
}

function getLanUrls() {
  if (!isNetworkExposureEnabled()) {
    return []
  }

  const seen = new Set()
  const urls = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !entry.address) {
        continue
      }

      const url = `http://${entry.address}:${backendPort}`
      if (!seen.has(url)) {
        seen.add(url)
        urls.push(url)
      }
    }
  }

  return urls.sort()
}

function getNetworkExposureState() {
  return {
    ...networkExposure,
    localUrl: localApiBaseUrl,
    lanUrls: getLanUrls(),
    wanUrlHint: networkExposure.openToWan
      ? `Forward TCP port ${backendPort} on your router to this machine, then connect using your public IP or DNS name. Make sure Windows Firewall also allows the app or port.`
      : '',
    remoteUiAvailable: isRemoteUiAvailable(),
  }
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
    return Promise.resolve()
  }

  if (backendStartupPromise) {
    return backendStartupPromise
  }

  backendStartupPromise = Promise.resolve().then(() => {
    clearStaleBackendProcess()

    resetBackendLog()
    const launch = resolveBackendLaunch()
    const workingDirectory = launch.workingDirectory
    const frontendDistPath = getFrontendDistPath()
    const backendHost = getBackendHost()
    const args = [
      ...launch.prefix,
      '-m',
      'uvicorn',
      'backend.app.main:app',
      '--host',
      backendHost,
      '--port',
      String(backendPort),
    ]
    const backendLog = fs.openSync(getBackendLogPath(), 'a')

    appendBackendLog(`Starting backend with ${launch.commandLabel} in ${workingDirectory}`)

    backendProcess = spawn(launch.command, args, {
      cwd: workingDirectory,
      env: {
        ...process.env,
        FRONTEND_DIST_PATH: frontendDistPath,
      },
      windowsHide: true,
      stdio: ['ignore', backendLog, backendLog],
    })

    backendProcess.once('exit', (code, signal) => {
      appendBackendLog(`Backend exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`)
      if (backendProcess && backendProcess.exitCode !== null) {
        backendProcess = null
      }
    })
  }).finally(() => {
    backendStartupPromise = null
  })

  return backendStartupPromise
}

function stopBackend() {
  if (!backendProcess) {
    return
  }

  appendBackendLog('Stopping backend process.')
  backendProcess.kill()
  backendProcess = null
}

async function restartBackend() {
  stopBackend()
  await startBackend()
  await waitForHttp(`${localApiBaseUrl}/health`)
}

async function createWindow() {
  if (windowCreationPromise) {
    return windowCreationPromise
  }

  windowCreationPromise = (async () => {
    await startBackend()
    await waitForHttp(`${localApiBaseUrl}/health`)

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
        preload: path.join(app.getAppPath(), 'electron', 'preload.cjs'),
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
      await mainWindow.loadURL(localApiBaseUrl)
    }

    mainWindow.once('ready-to-show', () => {
      mainWindow.show()
    })

    return mainWindow
  })().finally(() => {
    windowCreationPromise = null
  })

  return windowCreationPromise
}

app.whenReady().then(async () => {
  try {
    networkExposure = loadNetworkExposure()

    ipcMain.handle('network-exposure:get', () => getNetworkExposureState())
    ipcMain.handle('network-exposure:set', async (_event, nextValue) => {
      const previousExposure = networkExposure
      networkExposure = normalizeNetworkExposure(nextValue)

      try {
        saveNetworkExposure()
        await restartBackend()
        return getNetworkExposureState()
      } catch (error) {
        networkExposure = previousExposure
        saveNetworkExposure()
        await restartBackend()
        throw error
      }
    })

    await createWindow()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const setupHint = app.isPackaged
      ? `The installed app is not the project root. The backend runtime is created automatically under ${app.getPath('userData')}. Check ${getBackendLogPath()} for bootstrap details.`
      : 'Run "npm run setup:backend" from the source checkout root, then try again.'
    dialog.showErrorBox(
      'Local Voice Studio startup failed',
      `The desktop shell could not start its local services. ${setupHint}\n\n${message}`,
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

app.on('second-instance', () => {
  const existingWindow = BrowserWindow.getAllWindows()[0]
  if (!existingWindow) {
    void createWindow()
    return
  }

  if (existingWindow.isMinimized()) {
    existingWindow.restore()
  }

  existingWindow.focus()
})