/** Desktop welcome presentation; the single enter action stays in the preload. */
import { useEffect, useRef, useState } from 'react'
import type { WelcomeApi } from '../welcome-api.ts'

/**
 * Render the standalone aishell welcome entry using shell-owned operations.
 * The DeepSeek sign-in and API-key flows were removed with their plugins:
 * this page presents the brand and enters the workspace, where Huawei Cloud
 * credentials are configured through the in-app credential entry.
 * @param props.api - isolated preload API; no account credentials reach the renderer.
 * @returns the welcome page with one enter action.
 */
export function Welcome({ api }: { api: WelcomeApi }) {
  const { messages: m } = api
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    document.documentElement.lang = api.id
    document.title = m.welcomeTitle
    return () => { mounted.current = false }
  }, [api, m.welcomeTitle])

  async function enter() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await api.skip()
    } catch {
      if (mounted.current) setError(m.welcomeContinueFailed)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return <>
    <div className="titlebar" aria-hidden="true" />
    <main className="welcome" aria-labelledby="welcome-heading">
      <img className="brand" src="assets/welcome-brand.svg" alt={m.welcomeBrand} width="472" height="40" />
      <div id="tagline" className="tagline">
        <h1 id="welcome-heading"><span>{m.welcomeTaglineBefore}</span><em>{m.welcomeTaglineBrand}</em><span>{m.welcomeTaglineAfter}</span></h1>
        <p id="welcome-description">{m.welcomeDescription}</p>
      </div>
      <div className="actions">
        <button id="enter" className="primary" type="button" disabled={busy} onClick={() => { void enter() }}>{m.welcomeEnter}</button>
      </div>
      <p className="key-error" role="alert" hidden={error === ''}>{error}</p>
    </main>
  </>
}
