// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Welcome } from '../src/client/WelcomePage.tsx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'

const html = readFileSync(join(import.meta.dirname, '../renderer/welcome.html'), 'utf8')
afterEach(cleanup)

function mount(language = 'zh-CN') {
  cleanup()
  const api = {
    analyticsEnabled: async () => true,
    ...resolveDesktopLocale(language),
    skip: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }
  const mounted = render(<Welcome api={api} />)
  const button = (id: string) => document.querySelector<HTMLButtonElement>(id)!
  const copy = () => {
    const heading = document.querySelector('main')!.getAttribute('aria-labelledby')!
    return [
      document.title, document.querySelector('img')!.alt, document.getElementById(heading)!.textContent,
      document.querySelector('#welcome-description')!.textContent,
      ...[...document.querySelectorAll('button')].filter(item => item.closest('[hidden]') === null)
        .map(item => `${item.textContent || item.getAttribute('aria-label')}${item.disabled ? ' [disabled]' : ''}`),
      '',
    ].join('\n')
  }
  return { document, api, button, copy, unmount: mounted.unmount }
}

describe('desktop welcome presentation', () => {
  it.each(['zh-CN', 'en'])('renders the %s brand entry', async (language) => {
    const view = mount(language)
    expect(view.document.documentElement.lang).toBe(language)
    expect(view.document.querySelector('img')!.getAttribute('src')).toBe('assets/welcome-brand.svg')
    await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}.expected.txt`)
  })

  it('enters the workspace through the single action and disables it while pending', async () => {
    const view = mount()
    const entered = Promise.withResolvers<undefined>()
    view.api.skip.mockReturnValue(entered.promise)
    fireEvent.click(view.button('#enter'))
    fireEvent.click(view.button('#enter'))
    expect(view.api.skip).toHaveBeenCalledExactlyOnceWith()
    expect(view.button('#enter').disabled).toBe(true)
    expect(view.button('#enter').textContent).toBe(view.api.messages.welcomeEnter)
    entered.resolve(undefined)
    await vi.waitFor(() => { expect(view.button('#enter').disabled).toBe(false) })
  })

  it('shows the enter action again after a failed entry', async () => {
    const view = mount()
    view.api.skip.mockRejectedValueOnce(new Error('workspace unavailable'))
    fireEvent.click(view.button('#enter'))
    await vi.waitFor(() => { expect(view.button('#enter').disabled).toBe(false) })
    expect(view.document.querySelector<HTMLElement>('[role="alert"]')!.hidden).toBe(false)
    expect(view.document.querySelector('[role="alert"]')!.textContent).toBe(view.api.messages.welcomeContinueFailed)
    fireEvent.click(view.button('#enter'))
    expect(view.api.skip).toHaveBeenCalledTimes(2)
  })

  it('keeps visible copy in the shell dictionaries and denies network access', () => {
    expect([...html.matchAll(/>([^<]*\p{L}[^<]*)</gu)]).toEqual([])
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("form-action 'none'")
  })
})
