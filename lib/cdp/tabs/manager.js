/**
 * TabManager — Lazy Attach architecture.
 *
 * Encapsulates all tab state: discovery, lazy physical attach, agent tracking.
 *
 * Tab lifecycle:
 *   virtual   → discovered by chrome.tabs.query, no chrome.debugger session
 *   attaching → chrome.debugger.attach() in flight
 *   connected → physically attached via chrome.debugger
 *
 * Relay notifications:
 *   Extension.tabDiscovered        — virtual tab discovered (relay stores, Playwright ignores)
 *   Extension.tabUpdated           — virtual tab metadata (title/url) changed
 *   Extension.tabRemoved           — virtual tab removed from cache
 *   Target.attachedToTarget        — physical debugger attached (Playwright sees this)
 *   Target.detachedFromTarget      — physical debugger detached (Playwright sees this)
 *
 * Delegates to:
 *   SessionIndicators  — spinner animation + idle tab detection
 *   AgentGroupManager  — Chrome tab group management
 */

import { TabType } from '../../constants.js'
import { createLogger } from '../../logger.js'
import { attachDebugger, detachDebugger, detachAll } from './debugger-attach.js'
import { SessionIndicators } from './session-indicators.js'
import { AgentGroupManager } from './agent-group.js'
import { cleanupTabQueue, cleanupAllTabQueues } from '../commands/dispatch.js'
import { interceptEvent } from '../events/index.js'

const log = createLogger('tabs')

const CANCELLED_TABS_KEY = 'tydbuddy_cancelledTabs'
const TABS_STATE_KEY = 'tydbuddy_tabsState'

let _sessionSeq = 0

const DEBUGGABLE_URL_RE = /^(https?|file):\/\//

function isDebuggableUrl(url) {
  if (!url) return false
  return DEBUGGABLE_URL_RE.test(url) || url === 'about:blank'
}

/** Derive stable vtab handle from numeric tab ID. */
function toVtabId(tabId) {
  return `vtab-${tabId}`
}

export class TabManager {
  /** @type {Map<number, {state: string, sessionId: string, targetId: string, url?: string, title?: string}>} */
  #tabs = new Map()
  /** @type {Map<string, number>} sessionId → tabId */
  #bySession = new Map()
  /** @type {Map<string, number>} targetId → tabId */
  #byTarget = new Map()
  /** @type {Map<string, number>} child sessionId → parent tabId */
  #childSession = new Map()
  /** @type {Map<number, Set<string>>} parent tabId → child sessionIds */
  #childSets = new Map()
  /** @type {Map<number, string>} tabId → TabType */
  #agentTabs = new Map()
  /** @type {Set<number>} */
  #cancelled = new Set()
  /** @type {Map<number, Promise<boolean>>} tabId → pending attach promise */
  #pending = new Map()
  #retainedCount = 0
  /** @type {boolean} */
  #shuttingDown = false
  /** @type {(payload: any) => void} */
  #sendToRelay

  /** @type {SessionIndicators} */
  #indicators
  /** @type {AgentGroupManager} */
  #group

  /**
   * @param {(payload: any) => void} sendToRelay — fire-and-forget relay send function
   */
  constructor(sendToRelay) {
    this.#sendToRelay = sendToRelay
    this.#group = new AgentGroupManager()
    this.#indicators = new SessionIndicators({
      getGroupId: () => this.#group.groupId,
      getTabEntries: () => this.#tabs.entries(),
      detachTab: (tabId, reason) => this.downgradeToVirtual(tabId, reason),
    })
  }

  // ── CDP command tracking (forwarded from dispatch) ──

  onCdpCommand(tabId) {
    this.#indicators.trackCommand(tabId)
  }

  // ── Session lifecycle ──

  startSessionIndicators() {
    this.#indicators.start()
  }

  stopSessionIndicators() {
    this.#indicators.stop()
  }

  handleIndicatorAlarm(alarmName) {
    return this.#indicators.handleAlarm(alarmName)
  }

  // ── Tab group ──

  async addToAgentGroup(tabId) {
    await this.#group.addTab(tabId)
  }

  async dissolveAgentGroup() {
    const agentIds = new Set(this.#agentTabs.keys())
    await this.#group.dissolve(agentIds)
  }

  /** Close every tab in every TydBuddy Agent–titled Chrome tab group (gateway hook). */
  async closeAllTydBuddyAgentGroupTabs() {
    return this.#group.closeAllTydBuddyAgentGroupTabs()
  }

  /**
   * Atomic shutdown: optionally dissolve agent group, then clear all state.
   * Dissolution runs BEFORE clearAll() so that the groupId and agentTabs
   * are still available for deciding which tabs to close vs ungroup.
   */
  async shutdown({ dissolveGroup = false } = {}) {
    if (dissolveGroup) {
      await this.dissolveAgentGroup()
    }
    return this.clearAll()
  }

  // ── Tab state queries ──

  get size() { return this.#tabs.size }
  has(tabId) { return this.#tabs.has(tabId) }
  get(tabId) { return this.#tabs.get(tabId) }
  entries() { return this.#tabs.entries() }

  get agentTabCount() { return this.#agentTabs.size }
  get retainedTabCount() { return this.#retainedCount }
  get agentTabs() { return this.#agentTabs }

  /**
   * @internal Test-only — DO NOT call from production code.
   * Atomically inject a connected (physical) tab into all indexes.
   * Mirrors the state that would exist after discover() + successful chrome.debugger.attach().
   * @param {number} tabId
   * @param {string} sessionId
   * @param {string} realTargetId — the real CDP targetId assigned after attach
   */
  _injectConnectedState(tabId, sessionId, realTargetId) {
    const vtabId = toVtabId(tabId)
    // Clean up any prior virtual entry indexes
    this.#byTarget.delete(vtabId)
    this.#bySession.delete(this.#tabs.get(tabId)?.sessionId)
    const entry = {
      state: 'connected',
      sessionId,
      targetId: realTargetId,
      url: 'https://test.example.com',
      title: 'Test',
    }
    this.#tabs.set(tabId, entry)
    this.#bySession.set(sessionId, tabId)
    this.#byTarget.set(realTargetId, tabId)
    return entry
  }

  // ── Lookup ──

  getBySessionId(sessionId) {
    const direct = this.#bySession.get(sessionId)
    if (direct !== undefined) return { tabId: direct, kind: 'main' }
    const child = this.#childSession.get(sessionId)
    if (child !== undefined) return { tabId: child, kind: 'child' }
    return null
  }

  getByTargetId(targetId) {
    return this.#byTarget.get(targetId) ?? null
  }

  resolveTabId(sessionId, targetId) {
    if (sessionId) {
      const found = this.getBySessionId(sessionId)
      if (found) return found.tabId
    }
    if (targetId) {
      const found = this.getByTargetId(targetId)
      if (found !== null) return found
    }
    return null
  }

  // ── User-cancelled tab tracking (persisted to session storage) ──

  markCancelled(tabId) {
    this.#cancelled.add(tabId)
    void this.#persistCancelled()
  }

  isCancelled(tabId) { return this.#cancelled.has(tabId) }

  removeCancelled(tabId) {
    this.#cancelled.delete(tabId)
    void this.#persistCancelled()
  }

  async loadCancelled() {
    try {
      const { [CANCELLED_TABS_KEY]: ids } = await chrome.storage.session.get(CANCELLED_TABS_KEY)
      const arr = Array.isArray(ids) ? ids : []
      this.#cancelled.clear()
      for (const id of arr) {
        if (typeof id === 'number' && Number.isInteger(id)) this.#cancelled.add(id)
      }
    } catch (err) {
      log.warn('loadCancelled failed:', err)
    }
  }

  async #persistCancelled() {
    try {
      await chrome.storage.session.set({ [CANCELLED_TABS_KEY]: [...this.#cancelled] })
    } catch (err) {
      log.warn('persistCancelled failed:', err)
    }
  }

  // ── Tab state persistence (chrome.storage.session) ──

  #persistTimer = null

  #persistTabs() {
    if (this.#persistTimer !== null) clearTimeout(this.#persistTimer)
    this.#persistTimer = setTimeout(() => this.#flushTabs(), 200)
  }

  async #flushTabs() {
    this.#persistTimer = null
    try {
      const data = {
        tabs: [...this.#tabs],
        sessionSeq: _sessionSeq,
        agentTabs: [...this.#agentTabs],
      }
      await chrome.storage.session.set({ [TABS_STATE_KEY]: data })
    } catch (err) {
      log.warn('persistTabs failed:', err)
    }
  }

  async #flushTabsImmediate() {
    if (this.#persistTimer !== null) {
      clearTimeout(this.#persistTimer)
      this.#persistTimer = null
    }
    await this.#flushTabs()
  }

  async loadTabs() {
    try {
      const { [TABS_STATE_KEY]: data } = await chrome.storage.session.get(TABS_STATE_KEY)
      if (!data?.tabs) return false
      this.#tabs = new Map(data.tabs)
      this.#bySession.clear()
      this.#byTarget.clear()
      for (const [tabId, entry] of this.#tabs) {
        this.#bySession.set(entry.sessionId, tabId)
        this.#byTarget.set(entry.targetId, tabId)
      }
      if (typeof data.sessionSeq === 'number') _sessionSeq = data.sessionSeq
      if (Array.isArray(data.agentTabs)) this.#agentTabs = new Map(data.agentTabs)
      log.info('loadTabs: restored', this.#tabs.size, 'tabs, sessionSeq =', _sessionSeq)
      return true
    } catch (err) {
      log.warn('loadTabs failed:', err)
      return false
    }
  }

  async reconcileTabs() {
    // Level 1: remove entries for tabs that no longer exist
    const liveTabs = await chrome.tabs.query({})
    const liveIds = new Set(liveTabs.map(t => t.id))

    const closedTabIds = [...this.#tabs.keys()].filter(id => !liveIds.has(id))
    for (const tabId of closedTabIds) {
      log.info('reconcileTabs: tab closed during sleep, removing', tabId)
      this.removeTrackedEntry(tabId, 'tab-closed')
      this.deleteAgent(tabId)
    }

    // Level 2: downgrade connected entries whose debugger is no longer attached
    const targets = await chrome.debugger.getTargets()
    const attachedTabIds = new Set(
      targets
        .filter(t => t.attached && t.tabId)
        .map(t => t.tabId)
    )

    for (const [tabId, entry] of this.#tabs) {
      if (entry.state === 'connected' && !attachedTabIds.has(tabId)) {
        log.info('reconcileTabs: debugger detached during sleep, downgrading to virtual', tabId)
        this.downgradeToVirtual(tabId, 'sw-restart')
      }
    }

    // Cross-validate: remove orphan agentTab entries
    const orphanAgentIds = [...this.#agentTabs.keys()].filter(id => !this.#tabs.has(id))
    for (const tabId of orphanAgentIds) {
      log.info('reconcileTabs: orphan agentTab entry, removing', tabId)
      this.deleteAgent(tabId)
    }

    // Rebuild indexes (removeEntry may have left them inconsistent)
    this.#bySession.clear()
    this.#byTarget.clear()
    for (const [tabId, entry] of this.#tabs) {
      this.#bySession.set(entry.sessionId, tabId)
      this.#byTarget.set(entry.targetId, tabId)
    }

    void this.#persistTabs()
    log.info('reconcileTabs: done,', this.#tabs.size, 'tabs surviving')
  }

  // ── Agent tab tracking ──

  markAgent(tabId, retain = false) {
    const prev = this.#agentTabs.get(tabId)
    const next = retain ? TabType.RETAINED : TabType.AGENT
    this.#agentTabs.set(tabId, next)
    if (next === TabType.RETAINED && prev !== TabType.RETAINED) this.#retainedCount++
    else if (next !== TabType.RETAINED && prev === TabType.RETAINED) this.#retainedCount--
    void this.#persistTabs()
  }

  deleteAgent(tabId) {
    const prev = this.#agentTabs.get(tabId)
    if (prev === undefined) return
    if (prev === TabType.RETAINED) this.#retainedCount--
    this.#agentTabs.delete(tabId)
    void this.#persistTabs()
  }

  isAgent(tabId) { return this.#agentTabs.has(tabId) }
  isRetained(tabId) { return this.#agentTabs.get(tabId) === TabType.RETAINED }

  // ── Discovery (virtual registration) ──

  resyncAttachedTabs() {
    let count = 0
    for (const [tabId, entry] of this.#tabs) {
      if (entry.state === 'connected') {
        const vtabId = toVtabId(tabId)
        this.#sendToRelay({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            params: {
              sessionId: entry.sessionId,
              targetInfo: {
                targetId: entry.targetId, type: 'page',
                title: entry.title || '', url: entry.url || '', attached: true,
              },
              waitingForDebugger: false,
              vtabId,
            },
          },
        })
        count++
      } else if (entry.state === 'virtual') {
        this.#sendToRelay({
          method: 'forwardCDPEvent',
          params: {
            method: 'Extension.tabDiscovered',
            params: {
              sessionId: entry.sessionId,
              targetInfo: {
                targetId: entry.targetId, type: 'page',
                title: entry.title || '', url: entry.url || '', attached: false,
              },
            },
          },
        })
      }
    }
    log.info('resyncAttachedTabs: re-sent', count, 'physical attachments,', this.#tabs.size - count, 'virtual tabs')
  }

  async discoverAll(isConnected) {
    const t0 = performance.now()
    if (!isConnected()) return

    const allTabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] })
    log.debug('discoverAll: query took', (performance.now() - t0).toFixed(1), 'ms,', allTabs.length, 'tabs')

    let count = 0
    for (const tab of allTabs) {
      if (!tab.id || this.#tabs.has(tab.id) || this.#cancelled.has(tab.id)) continue
      this.#registerVirtual(tab.id, tab.url, tab.title)
      count++
    }
    log.info('discoverAll: registered', count, 'virtual tabs in', (performance.now() - t0).toFixed(1), 'ms')
  }

  discover(tabId, url, title) {
    if (!this.#tabs.has(tabId) && isDebuggableUrl(url)) {
      this.#registerVirtual(tabId, url, title)
      log.debug('discover: registered virtual tab', tabId)
    }
  }

  /**
   * Update a tracked tab's URL and/or title.
   * Sends Extension.tabUpdated to the relay so the agent side stays in sync.
   */
  updateTab(tabId, url, title) {
    const entry = this.#tabs.get(tabId)
    if (!entry) return

    let changed = false
    if (url !== undefined && url !== entry.url) { entry.url = url; changed = true }
    if (title !== undefined && title !== entry.title) { entry.title = title; changed = true }
    if (!changed) return

    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Extension.tabUpdated',
        params: {
          sessionId: entry.sessionId,
          targetInfo: {
            targetId: entry.targetId, type: 'page',
            title: entry.title || '', url: entry.url || '',
            attached: entry.state === 'connected',
          },
        },
      },
    })
    void this.#persistTabs()
  }

  #registerVirtual(tabId, url, title) {
    if (this.#tabs.has(tabId) || this.#cancelled.has(tabId)) return

    const sessionId = `cb-tab-${++_sessionSeq}-${tabId}`
    const targetId = toVtabId(tabId)

    this.#tabs.set(tabId, { state: 'virtual', sessionId, targetId, url, title })
    this.#bySession.set(sessionId, tabId)
    this.#byTarget.set(targetId, tabId)

    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Extension.tabDiscovered',
        params: {
          sessionId,
          targetInfo: { targetId, type: 'page', title: title || '', url: url || '', attached: false },
        },
      },
    })
    void this.#persistTabs()
  }

  // ── Lazy Attach (on-demand physical attachment) ──

  async ensureAttached(tabId) {
    if (this.#cancelled.has(tabId)) {
      log.warn('ensureAttached: tab was cancelled by user', tabId)
      throw new Error(`User denied debugger permission for tab ${tabId}`)
    }
    const entry = this.#tabs.get(tabId)
    if (!entry) { log.warn('ensureAttached: tab not tracked', tabId); return false }
    if (entry.state === 'connected') return true
    if (entry.state === 'attaching') {
      const p = this.#pending.get(tabId)
      if (p) return p
    }

    const promise = this.#physicalAttach(tabId, entry)
    this.#pending.set(tabId, promise)
    try { return await promise } finally { this.#pending.delete(tabId) }
  }

  async #getRealTargetId(tabId) {
    try {
      const targets = await chrome.debugger.getTargets()
      const match = targets.find(t => t.tabId === tabId && t.attached && t.type === 'page')
      return match?.id || null
    } catch (err) {
      log.warn('getRealTargetId: failed for tab', tabId, err)
      return null
    }
  }

  async #physicalAttach(tabId, entry) {
    const t0 = performance.now()
    if (this.#shuttingDown) return false
    entry.state = 'attaching'
    log.info('physicalAttach: begin', tabId)

    try {
      if (this.#shuttingDown) return false
      const { realTargetId } = await attachDebugger(tabId)

      // Guard: tab may have been removed by clearAll/detach while we were awaiting
      if (!this.#tabs.has(tabId)) {
        log.warn('physicalAttach: tab removed during attach, cleaning up', tabId)
        void detachDebugger(tabId)
        return false
      }

      if (realTargetId && realTargetId !== entry.targetId) {
        this.#byTarget.delete(entry.targetId)
        entry.targetId = realTargetId
        this.#byTarget.set(realTargetId, tabId)
      }

      entry.state = 'connected'

      const vtabId = toVtabId(tabId)
      this.#sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId: entry.sessionId,
            targetInfo: {
              targetId: entry.targetId, type: 'page',
              title: entry.title || '', url: entry.url || '', attached: true,
            },
            waitingForDebugger: false,
            vtabId,
          },
        },
      })

      void this.#persistTabs()
      log.info('physicalAttach: done', tabId, 'in', (performance.now() - t0).toFixed(1), 'ms')
      return true
    } catch (err) {
      const msg = err?.message || ''
      if (msg.includes('Another debugger is already attached')) {
        log.info('physicalAttach: debugger already attached (SW restart), reusing', tabId)
        const realTargetId = await this.#getRealTargetId(tabId)
        if (realTargetId) {
          if (realTargetId !== entry.targetId) {
            this.#byTarget.delete(entry.targetId)
            entry.targetId = realTargetId
            this.#byTarget.set(realTargetId, tabId)
          }
          entry.state = 'connected'
          void this.#persistTabs()
          log.info('physicalAttach: reused existing debugger', tabId, 'realTargetId:', realTargetId)
          return true
        }
        log.warn('physicalAttach: debugger attached but getRealTargetId returned null, keeping debugger', tabId)
        return false
      }
      log.warn('physicalAttach: failed', tabId, (performance.now() - t0).toFixed(1), 'ms', err)
      void detachDebugger(tabId)
      if (this.#tabs.has(tabId)) {
        this.removeTrackedEntry(tabId, 'attach-failed')
      }
      return false
    }
  }

  async attach(tabId) {
    if (this.#cancelled.has(tabId)) {
      log.warn('attach: tab was cancelled by user', tabId)
      return null
    }
    const existing = this.#tabs.get(tabId)
    if (existing?.state === 'connected') {
      log.debug('attach: already connected', tabId)
      return existing
    }

    const wasNew = !existing
    if (wasNew) {
      let url, title
      try {
        const tab = await chrome.tabs.get(tabId)
        url = tab.url; title = tab.title
      } catch { /* tab may have closed */ }
      const sessionId = `cb-tab-${++_sessionSeq}-${tabId}`
      const targetId = toVtabId(tabId)
      this.#tabs.set(tabId, { state: 'virtual', sessionId, targetId, url, title })
      this.#bySession.set(sessionId, tabId)
      this.#byTarget.set(targetId, tabId)
    }

    const ok = await this.ensureAttached(tabId)
    if (!ok) {
      if (wasNew && this.#tabs.has(tabId)) this.#removeEntry(tabId)
      return null
    }

    const entry = this.#tabs.get(tabId)
    return entry ? { sessionId: entry.sessionId, targetId: entry.targetId, vtabId: toVtabId(tabId) } : null
  }

  // ── Detach ──

  async detach(tabId, reason) {
    const t0 = performance.now()
    const entry = this.#tabs.get(tabId)
    log.info('detach:', tabId, reason, 'state:', entry?.state)

    const wasPhysical = entry?.state === 'connected' || entry?.state === 'attaching'

    this.removeTrackedEntry(tabId, reason)

    if (wasPhysical) {
      await detachDebugger(tabId)
      log.debug('detach: chrome.debugger cleanup', tabId, (performance.now() - t0).toFixed(1), 'ms')
    }
  }

  clearAll() {
    const t0 = performance.now()
    this.#shuttingDown = true
    this.stopSessionIndicators()

    const physical = []
    for (const [tabId, entry] of this.#tabs) {
      if (entry.state === 'connected' || entry.state === 'attaching') {
        physical.push(tabId)
      }
    }

    log.info('clearAll:', this.#tabs.size, 'total,', physical.length, 'physically attached')

    this.#tabs.clear()
    this.#bySession.clear()
    this.#byTarget.clear()
    this.#childSession.clear()
    this.#childSets.clear()
    this.#pending.clear()
    this.#cancelled.clear()
    void chrome.storage.session.remove(CANCELLED_TABS_KEY).catch(() => {})
    this.#agentTabs.clear()
    this.#retainedCount = 0
    this.#group.reset()
    this.#indicators.clear()
    cleanupAllTabQueues()
    void this.#flushTabsImmediate()

    const settled = detachAll(physical)
    settled.then(() => {
      this.#shuttingDown = false
      log.info('clearAll: done in', (performance.now() - t0).toFixed(1), 'ms')
    })
    return settled
  }

  // ── Debugger event handlers ──

  onDebuggerEvent(source, method, params) {
    const tabId = source.tabId
    if (!tabId) return
    const tab = this.#tabs.get(tabId)
    if (!tab?.sessionId) return

    const result = interceptEvent(method, tabId, params, {
      childSession: this.#childSession,
      childSets: this.#childSets,
      log,
    })

    if (result.suppress) return

    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: { sessionId: source.sessionId || tab.sessionId, method, params },
    })
  }

  onDebuggerDetach(source, reason) {
    const tabId = source.tabId
    const entry = tabId ? this.#tabs.get(tabId) : undefined
    log.info('onDebuggerDetach:', tabId, reason, 'state:', entry?.state)
    if (!tabId || !entry) return
    // If the entry has already been downgraded to virtual (e.g. by
    // downgradeToVirtual() in a sendCommand failure path), the detach event
    // is stale — the cleanup events have already been sent to relay.
    // Removing the virtual entry here would undo the downgrade and leave
    // relay with no record of the tab.
    if (entry.state === 'virtual') {
      log.info('onDebuggerDetach: entry already virtual, skipping removal', tabId)
      return
    }
    void this.detach(tabId, reason)
  }

  // ── Private helpers ──

  #removeEntry(tabId) {
    const entry = this.#tabs.get(tabId)
    if (!entry) return
    if (entry.sessionId) this.#bySession.delete(entry.sessionId)
    if (entry.targetId) this.#byTarget.delete(entry.targetId)
    this.#tabs.delete(tabId)
    this.#indicators.removeTab(tabId)
    cleanupTabQueue(tabId)

    const children = this.#childSets.get(tabId)
    if (children) {
      for (const sid of children) this.#childSession.delete(sid)
      this.#childSets.delete(tabId)
    }
    void this.#persistTabs()
  }

  /**
   * Remove a tracked tab entry and notify relay with the appropriate event.
   * - virtual / attaching (never successfully attached) → Extension.tabRemoved
   * - connected (real physical target) → Target.detachedFromTarget
   *   For tab-closed specifically, also send Extension.tabRemoved(vtabId) as
   *   a belt-and-suspenders authoritative close signal so the relay can
   *   unconditionally delete the vtab entry even if reason field drifts.
   * After notification, the local entry is fully deleted.
   */
  removeTrackedEntry(tabId, reason) {
    const entry = this.#tabs.get(tabId)
    if (!entry) return
    // Only 'connected' is truly physical (has a real targetId from Chrome debugger).
    // 'attaching' is still mid-handshake with a vtab-* targetId — never broadcast
    // as attached, so should not broadcast detached either.
    const wasPhysical = entry.state === 'connected'
    if (wasPhysical && entry.targetId) {
      this.#sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: entry.sessionId, targetId: entry.targetId, reason },
        },
      })
      // True close: also send Extension.tabRemoved(vtabId) as authoritative signal.
      if (reason === 'tab-closed') {
        this.#notifyRemoved(entry.sessionId, toVtabId(tabId))
      }
    } else {
      this.#notifyRemoved(entry.sessionId, entry.targetId)
    }
    this.#removeEntry(tabId)
  }

  /**
   * Downgrade a physical entry back to virtual and notify relay.
   * Sends Target.detachedFromTarget for the old physical, then
   * Extension.tabDiscovered to re-register as virtual.
   * The local entry is updated in-place (not deleted).
   */
  downgradeToVirtual(tabId, reason) {
    const entry = this.#tabs.get(tabId)
    if (!entry) return
    if (entry.state !== 'connected') {
      log.info('downgradeToVirtual: skipping, entry not connected', tabId, entry.state)
      return
    }
    const oldTargetId = entry.targetId
    const oldSessionId = entry.sessionId
    // Notify relay: old physical is gone
    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: { sessionId: oldSessionId, targetId: oldTargetId, reason },
      },
    })
    // Clean up child session indexes (OOPIF / worker sessions from the
    // physical debugger session are no longer valid after downgrade).
    const children = this.#childSets.get(tabId)
    if (children) {
      for (const sid of children) this.#childSession.delete(sid)
      this.#childSets.delete(tabId)
    }
    // Update local state back to virtual
    const vtabTargetId = toVtabId(tabId)
    this.#byTarget.delete(oldTargetId)
    entry.state = 'virtual'
    entry.targetId = vtabTargetId
    this.#byTarget.set(vtabTargetId, tabId)
    // Notify relay: tab still exists as virtual
    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Extension.tabDiscovered',
        params: {
          sessionId: oldSessionId,
          targetInfo: {
            targetId: vtabTargetId, type: 'page',
            title: entry.title || '', url: entry.url || '', attached: false,
          },
        },
      },
    })
    void this.#persistTabs()
  }

  /**
   * Notify relay that a target/session it sent us is stale (route miss).
   * Called when resolveTabId() returns null — we have no local entry,
   * so we use the relay-provided sessionId/targetId to send the right cleanup event.
   */
  notifyStaleTarget(sessionId, targetId) {
    if (!sessionId && !targetId) return
    const isKnownVirtual = targetId && targetId.startsWith('vtab-')
    if (isKnownVirtual) {
      // Definitely virtual — tabRemoved is sufficient
      this.#notifyRemoved(sessionId, targetId)
    } else {
      // Either physical (has real targetId) or unknown (no targetId, only sessionId).
      // Send Target.detachedFromTarget so CDP clients get the detach broadcast,
      // then also send Extension.tabRemoved as belt-and-suspenders cleanup for
      // any virtual-only entries relay might hold under the same session/target.
      this.#sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId, targetId, reason: 'stale-route-miss' },
        },
      })
      this.#notifyRemoved(sessionId, targetId)
    }
    log.info('notifyStaleTarget: sent cleanup event for', { sessionId, targetId, isKnownVirtual })
  }

  #notifyRemoved(sessionId, targetId) {
    if (!sessionId && !targetId) return
    this.#sendToRelay({
      method: 'forwardCDPEvent',
      params: { method: 'Extension.tabRemoved', params: { sessionId, targetId } },
    })
  }
}
