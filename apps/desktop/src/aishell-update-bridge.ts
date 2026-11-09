/** AI Shell distribution (settings-update-button): the first-party updater drives the official update indicator. */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DesktopUpdateState } from './ipc.ts'

/** Check result of the update module's `check --json --force` invocation. */
export interface AishellCheckResult {
  readonly version: string
  readonly update: { version: string, url?: string, sha256?: string } | null
  readonly error: string | null
}

/** One NDJSON progress line from the download child's fd 3. */
export interface AishellProgressLine {
  readonly received?: number
  readonly total?: number
  readonly percent?: number
  readonly done?: boolean
}

/** Injection surface for tests: process operations the bridge needs. */
export interface AishellUpdatePlatform {
  readonly platform: string
  readonly resourcesPath: string
  readonly execPath: string
  /**
   * Spawn the update module in node mode; replaceable in tests. The handle
   * resolves with the exit code and collected stdout; kill() cancels the
   * child (the download SIGTERM law: quitting the app cancels an in-flight
   * download, and the module's signal handler removes its .part).
   */
  spawnUpdate(args: readonly string[], onProgress: (line: AishellProgressLine) => void, onStdout: (text: string) => void): { promise: Promise<{ code: number | null, stdout: string }>, kill(): void }
  /** Spawn the packaged upgrade launcher detached; replaceable in tests. */
  spawnLauncher(launcherPath: string): { pid: number | undefined }
  /** Sleep; replaceable in tests. */
  delay(ms: number): Promise<void>
  /** Read the installed version file; replaceable in tests. */
  readLocalVersion(): string
  /** Read the staged ready.json, or undefined when absent/corrupt; replaceable in tests. */
  readStaging(): { version: string, file: string, sha256?: string } | undefined
  /** Whether the staged artifact file exists; replaceable in tests. */
  stagedArtifactExists(staging: { file: string }): boolean
  /** Remove the staging directory; replaceable in tests. */
  clearStaging(): void
}

/** The real process surface: node-mode update module, detached launcher, install-root state. */
export const aishellPlatform = (resourcesPath: string, execPath: string): AishellUpdatePlatform => {
  const stagingDir = join(resourcesPath, '..', '..', '.aishell-update', 'download')
  const spawnUpdate = (args: readonly string[], onProgress: (line: AishellProgressLine) => void, onStdout: (text: string) => void) => {
    // fd 3 is the progress channel (the module's --progress-fd contract):
    // kept off stdout so the check's JSON never mixes with progress lines.
    const child = spawn(execPath, ['--expose-internals', join(resourcesPath, 'aishell-update', 'aishell-update.mjs'), ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); onStdout(chunk.toString('utf8')) })
    child.stdio?.[3]?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line === '') continue
        try { onProgress(JSON.parse(line) as AishellProgressLine) } catch { /* garbage line: ignore (fail-open) */ }
      }
    })
    return {
      promise: new Promise<{ code: number | null, stdout: string }>(resolve => {
        child.on('error', () => resolve({ code: 1, stdout: out }))
        child.on('close', (code: number | null) => resolve({ code, stdout: out }))
      }),
      kill: () => { try { child.kill('SIGTERM') } catch { /* already gone */ } },
    }
  }
  return {
    platform: process.platform,
    resourcesPath,
    execPath,
    spawnUpdate,
    spawnLauncher: launcherPath => {
      // The ready-dialog's install action: detached, stdio inherited (the
      // wrapper terminal keeps the chain's progress), ACK pre-authorized
      // (the click IS the consent to close), wrapper marker stripped so an
      // app-initiated chain does not skip its own relaunch.
      const child = spawn(launcherPath, ['upgrade'], {
        detached: true, stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, AISHELL_UPGRADE_ACK: '1', AISHELL_FROM_WRAPPER: undefined },
      })
      child.unref()
      return { pid: child.pid }
    },
    delay: (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) }),
    readLocalVersion: () => readFileSync(join(resourcesPath, 'aishell-version'), 'utf8').trim(),
    readStaging: () => {
      try {
        const parsed = JSON.parse(readFileSync(join(stagingDir, 'ready.json'), 'utf8')) as { version?: string, file?: string, sha256?: string }
        if (typeof parsed.version === 'string' && parsed.version !== '' && typeof parsed.file === 'string' && parsed.file !== '') {
          return { version: parsed.version, file: parsed.file, ...(parsed.sha256 === undefined ? {} : { sha256: parsed.sha256 }) }
        }
        return undefined
      } catch { return undefined }
    },
    stagedArtifactExists: staging => existsSync(join(stagingDir, staging.file)),
    clearStaging: () => { try { rmSync(stagingDir, { recursive: true, force: true }) } catch { /* best-effort */ } },
  }
}

const BUSY_PHASES: ReadonlySet<DesktopUpdateState['phase']> = new Set(['checking', 'downloading', 'verifying', 'installing'])

/**
 * Background-trigger (focus/timer) minimum spacing. The module's own cache
 * TTL gates the network ask; this gates the PHASE FLIP. A short floor keeps
 * discovery snappy (a genuinely new focus after 60s may check) while a
 * dialog-close burst (sub-second) can never flip the button.
 */
const BACKGROUND_CHECK_MIN_INTERVAL_MS = 60_000
const NETWORK_WORDS = /\b(?:ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network|timeout|aborted)\b/iu

/**
 * Bridge the first-party updater (resources/aishell-update) into the official
 * update-indicator protocol. Owns the phase machine, the background schedule,
 * the staging lifecycle, and the busy/once installation guards; publishes
 * through the injected publisher (single-writer law: while the bridge is
 * active the official electron-updater coordinator stays idle — no packaged
 * app-update.yml exists in this distribution).
 *
 * Failure-invariant law: the bridge is fail-open. Every async operation is
 * wrapped; a bridge defect degrades to "the button disappears", never to a
 * dead app. Background check failures stay silent (phase unchanged); only
 * user-initiated opens surface error phases.
 */
export class AishellUpdateBridge {
  private state: DesktopUpdateState = { phase: 'idle' }
  private disposed = false
  /**
   * Monotonic deadline for the NEXT background check (focus/timer triggers).
   * The official schedule's law: unforced checks are throttled by a deadline
   * so a burst of window-focus events (every dialog close fires one) cannot
   * flip the phase machine at event rate. Manual opens bypass it.
   */
  private nextBackgroundCheckAt = -Infinity
  private checkOperation: Promise<void> | undefined
  private downloadKill: (() => void) | undefined
  private installSpawned = false
  private readonly timer: ReturnType<typeof setInterval> | undefined
  private resumed = false

  /**
   * @param publish - State change publisher (the main publishUpdate seam).
   * @param platform - Process operations; inject fakes in tests.
   * @param enabled - Whether this install carries the first-party updater.
   * @param checkIntervalMs - Background cadence; the first check runs immediately (startup), later ones ride the module's cache TTL.
   * @param confirmInstall - The ready confirmation surface (the official updateDialog with the official ready copy); resolves true only on the explicit install choice. X/Esc/replacement resolve false (the nonexistent-cancelId law) — no install, state stays ready, a later click re-asks.
   */
  constructor(
    private readonly publish: (state: DesktopUpdateState) => void,
    private readonly platform: AishellUpdatePlatform,
    private readonly enabled: boolean,
    checkIntervalMs: number,
    private readonly confirm: (version: string) => Promise<boolean> = async () => true,
  ) {
    if (enabled) {
      this.timer = setInterval(() => { void this.backgroundCheck().catch(() => { /* fail-open */ }) }, checkIntervalMs)
      this.timer.unref()
    }
  }

  /** Latest observable state; the web queries this through updatesStatus. */
  get status(): DesktopUpdateState { return this.state }

  /**
   * The user opened the update surface (button click / menu / updatesOpen).
   * Busy phases ignore the click (the web guards too — this is the
   * main-process defense against stale or concurrent IPC).
   */
  open(): void {
    if (this.disposed || !this.enabled) return
    if (BUSY_PHASES.has(this.state.phase)) return
    switch (this.state.phase) {
      case 'available': void this.download().catch(() => { /* fail-open */ }); return
      case 'ready': void this.confirmInstall().catch(() => { /* fail-open */ }); return
      default: void this.runCheck(true).catch(() => { /* fail-open */ })
    }
  }

  /**
   * One background check: silent on failure, never surfaces an error phase.
   * Two anti-flicker laws (field report 2026-10-22: closing the About or
   * Check-for-Updates dialog made the button blink, because the official
   * window-on-focus hook fires on EVERY dialog close):
   * - Known-outcome states (available, ready) hold — the information is
   *   already on screen; re-checking flips checking and back for nothing.
   * - Everything else honors a monotonic deadline — the official schedule's
   *   throttle, ported: an unforced check that lands before the deadline is
   *   a no-op, so focus bursts cannot run the phase machine at event rate.
   *   The 10-minute TIMER arrives past the deadline and checks normally;
   *   manual opens (menu, button) bypass it, exactly as the official
   *   schedule's force flag does.
   */
  async backgroundCheck(): Promise<void> {
    if (this.disposed || !this.enabled) return
    if (BUSY_PHASES.has(this.state.phase) && this.state.phase !== 'checking') return
    if (this.state.phase === 'available' || this.state.phase === 'ready') return
    if (Date.now() < this.nextBackgroundCheckAt) return
    this.nextBackgroundCheckAt = Date.now() + BACKGROUND_CHECK_MIN_INTERVAL_MS
    await this.runCheck(false)
  }

  /** Startup recovery: restore the ready phase from a persisted staging when it still matches the feed. */
  async resume(feedNewer: (candidate: string) => boolean): Promise<void> {
    if (this.disposed || !this.enabled || this.resumed) return
    this.resumed = true
    try {
      const staged = this.platform.readStaging()
      if (staged === undefined) return
      const local = this.platform.readLocalVersion()
      // Ready only when the staged version is strictly newer than the local
      // one AND not older than what the feed offers — otherwise the button
      // would promise a version the install chain would not deliver.
      if (!feedNewer(staged.version) && this.compare(staged.version, local) > 0 && this.platform.stagedArtifactExists(staged)) {
        this.setState({ phase: 'ready', version: staged.version })
      } else {
        // Installed-already or stale: dead weight on disk (~400MB).
        this.platform.clearStaging()
      }
    } catch { /* fail-open: resume is best-effort */ }
  }

  /** Stop the schedule, cancel an in-flight download, and publish nothing further. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.cancelDownload()
  }

  // ---------- internals ----------

  private setState(state: DesktopUpdateState): DesktopUpdateState {
    if (this.disposed) return state
    this.state = state
    this.publish(state)
    return state
  }

  private async runCheck(manual: boolean): Promise<void> {
    this.checkOperation ??= Promise.resolve().then(async () => {
      this.setState({ phase: 'checking' })
      try {
        const { promise } = this.platform.spawnUpdate(['check', '--json', '--force'], () => {}, text => text)
        const { stdout } = await promise
        const result = JSON.parse(stdout) as AishellCheckResult
        if (result.update !== null && typeof result.update.version === 'string') {
          this.setState({ phase: 'available', version: result.update.version })
        } else if (manual && result.error !== null) {
          this.setState(this.failure(new Error(result.error), 'check'))
        } else {
          // No update, or a silent background failure: both are "no news".
          this.setState({ phase: 'idle' })
        }
      } catch (error) {
        if (manual) this.setState(this.failure(error, 'check'))
        else this.setState({ phase: 'idle' })
      } finally {
        this.checkOperation = undefined
      }
    }).catch(() => { /* fail-open */ })
    await this.checkOperation
  }

  private async download(): Promise<void> {
    const version = this.state.version
    if (version === undefined) return
    this.setState({ phase: 'downloading', version, percent: 0 })
    try {
      const handle = this.platform.spawnUpdate(['download', '--progress-fd', '3'],
        line => {
          if (this.disposed) return
          if (line.done === true) { this.setState({ phase: 'verifying', version }); return }
          const percent = line.percent
          if (percent === undefined) { this.setState({ phase: 'downloading', version }); return }
          const clamped = Math.min(100, Math.max(0, Math.floor(percent)))
          if (clamped >= (this.state.percent ?? -1)) this.setState({ phase: 'downloading', version, percent: clamped })
        },
        () => {})
      this.downloadKill = handle.kill
      const { code } = await handle.promise
      this.downloadKill = undefined
      if (this.disposed) return
      if (code === 0) {
        this.setState({ phase: 'ready', version })
        // Official rhythm: the confirmation opens itself when the download
        // lands (the official chain's downloadUpdate ends in install()'s
        // prompt) — the user is already looking at the button they clicked.
        await this.confirmInstall()
      } else this.setState(this.failure(new Error(`update module exited ${code ?? 'by signal'}`), 'download'))
    } catch (error) {
      this.downloadKill = undefined
      this.setState(this.failure(error, 'download'))
    }
  }

  /**
   * The ready confirmation: ask through the injected surface (the official
   * updateDialog, official ready copy, 「安装并重启」), and only an explicit
   * install choice spawns the packaged launcher's upgrade chain — once.
   * X/Esc/replacement declines: no install, the phase returns to ready
   * (the button stays 安装并重启; a later click re-asks, no state damage).
   * The chain closes this app (ACK pre-authorized) and relaunches it; if
   * the chain exits while this app still lives (lock contention, early
   * failure), a check re-runs and the state self-heals.
   */
  private async confirmInstall(): Promise<void> {
    if (this.installSpawned) return
    this.installSpawned = true
    const version = this.state.version
    if (version === undefined) { this.installSpawned = false; return }
    this.setState({ phase: 'installing', version })
    try {
      const agreed = await this.confirm(version)
      if (!agreed) {
        this.installSpawned = false
        this.setState({ phase: 'ready', version })
        return
      }
      const launcher = join(this.platform.resourcesPath, 'aishell-launcher', 'aishell')
      this.platform.spawnLauncher(launcher)
    } catch {
      this.installSpawned = false
      this.setState({ phase: 'ready', version })
      /* fail-open: the next check cycle heals the state */
    }
  }

  private cancelDownload(): void {
    const kill = this.downloadKill
    this.downloadKill = undefined
    if (kill !== undefined) {
      try { kill() } catch { /* already gone */ }
    }
  }

  private failure(error: unknown, failedOperation: 'check' | 'download'): DesktopUpdateState {
    const message = error instanceof Error ? error.message : String(error)
    const network = NETWORK_WORDS.test(message)
    return {
      phase: 'error', failedOperation,
      message: network ? `${failedOperation}-network` : message,
    }
  }

  /** Semver precedence, subset form (release + prerelease identifiers). */
  private compare(a: string, b: string): number {
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
}
