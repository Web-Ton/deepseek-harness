/** Shared geometry for the self-drawn main-window caption. */

/** Self-drawn titlebar height in device-independent pixels. */
export const WINDOWS_TITLEBAR_HEIGHT = 40

/**
 * AI Shell distribution (Linux chrome theme): platforms whose primary window
 * draws its own caption (hidden native titlebar + Window Controls Overlay +
 * in-page menus). macOS keeps native chrome (AppKit menus and traffic
 * lights). A function, not a constant: the preload's client spec exercises
 * the gate with per-case platform mocks, so the check must observe
 * process.platform at call time, not at module-load time.
 */
export function selfDrawnChrome(): boolean {
  return process.platform === 'win32' || process.platform === 'linux'
}
