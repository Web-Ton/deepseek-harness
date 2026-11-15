/** Electron shell: desktop project ownership, custom protocol, windows, and lifecycle. */

import { installFileActions } from './file-actions.ts'
import { configurationFailure, channelSaveFailure, configurationMessage } from './update-configuration.ts'
import type { DesktopChannelState, DesktopChannelChangeResult } from '@deepseek-ai/dsh-client-ui-settings-general/types'
import { DesktopUpdateSettings } from './update-settings.ts'
import { isDesktopUpdateChannel } from './settings-file.ts'
import type { ProductEventMap, ProductEvent } from '@deepseek-ai/dsh-client-product-analytics/types'
import { WINDOWS_TITLEBAR_HEIGHT, selfDrawnChrome } from './windows-layout.ts'
/** Electron shell: desktop project ownership, custom protocol, windows, and lifecycle. */

import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createReadStream, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  nativeImage,
  nativeTheme,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import { resolveDesktopPaths } from './paths.ts'
import { DesktopProjectManager } from './project-manager.ts'
import { DesktopHostFatalError, DesktopHostProcess, DesktopHostUncleanExitError } from './host-process.ts'
import { DesktopPlatformView, PLATFORM_IPC, platformBounds } from './platform-view.ts'
import { installDesktopFileDrag } from './file-drag.ts'
import { installDesktopDirectoryPicker } from './directory-picker.ts'
import { installMicrophonePermissions } from './microphone-permissions.ts'
import { DesktopBackendController } from './backend-controller.ts'
import { DESKTOP_IPC, SCHEME, assertDesktopSender, type DesktopUpdateState } from './ipc.ts'
import { readDeviceInfo } from './device-info.ts'
import { desktopUpdateReadyConfirmation, formatDesktopMessage, resolveDesktopLocale, resolveDesktopStartupLocale } from './locale.ts'
import type { DesktopMessages } from './locale.ts'
import { claimDesktopSingleInstance } from './single-instance.ts'
import {
  AISHELL_DEEPLINK_SCHEME, DeepLinkDelivery, DeepLinkSocketListener, findDeepLink, isOpenLiteral, realSocketPlatform,
} from './aishell-deeplink.ts'
import { desktopUpdateChannel } from './update-channel.ts'
import { DesktopUpdateCoordinator } from './update-coordinator.ts'
import { AishellUpdateBridge, aishellPlatform } from './aishell-update-bridge.ts'
import { prepareDesktopUpdateWindow } from './update-window.ts'
import { DesktopCommandManager } from './command-management.ts'
import { serveWebDocument, authenticateWebHost, forwardWebRequest, removeLegacyHostCookies } from './web-document.ts'
import { DesktopFatalRecovery } from './fatal-recovery.ts'
import { pruneCrashReports, RendererConsoleTail, writeCrashReport, type CrashReportSource } from './crash-report.ts'
import { OperationJournal } from './operation-journal.ts'
import { runOperationReportJob, type OperationReportJobResult } from './operation-report-job.ts'
import { openWelcomeWindow } from './welcome-window.ts'
import { WELCOME_IPC, needsWelcome, type WelcomeNotice } from './welcome-api.ts'
import { connectDesktopWelcome, type DesktopWelcomeBackend, type WelcomeState } from './welcome-backend.ts'
import { DesktopUpdateJournal } from './update-journal.ts'
import { DesktopUpdatePreparationError } from './update-error.ts'
import { DesktopUpdateSchedule, resolveDesktopUpdateScheduleConfig } from './update-schedule.ts'
import { desktopUpdateErrorSummary, presentDesktopUpdate } from './update-presentation.ts'
import { desktopErrorState } from './startup-error.ts'
import { readDesktopLoginShellEnvironment, resolveDesktopLoginShellConfig } from './login-shell-environment.ts'
import { DesktopMandatoryUpdatePolicy, resolveDesktopPolicyConfig, type DesktopPolicyState } from './mandatory-update-policy.ts'
import { desktopClientMetadata, desktopClientVersion } from './client-metadata.ts'
import { DesktopMandatoryUpdateWindow } from './mandatory-update-window.ts'
import { DesktopPolicyTestAuth } from './policy-test-auth.ts'
import { readDesktopSettings } from './settings.ts'
import { readDesktopLocaleCache, writeDesktopLocaleCache } from './locale-cache.ts'
import { DesktopUpdateDialog, type UpdateDialogOptions } from './update-dialog.ts'
import { readDesktopRuntime } from './runtime-tree.ts'
import { DesktopBrowserGuests } from './browser-guests.ts'
import { installDesktopShortcuts } from './keyboard.ts'
import { DesktopUpdateOverlays } from './update-overlay.ts'
import { DesktopQuitConfirmation } from './quit-confirmation.ts'
import { DesktopTray } from './tray.ts'
import { DesktopBackgroundNotice } from './background-notice.ts'

let focusPrimaryWindow: (force?: boolean) => void = () => {}
let stopForRecovery = async (): Promise<void> => { await stopOperationReports() }
let shuttingDown = false
/**
 * AI Shell distribution (deeplink host delivery): the main process's deep-link
 * entry hub, created AT MODULE SCOPE on purpose. The OS can hand the app a URL
 * before `whenReady` (macOS `open-url` fires during launch; the cold-start argv
 * is read once at module load) — those early URLs must land in the hub's stash,
 * not in a placeholder that drops them. The send callback resolves the Host
 * child through `deepLinkBackend`, which main() assigns once the backend
 * controller exists; until then delivery returns false and the hub stashes
 * (LAST wins — the frozen design ruling). The URL string is forwarded
 * UNMODIFIED; no hop parses it.
 */
const deepLinkHub = new DeepLinkDelivery((url) => {
  const backend = deepLinkBackend
  if (backend === undefined) return false
  const host = backend.host
  if (host === undefined) return false
  return host.sendDeepLink(url)
})
let deepLinkBackend: { host: { sendDeepLink(url: string): boolean } | undefined } | undefined
const deliverDeepLink: (url: string) => void = (url) => { deepLinkHub.deliver(url) }
/**
 * AI Shell distribution (deeplink host delivery): Linux-packaged socket fast
 * path (contract §12, adopted) — the URL-handler helper connects here for
 * warm delivery without a second Electron process. Bound after the
 * single-instance lock, disposed at quit.
 */
let disposeDeepLinkSocket: () => Promise<void> = async () => {}
/**
 * Set by quit entries that must not ask: crash recovery exit and restart, and the
 * development restart command. The installer handoff has its own before-quit branch.
 */
let skipQuitConfirmation = false
let windowsLanguage: string | undefined = readDesktopLocaleCache(app.getPath('userData'))
/**
 * Whether the backend has reached ready: false until the first ready, back to
 * false when a restart returns it to starting, frozen during shutdown so a
 * failure while tearing down a ready backend still reads as `running`.
 */
let backendReady = false
/** Error-level console output of the primary window, attached to crash reports. */
const rendererConsole = new RendererConsoleTail()

// Platform-conventional logs directory (macOS ~/Library/Logs/<name>, otherwise under userData);
// set before ready so the first fatal report already resolves under it.
app.setAppLogsPath()

function currentDesktopLocale(): ReturnType<typeof resolveDesktopLocale> {
  return resolveDesktopLocale(windowsLanguage ?? app.getLocale())
}
/** Quit without the task confirmation; the caller has already decided the application must stop. */
function quitWithoutConfirmation(): void {
  skipQuitConfirmation = true
  app.quit()
}
const recovery = new DesktopFatalRecovery({
  messages: () => currentDesktopLocale().messages,
  show: options => dialog.showMessageBox(options),
  stop: () => { shuttingDown = true; return stopForRecovery() },
  disablePlugins: async () => {
    const manager = new DesktopProjectManager(resolveDesktopPaths(), runtimeResources())
    const backupPath = await manager.disableAllPlugins()
    console.info('Desktop profile recovery completed:', { profilePatchBackup: backupPath ?? null, homePatch: 'unchanged' })
  },
  exit: () => { quitWithoutConfirmation() },
  restart: () => { app.relaunch(); quitWithoutConfirmation() },
  writeReport: (error, source) => persistCrashReport(error, source),
  revealReport: async (path) => { await access(path); shell.showItemInFolder(path) },
})

let operationJournal: OperationJournal | undefined
let operationReportJob: Promise<OperationReportJobResult> | undefined
let operationReportAbort: AbortController | undefined
let operationReportsStopping = false
let operationReportStop: Promise<void> | undefined

/** Bound application shutdown waiting without claiming that an unresponsive Worker has exited. */
function stopOperationReports(): Promise<void> {
  operationReportStop ??= waitForOperationReports()
  return operationReportStop
}

async function waitForOperationReports(): Promise<void> {
  operationReportsStopping = true
  operationReportAbort?.abort()
  const job = operationReportJob
  if (job === undefined) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const exited = await Promise.race([job.then(() => true), new Promise<false>((resolve) => {
      timer = setTimeout(() => { resolve(false) }, 500)
    })])
    if (!exited) console.error('dsh desktop: operation report Worker has not exited; continuing shutdown')
  } finally { clearTimeout(timer) }
}

function persistCrashReport(error: unknown, source: CrashReportSource): Promise<string | undefined> {
  const directory = app.getPath('logs')
  const report = writeCrashReport(directory, {
    operationHistoryPlanned: !shuttingDown && !operationReportsStopping,
    source,
    phase: backendReady ? 'running' : 'startup',
    error,
    ...(error instanceof DesktopHostFatalError && error.diagnostic !== undefined ? { hostDiagnostic: error.diagnostic } : {}),
    rendererConsole: rendererConsole.snapshot(),
    app: {
      name: app.name, version: app.getVersion(), platform: process.platform, arch: process.arch,
      electron: process.versions.electron, node: process.versions.node, locale: currentDesktopLocale().id,
    },
    time: new Date(),
  })
  void report.then((path) => {
    if (path !== undefined && operationReportJob === undefined && !shuttingDown && !operationReportsStopping) {
      operationReportAbort = new AbortController()
      operationReportJob = runOperationReportJob({ reportPath: path, directory: join(app.getPath('userData'), 'plugin-operations'),
        limits: { bytes: 64 * 1024, recordBytes: 4096, records: 100, outputBytes: 64 * 1024 },
        journal: operationJournal?.status() ?? null,
      }, { timeoutMs: 500, cancellationGraceMs: 100 }, operationReportAbort.signal)
      void operationReportJob.finally(() => { operationReportJob = undefined; operationReportAbort = undefined })
    }
  }).catch((_error: unknown) => { /* Basic persistence failure is owned by fatal recovery. */ })
  return report
}

function reportFatal(error: unknown, source: CrashReportSource): void {
  console.error(error)
  if (shuttingDown) {
    // No dialog during shutdown, but the report still records what failed on the way out.
    void persistCrashReport(error, source)
    return
  }
  void recovery.report(error, source).catch(async (failure: unknown) => {
    console.error(failure)
    shuttingDown = true
    await stopOperationReports()
    app.exit(1)
  })
}

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    codeCache: true,
  },
}])

interface RuntimeResources {
  readonly nodeBin: string
  readonly node: string
  readonly pnpm: string
  readonly dsh: string
}

function runtimeResources(): RuntimeResources {
  const development = !app.isPackaged
  const node = process.execPath
  const nodeBin = development ? join(app.getAppPath(), 'scripts', 'node-bin') : join(process.resourcesPath, 'runtime', 'bin')
  const pnpm = (development ? process.env.DSH_DESKTOP_PNPM_ENTRY : undefined)
    ?? (development ? join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
      : join(process.resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'))
  const dsh = (development ? process.env.DSH_DESKTOP_DSH_DIR : undefined)
    ?? (development ? join(app.getAppPath(), '.desktop-build', 'development', 'project') : join(app.getAppPath(), 'dsh'))
  return { node, nodeBin, pnpm, dsh }
}

function developmentPrimaryRuntime(): string {
  const directory = process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR
  if (directory === undefined || directory === '') {
    throw new Error('dsh desktop: DSH_DESKTOP_PRIMARY_RUNTIME_DIR is required for an unpackaged launch')
  }
  return directory
}

function developmentHostInspectPort(enabled: boolean): number | undefined {
  const configured = process.env.DSH_DESKTOP_HOST_INSPECT_PORT
  if (!enabled || configured === undefined || configured === '') return undefined
  const port = Number(configured)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('dsh desktop: DSH_DESKTOP_HOST_INSPECT_PORT must be an integer from 1 through 65535')
  }
  return port
}

/**
 * Opaque chrome fallback matching the built-in sidebar palette (the resolved
 * `--dsw-static-neutral-bluish-900` / `-50` tokens). An approximation for
 * custom themes: Windows captions use the renderer's measured palette over
 * windowsAppearance IPC. The Windows workspace base stays opaque and follows
 * the effective light/dark theme; macOS uses it only while minimized or hidden.
 * @returns the sidebar fill hex for the effective application color scheme.
 */
function chromeFallbackFill(): string {
  return nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb'
}

/**
 * Add the effective Desktop palette to a Platform authorization URL so the
 * login page opens in the application's theme. `system` resolves through
 * `nativeTheme.shouldUseDarkColors`, which follows the theme source the
 * application preload publishes.
 * @param authorizeUrl - validated Platform authorization URL.
 * @returns the authorization URL carrying `theme=light` or `theme=dark`.
 */
function platformLoginUrl(authorizeUrl: string): string {
  const url = new URL(authorizeUrl)
  url.searchParams.set('theme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  return url.href
}

function createWindow(preload: string, show = false, primary = false): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 520,
    minHeight: 600,
    show,
    ...(selfDrawnChrome() && primary ? {
      titleBarStyle: 'hidden' as const,
      backgroundColor: chromeFallbackFill(),
      titleBarOverlay: { height: WINDOWS_TITLEBAR_HEIGHT, color: chromeFallbackFill(),
        symbolColor: nativeTheme.shouldUseDarkColors ? '#f9fafb' : '#0f1115' },
    } : {}),
    // hiddenInset places traffic lights inside the sidebar; sidebar vibrancy
    // needs a transparent window background to show through the page.
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'sidebar' as const,
      // 'active' keeps the vibrancy material stable when the window blurs;
      // 'followWindow' washes the sidebar out behind an unfocused window.
      visualEffectState: 'active' as const,
      backgroundColor: '#00000000',
    } : {}),
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: primary,
      devTools: true,
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (['http:', 'https:'].includes(new URL(url).protocol)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.platform === 'darwin' || process.platform === 'win32') {
    // Fullscreen hides native window controls; overlays drop their caption clearance.
    const sendFullscreen = (): void => {
      if (!window.isDestroyed()) window.webContents.send(DESKTOP_IPC.windowFullscreen, window.isFullScreen())
    }
    window.on('enter-full-screen', sendFullscreen)
    window.on('leave-full-screen', sendFullscreen)
    // Reloads and navigations re-register the preload listener; resend the
    // current state so a fullscreen reload does not fall back to windowed CSS.
    window.webContents.on('did-finish-load', sendFullscreen)
  }
  if (selfDrawnChrome() && primary) {
    const updateBackground = (): void => {
      if (!window.isDestroyed()) window.setBackgroundColor(chromeFallbackFill())
    }
    nativeTheme.on('updated', updateBackground)
    window.once('closed', () => { nativeTheme.removeListener('updated', updateBackground) })
  }
  if (process.platform === 'darwin') {
    // Deminiaturize reattaches the NSVisualEffectView material late
    // (electron/electron#25368), so a transparent window shows the desktop
    // through the sidebar until then. Paint an opaque base while minimized or
    // hidden so the deminiaturize animation and the reattachment gap show a
    // solid fill; restoring flips back, and the null -> 'sidebar' transition
    // forces the material to reattach.
    const applyBackdrop = (): void => {
      if (window.isDestroyed()) return
      if (window.isMinimized() || !window.isVisible()) {
        window.setVibrancy(null)
        window.setBackgroundColor(chromeFallbackFill())
      } else {
        window.setVibrancy('sidebar')
        window.setBackgroundColor('#00000000')
      }
    }
    window.on('minimize', applyBackdrop)
    window.on('hide', applyBackdrop)
    window.on('restore', applyBackdrop)
    window.on('show', applyBackdrop)
  }
  window.webContents.on('context-menu', (_event, { isEditable, selectionText, editFlags }) => {
    const items: MenuItemConstructorOptions[] = []
    if (isEditable) {
      items.push(
        { role: 'undo', enabled: editFlags.canUndo },
        { role: 'redo', enabled: editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: editFlags.canCut },
        { role: 'copy', enabled: editFlags.canCopy },
        { role: 'paste', enabled: editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: editFlags.canSelectAll },
      )
    } else if (selectionText.length > 0) {
      items.push({ role: 'copy', enabled: editFlags.canCopy })
    }
    // Empty accelerators suppress Electron's default shortcut labels for native roles.
    if (items.length > 0) {
      const messages = currentDesktopLocale().messages
      Menu.buildFromTemplate(items.map(item => ({
        ...item,
        // AI Shell distribution (Linux menu i18n): role labels are localized
        // on Windows and Linux alike - macOS leaves them to AppKit.
        ...(process.platform !== 'darwin' && item.role !== undefined && item.role in messages
          ? { label: messages[item.role as keyof typeof messages] } : {}),
        accelerator: '',
      }))).popup({ window })
    }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const destination = new URL(url)
    const current = new URL(window.webContents.getURL())
    if (destination.protocol !== `${SCHEME}:`
      && !(destination.protocol === 'http:' && destination.origin === current.origin)) {
      event.preventDefault()
      if (['http:', 'https:'].includes(destination.protocol)) void shell.openExternal(url)
    }
  })
  return window
}

async function main(): Promise<void> {
  const desktopSettings = await readDesktopSettings(app.getPath('userData'))
  void pruneCrashReports(app.getPath('logs'))
  const journalDirectory = process.env.DSH_DESKTOP_UPDATE_JOURNAL_DIR
  const updateJournal = journalDirectory === undefined ? undefined : new DesktopUpdateJournal(journalDirectory, app.getVersion())
  const resources = runtimeResources()
  const paths = resolveDesktopPaths()
  const development = !app.isPackaged
  const primaryRuntime = development
    ? developmentPrimaryRuntime()
    : join(process.resourcesPath, 'runtime', 'primary-runtime')
  const activeProject = paths.profile
  const manager = new DesktopProjectManager(paths, resources)
  // Dock and Finder launches inherit only launchd's environment; every Host shares one login-shell read.
  const loginShellRead = new AbortController()
  // The probe runs in its own process group, which outlives Desktop unless the read is aborted.
  app.on('will-quit', () => { loginShellRead.abort() })
  const loginShell = readDesktopLoginShellEnvironment(process.env, resolveDesktopLoginShellConfig(process.env), {
    signal: loginShellRead.signal,
  }).then((result) => {
    for (const failure of result.failures) console.warn(`desktop login shell: ${failure.shell} failed (${failure.reason})`)
    return result.environment
  })
  let hostEnvironment: NodeJS.ProcessEnv = process.env
  const prepareHostEnvironment = async (): Promise<void> => { hostEnvironment = await loginShell }
  let quitting = false
  let startup: Promise<void> | undefined
  let workspaceRecovery: Promise<void> | undefined
  let mainWindow: BrowserWindow | undefined
  let welcomeWindow: BrowserWindow | undefined
  const installFileDrag = (): (() => Promise<void>) => installDesktopFileDrag(
    event => assertProductSender(event),
    (address, signal) => {
      const host = backend.host
      if (host === undefined) return Promise.reject(new Error('File drag Host unavailable'))
      return host.resolveDragResource(address, signal)
    },
  )
  const fileDragCleanups = new Set([installFileDrag()])
  let fileDragStopped = false
  const disposeFileDrag = async (): Promise<void> => {
    fileDragStopped = true
    const results = await Promise.allSettled([...fileDragCleanups].map(async (release) => {
      await release()
      fileDragCleanups.delete(release)
    }))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  let enteredWorkspace = false
  // NSIS passes --updated when it launches the application after installation.
  let raiseAfterUpdate = process.platform === 'win32' && process.argv.includes('--updated')
  let shellInstallerOwnsQuit = false
  let requireCleanStop = false
  let updateStoppedHost = false
  let updateStopFailure: DesktopHostUncleanExitError | undefined
  let updateState: DesktopUpdateState = { phase: 'idle' }
  let channelState: DesktopChannelState | undefined
  const updatePresentation = (state: DesktopUpdateState) => ({ ...presentDesktopUpdate(state),
    ...(channelState?.error === undefined ? {} : { configurationError: channelState.error }) })
  const systemLanguages = app.getPreferredSystemLanguages()
  let locale = windowsLanguage === undefined
    ? resolveDesktopStartupLocale(null, systemLanguages) : resolveDesktopLocale(windowsLanguage)
  windowsLanguage = locale.id
  let mandatoryPolicy: DesktopMandatoryUpdatePolicy | undefined
  let mandatoryUI: DesktopMandatoryUpdateWindow | undefined
  let policyAuth: DesktopPolicyTestAuth | undefined
  let tray: DesktopTray | undefined
  /**
   * The operating system is ending the session: the quit skips its confirmation. Windows sets it
   * on the definitive session-end message. macOS sets it on the power-off notification, which
   * another application can still cancel, so the next focus or show of the main window clears it.
   */
  let sessionEnding = false
  const isQuitting = (): boolean => quitting
  const currentMainWindow = (): BrowserWindow | undefined => mainWindow
  const ordinaryDialogs = new Set<AbortController>()
  const currentDialogWindow = (): BrowserWindow | undefined => welcomeWindow ?? mainWindow
  const updateOverlays = new DesktopUpdateOverlays()
  const updateDialog = new DesktopUpdateDialog(fileURLToPath(new URL('./preload-update-dialog.cjs', import.meta.url)), () => locale, updateOverlays)
  const isMandatory = (): boolean => mandatoryPolicy?.state.blocking === true
  const ordinaryMessageBox = async (options: UpdateDialogOptions,
    parent = currentDialogWindow()): Promise<Electron.MessageBoxReturnValue> => {
    const controller = new AbortController()
    ordinaryDialogs.add(controller)
    try {
      // AI Shell distribution (D14 rev6 instrumentation): the silent no-parent
      // return is a real "clicked but nothing appeared" cause when no window is
      // alive — make it visible in stdout instead of vanishing.
      if (parent === undefined) console.warn('aishell update check: no parent window — dialog suppressed')
      if (parent === undefined) return { response: options.cancelId ?? 0, checkboxChecked: false }
      return await updateDialog.show(parent, { ...options, signal: controller.signal })
    }
    finally { ordinaryDialogs.delete(controller) }
  }
  // Copy comes from the same locale as the update prompts so the dialog
  // chrome and its content never mix languages.
  const showAbout = async (): Promise<void> => {
    // AI Shell distribution (D14): the About box reports the DISTRIBUTION's
    // own identity, never the base version alone (app.getVersion() reports
    // the upstream base — not what a user comparing releases needs on its
    // own). Two lines: the app (dist) version from the A3 version file, and
    // the DSH base version from app.getVersion(); dev runs without the
    // version file degrade to the official single-line form.
    let appVersion: string | undefined
    try {
      appVersion = (await readFile(join(process.resourcesPath, 'aishell-version'), 'utf8')).trim()
    } catch { /* dev layout — no version file */ }
    // Localized labels (zh: 应用版本/DSH 版本, others: App/DSH version) — the
    // About box follows the UI language, never mixed bilingual.
    const zh = locale.id === 'zh-CN'
    const appLabel = zh ? '应用版本' : 'App version'
    const dshLabel = zh ? 'DSH 版本' : 'DSH version'
    const detail = appVersion === undefined
      ? formatDesktopMessage(locale.messages.aboutVersion, { version: app.getVersion() })
      : `${appLabel} ${appVersion}\n${dshLabel} ${app.getVersion()}`
    await ordinaryMessageBox({ type: 'info', title: locale.messages.aboutMenu, message: locale.messages.aboutProduct,
      detail,
      buttons: [locale.messages.updateAcknowledge], cancelId: 0 })
  }
  // AI Shell distribution (D15 rev13, macOS upgrade chain — desktop half):
  // the 下载更新 click on darwin runs IN the app — pinned re-check,
  // resumable curl download, streamed sha256 verify — so the user keeps
  // working while the artifact lands, with osascript notifications
  // carrying the phases (the accepted notification-level UX; no percent
  // surface). The verified dmg then hands off to the update module's
  // darwin-install subcommand and the app quits itself cleanly
  // (shellInstallerOwnsQuit: the click was the consent — the quit question
  // must not ask twice). Linux/Windows keep the packaged-launcher chain
  // inside checkAishellUpdates below.
  // AI Shell distribution (D15, changelog task 2026-10-22): the optional
  // feed changelog rides the check result; display-only, absent key = no
  // block (one window one language — never the other language).
  type AishellCheckResult = { update: { version: string; artifactUrl?: string; sha256?: string; changelog?: { en?: string; zh?: string } } | null; version: string; error: string | null }
  // One spawn handle per helper, passed (not re-imported): two concurrent
  // dynamic imports of the same mocked builtin race in the module runner —
  // the loser resolves the NATIVE module and escapes the test double
  // (found while driving this chain in main-startup.spec).
  const showMacNotification = (spawn: typeof import('node:child_process')['spawn'], body: string): void => {
    const escaped = body.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    const child = spawn('osascript', ['-e', `display notification "${escaped}" with title "AI Shell"`], { stdio: 'ignore' })
    child.on('error', () => undefined) // notifications are best-effort
  }
  const runAishellCheck = async (module: string): Promise<AishellCheckResult> => {
    const { spawn } = await import('node:child_process')
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--expose-internals', module, 'check', '--json', '--force'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
      child.on('error', reject)
      child.on('close', (code: number | null) => { code === 0 ? resolve(out) : reject(new Error(`exit ${code ?? 'signal'}`)) })
    })
    return JSON.parse(stdout) as AishellCheckResult
  }
  const runMacAishellUpgrade = async (module: string): Promise<void> => {
    const fail = async (technical: string): Promise<void> => {
      await ordinaryMessageBox({ type: 'warning', title: locale.messages.updateCheckTitle, message: locale.messages.updateCheckTitle,
        detail: locale.messages.updateCheckFailed, technicalDetails: technical,
        buttons: [locale.messages.updateAcknowledge], cancelId: 0 })
    }
    // Pinned re-check at click time (the dialog that asked may have aged in
    // a cache): the bytes installed must be the bytes the feed named when
    // the user said yes — the same law as `aishell upgrade`'s pre-flight.
    let pinned: AishellCheckResult
    try { pinned = await runAishellCheck(module) } catch (error) { await fail(error instanceof Error ? error.message : String(error)); return }
    if (pinned.update === null) {
      if (pinned.error !== null) { await fail(pinned.error); return }
      await ordinaryMessageBox({ type: 'info', title: locale.messages.updateCheckTitle,
        message: locale.messages.updateCurrent,
        detail: formatDesktopMessage(locale.messages.updateCurrentDetail, { version: pinned.version }),
        buttons: [locale.messages.updateAcknowledge], cancelId: 0 })
      return
    }
    const update = pinned.update
    if (update.artifactUrl === undefined || update.sha256 === undefined) {
      await fail('feed entry lacks artifactUrl/sha256 — the packaged update module predates the macOS chain')
      return
    }
    const artifactUrl = update.artifactUrl
    const sha256 = update.sha256
    const { spawn } = await import('node:child_process')
    showMacNotification(spawn, formatDesktopMessage(locale.messages.updateBackgroundDownload, { }))
    const workDir = await mkdtemp(join(tmpdir(), 'aishell-upgrade-'))
    const dmgPath = join(workDir, 'update.dmg')
    try {
      // Resumable download, five attempts — install.sh's fetch contract
      // (mid-body resets on long-haul links are not in curl's transient
      // list; -C - resumes from the partial file).
      for (let attempt = 1; ; attempt++) {
        const ok = await new Promise<boolean>((resolve, reject) => {
          const child = spawn('curl', ['-fL', '--retry', '3', '-C', '-', '-o', dmgPath, artifactUrl], { stdio: 'ignore' })
          child.on('error', reject)
          child.on('close', (code: number | null) => { resolve(code === 0) })
        })
        if (ok) break
        if (attempt === 5) throw new Error(`curl download failed (attempt ${attempt})`)
      }
      // Streamed verify — a ~450MB dmg never buffers whole.
      const { createHash } = await import('node:crypto')
      const hash = createHash('sha256')
      await new Promise<void>((resolve, reject) => {
        createReadStream(dmgPath)
          .on('data', (chunk: string | Buffer) => { hash.update(chunk) })
          .on('error', reject)
          .on('end', () => { resolve() })
      })
      const actual = hash.digest('hex')
      if (actual !== sha256) throw new Error(`checksum mismatch (expected ${sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`)
    } catch (error) {
      rmSync(workDir, { recursive: true, force: true })
      await fail(error instanceof Error ? error.message : String(error))
      return
    }
    // Hand off: the detached module survives this app's exit, finishes the
    // install (mount/replace/relaunch), and owns its log + failure dialogs
    // (its darwin-install subcommand removes the dmg and its workdir).
    // AISHELL_UPGRADE_LOCALE keeps the module's dialogs in the app language.
    showMacNotification(spawn, formatDesktopMessage(locale.messages.updateInstalling, { }))
    const child = spawn(process.execPath, ['--expose-internals', module, 'darwin-install', dmgPath, update.version, String(process.pid)], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1',
        AISHELL_UPGRADE_LOCALE: locale.id === 'zh-CN' ? 'zh' : 'en' } })
    child.unref()
    shellInstallerOwnsQuit = true
    app.quit()
  }
  // AI Shell distribution (D14 first-party update check): the official
  // "Check for Updates…" menu item and the renderer's updatesOpen IPC both
  // used to drive the official electron-updater chain, which is inert in
  // unsigned builds (no app-update.yml) — the menu item answered a click
  // with nothing. This replacement asks the DISTRIBUTION's own updater
  // (resources/aishell-update/aishell-update.mjs, A3) and reports the
  // result through the same dialog surface as About. The user decision
  // law: this only INFORMS (and names the upgrade command); it never
  // installs anything — `aishell upgrade` (user-invoked) owns the install
  // chain. Dev runs without the module stay stock: the click falls back to
  // the official prompt exactly as upstream shipped it.
  //
  // ASYNC LAW (revision after a real VM test): the check runs OFF the menu
  // click's critical path — a synchronous await here froze the menu IPC
  // for the Electron cold start + feed fetch (seconds), and a window
  // close during that window collided with the official quit
  // confirmation's focus handling (close button appeared dead). The click
  // now returns instantly; the dialog appears whenever the check lands.
  // Concurrent clicks join one in-flight check instead of stacking.
  let aishellCheckOperation: Promise<void> | undefined
  const checkAishellUpdates = (): void => {
    aishellCheckOperation ??= (async (): Promise<void> => {
      const module = join(process.resourcesPath, 'aishell-update', 'aishell-update.mjs')
      // AishellCheckResult (not a narrower inline shape): the dialog below
      // reads update.changelog for the detail block — the narrow
      // `{ version: string }` form type-checked only under vitest's
      // esbuild (no type gate) and failed the real build's tsc
      // (found 2026-10-22 on the alpha.39 experience build).
      let result: AishellCheckResult
      try {
        result = await runAishellCheck(module)
      } catch (error: unknown) {
        result = { update: null, version: app.getVersion(), error: error instanceof Error ? error.message : String(error) }
      }
      aishellCheckOperation = undefined
      // Instrumentation (D14 rev6): every field report of "clicked, nothing
      // appeared" came without any trace. Log the full decision so the
      // app's stdout (the wrapper terminal) always tells which branch ran:
      // the check result, the dialog branch, and any silent-return cause.
      console.info(`aishell update check: local=${result.version} update=${result.update?.version ?? 'none'} error=${result.error ?? 'none'}`)
      if (result.error !== null && result.update === null) {
        await ordinaryMessageBox({ type: 'warning', title: locale.messages.updateCheckTitle, message: locale.messages.updateCheckTitle,
          // rev8: official copy; the technical reason rides technicalDetails
          // (the dialog's expandable diagnostics field), not the detail line.
          detail: locale.messages.updateCheckFailed,
          technicalDetails: String(result.error), buttons: [locale.messages.updateAcknowledge], cancelId: 0 })
        return
      }
      if (result.update === null) {
        // Official copy exactly (updateCurrent / updateCurrentDetail) — the
        // version shown is the DISTRIBUTION version from the first-party
        // check result, never app.getVersion() (which reports the base
        // version) and never the plugin-set version.
        await ordinaryMessageBox({ type: 'info', title: locale.messages.updateCheckTitle,
          message: locale.messages.updateCurrent,
          detail: formatDesktopMessage(locale.messages.updateCurrentDetail, { version: result.version }),
          buttons: [locale.messages.updateAcknowledge], cancelId: 0 })
        return
      }
      // rev8: user-decision dialog — a new version gets REAL choices, not an
      // acknowledge-only box. Official copy (updateDownloadedTitle + detail);
      // buttons: 立即升级 runs the user-owned install chain via the packaged
      // launcher (same chain as the startup question and `aishell upgrade`);
      // 暂不 (updateLater) dismisses — the menu item remains the door back,
      // and no decline is recorded here (this was a user-initiated check).
      // Changelog block (2026-10-22): the feed's optional changelog for the
      // UI language heads the detail; a missing key hides the whole block
      // (never the other language) and the detail is exactly today's.
      const changelog = locale.id === 'zh-CN' ? result.update.changelog?.zh : result.update.changelog?.en
      const detail = changelog === undefined
        ? formatDesktopMessage(locale.messages.updateDownloadedDetail, { })
        : `${locale.messages.updateWhatsNew}\n${changelog}\n\n${formatDesktopMessage(locale.messages.updateDownloadedDetail, { })}`
      const choice = await ordinaryMessageBox({ type: 'info', title: locale.messages.updateCheckTitle,
        message: formatDesktopMessage(locale.messages.updateDownloadedTitle, { version: result.update.version }),
        detail,
        buttons: [locale.messages.updateDownload, locale.messages.updateLater], cancelId: 1 })
      if (choice.response === 0) {
        // AI Shell distribution (D15 rev13): macOS runs the in-app chain
        // (download + verify here, install via the module's darwin-install
        // after a clean quit). The packaged launcher below stays the
        // Linux/Windows install chain, and its absence there (stripped
        // artifact) still degrades to the manual-download instruction.
        if (process.platform === 'darwin') {
          await runMacAishellUpgrade(module)
          return
        }
        // AI Shell distribution (D15 win32 upgrade path, 2026-10-20):
        // the 下载更新 click must close the running app before the install
        // chain can replace the exe. On win32 the Host's task-protection
        // protocol is reachable ONLY while the app is alive (Host IPC), so
        // this hunk owns the graceful-shutdown sequence — mirroring the
        // official beforeRestart hook (main.ts:591-638) — BEFORE spawning
        // aishell-upgrade.mjs. The chain (ACK=1) then handles only the
        // residual Electron shell. Skipping task protection here would hard-
        // kill the Host and lose the user's running work (W-U15).
        if (process.platform === 'win32') {
          // Stripped-artifact guard BEFORE task protection: a missing
          // aishell-upgrade.mjs degrades to the manual-download instruction
          // (same law as the Linux launcher guard below) — checking first
          // avoids locking the Host for an install that can never run.
          const upgradeModule = join(process.resourcesPath, 'aishell-update', 'aishell-upgrade.mjs')
          if (!existsSync(upgradeModule)) {
            await ordinaryMessageBox({ type: 'info', title: locale.messages.updateManualDownloadTitle,
              message: locale.messages.updateManualDownloadTitle,
              detail: locale.messages.updateManualDownloadDetail,
              buttons: [locale.messages.updateAcknowledge], cancelId: 0 })
            return
          }
          const host = backend.host
          if (host !== undefined) {
            // Inspect active tasks; if any, ask the user to stop them
            // (official updateActiveTasks copy + stopTasks/updateLater).
            const active = await host.updateTasks('inspect')
            if (active) {
              const confirm = await ordinaryMessageBox({ type: 'warning',
                title: locale.messages.updateTitle,
                message: locale.messages.updateActiveTasks,
                detail: locale.messages.updateActiveTasksDetail,
                buttons: [locale.messages.updateStopTasks, locale.messages.updateLater],
                defaultId: 1, cancelId: 1 })
              if (confirm.response !== 0) return  // user chose "later" — no install
            }
            // Lock: reject new task HTTP, then gracefully stop the Host.
            // unlock on failure so a stopped-host error doesn't strand the lock.
            await host.updateTasks('lock')
            try {
              await platformView.closeAndWait()
              await backend.stop()
            } catch (error) {
              await host.updateTasks('unlock').catch((unlockError: unknown) => { console.error(unlockError) })
              throw error
            }
          }
          // Host stopped (or never running) → spawn the upgrade chain via
          // cmd.exe /c start. Two problems this solves (both field-proven):
          //   1. Quote trap: an earlier rev used `cmd /d /s /c "${cmd}" upgrade`
          //      but cmd /s strips the outer quote pair, leaving the spaced
          //      default install path (…\Programs\AI Shell\…) bare — cmd splits
          //      at the space and exits 1, the chain never started.
          //   2. Job kill: `spawn(process.execPath, …, { detached: true })` stays
          //      in the Electron process's Job Object; app.quit() closes the Job
          //      and the detached child is killed mid-download (died at ~65%).
          // `start ""` creates a fully independent process that breaks away
          // from the Job (field-proven: child survives parent exit). The first
          // "" is the mandatory empty window title; each spaced arg quoted.
          // Spawning process.execPath directly (not aishell.cmd) avoids the
          // CVE-2024-27980 .cmd-without-shell gate and the cmd /s quote trap
          // in one move. aishell-upgrade.mjs resolves its own stateDir from
          // USERPROFILE, no DSH_HOME needed. Detached + unref: the chain
          // outlives this app's process. ACK=1 = consent to close was given
          // above (or no app was running). AISHELL_FROM_WRAPPER stripped so
          // the chain relaunches the new version (same law as the Linux path).
          const { spawn } = await import('node:child_process')
          const child = spawn('cmd.exe', ['/d', '/c', 'start', '""',
            `"${process.execPath}"`, `"${upgradeModule}"`, 'upgrade'], {
            detached: true, stdio: ['ignore', 'ignore', 'ignore'],
            windowsVerbatimArguments: true,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AISHELL_UPGRADE_ACK: '1', AISHELL_FROM_WRAPPER: undefined } })
          child.unref()
          // Quit the Electron main process after spawning the detached upgrade
          // chain: backend.stop() halted the Host (the "重新连接中" the UI shows),
          // but the Electron shell stays alive holding the exe file lock — NSIS /S
          // cannot replace a running exe. The official beforeRestart hook relies
          // on quitAndInstall() to do this; the A3 chain owns the reinstall, so
          // app.quit() here releases the lock and closes the window. The detached
          // child (unref'd) outlives this process and relaunches the new version.
          app.quit()
        } else {
          // AI Shell distribution (D15): the packaged launcher owns the
          // Linux install chain; a stripped artifact (no launcher) degrades
          // to the manual-download instruction instead of an ENOENT crash.
          const launcher = join(process.resourcesPath, 'aishell-launcher', 'aishell')
          if (!existsSync(launcher)) {
            await ordinaryMessageBox({ type: 'info', title: locale.messages.updateManualDownloadTitle,
              message: locale.messages.updateManualDownloadTitle,
              detail: locale.messages.updateManualDownloadDetail,
              buttons: [locale.messages.updateAcknowledge], cancelId: 0 })
            return
          }
          const { spawn } = await import('node:child_process')
          // Detached: the install chain may close this app; its stdio inherits
          // the app's (the wrapper terminal) so progress stays visible.
          // AISHELL_UPGRADE_ACK: the 下载更新 click is the consent to close the
          // running app; the detached child has no tty, so the interactive ask
          // would read /dev/tty, fail, and abort the install (field-proven).
          const child = spawn(launcher, ['upgrade'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'],
            // Strip AISHELL_FROM_WRAPPER: the wrapper exports it for ITS chain (the wrapper
            // relaunches the app after its own startup-dialog upgrade, so the chain must not
            // spawn a second instance). The app INHERITS it from the wrapper that launched it,
            // and without stripping it here it leaks into app-initiated chains — an upgrade
            // started from the in-app menu then skipped the relaunch entirely (field-proven:
            // decline at startup → manual check → 下载更新 → no window after success).
            env: { ...process.env, AISHELL_UPGRADE_ACK: '1', AISHELL_FROM_WRAPPER: undefined } })
          child.unref()
        }
      }
    })().catch((error: unknown) => { console.error(error) })
  }
  const commandManager = new DesktopCommandManager({
    resources: process.resourcesPath,
    isPackaged: app.isPackaged,
    isInstalledLocation: () => process.platform !== 'darwin' || app.isInApplicationsFolder(),
    isInstalling: () => updateState.phase === 'installing',
    isQuitting,
    messages: () => currentDesktopLocale().messages,
    show: ordinaryMessageBox,
  })
  const appPreload = fileURLToPath(new URL('./preload-app.cjs', import.meta.url))
  const applicationUrl = `${SCHEME}://app/`
  let hostUrl: string | undefined
  let hostCookie: string | undefined
  const browserGuests = new DesktopBrowserGuests(() => hostUrl)
  let injections: readonly unknown[] = []
  let welcomeBackend: DesktopWelcomeBackend | undefined
  let reportedLaunch = false
  let analyticsEnabled = false
  const track = async <K extends keyof ProductEventMap>(eventName: K, attributes: ProductEventMap[K]): Promise<void> => {
    const event = { eventName, attributes, timestamp: Date.now() } as ProductEvent
    try {
      if (analyticsEnabled) await welcomeBackend?.report(event)
    } catch (_error) { /* Analytics cannot interrupt native actions. */ }
  }
  let stopAccount: (() => void) | undefined
  let openedAttempt: string | undefined
  let returnedAttempt: string | undefined
  let pendingWelcomeNotice: WelcomeNotice | undefined
  let previousAccountStatus: string | undefined
  const assertProductSender = (event: IpcMainInvokeEvent): BrowserWindow => {
    assertDesktopSender(event, ['app'])
    if (mainWindow === undefined || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || event.senderFrame === null || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('dsh desktop: rejected IPC from an unowned renderer')
    }
    return mainWindow
  }
  let navigation: { window: BrowserWindow; url: string; promise: Promise<void> } | undefined
  const navigateMain = (url: string): Promise<void> => {
    const window = mainWindow
    if (quitting || window === undefined || window.isDestroyed()) return Promise.resolve()
    if (navigation?.window === window && navigation.url === url) return navigation.promise
    const next = { window, url, promise: Promise.resolve() }
    next.promise = window.loadURL(url).catch((error: unknown) => {
      if (quitting || shuttingDown || window.isDestroyed() || navigation !== next
        || (error instanceof Error && 'code' in error && error.code === 'ERR_ABORTED')) return
      navigation = undefined
      throw error
    })
    navigation = next
    return next.promise
  }
  const platformView = new DesktopPlatformView(join(app.getAppPath(), 'lib', 'preload-platform-account.cjs'),
    () => locale.id === 'zh-CN' ? 'zh_CN' : 'en_US', process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin',
    owner => isMandatory() || updateOverlays.input(owner).blocked)
  // AI Shell distribution (deeplink host delivery): the hub itself lives at
  // module scope (early URLs — cold-start argv, macOS pre-ready open-url —
  // must reach it before main() runs); main() only wires the backend whose
  // `.host` the send callback reads. Until this assignment the hub stashes;
  // the readiness observer below flushes once the Host child reports ready.
  const backend = new DesktopBackendController((onFailure) => {
    const hostInspectPort = developmentHostInspectPort(development)
    const host = new DesktopHostProcess(resources.node, resources.dsh, activeProject,
      hostInspectPort, { ...hostEnvironment, DSH_CLIENT_VERSION: desktopClientVersion() }, onFailure,
      primaryRuntime,
      resources, (next) => { platformView.setSession(next) }, (record) => {
        operationJournal ??= new OperationJournal(join(app.getPath('userData'), 'plugin-operations'), {
          segmentBytes: 256 * 1024, recordBytes: 4096, queuedBytes: 64 * 1024,
        })
        operationJournal.enqueue(JSON.stringify(record))
      })
    return {
      start: async () => {
        const ready = await host.start()
        const cookie = await authenticateWebHost(ready.url)
        hostCookie = cookie
        hostUrl = ready.url
        void removeLegacyHostCookies(session.defaultSession.cookies, ready.url)
          .catch((error: unknown) => { console.error('desktop: legacy Host cookie cleanup failed', error) })
        if (ready.injections === undefined) throw new Error('Desktop Host did not provide boot injections')
        injections = ready.injections
        welcomeBackend = connectDesktopWelcome(ready.url, cookie)
        analyticsEnabled = await welcomeBackend.analyticsEnabled().catch(() => false)
        if (!reportedLaunch) { reportedLaunch = true; void track('desktop_app_launch', {}) }
        stopAccount?.()
        const accountBackend = welcomeBackend.account
        stopAccount = accountBackend.watch((state) => {
          if (quitting) return
          if (welcomeWindow !== undefined && !welcomeWindow.isDestroyed()) welcomeWindow.webContents.send(WELCOME_IPC.state, state)
          const attempt = state.attempt
          if (attempt?.phase === 'waiting-browser' && attempt.authorizeUrl !== undefined && openedAttempt !== attempt.id) {
            openedAttempt = attempt.id
            void shell.openExternal(platformLoginUrl(attempt.authorizeUrl)).catch(() => undefined)
          }
          if ((attempt?.phase === 'failed' || attempt?.phase === 'expired') && returnedAttempt !== attempt.id) {
            returnedAttempt = attempt.id
            focusPrimaryWindow()
          }
          if (state.status === 'credential-stored' && attempt?.phase === 'succeeded' && welcomeWindow !== undefined) void enterWorkspace({ activate: false }).catch(() => undefined)
          if (previousAccountStatus === 'credential-stored' && state.status === 'signed-out') {
            void readWelcomeState().then(async (value) => {
              if (needsWelcome(value) && !quitting) {
                enteredWorkspace = false
                await showWelcome()
                if (welcomeWindow !== undefined && !welcomeWindow.isDestroyed()) welcomeWindow.webContents.send(WELCOME_IPC.state, state)
              }
              return undefined
            }).catch(() => undefined)
          }
          previousAccountStatus = state.status
        }, () => {
          // The stream reconnects; a transport failure does not change account state.
        }, () => {
          void readWelcomeState().then(async (value) => {
            if (!needsWelcome(value) || quitting) return
            pendingWelcomeNotice = 'session-expired'
            enteredWorkspace = false
            await showWelcome()
            const state = await accountBackend.state()
            if (welcomeWindow !== undefined && !welcomeWindow.isDestroyed()) welcomeWindow.webContents.send(WELCOME_IPC.state, state)
          }).catch(() => undefined)
        }, (enabled) => { analyticsEnabled = enabled })
      },
      stop: async () => {
        analyticsEnabled = false
        stopAccount?.()
        try { await host.stop(requireCleanStop) }
        catch (error) {
          if (!requireCleanStop || !(error instanceof DesktopHostUncleanExitError)) throw error
          // Backend cleanup succeeded; installation still rejects the unsuccessful task teardown.
          updateStopFailure = error
        }
      },
      updateTasks: (action: 'inspect' | 'lock' | 'unlock') => host.updateTasks(action),
      inspectQuit: () => host.inspectQuit(),
      resolveDragResource: (address: string, signal?: AbortSignal) => host.resolveDragResource(address, signal),
      sendDeepLink: (url: string) => host.sendDeepLink(url),
    }
  }, (state) => {
    if (state.phase === 'error') reportFatal(state.failure, 'host')
    else if (!shuttingDown) backendReady = state.phase === 'ready'
    // AI Shell distribution (deeplink host delivery): flush the pending
    // deep link once the Host child reports readiness (buffer #1 empties
    // here); a Host replacement (update restore path) re-arms the hub.
    if (state.phase === 'ready') deepLinkHub.hostReady()
    else if (state.phase === 'starting') deepLinkHub.hostReplaced()
  })
  // Wire the module-scope hub's send callback to this backend controller:
  // until now early URLs stashed; from here `.host` is live for delivery.
  deepLinkBackend = backend

  const updateErrors = new WeakMap<DesktopUpdateState, Promise<void>>()
  const showUpdateFailure = (state: DesktopUpdateState): Promise<void> => {
    if (state.phase !== 'error') return Promise.resolve()
    if (isMandatory()) { mandatoryUI?.sync(); return Promise.resolve() }
    let shown = updateErrors.get(state)
    if (shown === undefined) {
      shown = ordinaryMessageBox({ type: 'error', title: locale.messages.updateFailedTitle,
        message: desktopUpdateErrorSummary(state, locale.messages),
        technicalDetails: state.technicalDetails ?? state.message ?? '' }).then(() => {})
      updateErrors.set(state, shown)
    }
    return shown
  }
  const publishUpdate = (state: DesktopUpdateState): DesktopUpdateState => {
    updateJournal?.state(state)
    updateState = state
    mandatoryUI?.sync()
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(DESKTOP_IPC.updatesPresentation, updatePresentation(state))
    }
    if (state.phase === 'error' && state.failedOperation !== 'check' && state.failedOperation !== 'configuration') {
      if (state.failedOperation === 'install' && fileDragStopped && !quitting) {
        fileDragCleanups.add(installFileDrag())
        fileDragStopped = false
      }
      const restoreHost = state.failedOperation === 'install' && updateStoppedHost && !quitting
      if (state.failedOperation === 'install' && !quitting) {
        operationReportsStopping = shuttingDown
        operationReportStop = undefined
      }
      shellInstallerOwnsQuit = false
      updateStoppedHost = false
      if (restoreHost) {
        // Only confirmed process exit permits replacement before another installation confirmation.
        const hostReady = backend.start(prepareHostEnvironment)
        startup = hostReady
        const recovery = hostReady.then(async () => {
          if (quitting) return
          // A replacement Host can have a new port, cookie, or boot injections even at the same URL.
          navigation = undefined
          await navigateMain(applicationUrl)
          if (backend.host !== undefined) updateJournal?.action('workspace-ready')
        })
        workspaceRecovery = recovery
        void recovery.catch((error: unknown) => { reportFatal(error, 'main') }).finally(() => {
          if (startup === hostReady) startup = undefined
          if (workspaceRecovery === recovery) workspaceRecovery = undefined
        })
      }
      void showUpdateFailure(state).catch((error: unknown) => { console.error(error) })
    }
    return state
  }

  // AI Shell distribution (D19 settings-update-button): the bridge drives
  // the official web indicator from the first-party updater on Linux
  // packaged runs. It publishes through publishUpdate (single-writer: the
  // official coordinator stays idle — this distribution ships no
  // app-update.yml), guards busy/once installations on the main-process
  // side, restores the ready phase from a persisted staging, and is
  // fail-open by construction (a bridge defect hides the button, never
  // kills the app). Win/mac keep the D14 menu flow; dev runs stay stock.
  let updateBridge: AishellUpdateBridge | undefined
  if (process.platform === 'linux' && app.isPackaged
    && existsSync(join(process.resourcesPath, 'aishell-update', 'aishell-update.mjs'))) {
    try {
      updateBridge = new AishellUpdateBridge(publishUpdate, aishellPlatform(process.resourcesPath, process.execPath),
        true, 10 * 60_000, async (version: string) => {
          // The official ready confirmation (official copy, official dialog):
          // 安装并重启 is the ONLY acceptance; the cancelId is a nonexistent
          // index, so X/Esc/replacement can never read as consent.
          const ready = desktopUpdateReadyConfirmation(locale.messages, version, process.platform)
          const parent = currentDialogWindow()
          if (parent === undefined) return false
          const result = await updateDialog.show(parent, {
            type: 'info', title: locale.messages.updateTitle,
            message: ready.message, detail: ready.detail,
            buttons: [locale.messages.installAndRestart], defaultId: 1, cancelId: 1,
          })
          return result.response === 0
        })
      // Startup pass: a check immediately (fresh info for the button), then
      // staging recovery against whatever the check learned.
      void updateBridge.backgroundCheck().then(async () => {
        const bridge = updateBridge
        if (bridge === undefined) return
        await bridge.resume((candidate) => {
          const state = bridge.status
          return state.phase === 'available' && state.version !== undefined
            && compareAishellVersions(state.version, candidate) > 0
        })
      }).catch((error: unknown) => { console.error(error) })
      console.info('aishell update bridge: active (10-minute cadence, startup check)')
    } catch (error) { console.error('aishell update bridge: disabled (init failure)', error) }
  }
  /** Semver precedence for the resume gate; 0 when unparseable (treated as unknown → resume declines). */
  function compareAishellVersions(a: string, b: string): number {
    const pa = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(a)
    const pb = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(b)
    if (pa === null || pb === null) return 0
    for (let i = 1; i <= 3; i++) {
      const x = Number(pa[i]), y = Number(pb[i])
      if (x !== y) return x < y ? -1 : 1
    }
    const ra = pa[4] === undefined ? [] : pa[4].split('.')
    const rb = pb[4] === undefined ? [] : pb[4].split('.')
    if (ra.length === 0 && rb.length === 0) return 0
    if (ra.length === 0) return 1
    if (rb.length === 0) return -1
    for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
      const x = ra[i], y = rb[i]
      if (x === undefined) return -1
      if (y === undefined) return 1
      if (x === y) continue
      const xn = /^-?\d+$/.test(x), yn = /^-?\d+$/.test(y)
      if (xn && yn) return Number(x) < Number(y) ? -1 : 1
      if (xn) return -1
      if (yn) return 1
      return x < y ? -1 : 1
    }
    return 0
  }

  const readWelcomeState = async (): Promise<WelcomeState> => {
    // AI Shell distribution (D3 welcome retirement, 0.2.2): the boot's
    // welcome wire-read drags the whole desktop down when the web listener
    // rejects the request (0.2.2's openInitialWindow awaits this before
    // entering the workspace). The distribution has no welcome flow —
    // credentials are Huawei Cloud AK/SK configured in-app by the
    // preinstalled plugins — so the authentication fields are static and the
    // heavy read (provider directory + credential metadata RPCs) never runs.
    // 0.2.2-rc.3 made openInitialWindow consume the user's locale and THEME
    // preferences from this state, so the LIGHT path remains: one
    // settings.describe RPC feeds both (a failure falls back to the
    // system locale and the system theme — the boot never dies on it).
    const preferences = await welcomeBackend?.readPreferences()
      .catch(() => ({ localePreference: null, themePreference: 'system' as const })) ??
      { localePreference: null, themePreference: 'system' as const }
    return { loggedIn: false, hasApiKey: false, writable: true, ...preferences }
  }
  stopForRecovery = async () => {
    const reports = stopOperationReports()
    try { await backend.close() }
    finally { await Promise.all([operationJournal?.drain(500), reports]) }
  }

  const reconcileBackend = (): Promise<void> => {
    startup ??= (async () => {
      await navigateMain(applicationUrl)
      await backend.start(async () => {
        await Promise.all([manager.applyRelease(), prepareHostEnvironment()])
      })
      if (backend.host !== undefined) await openInitialWindow()
      if (backend.host !== undefined) updateJournal?.action('workspace-ready')
      // The existing Web document resumes through the boot IPC response.
    })().catch((error: unknown) => {
      updateJournal?.action('workspace-failed')
      reportFatal(error, 'main')
      throw error
    }).finally(() => { startup = undefined })
    return startup
  }

  const manifest: unknown = JSON.parse(await readFile(join(app.getAppPath(), 'package.json'), 'utf8'))
  const packagedChannel = desktopUpdateChannel(manifest)
  const channelSettings = new DesktopUpdateSettings(app.getPath('userData'), packagedChannel)
  const initialChannel = await channelSettings.load()
  channelState = { channel: initialChannel.kind === 'ready' ? initialChannel.channel : null,
    packagedChannel, changing: false,
    ...(initialChannel.kind === 'error' ? { error: configurationFailure(initialChannel.error) } : {}) }
  const updateChannel = initialChannel.kind === 'ready' ? initialChannel.channel : packagedChannel
  const updates = new DesktopUpdateCoordinator(
    publishUpdate,
    async () => {
      await commandManager.idle()
      await workspaceRecovery
      await startup?.catch(() => undefined)
      const host = backend.host
      if (host === undefined) throw new DesktopUpdatePreparationError('tasks-unavailable', locale.messages.updateTasksUnavailable)
      const active = await host.updateTasks('inspect')
      const parent = currentDialogWindow()
      if (parent === undefined || !await prepareDesktopUpdateWindow(parent, locale.messages.updateFullscreenTimeout)) return false
      const ready = desktopUpdateReadyConfirmation(locale.messages, updates.state.version ?? '', process.platform)
      const confirmation: Electron.MessageBoxOptions = {
        type: active ? 'warning' : 'info', title: locale.messages.updateTitle,
        message: active ? locale.messages.updateActiveTasks : ready.message,
        detail: active ? locale.messages.updateActiveTasksDetail : ready.detail,
        buttons: active ? [locale.messages.updateStopTasks, locale.messages.updateLater] : [locale.messages.installAndRestart],
        defaultId: 1, cancelId: 1,
      }
      if (isMandatory()) {
        if (!await mandatoryUI?.confirm(updates.state.version ?? '', active)) return false
      } else {
        const result = await updateDialog.show(parent, confirmation)
        if (result.response !== 0 || isMandatory()) return false
      }
      // The update lock rejects new HTTP requests, including analytics intake.
      await track('desktop_upgrade_install_restart_click', {})
      if (backend.host !== host) throw new DesktopUpdatePreparationError('tasks-unavailable', locale.messages.updateTasksUnavailable)
      try {
        const stillActive = await host.updateTasks('lock')
        if (stillActive && !active) throw new DesktopUpdatePreparationError('tasks-changed', locale.messages.updateTasksChanged)
        mandatoryUI?.preparingRestart(stillActive)
        // The embedded Platform document holds credentials issued by the Host that is about to stop.
        await platformView.closeAndWait()
        await disposeFileDrag().catch((error: unknown) => { console.error(error) })
        requireCleanStop = true
        updateStopFailure = undefined
        await Promise.all([backend.stop(), stopOperationReports()])
        updateStoppedHost = true
        // The backend's async cleanup callback can assign this after the reset above.
        const stopFailure = updateStopFailure as DesktopHostUncleanExitError | undefined
        if (stopFailure !== undefined) throw new DesktopUpdatePreparationError('stop-failed', locale.messages.updateStopFailed, stopFailure.message)
        await operationJournal?.drain(500)
        updateJournal?.action('install-confirmed')
        shellInstallerOwnsQuit = true
      } catch (error) {
        operationReportsStopping = shuttingDown
        operationReportStop = undefined
        if (!updateStoppedHost) await host.updateTasks('unlock').catch((unlockError: unknown) => { console.error(unlockError) })
        throw error
      } finally {
        requireCleanStop = false
      }
      return true
    },
    undefined, undefined, undefined,
    (success, reason) => { void track('desktop_upgrade_download_result', { is_success: success, ...reason === undefined ? {} : { error_reason: reason } }) },
    updateChannel,
  )

  if (initialChannel.kind === 'error') updates.suspendConfiguration(initialChannel.error.path)
  const publishChannel = (state: DesktopChannelState): DesktopChannelState => {
    channelState = state
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(DESKTOP_IPC.updatesChannelChanged, state)
      window.webContents.send(DESKTOP_IPC.updatesPresentation, updatePresentation(updates.state))
    }
    return state
  }

  const updateSchedule = new DesktopUpdateSchedule(updates, resolveDesktopUpdateScheduleConfig(process.env))

  const downloadUpdate = async (version: string, revision = updates.revision): Promise<DesktopUpdateState> => {
    void track('desktop_upgrade_click', {})
    updateJournal?.action('download-requested')
    const state = await updates.download(version, revision)
    if (state.phase !== 'ready' || quitting) return state
    // Only a completed user-driven download opens this prompt; cancelling installation does not reopen it.
    // A confirmation on a hidden window would go unseen, so it waits for the next show; the mandatory
    // flow keeps its own taskbar and Dock attention instead.
    if (!isMandatory()) await windowShown()
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- A quit can begin while the show is awaited.
    if (quitting) return state
    return updates.install(version, revision)
  }
  const windowShown = (): Promise<void> => new Promise((resolve) => {
    const window = currentDialogWindow()
    if (window === undefined || window.isDestroyed() || window.isVisible()) { resolve(); return }
    window.once('show', () => { resolve() })
    window.once('closed', () => { resolve() })
  })

  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    // Shell-owned documents live in the application bundle and never pass through the Host.
    if (url.hostname === 'shell') return serveWebDocument(request, join(app.getAppPath(),
      url.pathname === '/design-platform.css' ? 'lib/welcome' : 'renderer'))
    if (url.hostname === 'app') {
      if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/assets/')
        || ['/favicon.svg', '/manifest.webmanifest'].includes(url.pathname)) {
        return serveWebDocument(request, join(resources.dsh, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'))
      }
      if (backend.host === undefined || hostUrl === undefined || hostCookie === undefined) {
        return Promise.resolve(new Response(null, { status: 503 }))
      }
      return forwardWebRequest(request, hostUrl, hostCookie)
    }
    return Promise.resolve(new Response(null, { status: 404 }))
  })

  installDesktopDirectoryPicker(() => mainWindow)
  installMicrophonePermissions(session.defaultSession, () => mainWindow?.webContents)
  const shortcuts = installDesktopShortcuts(() => mainWindow, app.getPath('userData'),
    process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux', () => { refreshApplicationMenu() }, window => updateOverlays.input(window))
  app.on('will-quit', () => { shortcuts.dispose() })

  ipcMain.handle(DESKTOP_IPC.boot, async (event) => {
    assertDesktopSender(event, ['app'])
    await startup
    if (backend.host === undefined || hostUrl === undefined) throw new Error('Desktop Host is unavailable')
    return { injections, streamBaseUrl: new URL(hostUrl).origin }
  })

  ipcMain.handle(DESKTOP_IPC.bootFailed, (event, message: unknown) => {
    assertDesktopSender(event, ['app'])
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('dsh desktop: rejected startup failure from a non-primary frame')
    }
    if (typeof message !== 'string') throw new Error('dsh desktop: startup failure must be text')
    reportFatal(new Error(message), 'web-boot')
  })

  ipcMain.handle(DESKTOP_IPC.browserAcquire, (event, workspace: unknown) => {
    assertProductSender(event)
    return browserGuests.acquire(event.sender, workspace)
  })
  ipcMain.handle(DESKTOP_IPC.browserRelease, (event, lease: unknown) => {
    assertProductSender(event)
    return browserGuests.release(event.sender, lease)
  })

  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['ws://127.0.0.1/*', 'wss://127.0.0.1/*'] }, (details, callback) => {
    if (hostUrl === undefined || hostCookie === undefined || details.webContentsId !== mainWindow?.webContents.id) {
      callback({})
      return
    }
    const target = new URL(hostUrl)
    const requested = new URL(details.url)
    if (requested.host !== target.host || requested.protocol !== (target.protocol === 'https:' ? 'wss:' : 'ws:')) { callback({}); return }
    const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]))
    if (headers.origin !== 'dsh-app://app') { callback({ cancel: true }); return }
    callback({ requestHeaders: { ...headers, origin: target.origin, cookie: hostCookie, 'sec-fetch-site': 'same-origin' } })
  })

  const assertMainApplication = (event: IpcMainInvokeEvent): BrowserWindow => {
    const owner = mainWindow
    if (owner === undefined || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame
      || !event.senderFrame.url.startsWith('dsh-app://app/')) throw new Error('Rejected Platform command')
    return owner
  }
  installFileActions(assertMainApplication, () => hostUrl)
  ipcMain.on(PLATFORM_IPC.bootstrap, (event) => {
    try { event.returnValue = platformView.bootstrap(event) }
    catch { event.returnValue = null }
  })
  ipcMain.handle(PLATFORM_IPC.open, (event, page: unknown, bounds: unknown) => {
    const owner = assertMainApplication(event)
    if (page !== 'usage' && page !== 'top-up') throw new Error('Invalid Platform page')
    return platformView.open(owner, page, platformBounds(bounds))
  })
  ipcMain.handle(PLATFORM_IPC.bounds, (event, bounds: unknown) => {
    assertMainApplication(event)
    platformView.setBounds(platformBounds(bounds))
  })
  ipcMain.handle(PLATFORM_IPC.close, (event) => { assertMainApplication(event); platformView.close() })
  // Only the main window may synchronize its palette with the native material.
  ipcMain.on(DESKTOP_IPC.nativeThemeSet, (event, source: unknown) => {
    if (mainWindow === undefined || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame
      || !event.senderFrame.url.startsWith(`${SCHEME}://app/`)) return
    if (source !== 'light' && source !== 'dark' && source !== 'system') return
    nativeTheme.themeSource = source
  })
  ipcMain.handle(DESKTOP_IPC.localeBootstrap, async (event) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame
      || new URL(event.senderFrame.url).origin !== new URL(applicationUrl).origin) {
      throw new Error('desktop welcome: rejected locale request from an unowned frame')
    }
    if (welcomeBackend === undefined) throw new Error('desktop welcome: backend unavailable')
    return { languages: systemLanguages, preference: await welcomeBackend.readLocalePreference() }
  })
  ipcMain.on(DESKTOP_IPC.localeChanged, (event, next: unknown) => {
    const window = mainWindow
    if (window === undefined || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || typeof next !== 'string') return
    const current = resolveDesktopStartupLocale(next, systemLanguages)
    writeDesktopLocaleCache(app.getPath('userData'), current.id)
    if (current.id === locale.id) return
    locale = current
    platformView.notifyLocaleChanged()
    windowsLanguage = locale.id
    refreshApplicationMenu()
  })
  ipcMain.handle(DESKTOP_IPC.updatesChannelGet, (event) => {
    assertProductSender(event)
    return channelState
  })
  let channelRequests = 0
  ipcMain.handle(DESKTOP_IPC.updatesChannelSet, async (event, channel: unknown): Promise<DesktopChannelChangeResult> => {
    assertProductSender(event)
    if (!isDesktopUpdateChannel(channel)) throw new Error('desktop update: unsupported channel')
    if (channelState === undefined) throw new Error('desktop update: settings are not initialized')
    channelRequests++
    publishChannel({ ...channelState, changing: true })
    try {
      const kind = await updates.switchChannel(channel, async () => {
        try { await channelSettings.save(channel) } catch (error) {
          if (channelSaveFailure(error) === 'uncertain') {
            updates.suspendConfiguration('desktop update: settings save outcome is unknown')
            publishChannel({ channel: updates.selectedChannel, packagedChannel, changing: true, error: 'read' })
          }
          throw error
        }
      })
      if (kind === 'applied') void mandatoryPolicy?.check('channel-change', true).catch((error: unknown) => { console.error(error) })
      return { kind, state: publishChannel({ channel: updates.selectedChannel, packagedChannel, changing: --channelRequests > 0 }) }
    } catch (error) {
      console.error('desktop update: channel change failed', error)
      const state = publishChannel({ ...channelState, changing: --channelRequests > 0,
        ...(updates.configurationFailure === 'cleanup' ? { error: 'cleanup' as const } : {}) })
      return { kind: 'failed', state, reason: channelSaveFailure(error) }
    }
  })
  ipcMain.handle(DESKTOP_IPC.updatesStatus, (event) => {
    assertProductSender(event)
    // AI Shell distribution (D19 settings-update-button): the bridge owns
    // the state on Linux packaged runs — the web indicator queries THIS,
    // not the inert electron-updater coordinator (no app-update.yml here).
    return updatePresentation(updateBridge !== undefined ? updateBridge.status : updates.state)
  })
  ipcMain.handle(DESKTOP_IPC.deviceInfo, (event) => {
    assertProductSender(event)
    return readDeviceInfo()
  })
  ipcMain.handle(DESKTOP_IPC.onboardingApiKey, async (event) => {
    assertProductSender(event)
    // AI Shell distribution (D3 welcome retirement): key discovery is static
    // — no welcome wire read on this path (the light preferences read serves
    // openInitialWindow only). Credentials live in the preinstalled plugins.
    return false
  })
  ipcMain.on(DESKTOP_IPC.onboardingActive, (event, active: unknown) => {
    const window = mainWindow
    if (window === undefined || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame
      || !event.senderFrame.url.startsWith(`${SCHEME}://app/`) || typeof active !== 'boolean') return
    window.setMinimumSize(active ? 960 : 520, 600)
    if (active) {
      const { width, height } = window.getBounds()
      if (width < 960) window.setSize(960, height)
    }
  })
  ipcMain.handle(DESKTOP_IPC.updatesOpen, async (event) => {
    assertProductSender(event)
    // AI Shell distribution (D19 settings-update-button): on Linux packaged
    // runs the button drives the bridge (official semantics: available ->
    // download with inline progress -> ready -> confirmation). Other packaged
    // platforms keep the D14 menu-dialog flow; dev runs stay stock.
    if (updateBridge !== undefined) {
      updateBridge.open()
      return
    }
    await openUpdatePrompt()
  })

  let configurationPrompt: Promise<void> | undefined
  const showConfigurationError = (): Promise<void> => {
    configurationPrompt ??= Promise.resolve().then(async () => {
      while (channelState?.error !== undefined) {
        const result = await ordinaryMessageBox({ type: 'error', title: locale.messages.updateFailedTitle,
          message: configurationMessage(channelState.error, locale.messages),
          ...{ detail: channelSettings.path,
            buttons: [locale.messages.updateReloadSettings, locale.messages.updateShowSettingsFile, locale.messages.updateClose],
            defaultId: 0, cancelId: 2,
            keepOpenAction: { index: 1, run: () => { shell.showItemInFolder(channelSettings.path) } },
            action: { index: 0, run: async () => {
              if (channelRequests > 0 || channelState === undefined) return false
              channelRequests++
              publishChannel({ ...channelState, changing: true })
              try {
                const loaded = await channelSettings.load()
                if (loaded.kind === 'error') {
                  publishChannel({ ...channelState, changing: true, error: configurationFailure(loaded.error) })
                  return false
                }
                await updates.switchChannel(loaded.channel, async () => {})
                publishChannel({ channel: updates.selectedChannel, packagedChannel, changing: true })
                return true
              } catch (error) {
                console.error('desktop update: settings reload failed', error)
                publishChannel({ ...channelState,
                  ...(updates.configurationFailure === 'cleanup' ? { error: 'cleanup' as const } : {}) })
                return false
              } finally {
                publishChannel({ ...channelState, changing: --channelRequests > 0 })
              }
            } } },
        }, mandatoryUI?.confirmationWindow ?? currentDialogWindow())
        if (result.response !== 0) return
      }
    }).finally(() => { configurationPrompt = undefined })
    return configurationPrompt
  }

  let promptOperation: Promise<void> | undefined
  let policyAuthenticationQueued = false
  /** Present check results only while their captured channel revision remains current. */
  const openUpdatePrompt = (manual = false): Promise<void> => {
    if (channelState?.error !== undefined) {
      return showConfigurationError()
    }
    if (authenticationOperation !== undefined) {
      policyAuth?.focus(); updateDialog.focus()
    }
    if (!isMandatory() && (updates.state.phase === 'downloading' || updates.state.phase === 'verifying')) {
      if (updateDialog.isOpen) {
        updateDialog.focus()
        return Promise.resolve()
      }
      const options = { type: 'info' as const, title: locale.messages.updateCheckTitle,
        message: updates.state.phase === 'downloading' ? locale.messages.updateDownloadInProgress : locale.messages.updateVerifying,
        detail: updates.state.phase === 'downloading' ? locale.messages.updateDownloadDetail : '', buttons: [locale.messages.updateClose], cancelId: 0,
      }
      return ordinaryMessageBox(options).then(() => {}).catch(async (error: unknown) => {
        console.error(error)
        try { await dialog.showMessageBox(options) }
        catch (nativeError) { console.error(nativeError) }
      })
    }
    let failedOperation: 'check' | 'download' | 'install' = 'check'
    promptOperation ??= Promise.resolve().then(async () => {
      if (manual) updateJournal?.action('check-requested')
      const joinedPolicyAuthentication = authenticationOperation !== undefined
      if (joinedPolicyAuthentication) await authenticatePolicy()
      if (isMandatory()) {
        mandatoryUI?.focus()
        if (manual) await Promise.all([checkPolicyManually(), updateSchedule.check(true)])
        return
      }
      let controller: AbortController | undefined
      let progress: Promise<unknown> | undefined
      try {
        let state = updates.state
        const revision = updates.revision
        if (manual || state.phase === 'idle' || (state.phase === 'error' && state.failedOperation === 'check')) {
          controller = new AbortController()
          ordinaryDialogs.add(controller)
          const parent = currentDialogWindow()
          progress = parent === undefined ? Promise.resolve() : updateDialog.show(parent, { type: 'info', title: locale.messages.updateCheckTitle,
            message: locale.messages.updateChecking, buttons: [locale.messages.later], cancelId: 0, signal: controller.signal })
          if (!joinedPolicyAuthentication) {
            void checkPolicyManually('deferred').catch((error: unknown) => { console.error(error) })
          }
          state = await updateSchedule.check(true)
        }
        if (revision !== updates.revision) return
        if (isMandatory()) { mandatoryUI?.focus(); return }
        if (state.phase === 'error' && state.failedOperation === 'check') { await showUpdateFailure(state); return }
        if (state.phase === 'idle') {
          await ordinaryMessageBox({ type: 'info', title: locale.messages.updateCheckTitle,
            message: locale.messages.updateCurrent,
            detail: formatDesktopMessage(locale.messages.updateCurrentDetail, { version: app.getVersion() }) })
          return
        }
        if (state.phase === 'ready' || (state.phase === 'error' && state.failedOperation === 'install')) {
          if (state.version !== undefined) {
            failedOperation = 'install'
            await showUpdateFailure(await updates.install(state.version, revision))
          }
          return
        }
        if (state.phase !== 'available' && !(state.phase === 'error' && state.failedOperation === 'download')) return
        if (manual) {
          const result = await ordinaryMessageBox({ title: locale.messages.updateCheckTitle,
            message: formatDesktopMessage(locale.messages.updateAvailable, { version: state.version ?? '' }),
            detail: locale.messages.updateDetail,
            buttons: [locale.messages.updateDownload], cancelId: 1 })
          if (result.response !== 0) return
        }
        if (!isMandatory() && state.version !== undefined) {
          controller?.abort()
          failedOperation = 'download'
          await showUpdateFailure(await downloadUpdate(state.version, revision))
        }
      } finally {
        controller?.abort()
        if (controller !== undefined) ordinaryDialogs.delete(controller)
        await progress
      }
    }).catch((error: unknown) => showUpdateFailure({ phase: 'error', failedOperation,
      message: desktopErrorState(error).message }))
      .finally(() => { promptOperation = undefined; flushQueuedPolicyAuthentication() })
    return promptOperation
  }

  let authenticationOperation: Promise<DesktopPolicyState | undefined> | undefined
  const authenticatePolicy = () => {
    if (authenticationOperation !== undefined) { policyAuth?.focus(); updateDialog.focus() }
    authenticationOperation ??= runPolicyAuthentication().finally(() => { authenticationOperation = undefined })
    return authenticationOperation
  }
  const flushQueuedPolicyAuthentication = (): void => {
    if (!policyAuthenticationQueued || promptOperation !== undefined || authenticationOperation !== undefined
      || isMandatory() || quitting) return
    policyAuthenticationQueued = false
    void authenticatePolicy().catch((error: unknown) => { console.error(error) })
  }
  const queuePolicyAuthentication = (): void => {
    if (!desktopSettings.updates.allowTestAuthPopupWindow) return
    if (authenticationOperation !== undefined) {
      policyAuth?.focus(); updateDialog.focus()
      return
    }
    policyAuthenticationQueued = true
    flushQueuedPolicyAuthentication()
  }
  const runPolicyAuthentication = async () => {
    if (!desktopSettings.updates.allowTestAuthPopupWindow
      || policyAuth === undefined || mandatoryPolicy === undefined || quitting) return undefined
    const parent = mandatoryUI?.confirmationWindow ?? currentDialogWindow()
    if (parent === undefined) return undefined
    const consent = await updateDialog.show(parent, { type: 'info', title: locale.messages.policyLoginTitle,
      message: locale.messages.policyLoginRequired, buttons: [locale.messages.policyLogin, locale.messages.later], cancelId: 1 })
    if (consent.response !== 0 || isQuitting()) return undefined
    const outcome = await policyAuth.login()
    if (isQuitting() || outcome === 'cancelled') return undefined
    if (outcome === 'failed') {
      await updateDialog.show(parent, { type: 'error', title: locale.messages.policyLoginTitle,
        message: locale.messages.policyLoginFailed, buttons: [locale.messages.updateAcknowledge], cancelId: 0 })
      return undefined
    }
    // Drain a pre-login request before asking the server to evaluate the new cookies.
    await mandatoryPolicy.check('login-return')
    if (isQuitting()) return undefined
    return mandatoryPolicy.check('login-return', true)
  }

  const checkPolicyManually = async (authentication: 'immediate' | 'deferred' = 'immediate') => {
    if (authenticationOperation !== undefined) return authenticatePolicy()
    const policy = await mandatoryPolicy?.check('manual', true)
    if (policy?.error !== 'authentication-required' || !desktopSettings.updates.allowTestAuthPopupWindow) return policy
    if (authentication === 'immediate') return authenticatePolicy()
    queuePolicyAuthentication()
    return policy
  }

  const automaticCheck = (): void => {
    if (!quitting) void mandatoryPolicy?.check('foreground-or-resume').catch((error: unknown) => { console.error(error) })
    // AI Shell distribution (D19): the bridge owns the ordinary polling on
    // Linux packaged runs — the official coordinator would publish a
    // no-packaged-source error on every tick and the button would flip to
    // retry. Single-writer law.
    if (!quitting && updateBridge === undefined) void updateSchedule.check().catch((error: unknown) => { console.error(error) })
    if (!quitting && updateBridge !== undefined) void updateBridge.backgroundCheck().catch((error: unknown) => { console.error(error) })
  }
  powerMonitor.on('resume', automaticCheck)
  app.on('will-quit', () => {
    updateBridge?.dispose()
    updateSchedule.dispose()
    powerMonitor.off('resume', automaticCheck)
    updates.dispose()
    // AI Shell distribution (deeplink host delivery): the socket fast path
    // listener dies with the app (the helper's next connect falls to its
    // spawn fallback — which IS the retry, by design).
    void disposeDeepLinkSocket()
  })

  const applicationIconPath = development ? join(app.getAppPath(), 'resources', 'icon-windows.png')
    : join(process.resourcesPath, 'icon.png')
  app.setAboutPanelOptions({
    applicationName: 'AI Shell',
    applicationVersion: app.getVersion(),
    // The release has no separate build number; omit Electron's bundle version.
    version: '',
    copyright: '',
    iconPath: applicationIconPath,
  })
  // A custom application menu replaces Electron's default menu, so macOS needs
  // its standard menus and application hide commands declared explicitly.
  // Keep app.name stable: Electron derives its default userData directory from it.
  const darwin = process.platform === 'darwin'
  // A copy of Electron 44's macOS Edit menu that binds Paste and Match Style to Shift+Command+V
  // (#7782) and keeps Electron's Option+Shift+Command+V as a hidden alias.
  const macEditMenu = (messages: DesktopMessages): MenuItemConstructorOptions => ({ role: 'editMenu', submenu: [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'pasteAndMatchStyle', accelerator: 'Shift+Command+V' },
    { role: 'pasteAndMatchStyle', accelerator: 'Option+Shift+Command+V', visible: false, acceleratorWorksWhenHidden: true },
    { role: 'delete' },
    { role: 'selectAll' },
    { type: 'separator' },
    { label: messages.substitutionsMenu, submenu: [
      { role: 'showSubstitutions' },
      { type: 'separator' },
      { role: 'toggleSmartQuotes' },
      { role: 'toggleSmartDashes' },
      { role: 'toggleTextReplacement' },
    ] },
    { label: messages.speechMenu, submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] },
  ] })
  const platformMenus = (): MenuItemConstructorOptions[] => darwin
    ? [shortcuts.fileMenu(currentDesktopLocale().messages), macEditMenu(currentDesktopLocale().messages), { role: 'windowMenu' }]
    : [{ role: 'editMenu' }]
  const hideCommands: MenuItemConstructorOptions[] = darwin
    ? [{ role: 'hide', label: currentDesktopLocale().messages.hideApplication },
      { role: 'hideOthers', label: currentDesktopLocale().messages.hideOtherApplications },
      { role: 'unhide', label: currentDesktopLocale().messages.showAllApplications }, { type: 'separator' }]
    : []
  const applicationItems = (): MenuItemConstructorOptions[] => [
    // AI Shell distribution (D15 rev12): the About item routes to the dist's
    // own dialog on every platform - the macOS system panel (role 'about')
    // reports the asar's base version, not the distribution's. macOS keeps
    // its system panel aligned via setAboutPanelOptions for other triggers.
    { label: currentDesktopLocale().messages.aboutMenu,
      click: () => { void showAbout().catch((error: unknown) => { console.error(error) }) } },
    { type: 'separator' },
    // AI Shell distribution (D14 rev5): packaged builds route the item to the
    // first-party updater (async, off the click path — the ASYNC LAW note on
    // checkAishellUpdates); dev runs keep the official prompt, stock.
    { label: currentDesktopLocale().messages.checkUpdatesMenu, click: () => { void (existsSync(join(process.resourcesPath, 'aishell-update', 'aishell-update.mjs'))
      ? checkAishellUpdates()
      : openUpdatePrompt(true)) } },
    // AI Shell distribution (aishell command): the upstream "Manage dsh
    // Command…" menu item is removed on every platform — the dist installs
    // the `aishell` command itself (NSIS PATH entry on Windows, install.sh
    // symlink on Linux and macOS) and never routes through the upstream
    // command-manager, whose macOS contract manages `dsh` for the official
    // desktop. The manager instance stays wired for update coordination.
    { type: 'separator' },
    ...development ? [
      { label: currentDesktopLocale().messages.reloadPageMenu, role: 'reload' as const },
      { label: currentDesktopLocale().messages.restartAppHostMenu, click: () => {
        if (quitting) return
        app.relaunch()
        quitWithoutConfirmation()
      } },
    ] : [],
    { role: 'toggleDevTools', label: currentDesktopLocale().messages.toggleDevToolsMenu },
    { type: 'separator' },
    ...hideCommands,
    { role: 'quit', ...(darwin ? { label: currentDesktopLocale().messages.quitApplication }
      : { label: currentDesktopLocale().messages.exitApplication }) },
  ]
  const devToolsF12Shortcut: MenuItemConstructorOptions = { role: 'toggleDevTools', visible: false, accelerator: 'F12' }
  const windowsDevToolsShortcuts: MenuItemConstructorOptions[] = [
    { role: 'toggleDevTools', visible: false },
    devToolsF12Shortcut,
  ]
  const refreshApplicationMenu = (): void => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(selfDrawnChrome()
      ? windowsDevToolsShortcuts : [{
        label: darwin ? app.name : currentDesktopLocale().messages.application,
        submenu: [...applicationItems(), devToolsF12Shortcut],
      }, ...platformMenus()]))
    tray?.relabel()
  }
  refreshApplicationMenu()
  const trayIconPath = development ? join(app.getAppPath(), 'resources', 'tray-windows.ico') : join(process.resourcesPath, 'tray.ico')
  if (process.platform === 'win32') {
    // The tray is the way back to a hidden window; without it, relaunching the application still focuses it.
    try {
      tray = new DesktopTray({ iconPath: trayIconPath, locale: currentDesktopLocale,
        open: () => { focusPrimaryWindow() }, quit: () => { app.quit() } })
    } catch (error) { console.warn('desktop tray: unavailable', error) }
  }
  const backgroundNotice = process.platform === 'win32'
    ? new DesktopBackgroundNotice({ markerPath: join(app.getPath('userData'), 'background-close-confirmed'),
      locale: () => locale, show: ordinaryMessageBox, focus: () => { updateDialog.focus() } })
    : undefined
  const quitConfirmation = new DesktopQuitConfirmation({
    locale: () => locale,
    inspect: () => backend.host?.inspectQuit(),
    // No owner window: a hidden window stays hidden and the native box is its own top-level window.
    show: options => dialog.showMessageBox(options),
    // macOS raises the open alert with the application; Electron exposes no handle to the Windows task
    // dialog, so a repeated request there only joins the open decision.
    focus: () => { if (process.platform === 'darwin') app.focus({ steal: true }) },
    // The task dialog draws its main icon at the system icon size; the multi-size ICO yields that
    // size directly, where the 1024 px PNG would be scaled down by GDI.
    ...(process.platform === 'win32' ? { icon: nativeImage.createFromPath(trayIconPath) } : {}),
  })

  if (selfDrawnChrome()) {
    ipcMain.handle(DESKTOP_IPC.windowsMenu, (event, name: unknown, x: unknown, y: unknown) => {
      assertDesktopSender(event, ['app'])
      if (mainWindow === undefined || event.sender !== mainWindow.webContents
        || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('desktop menu: rejected sender')
      if ((name !== 'application' && name !== 'edit')
        || typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)
        || x < 0 || y < 0 || x > 100_000 || y > 100_000) throw new Error('desktop menu: invalid popup request')
      const window = mainWindow
      // Editor-owned history listens to key events rather than Chromium's native undo stack.
      const editItem = (label: string, keyCode: string, modifiers: Array<'control'>, accelerator?: string): MenuItemConstructorOptions => ({
        label,
        ...(accelerator === undefined ? {} : { accelerator }),
        click: () => {
          shortcuts.sendEditingKey(keyCode, modifiers)
        },
      })
      const items: MenuItemConstructorOptions[] = name === 'application' ? applicationItems() : [
        editItem(currentDesktopLocale().messages.undo, 'Z', ['control'], 'Ctrl+Z'),
        editItem(currentDesktopLocale().messages.redo, 'Y', ['control'], 'Ctrl+Y'),
        { type: 'separator' },
        editItem(currentDesktopLocale().messages.cut, 'X', ['control'], 'Ctrl+X'),
        editItem(currentDesktopLocale().messages.copy, 'C', ['control'], 'Ctrl+C'),
        editItem(currentDesktopLocale().messages.paste, 'V', ['control'], 'Ctrl+V'),
        editItem(currentDesktopLocale().messages.delete, 'Delete', []),
        { type: 'separator' },
        editItem(currentDesktopLocale().messages.selectAll, 'A', ['control'], 'Ctrl+A'),
      ]
      const zoom = mainWindow.webContents.getZoomFactor()
      return new Promise<void>((resolve) => {
        Menu.buildFromTemplate(items).popup({ window, x: Math.round(x * zoom), y: Math.round(y * zoom), callback: resolve })
      })
    })
    ipcMain.on(DESKTOP_IPC.windowsAppearance, (event, _language: unknown, color: unknown, symbolColor: unknown) => {
      if (mainWindow === undefined || event.sender !== mainWindow.webContents
        || event.senderFrame !== mainWindow.webContents.mainFrame) return
      if (!event.senderFrame.url.startsWith(`${SCHEME}://app/`)) return
      // Document lang starts as English before Host locale bootstrap; only localeChanged owns shell language.
      // Empty colors precede client stylesheet installation; only CSS color values cross IPC.
      const validColor = (value: unknown): value is string => typeof value === 'string'
        && /^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/iu.test(value)
      if (validColor(color) && validColor(symbolColor)) mainWindow.setTitleBarOverlay({ color, symbolColor })
    })
  }

  const hideMainWindow = (window: BrowserWindow): void => {
    if (process.platform === 'darwin' && window.isFullScreen()) {
      // Hiding a fullscreen window leaves an empty black space; leave fullscreen first.
      window.once('leave-full-screen', () => { if (!window.isDestroyed()) window.hide() })
      window.setFullScreen(false)
    } else {
      window.hide()
    }
  }
  const createMainWindow = (): BrowserWindow => {
    const window = createWindow(appPreload, false, true)
    mainWindow = window
    browserGuests.bind(window, (guest, name) => shortcuts.attachGuest(window, guest, name))
    shortcuts.attach(window)
    window.on('focus', automaticCheck)
    // Closing hides: the page and the Host keep running, and the next show resumes the same document.
    // AI Shell distribution (D17): on Linux, closing the window exits — the
    // official close-to-background design has no return channel there (the
    // tray and the background notice are win32-only, the Dock is darwin-only),
    // so a hidden window read as a dead window with resident processes. The
    // quit routes through the application's own quit chain, so the task
    // confirmation (active or scheduled work) still asks before stopping.
    // Windows and macOS keep the official semantics unchanged.
    window.on('close', (event) => {
      if (quitting || shellInstallerOwnsQuit || sessionEnding) return
      if (process.platform === 'linux') { app.quit(); return }
      event.preventDefault()
      if (updateDialog.isOpen) { updateDialog.focus(); return }
      const hide = (): void => {
        if (!quitting && !shellInstallerOwnsQuit && !sessionEnding && !window.isDestroyed()) hideMainWindow(window)
      }
      if (backgroundNotice === undefined) hide()
      else backgroundNotice.close(hide)
    })
    if (process.platform === 'win32') {
      // Shutdown, restart, and log-off must not wait on a confirmation. query-session-end is only a
      // question that another application can veto without any follow-up message, so it does not count.
      window.on('session-end', () => { sessionEnding = true })
    } else {
      // The macOS power-off notification arrives before the terminate request; a cancelled shutdown
      // leaves the process running, and user attention on the window shows the session continues.
      window.on('focus', () => { sessionEnding = false })
      window.on('show', () => { sessionEnding = false })
    }
    window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
    window.webContents.on('console-message', (details) => {
      if (details.level !== 'error') return
      rendererConsole.push(`${details.sourceId}:${String(details.lineNumber)} ${details.message}`)
    })
    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3 && !quitting && !window.isDestroyed()) {
        reportFatal(new Error(`Desktop page failed to load: ${url} (${String(code)}: ${description})`), 'renderer')
      }
    })
    window.webContents.on('preload-error', (_event, _path, error) => {
      if (!quitting && !window.isDestroyed()) reportFatal(error, 'renderer')
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      navigation = undefined
      if (!quitting && !window.isDestroyed() && details.reason !== 'clean-exit') {
        reportFatal(new Error(`Desktop renderer exited: ${details.reason}`), 'renderer')
      }
    })
    return window
  }
  const enterWorkspace = async ({ activate = true }: { activate?: boolean } = {}): Promise<void> => {
    if (quitting) return
    const window = mainWindow ?? createMainWindow()
    await navigateMain(applicationUrl)
    if (isQuitting() || recovery.active || window.isDestroyed()) return
    if (process.platform === 'win32') window.setBackgroundColor(chromeFallbackFill())
    if (activate) window.show()
    else window.showInactive()
    enteredWorkspace = true
    if (welcomeWindow !== undefined) {
      welcomeWindow.close()
      window.webContents.send(DESKTOP_IPC.enterWorkspace)
    }
    welcomeWindow = undefined
    if (raiseAfterUpdate) {
      raiseAfterUpdate = false
      window.moveTop()
      window.focus()
    }
    if (activate && development && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== '0') {
      window.webContents.openDevTools({ mode: 'detach' })
    }
  }
  let openingWelcome: Promise<void> | undefined
  const showWelcome = (): Promise<void> => {
    if (quitting) return Promise.resolve()
    if (welcomeWindow !== undefined && !welcomeWindow.isDestroyed()) {
      if (!welcomeWindow.isVisible()) void track('auth_page_view', {})
      welcomeWindow.show()
      welcomeWindow.focus()
      return Promise.resolve()
    }
    openingWelcome ??= (async () => {
      welcomeWindow = await openWelcomeWindow(locale, {
        analytics: track,
        analyticsEnabled: () => Promise.resolve(analyticsEnabled),
        takeNotice: () => {
          const notice = pendingWelcomeNotice
          pendingWelcomeNotice = undefined
          return Promise.resolve(notice)
        },
        startSignIn: async () => {
          if (welcomeBackend === undefined) throw new Error('desktop welcome: backend unavailable')
          return welcomeBackend.account.start(desktopClientMetadata(locale.id))
        },
        cancelSignIn: async (id) => {
          if (welcomeBackend === undefined) throw new Error('desktop welcome: backend unavailable')
          return welcomeBackend.account.cancel(id)
        },
        copySignInLink: async (id) => {
          const state = await welcomeBackend?.account.state()
          if (state?.attempt?.id !== id || state.attempt.phase !== 'waiting-browser' || state.attempt.authorizeUrl === undefined) {
            throw new Error('desktop welcome: login link is unavailable')
          }
          await clipboard.writeText(platformLoginUrl(state.attempt.authorizeUrl))
        },
        saveApiKey: async (apiKey) => {
          if (backend.host === undefined || welcomeBackend === undefined) return { ok: false }
          const saved = await welcomeBackend.save(apiKey)
          if (!saved.ok) return saved
          await enterWorkspace()
          return { ok: true }
        },
        skip: enterWorkspace,
      })
      const window = welcomeWindow
      window.once('closed', () => {
        void welcomeBackend?.account.state().then((state) => {
          if (state.attempt !== null && !enteredWorkspace) return welcomeBackend?.account.cancel(state.attempt.id)
          return undefined
        }).catch(() => undefined)
      })
      window.once('closed', () => {
        if (welcomeWindow === window) welcomeWindow = undefined
        if (enteredWorkspace || recovery.active) return
        // Nothing runs before the workspace opens. macOS keeps the Dock convention and drops the
        // unused main window so the next activation rebuilds the welcome; elsewhere the close quits.
        if (process.platform === 'darwin') mainWindow?.destroy()
        else app.quit()
      })
      if (isQuitting() || recovery.active || enteredWorkspace) window.close()
      else mainWindow?.hide()
    })().finally(() => { openingWelcome = undefined })
    return openingWelcome
  }
  const openInitialWindow = async (): Promise<void> => {
    if (quitting || recovery.active) return
    const state = await readWelcomeState()
    if (isQuitting() || backend.state.phase !== 'ready') return
    nativeTheme.themeSource = state.themePreference
    locale = resolveDesktopStartupLocale(state.localePreference, systemLanguages)
    writeDesktopLocaleCache(app.getPath('userData'), locale.id)
    windowsLanguage = locale.id
    refreshApplicationMenu()
    if (!enteredWorkspace && needsWelcome({ loggedIn: state.loggedIn, hasApiKey: state.hasApiKey })) {
      // A later login must retain its own activation policy instead of replaying startup focus.
      raiseAfterUpdate = false
      await showWelcome()
    } else {
      await enterWorkspace()
    }
  }
  // The `force` parameter is the deep-link summon semantics: a link click is
  // an explicit user action on content the user already chose to see, so the
  // no-peek guard below must not apply. The found case: a fresh install whose
  // credential state left `enteredWorkspace` false while the window is fully
  // visible — every warm deep link silently skipped focus (the field report
  // behind the t023test.3 round). Callers reflecting the user's own
  // navigation (menu, tray, second-instance without a URL) keep the guard.
  focusPrimaryWindow = (force = false) => {
    if (quitting) return
    if (isMandatory()) { mandatoryUI?.focus(); return }
    const window = welcomeWindow ?? mainWindow
    if (window === undefined || window.isDestroyed()) {
      try { createMainWindow() } catch (error) { reportFatal(error, 'main'); return }
      void (backend.state.phase === 'ready' ? openInitialWindow() : navigateMain(applicationUrl)).catch((error: unknown) => { reportFatal(error, 'main') })
      return
    }
    // Startup and sign-out select the visible window before activation may reveal the workspace.
    // A deep-link delivery is the user's own summon (force): raise regardless.
    if (!force && window === mainWindow && !enteredWorkspace) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  // AI Shell distribution: register "aishell://" instead of "dsh://" so each
  // app owns its own Windows URL-handler registry entry (HKCR\aishell vs
  // HKCR\dsh). Sharing "dsh://" caused last-installed-wins overwrite and
  // cross-app open-url races when the official DSH desktop and AI Shell
  // coexist on one machine.
  // AI Shell distribution (deeplink host delivery): registration authority
  // (design §10.1 frozen ruling) — packaged LINUX does NOT call this: the
  // install.sh URL-handler .desktop entry (Exec → the socket helper) is the
  // only authority there, and Electron's runtime registration would steal
  // the xdg default back to the bare binary on every app start, silently
  // degrading the socket fast path to the slow spawn-a-second-Electron
  // path. Dev-mode, mac, and win keep the runtime registration (with the
  // exec args the OS appends when invoking for a URL — without them Linux
  // never sees the URL on the command line).
  // The open-url listener itself moved to module scope under
  // will-finish-launching (macOS delivers URLs as early events).
  const packagedLinux = process.platform === 'linux' && app.isPackaged
  if (!packagedLinux && (app.isPackaged || process.env.DSH_DESKTOP_DEV_APP === '1')) {
    app.setAsDefaultProtocolClient(AISHELL_DEEPLINK_SCHEME, process.execPath, ['--open-url', '--'])
  }
  // AI Shell distribution (deeplink host delivery, contract §12 adopted):
  // the Linux-packaged socket fast path. The URL-handler helper connects to
  // $XDG_RUNTIME_DIR/aishell-deeplink.sock and writes one `aishell://…\n`
  // line per delivery — warm clicks never spawn a second Electron process.
  // Bound in the owner process only (the single-instance lock was claimed
  // at module scope, before main() ran); every failure path logs and skips
  // (the argv fallback still delivers). Unlink-before-bind handles a stale
  // file from a SIGKILLed owner; EADDRINUSE after unlink is a live
  // different-owner edge — log + skip listening.
  if (packagedLinux) {
    // Focus-then-deliver (contract §5.3's second-instance semantics carried
    // into the socket fast path): a warm click means the person acted on a
    // link OUTSIDE this app — the window must rise with the delivery, or
    // the preview modal lands behind the browser that dispatched the click
    // (VM field finding: delivered but buried). The spawn fallback (the
    // second-instance path) already focuses; this is the fast path's own
    // hop, so the focus lives here.
    const socket = new DeepLinkSocketListener((url) => { focusPrimaryWindow(true); deliverDeepLink(url) }, realSocketPlatform())
    void socket.listen().catch((error: unknown) => {
      console.warn(`aishell deeplink socket: listener failed (${error instanceof Error ? error.message : String(error)}) — skipping (argv fallback still delivers)`)
    })
    const previousDispose = disposeDeepLinkSocket
    disposeDeepLinkSocket = async () => { await previousDispose(); await socket.dispose() }
  }

  app.on('activate', (_event, hasVisibleWindows) => {
    if (!hasVisibleWindows) focusPrimaryWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  if (process.platform !== 'win32') powerMonitor.on('shutdown', () => { sessionEnding = true })
  const finishQuit = (): void => {
    quitting = true
    shuttingDown = true
    updateJournal?.action('quit-requested')
    quitConfirmation.dispose()
    backgroundNotice?.dispose()
    tray?.dispose()
    stopAccount?.()
    if (welcomeWindow !== undefined && !welcomeWindow.isDestroyed()) welcomeWindow.hide()
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.hide()
    updateSchedule.dispose()
    updateDialog.dispose()
    mandatoryUI?.dispose()
    void Promise.all([stopOperationReports(), Promise.resolve(mandatoryPolicy?.dispose()).then(() => policyAuth?.dispose()),
      backend.close().then(async () => { await operationJournal?.drain(500) }, async (error: unknown) => {
        await operationJournal?.drain(500)
        throw error
      }),
      platformView.dispose(),
      disposeFileDrag(),
    ].map(cleanup => cleanup.catch((error: unknown) => { console.error(error) })))
      .then(() => { app.quit() })
  }
  app.on('before-quit', (event) => {
    if (shellInstallerOwnsQuit) {
      shuttingDown = true
      quitConfirmation.dispose()
      backgroundNotice?.dispose()
      updateJournal?.action('quit-requested')
      tray?.dispose()
      updateDialog.dispose()
      mandatoryUI?.dispose()
      // Installation preparation already awaited Platform storage cleanup.
      void platformView.dispose().catch((error: unknown) => { console.error(error) })
      return
    }
    if (quitting) return
    event.preventDefault()
    if (skipQuitConfirmation || sessionEnding) { finishQuit(); return }
    void quitConfirmation.confirm().then((approved) => {
      if (quitting || shellInstallerOwnsQuit) return
      if (approved) { finishQuit(); return }
      // A quit that started from closing the welcome window destroyed it; a cancelled quit needs it back.
      if (!enteredWorkspace && !recovery.active) void showWelcome().catch((error: unknown) => { reportFatal(error, 'main') })
    }).catch((error: unknown) => { console.error(error); if (!quitting && !shellInstallerOwnsQuit) finishQuit() })
  })

  mainWindow = createMainWindow()
  if (typeof manifest !== 'object' || manifest === null) throw new Error('desktop policy: invalid application manifest')
  const developmentPolicy = app.isPackaged ? undefined : process.env.DSH_DESKTOP_MANDATORY_UPDATE_CONFIG
  const policyInput: unknown = app.isPackaged
    ? ('dshMandatoryUpdatePolicy' in manifest ? manifest.dshMandatoryUpdatePolicy : undefined)
    : developmentPolicy === undefined ? undefined : JSON.parse(developmentPolicy) as unknown
  const policyConfig = resolveDesktopPolicyConfig(policyInput, !app.isPackaged)
  if (policyConfig !== undefined) {
    if (policyConfig.authentication === 'feishu-test') {
      policyAuth = new DesktopPolicyTestAuth(policyConfig.origin, policyConfig.allowedAuthOrigins, locale,
        () => mandatoryUI?.confirmationWindow ?? currentDialogWindow(),
        (event) => { console.info(`desktop policy authentication: ${event}`); updateJournal?.action(`policy-login-${event}`) })
    }
    if (!['win32', 'darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('desktop policy: unsupported platform')
    let wasBlocking = false
    mandatoryPolicy = new DesktopMandatoryUpdatePolicy(policyConfig, {
      platform: process.platform as 'win32' | 'darwin' | 'linux', arch: process.arch as 'x64' | 'arm64',
      get channel() { return updates.selectedChannel },
      bundledDshVersion: app.isPackaged ? readDesktopRuntime(resources.dsh).release.version : app.getVersion(),
    }, (state) => {
      if (state.error !== 'authentication-required') policyAuthenticationQueued = false
      if (state.blocking) {
        for (const controller of ordinaryDialogs) controller.abort()
        if (!wasBlocking) updateDialog.cancel()
      }
      mandatoryUI?.sync()
      if (state.blocking && !wasBlocking) void updateSchedule.check(false, true).catch((error: unknown) => { console.error(error) })
      wasBlocking = state.blocking
    }, policyAuth?.request, () => desktopClientMetadata(locale.id))
    const policy = mandatoryPolicy
    mandatoryUI = new DesktopMandatoryUpdateWindow({
      overlays: updateOverlays,
      preload: fileURLToPath(new URL('./preload-mandatory.cjs', import.meta.url)), locale,
      allowedPageOrigins: policyConfig.allowedPageOrigins, parent: () => mainWindow,
      policy: () => policy.state, update: () => updates.state,
      refresh: async () => {
        if (channelState?.error !== undefined) await showConfigurationError()
        if (channelState?.error === undefined) await Promise.all([checkPolicyManually(), updateSchedule.check(true)])
      },
      download: downloadUpdate, install: version => updates.install(version),
    })
    void mandatoryPolicy.check('launch').then((state) => {
      if (app.isPackaged && state.error === 'authentication-required' && !isQuitting()) queuePolicyAuthentication()
    }).catch((error: unknown) => { console.error(error) })
  }
  automaticCheck()
  await reconcileBackend().catch(() => undefined)
  // Window lifecycle callbacks run while backend startup is pending.
  if (isQuitting()) return
  const window = currentMainWindow()
  if (window !== undefined && development && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== '0') {
    window.webContents.openDevTools({ mode: 'detach' })
  }
  // AI Shell distribution (D19): with the bridge active, the bridge state
  // IS the update state - republish it so late-attaching windows see the
  // startup check's verdict rather than a stale idle.
  if (updateBridge !== undefined) publishUpdate(updateBridge.status)
  publishUpdate(updateState)
}

// AI Shell distribution: claim a single-instance lock key distinct from the
// official DSH desktop app. Electron's requestSingleInstanceLock keys on
// app.name, which defaults to package.json's "name" — identical
// ("@deepseek-ai/dsh-desktop") across the official and AI Shell builds.
// Without this, the app that starts second sees the first's lock and
// silently quits. Set at module top level before the lock claim below;
// main() runs too late (after whenReady). Mirrors the upstream dev build's
// per-bundle CFBundleIdentifier (development-app.ts) for the same reason.
app.setName('AI Shell')

// AI Shell distribution (linux-support): pin the display backend to X11.
// The 0.2.2-rc.3 base's Chromium auto-selects native Wayland whenever
// WAYLAND_DISPLAY is set, and under GNOME Wayland mutter rejects an
// application's own window-activation requests (window.show()/focus() are
// silently ignored — no xdg-activation token is honored by this Electron
// for the deep-link summon, the menu raise, or the update dialogs), so a
// link click delivered the preview behind the browser with the app never
// coming forward (VM field finding on 0.0.3-test.2: healthy process +
// socket + Host, zero focus). XWayland is the display mode every released
// build and the whole verify battery run under — pin it back. Revisit when
// Electron honors xdg-activation for focus (then native Wayland may return
// with a real focus audit).
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11')

// AI Shell distribution (deeplink host delivery, contract §5.3): macOS
// delivers URLs as `open-url` events that may fire BEFORE ready — the
// listener must exist during launch, not inside main() (which runs after
// whenReady and loses early events). `will-finish-launching` is the
// documented early window; registration happens at module scope, before the
// single-instance claim below. `aishell://open` keeps its focus-only
// behavior (D1 ruling: dead code — login is blocked, no live producer;
// revisit only if login returns). Every OTHER aishell:// URL is delivered
// unmodified (the legacy literal check is a string comparison, not a parse).
app.on('will-finish-launching', () => {
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (isOpenLiteral(url)) focusPrimaryWindow()
    else if (url.startsWith(`${AISHELL_DEEPLINK_SCHEME}://`)) { focusPrimaryWindow(true); deliverDeepLink(url) }
  })
})
// Cold start: the URL is in this process's own argv (every platform).
// Scanned once, early — the hub stashes it until the Host child is ready.
{
  const initialUrl = findDeepLink(process.argv)
  if (initialUrl !== undefined && !isOpenLiteral(initialUrl)) deliverDeepLink(initialUrl)
}

const ownsDesktopInstance = claimDesktopSingleInstance(app, (argv) => {
  focusPrimaryWindow()
  // AI Shell distribution (deeplink host delivery): the later launch's argv
  // carries the URL (Linux/Windows second-instance path — the fallback for
  // the cold-start race window: lock taken, socket not yet bound, helper's
  // spawn path lands here). Scan and deliver; the string is never parsed.
  const url = findDeepLink(argv)
  if (url !== undefined) deliverDeepLink(url)
})

if (ownsDesktopInstance) void app.whenReady().then(main).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(error)
  const diagnosticFile = process.env.DSH_DESKTOP_DIAGNOSTIC_FILE
  if (diagnosticFile !== undefined) {
    await writeFile(diagnosticFile, `${error instanceof Error ? error.stack ?? message : message}\n`).catch(() => undefined)
  }
  reportFatal(error, 'main')
}).catch(async (error: unknown) => {
  console.error(error)
  shuttingDown = true
  await stopOperationReports()
  app.exit(1)
})
