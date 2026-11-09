/** Bridge unit tests: phase machine, concurrency guards, staging recovery, fail-open. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopUpdateState } from '../src/ipc.ts'
import type { AishellCheckResult, AishellProgressLine, AishellUpdatePlatform } from '../src/aishell-update-bridge.ts'

const { AishellUpdateBridge } = await import('../src/aishell-update-bridge.ts')

/** Scripted platform: canned module results, no real processes. */
class FakePlatform implements AishellUpdatePlatform {
  readonly platform = 'linux'
  readonly resourcesPath = '/fake/resources'
  readonly execPath = '/fake/electron'
  checkResult: AishellCheckResult = { version: '0.0.1-alpha.1', update: null, error: null }
  downloadExit = 0
  downloadProgress: readonly AishellProgressLine[] = []
  readonly launches: string[] = []
  killed = false
  localVersion = '0.0.1-alpha.1'
  staging: { version: string, file: string, sha256?: string } | undefined
  stagingArtifactPresent = true
  cleared = false

  spawnUpdate(args: readonly string[], onProgress: (line: AishellProgressLine) => void): { promise: Promise<{ code: number | null, stdout: string }>, kill(): void } {
    if (args[0] === 'check') {
      return {
        promise: Promise.resolve({ code: 0, stdout: JSON.stringify(this.checkResult) }),
        kill: () => { this.killed = true },
      }
    }
    let killed = false
    return {
      promise: (async () => {
        await Promise.resolve()
        for (const line of this.downloadProgress) onProgress(line)
        return { code: killed ? null : this.downloadExit, stdout: '' }
      })(),
      kill: () => { killed = true; this.killed = true },
    }
  }

  spawnLauncher(launcherPath: string): { pid: number | undefined } {
    this.launches.push(launcherPath)
    return { pid: 4242 }
  }

  delay(): Promise<void> { return Promise.resolve() }
  readLocalVersion(): string { return this.localVersion }
  readStaging(): { version: string, file: string, sha256?: string } | undefined { return this.staging }
  stagedArtifactExists(): boolean { return this.stagingArtifactPresent }
  clearStaging(): void { this.cleared = true }
}

/** Recorded publisher for sequence assertions. */
class Recorder {
  readonly states: DesktopUpdateState[] = []
  publish = (state: DesktopUpdateState): void => { this.states.push(state) }
  get last(): DesktopUpdateState { return this.states[this.states.length - 1] ?? { phase: 'idle' } }
  phases(): string[] { return this.states.map(state => state.phase) }
}

afterEach(() => { vi.restoreAllMocks() })

describe('aishell update bridge', () => {
  it('stays idle and silent when not enabled (dev runs are stock)', () => {
    const rec = new Recorder()
    const bridge = new AishellUpdateBridge(rec.publish, new FakePlatform(), false, 60_000)
    bridge.open()
    void bridge.backgroundCheck()
    expect(rec.states).toEqual([])
    expect(bridge.status).toEqual({ phase: 'idle' })
    bridge.dispose()
  })

  it('manual check with an available update reaches available; open then downloads to ready', async () => {
    const rec = new Recorder()
    const platform = new FakePlatform()
    platform.checkResult = { version: '0.0.1-alpha.1', update: { version: '0.0.1-alpha.2' }, error: null }
    platform.downloadProgress = [
      { received: 0, total: 100, percent: 0 },
      { received: 50, total: 100, percent: 50 },
      { done: true },
    ]
    const bridge = new AishellUpdateBridge(rec.publish, platform, true, 600_000)
    bridge.open()
    await vi.waitFor(() => expect(rec.last.phase).toBe('available'))
    bridge.open()
    // Auto-confirm walks ready → installing; ready must have been observed.
    await vi.waitFor(() => expect(rec.last.phase).toBe('installing'))
    expect(rec.phases()).toContain('ready')
    expect(rec.states[rec.phases().lastIndexOf('ready')]?.version).toBe('0.0.1-alpha.2')
    // The auto-confirm (official rhythm: the confirmation opens itself
    // when the download lands) walks on into installing after ready.
    expect(rec.phases()).toEqual(['checking', 'available', 'downloading', 'downloading', 'downloading', 'verifying', 'ready', 'installing'])
    expect(rec.states.find(state => state.phase === 'downloading' && state.percent === 50)).toBeDefined()
    bridge.dispose()
  })

  it('background check failure stays silent; manual surfaces the error phase', async () => {
    const rec = new Recorder()
    const platform = new FakePlatform()
    platform.checkResult = { version: '0.0.1-alpha.1', update: null, error: 'feed HTTP 503' }
    const bridge = new AishellUpdateBridge(rec.publish, platform, true, 600_000)
    await bridge.backgroundCheck()
    expect(rec.last.phase).toBe('idle')
    expect(rec.states.some(state => state.phase === 'error')).toBe(false)
    bridge.open()
    await vi.waitFor(() => expect(rec.last.phase).toBe('error'))
    expect(rec.last.failedOperation).toBe('check')
    bridge.dispose()
  })

  it('available and ready hold against background (focus) triggers — no checking flicker', async () => {
    const rec = new Recorder()
    const platform = new FakePlatform()
    platform.checkResult = { version: '0.0.1-alpha.1', update: { version: '0.0.1-alpha.2' }, error: null }
    const bridge = new AishellUpdateBridge(rec.publish, platform, true, 600_000)
    bridge.open()
    await vi.waitFor(() => expect(rec.last.phase).toBe('available'))
    const phasesBefore = rec.phases().length
    // The official window-on-focus hook fires on every dialog close; a burst
    // of them must not flip the button to checking and back.
    await bridge.backgroundCheck()
    await bridge.backgroundCheck()
    await bridge.backgroundCheck()
    expect(rec.phases()).toHaveLength(phasesBefore) // zero new states
    expect(rec.last.phase).toBe('available')
    bridge.dispose()
  })

  it('idle holds against a focus burst — the deadline throttle bars event-rate flips', async () => {
    const rec = new Recorder()
    const platform = new FakePlatform()
    platform.checkResult = { version: '0.0.1-alpha.1', update: null, error: null }
    const bridge = new AishellUpdateBridge(rec.publish, platform, true, 600_000)
    // First background check runs (past -Infinity deadline): idle, no update.
    await bridge.backgroundCheck()
    const afterFirst = rec.phases().length
    expect(rec.last.phase).toBe('idle')
    // A dialog-close burst (each close = one focus = one backgroundCheck):
    for (let i = 0; i < 5; i++) await bridge.backgroundCheck()
    expect(rec.phases()).toHaveLength(afterFirst) // zero phase flips in the burst
    expect(rec.last.phase).toBe('idle')
    bridge.dispose()
  })

  it('network-worded failures are classified for the official failure-kind picker', async () => {
    const rec = new Recorder()
    const platform = new FakePlatform()
    platform.checkResult = { version: '0.0.1-alpha.1', update: null, error: 'fetch failed: ETIMEDOUT' }
    const bridge = new AishellUpdateBridge(rec.publish, platform, true, 600_000)
    bridge.open()
    await vi.waitFor(() => expect(rec.last.phase).toBe('error'))
    expect(String(rec.last.message)).toMatch(/network|ETIMEDOUT|fetch failed/iu)
    bridge.dispose()
  })

  it('download failure sets the retry phase with failedOperation download', async () => {
    const rec = new Recorder()
    const platform = new FakePlatform()
    platform.checkResult = { version: '0.0.1-alpha.1', update: { version: '0.0.1-alpha.2' }, error: null }
    platform.downloadExit = 1
    const bridge = new AishellUpdateBridge(rec.publish, platform, true, 600_000)
    bridge.open()
    await vi.waitFor(() => expect(rec.last.phase).toBe('available'))
    bridge.open()
    await vi.waitFor(() => expect(rec.last.phase).toBe('error'))
    expect(rec.last.failedOperation).toBe('download')
    bridge.dispose()
  })

  it('install spawns the packaged launcher exactly once; a second ready-confirm does not respawn', async () => {
    const rec = new Recorder()
    const platform = new FakePlatform()
    platform.checkResult = { version: '0.0.1-alpha.1', update: { version: '0.0.1-alpha.2' }, error: null }
    platform.downloadProgress = [{ done: true }]
    const bridge = new AishellUpdateBridge(rec.publish, platform, true, 600_000)
    bridge.open()
    await vi.waitFor(() => expect(rec.last.phase).toBe('available'))
    bridge.open()
    // Auto-confirm installs on landing; the once-guard must hold against
    // further clicks (the ready label would re-trigger confirmInstall).
    await vi.waitFor(() => expect(rec.last.phase).toBe('installing'))
    bridge.open() // second click while installing: swallowed
    bridge.open() // third click: still swallowed (installSpawned)
    expect(platform.launches).toEqual(['/fake/resources/aishell-launcher/aishell'])
    expect(rec.phases().filter(phase => phase === 'installing')).toHaveLength(1)
    bridge.dispose()
  })

  it('staging recovery restores ready when the staged version is newer than local and current vs the feed', async () => {
    const rec = new Recorder()
    const platform = new FakePlatform()
    platform.staging = { version: '0.0.1-alpha.2', file: 'ai-shell-linux-x64.tar.gz' }
    const bridge = new AishellUpdateBridge(rec.publish, platform, true, 600_000)
    await bridge.resume(() => false)
    expect(rec.last.phase).toBe('ready')
    expect(rec.last.version).toBe('0.0.1-alpha.2')
    expect(platform.cleared).toBe(false)
    bridge.dispose()
  })

  it('staging recovery clears staging when the staged version is not newer than local (installed already)', async () => {
    const rec = new Recorder()
    const platform = new FakePlatform()
    platform.localVersion = '0.0.1-alpha.2'
    platform.staging = { version: '0.0.1-alpha.2', file: 'ai-shell-linux-x64.tar.gz' }
    const bridge = new AishellUpdateBridge(rec.publish, platform, true, 600_000)
    await bridge.resume(() => false)
    expect(rec.last.phase).toBe('idle')
    expect(platform.cleared).toBe(true)
    bridge.dispose()
  })

  it('staging behind the feed is ignored (the button must promise what the chain installs)', async () => {
    const rec = new Recorder()
    const platform = new FakePlatform()
    platform.staging = { version: '0.0.1-alpha.2', file: 'ai-shell-linux-x64.tar.gz' }
    const bridge = new AishellUpdateBridge(rec.publish, platform, true, 600_000)
    await bridge.resume(candidate => candidate === '0.0.1-alpha.2')
    expect(rec.last.phase).toBe('idle')
    expect(rec.last.version).toBeUndefined()
    expect(platform.cleared).toBe(true)
    bridge.dispose()
  })

  it('AC4: a declined confirmation returns to ready — no install, state intact, a later click re-asks', async () => {
    const rec = new Recorder()
    const platform = new FakePlatform()
    platform.checkResult = { version: '0.0.1-alpha.1', update: { version: '0.0.1-alpha.2' }, error: null }
    platform.downloadProgress = [{ done: true }]
    let askCount = 0
    const bridge = new AishellUpdateBridge(rec.publish, platform, true, 600_000, async () => {
      askCount++
      return askCount === 1 ? false : true // X first, install on the re-ask
    })
    bridge.open()
    await vi.waitFor(() => expect(rec.last.phase).toBe('available'))
    bridge.open() // download → ready → auto-confirm → DECLINED (X)
    await vi.waitFor(() => expect(rec.phases().filter(phase => phase === 'ready')).toHaveLength(2))
    expect(platform.launches).toEqual([]) // no chain spawned on decline
    expect(rec.last.phase).toBe('ready') // the button stays 安装并重启
    bridge.open() // the user clicks the button again
    await vi.waitFor(() => expect(rec.last.phase).toBe('installing'))
    expect(platform.launches).toEqual(['/fake/resources/aishell-launcher/aishell']) // the re-ask accepted
    expect(askCount).toBe(2)
    bridge.dispose()
  })

  it('a platform that throws never breaks the bridge (fail-open)', async () => {
    const rec = new Recorder()
    const platform = new FakePlatform()
    platform.checkResult = { version: '0.0.1-alpha.1', update: { version: '0.0.1-alpha.2' }, error: null }
    platform.spawnLauncher = (): { pid: number | undefined } => { throw new Error('spawn ENOENT') }
    platform.downloadProgress = [{ done: true }]
    const bridge = new AishellUpdateBridge(rec.publish, platform, true, 600_000)
    expect(() => bridge.open()).not.toThrow()
    await vi.waitFor(() => expect(rec.last.phase).toBe('available'))
    bridge.open()
    // The confirming install throws inside (default confirm agrees, then the
    // launcher spawn throws) — the catch resets to ready: state self-heals,
    // the bridge survives, and the button stays usable.
    await vi.waitFor(() => expect(rec.phases()).toContain('installing'))
    await vi.waitFor(() => expect(rec.last.phase).toBe('ready'))
    expect(() => bridge.open()).not.toThrow()
    bridge.dispose()
  })
})
