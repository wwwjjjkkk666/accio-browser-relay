import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'

function loadContentScript({ lastError } = {}) {
  const listeners = new Map()
  const posts = []
  let lastErrorReadCount = 0

  const windowRef = {
    location: { origin: 'https://www.accio.com' },
    postMessage(payload, origin) {
      posts.push({ payload, origin })
    },
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type)
    },
  }

  const runtime = {
    id: 'ext-id',
    getManifest: () => ({ version: '0.1.4' }),
    sendMessage(_message, callback) {
      callback?.({ connected: true })
    },
  }

  Object.defineProperty(runtime, 'lastError', {
    configurable: true,
    get() {
      lastErrorReadCount += 1
      return lastError
    },
  })

  const context = createContext({
    window: windowRef,
    chrome: { runtime },
  })
  const source = readFileSync(new URL('../../../content-script.js', import.meta.url), 'utf8')
  new Script(source, { filename: 'content-script.js' }).runInContext(context)

  return {
    posts,
    dispatchMessage(data) {
      listeners.get('message')?.({ source: windowRef, data })
    },
    getLastErrorReadCount() {
      return lastErrorReadCount
    },
  }
}

describe('accio browser relay content script', () => {
  test('consumes runtime.lastError and skips stale status response when message channel closes', () => {
    const runtimeError = {
      message:
        'The page keeping the extension port is moved into back/forward cache, so the message channel is closed.',
    }
    const harness = loadContentScript({ lastError: runtimeError })

    harness.dispatchMessage({ type: 'accio.extension.status.request' })

    expect(harness.getLastErrorReadCount()).toBeGreaterThan(0)
    expect(harness.posts.map((entry) => entry.payload.type)).not.toContain('accio.extension.status')
  })
})
