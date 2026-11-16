import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, powerMonitor, safeStorage, session, shell } from 'electron'
import { killAllEngineProcesses } from './core/engine/process'
import { IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL } from '@shared/ipc'
import type { Bootstrap } from '@shared/types'
import { EventBus } from './core/event-bus'
import type { PlatformServices } from './core/platform'
import { OrbitRuntime } from './core/runtime'
import { createLogger } from './infra/logger'
import type { HostApi } from './ipc/handlers'
import { dispatch } from './ipc/router'

const log = createLogger('main')
const here = fileURLToPath(new URL('.', import.meta.url))
const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL)

app.setName('Orbit')
nativeTheme.themeSource = 'dark'

const dataDir = process.env.ORBIT_DATA_DIR ?? app.getPath('userData')
mkdirSync(dataDir, { recursive: true })
// An isolated data dir is also an isolated Electron profile (and single-instance lock),
// so a test instance can run next to the everyday one.
if (process.env.ORBIT_DATA_DIR) app.setPath('userData', dataDir)
const stateFile = join(dataDir, 'orbit-state.json')

function readMode(): 'real' | 'demo' {
  try {
    const s = JSON.parse(readFileSync(stateFile, 'utf8')) as { mode?: string }
    return s.mode === 'demo' ? 'demo' : 'real'
  } catch {
    return 'real'
  }
}
const writeMode = (mode: 'real' | 'demo') => writeFileSync(stateFile, JSON.stringify({ mode }))
const dbFileFor = (mode: 'real' | 'demo') => join(dataDir, mode === 'demo' ? 'orbit-demo.db' : 'orbit.db')

let mainWindow: BrowserWindow | null = null
const bus = new EventBus()

const platform: PlatformServices = {
  secrets: {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64')),
  },
  nativeNotify(title, body, route) {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => {
      showWindow()
      if (route) bus.emit({ type: 'navigate', route })
    })
    n.show()
  },
  fetch: (...args) => fetch(...args),
  appVersion: app.getVersion(),
  runtimeBundle: () => {
    const f = join(app.getAppPath(), 'out', 'runtime', 'orbit-runtime.mjs')
    return existsSync(f) ? f : null
  },
}

let runtime: OrbitRuntime | null = null
function getRuntime(): OrbitRuntime {
  if (!runtime) throw new Error('Runtime not ready')
  return runtime
}

function bootstrap(): Bootstrap {
  const rt = getRuntime()
  return {
    settings: rt.settings.get(),
    appVersion: app.getVersion(),
    platform: process.platform,
    dataPath: dataDir,
    secureStorage: safeStorage.isEncryptionAvailable(),
  }
}

const host: HostApi = {
  runtime: getRuntime,
  bootstrap,
  async setMode(mode) {
    if (runtime?.mode !== mode) {
      runtime?.dispose()
      writeMode(mode)
      runtime = new OrbitRuntime(mode, dbFileFor(mode), bus, platform)
      runtime.start()
      bus.invalidate('all')
    }
    return bootstrap()
  },
  async openExternal(url) {
    if (!/^https:\/\//.test(url)) return
    await shell.openExternal(url)
  },
  launchAtLogin(enabled) {
    const supported = process.platform === 'darwin' && app.isPackaged
    if (enabled !== undefined && supported) {
      app.setLoginItemSettings({ openAtLogin: enabled })
      runtime?.journal.audit({ actor: 'user', agentId: null, action: 'app.launchAtLogin', target: enabled ? 'on' : 'off', allowed: true, reason: null })
    }
    return { enabled: supported ? app.getLoginItemSettings().openAtLogin : false, supported }
  },
  revealPath(path) {
    shell.showItemInFolder(path)
  },
  async chooseDirectory() {
    const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'], message: 'Dossier de travail du compagnon' })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  },
}

function showWindow() {
  if (!mainWindow) createWindow()
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    title: 'Orbit',
    backgroundColor: '#0B0C10',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 19 },
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))

  const wc = mainWindow.webContents
  wc.setWindowOpenHandler(({ url }) => {
    void host.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    if (isDev && url.startsWith(process.env.ELECTRON_RENDERER_URL!)) return
    e.preventDefault()
  })

  if (isDev) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void mainWindow.loadFile(join(here, '../renderer/index.html'))
}

function installSecurity() {
  const csp = isDev
    ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: http://localhost:*"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
}

function installMenu() {
  const go = (route: string) => () => {
    showWindow()
    bus.emit({ type: 'navigate', route })
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Orbit',
        submenu: [
          { role: 'about', label: 'À propos d’Orbit' },
          { type: 'separator' },
          { label: 'Réglages…', accelerator: 'Cmd+,', click: go('/settings') },
          { type: 'separator' },
          { role: 'hide', label: 'Masquer Orbit' },
          { role: 'hideOthers', label: 'Masquer les autres' },
          { type: 'separator' },
          { role: 'quit', label: 'Quitter Orbit' },
        ],
      },
      {
        label: 'Édition',
        submenu: [
          { role: 'undo', label: 'Annuler' },
          { role: 'redo', label: 'Rétablir' },
          { type: 'separator' },
          { role: 'cut', label: 'Couper' },
          { role: 'copy', label: 'Copier' },
          { role: 'paste', label: 'Coller' },
          { role: 'selectAll', label: 'Tout sélectionner' },
        ],
      },
      {
        label: 'Aller',
        submenu: [
          { label: 'Accueil', accelerator: 'Cmd+1', click: go('/') },
          { label: 'Missions', accelerator: 'Cmd+2', click: go('/missions') },
          { label: 'Constellations', accelerator: 'Cmd+3', click: go('/constellations') },
          { label: 'Automatisations', accelerator: 'Cmd+4', click: go('/automations') },
          { label: 'Compagnons', accelerator: 'Cmd+5', click: go('/companions') },
          { type: 'separator' },
          { label: 'Activité', accelerator: 'Cmd+6', click: go('/activity') },
          { label: 'Statistiques', accelerator: 'Cmd+7', click: go('/analytics') },
          { label: 'Machines', accelerator: 'Cmd+8', click: go('/machines') },
          { type: 'separator' },
          { label: 'Mon univers', click: go('/universe') },
        ],
      },
      {
        label: 'Présentation',
        submenu: [
          ...(isDev ? ([{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as const) : []),
          { role: 'togglefullscreen', label: 'Plein écran' },
        ],
      },
      { role: 'windowMenu', label: 'Fenêtre' },
    ]),
  )
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
app.on('second-instance', showWindow)

app.whenReady().then(() => {
  installSecurity()
  installMenu()
  const mode = readMode()
  if (!existsSync(dbFileFor(mode))) log.info(`Creating ${mode} database in ${dataDir}`)
  runtime = new OrbitRuntime(mode, dbFileFor(mode), bus, platform)
  runtime.start()

  ipcMain.handle(IPC_INVOKE_CHANNEL, (event, channel: unknown, input: unknown) => {
    if (event.senderFrame?.url && !isDev && !event.senderFrame.url.startsWith('file://')) {
      return { ok: false, error: { code: 'forbidden', message: 'Origine non autorisée.' } }
    }
    return dispatch(channel, input, host)
  })
  bus.on((evt) => mainWindow?.webContents.send(IPC_EVENT_CHANNEL, evt))

  createWindow()
  app.on('activate', showWindow)
  // After sleep, the scheduler checks immediately (missed occurrences follow their policy).
  powerMonitor.on('resume', () => void runtime?.scheduler.tick())
  if (!app.isPackaged && process.env.ORBIT_CAPTURE_STEPS) void runCaptureSteps()
})

/**
 * Dev-only visual verification harness. ORBIT_CAPTURE_STEPS is a JSON array of
 * steps: ["nav:/", "wait:800", "js:document.querySelector('button').click()", "shot:overview"].
 * Screenshots are written to ORBIT_CAPTURE_DIR, then the app quits.
 */
async function runCaptureSteps() {
  const steps = JSON.parse(process.env.ORBIT_CAPTURE_STEPS!) as string[]
  const dir = process.env.ORBIT_CAPTURE_DIR ?? join(dataDir, 'captures')
  mkdirSync(dir, { recursive: true })
  const win = mainWindow!
  await new Promise<void>((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', () => r()) : r()))
  await new Promise((r) => setTimeout(r, 1200))
  for (const step of steps) {
    const [kind, ...rest] = step.split(':')
    const arg = rest.join(':')
    try {
      if (kind === 'nav') bus.emit({ type: 'navigate', route: arg })
      else if (kind === 'wait') await new Promise((r) => setTimeout(r, Number(arg)))
      else if (kind === 'js') await win.webContents.executeJavaScript(arg, true)
      else if (kind === 'size') {
        const [w, h] = arg.split('x').map(Number)
        win.setContentSize(w!, h!)
      } else if (kind === 'shot') {
        await new Promise((r) => setTimeout(r, 350))
        const img = await win.webContents.capturePage()
        writeFileSync(join(dir, `${arg}.png`), img.toPNG())
        log.info(`captured ${arg}`)
      }
    } catch (err) {
      log.error(`capture step failed: ${step}`, err)
    }
  }
  app.quit()
}

app.on('window-all-closed', () => {
  // macOS: keep the runtime alive so missions continue while the window is closed.
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  runtime?.dispose()
  runtime = null
  // No engine process (and none of their commands) may outlive Orbit.
  killAllEngineProcesses()
})
