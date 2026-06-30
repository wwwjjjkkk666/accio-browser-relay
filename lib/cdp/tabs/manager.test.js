/**
 * TabManager regression tests for stale target cleanup.
 *
 * Covers:
 *   1. downgradeToVirtual → onDebuggerDetach race: virtual entry must survive
 *   2. downgradeToVirtual cleans up child sessions
 *   3. removeTrackedEntry: attaching uses tabRemoved, connected uses detachedFromTarget
 */

import { beforeEach, describe, expect, test } from 'bun:test'

// ── Minimal chrome.* mock ──
// TabManager and its dependencies call chrome.tabs, chrome.debugger,
// chrome.tabGroups, chrome.storage, chrome.action at import/construct time.

const noop = () => {}
const noopAsync = () => Promise.resolve()
const noopCb = (_arg, cb) => { if (cb) cb(); return Promise.resolve() }

globalThis.chrome = {
  tabs: {
    query: () => Promise.resolve([]),
    get: (id) => Promise.resolve({ id, url: 'https://example.com', title: 'Test' }),
    update: noopAsync,
    remove: noopAsync,
    create: () => Promise.resolve({ id: 999 }),
    onRemoved: { addListener: noop, removeListener: noop },
    onUpdated: { addListener: noop, removeListener: noop },
  },
  debugger: {
    attach: noopCb,
    detach: noopCb,
    sendCommand: (_d, _m, _p, cb) => { if (cb) cb(); return Promise.resolve() },
    getTargets: () => Promise.resolve([]),
    onEvent: { addListener: noop, removeListener: noop },
    onDetach: { addListener: noop, removeListener: noop },
  },
  tabGroups: {
    query: () => Promise.resolve([]),
    update: noopAsync,
    TAB_GROUP_ID_NONE: -1,
  },
  storage: {
    session: {
      get: () => Promise.resolve({}),
      set: noopAsync,
      remove: noopAsync,
    },
  },
  action: {
    setIcon: noopAsync,
    setBadgeText: noopAsync,
    setBadgeBackgroundColor: noopAsync,
  },
  windows: {
    update: noopAsync,
    create: () => Promise.resolve({ tabs: [{ id: 999 }] }),
  },
  runtime: {
    lastError: null,
  },
}

// Now safe to import TabManager
const { TabManager } = await import('./manager.js')

// ── Test helpers ──

function createManager() {
  const sent = []
  const sendToRelay = (payload) => sent.push(payload)
  const mgr = new TabManager(sendToRelay)
  return { mgr, sent }
}

/**
 * Build a connected (physical) tab with consistent indexes via the
 * test-only _injectConnectedState helper, then optionally register
 * child sessions via the real onDebuggerEvent path.
 */
function setupConnectedTab(mgr, tabId, sessionId, realTargetId) {
  mgr._injectConnectedState(tabId, sessionId, realTargetId)
}

function addChildSession(mgr, parentTabId, mainSessionId, childSessionId, childTargetId) {
  mgr.onDebuggerEvent(
    { tabId: parentTabId, sessionId: mainSessionId },
    'Target.attachedToTarget',
    {
      sessionId: childSessionId,
      targetInfo: { type: 'iframe', targetId: childTargetId, url: 'https://child.example.com' },
    },
  )
}

describe('TabManager — downgradeToVirtual + onDebuggerDetach race', () => {
  test('onDebuggerDetach does NOT delete an entry already downgraded to virtual', async () => {
    const { mgr, sent } = createManager()

    // Build a consistent connected state via _injectConnectedState
    setupConnectedTab(mgr, 100, 'session-100', 'REAL_TARGET_ABC')

    // Verify indexes are consistent before downgrade
    expect(mgr.get(100)?.state).toBe('connected')
    expect(mgr.resolveTabId('session-100', null)).toBe(100)
    expect(mgr.resolveTabId(null, 'REAL_TARGET_ABC')).toBe(100)
    sent.length = 0

    // Step 1: downgradeToVirtual — simulates "sendCommand failed, debugger gone"
    mgr.downgradeToVirtual(100, 'debugger-gone')

    // Should have sent: Target.detachedFromTarget + Extension.tabDiscovered
    const detachEvent = sent.find((s) => s.params?.method === 'Target.detachedFromTarget')
    const discoverEvent = sent.find((s) => s.params?.method === 'Extension.tabDiscovered')
    expect(detachEvent).toBeDefined()
    expect(discoverEvent).toBeDefined()
    expect(detachEvent.params.params.targetId).toBe('REAL_TARGET_ABC')
    expect(discoverEvent.params.params.targetInfo.targetId).toBe('vtab-100')

    // Entry should now be virtual; old real target should NOT be routable
    const afterDowngrade = mgr.get(100)
    expect(afterDowngrade.state).toBe('virtual')
    expect(afterDowngrade.targetId).toBe('vtab-100')
    expect(mgr.resolveTabId(null, 'REAL_TARGET_ABC')).toBeNull()
    expect(mgr.resolveTabId(null, 'vtab-100')).toBe(100)
    sent.length = 0

    // Step 2: onDebuggerDetach fires (late arrival from Chrome)
    mgr.onDebuggerDetach({ tabId: 100 }, 'target_closed')

    // Entry should STILL exist — virtual skip must prevent deletion
    const afterDetach = mgr.get(100)
    expect(afterDetach).toBeDefined()
    expect(afterDetach.state).toBe('virtual')
    expect(mgr.resolveTabId(null, 'vtab-100')).toBe(100)

    // No additional events should have been sent to relay
    expect(sent.length).toBe(0)
  })

  test('onDebuggerDetach still removes connected entries normally', async () => {
    const { mgr, sent } = createManager()

    setupConnectedTab(mgr, 200, 'session-200', 'REAL_TARGET_XYZ')
    sent.length = 0

    // onDebuggerDetach on a connected entry — should detach normally
    mgr.onDebuggerDetach({ tabId: 200 }, 'target_closed')
    await new Promise((r) => setTimeout(r, 10))

    expect(mgr.get(200)).toBeUndefined()
    expect(mgr.resolveTabId('session-200', null)).toBeNull()
    expect(mgr.resolveTabId(null, 'REAL_TARGET_XYZ')).toBeNull()

    const detachEvent = sent.find((s) => s.params?.method === 'Target.detachedFromTarget')
    expect(detachEvent).toBeDefined()
  })
})

describe('TabManager — downgradeToVirtual cleans child sessions', () => {
  test('child sessions registered via onDebuggerEvent are cleared on downgrade', () => {
    const { mgr, sent } = createManager()

    setupConnectedTab(mgr, 300, 'session-300', 'REAL_TARGET_PARENT')

    // Register child sessions (OOPIF iframe + worker) via real public path
    addChildSession(mgr, 300, 'session-300', 'child-iframe-1', 'child-target-1')
    addChildSession(mgr, 300, 'session-300', 'child-worker-2', 'child-target-2')

    // Verify child sessions are routable BEFORE downgrade
    const iframeHit = mgr.getBySessionId('child-iframe-1')
    expect(iframeHit).not.toBeNull()
    expect(iframeHit.tabId).toBe(300)
    expect(iframeHit.kind).toBe('child')

    const workerHit = mgr.getBySessionId('child-worker-2')
    expect(workerHit).not.toBeNull()
    expect(workerHit.tabId).toBe(300)

    // Also verify resolveTabId routes child sessions
    expect(mgr.resolveTabId('child-iframe-1', null)).toBe(300)
    expect(mgr.resolveTabId('child-worker-2', null)).toBe(300)

    sent.length = 0
    mgr.downgradeToVirtual(300, 'debugger-gone')

    // After downgrade: entry is virtual, old target not routable
    const afterDowngrade = mgr.get(300)
    expect(afterDowngrade.state).toBe('virtual')
    expect(mgr.resolveTabId(null, 'REAL_TARGET_PARENT')).toBeNull()
    expect(mgr.resolveTabId(null, 'vtab-300')).toBe(300)

    // Child sessions must no longer be routable
    expect(mgr.getBySessionId('child-iframe-1')).toBeNull()
    expect(mgr.getBySessionId('child-worker-2')).toBeNull()
    expect(mgr.resolveTabId('child-iframe-1', null)).toBeNull()
    expect(mgr.resolveTabId('child-worker-2', null)).toBeNull()
  })

  test('onDebuggerDetach after downgrade does not revive stale child routes', async () => {
    const { mgr, sent } = createManager()

    setupConnectedTab(mgr, 350, 'session-350', 'REAL_TARGET_350')
    addChildSession(mgr, 350, 'session-350', 'child-sw-1', 'sw-target-1')

    expect(mgr.getBySessionId('child-sw-1')?.tabId).toBe(350)

    mgr.downgradeToVirtual(350, 'debugger-gone')
    expect(mgr.getBySessionId('child-sw-1')).toBeNull()

    sent.length = 0
    // Late onDebuggerDetach — virtual skip
    mgr.onDebuggerDetach({ tabId: 350 }, 'target_closed')

    // Entry survives, child sessions still gone
    expect(mgr.get(350)?.state).toBe('virtual')
    expect(mgr.getBySessionId('child-sw-1')).toBeNull()
    expect(sent.length).toBe(0)
  })
})

describe('TabManager — removeTrackedEntry event semantics', () => {
  test('connected entry sends Target.detachedFromTarget', () => {
    const { mgr, sent } = createManager()

    setupConnectedTab(mgr, 400, 'session-400', 'REAL_TARGET_400')
    sent.length = 0

    mgr.removeTrackedEntry(400, 'tab-closed')

    expect(mgr.get(400)).toBeUndefined()
    expect(mgr.resolveTabId('session-400', null)).toBeNull()
    expect(mgr.resolveTabId(null, 'REAL_TARGET_400')).toBeNull()

    const detach = sent.find((s) => s.params?.method === 'Target.detachedFromTarget')
    expect(detach).toBeDefined()
    expect(detach.params.params.targetId).toBe('REAL_TARGET_400')
    // Should NOT have sent Extension.tabRemoved
    const removed = sent.find((s) => s.params?.method === 'Extension.tabRemoved')
    expect(removed).toBeUndefined()
  })

  test('attaching entry sends Extension.tabRemoved (not detachedFromTarget)', () => {
    const { mgr, sent } = createManager()

    mgr.discover(500, 'https://example.com', 'Attaching')
    const entry = mgr.get(500)
    entry.state = 'attaching'
    sent.length = 0

    mgr.removeTrackedEntry(500, 'attach-failed')

    expect(mgr.get(500)).toBeUndefined()
    const removed = sent.find((s) => s.params?.method === 'Extension.tabRemoved')
    expect(removed).toBeDefined()
    const detach = sent.find((s) => s.params?.method === 'Target.detachedFromTarget')
    expect(detach).toBeUndefined()
  })

  test('virtual entry sends Extension.tabRemoved', () => {
    const { mgr, sent } = createManager()

    mgr.discover(600, 'https://example.com', 'Virtual')
    sent.length = 0

    mgr.removeTrackedEntry(600, 'tab-closed')

    expect(mgr.get(600)).toBeUndefined()
    const removed = sent.find((s) => s.params?.method === 'Extension.tabRemoved')
    expect(removed).toBeDefined()
  })

  test('connected entry with child sessions clears child routes on removal', () => {
    const { mgr, sent } = createManager()

    setupConnectedTab(mgr, 700, 'session-700', 'REAL_TARGET_700')
    addChildSession(mgr, 700, 'session-700', 'child-oopif-1', 'oopif-target-1')

    expect(mgr.getBySessionId('child-oopif-1')?.tabId).toBe(700)
    sent.length = 0

    mgr.removeTrackedEntry(700, 'tab-closed')

    expect(mgr.get(700)).toBeUndefined()
    expect(mgr.getBySessionId('child-oopif-1')).toBeNull()
    expect(mgr.resolveTabId('child-oopif-1', null)).toBeNull()
  })
})
