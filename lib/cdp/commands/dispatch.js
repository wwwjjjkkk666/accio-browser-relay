/**
 * CDP command dispatch — main routing logic.
 *
 * Routes incoming forwardCDPCommand messages to the appropriate handler:
 *   Target.*     → target-ops.js   (tab creation, closing, activation)
 *   Extension.*  → content_script/extension-ops.js (viewport, content, elements, actions)
 *   Other CDP    → chrome.debugger.sendCommand (transparent forwarding)
 *
 * @param {import('../tabs/manager.js').TabManager} mgr
 * @returns {(msg: any) => Promise<any>}
 */

import { createTargetOps } from './target-ops.js'
import {
  extGetViewportInfo, extEnsureZoom, extCaptureViewport,
  extExtractContent, extMarkElements, extClick, extInput,
} from '../../content_script/extension-ops.js'
import { RUNTIME_ENABLE_DELAY, CDP_COMMAND_TIMEOUT, withTimeout } from './utils.js'

const MAX_QUEUE_DEPTH = 100
const _tabQueues = new Map()

function getTabQueue(tabId) {
  if (!tabId) return null
  let q = _tabQueues.get(tabId)
  if (!q) {
    q = { running: false, queue: [] }
    _tabQueues.set(tabId, q)
  }
  return q
}

async function processQueue(q) {
  if (q.running) return
  q.running = true
  try {
    while (q.queue.length > 0) {
      const { task, resolve, reject } = q.queue.shift()
      try {
        resolve(await task())
      } catch (err) {
        reject(err)
      }
    }
  } finally {
    q.running = false
  }
}

function enqueueForTab(tabId, task) {
  const q = getTabQueue(tabId)
  if (!q) return task()
  if (q.queue.length >= MAX_QUEUE_DEPTH) {
    return Promise.reject(new Error(`Tab ${tabId} command queue full (${MAX_QUEUE_DEPTH})`))
  }
  return new Promise((resolve, reject) => {
    q.queue.push({ task, resolve, reject })
    processQueue(q)
  })
}

export function cleanupTabQueue(tabId) {
  _tabQueues.delete(tabId)
}

export function cleanupAllTabQueues() {
  _tabQueues.clear()
}

export function createDispatcher(mgr) {

  const { cdpCreateTarget, cdpCloseTarget, cdpCloseAllAgentTabs, cdpActivateTarget } = createTargetOps(mgr)

  async function cdpRuntimeEnable(debuggee, params) {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, RUNTIME_ENABLE_DELAY))
    } catch (err) {
      console.debug('[accio-relay] Runtime.disable pre-step failed:', err)
    }
    return withTimeout(
      chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params),
      CDP_COMMAND_TIMEOUT,
      'Runtime.enable',
    )
  }

  return async function handleForwardCdpCommand(msg) {
    const method = String(msg?.params?.method || '').trim()
    const params = msg?.params?.params || undefined
    const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined
    // targetId 可能在顶层 msg.params.targetId（来自 external bridge CDP.send），
    // 也可能在 msg.params.params.targetId（来自 relay 桌面端路径）
    const targetId =
      (typeof msg?.params?.targetId === 'string' ? msg.params.targetId : undefined) ??
      (typeof params?.targetId === 'string' ? params.targetId : undefined)

    // Global: must run BEFORE resolveTabId — these commands don't target a specific tab.
    if (
      method === 'Extension.dissolveAllAgentTabGroupsCloseAll' ||
      method === 'Target.dissolveAllAgentTabGroupsCloseAll'
    ) {
      return mgr.closeAllAccioAgentGroupTabs()
    }
    const tabId = mgr.resolveTabId(sessionId, targetId)

    // ── Tab activation: bypass the per-tab queue ──
    // These commands use Chrome extension APIs (chrome.windows.update, chrome.tabs.update)
    // that don't require the renderer to respond. They must NOT be queued behind
    // renderer-blocking CDP commands (e.g. Runtime.callFunctionOn, Page.screenshot)
    // because when a tab is minimized/backgrounded, those commands hang and the queue
    // never reaches the activation command — creating a deadlock.
    if (method === 'Target.activateTarget' || method === 'Page.bringToFront') {
      if (!tabId) {
        mgr.notifyStaleTarget(sessionId, targetId)
        throw new Error(`No attached tab for method ${method}`)
      }
      return cdpActivateTarget(params, tabId)
    }

    return enqueueForTab(tabId, async () => {
      // ── Target.* commands (no tabId required for createTarget) ──
      if (method === 'Target.createTarget') return cdpCreateTarget(params)
      if (method === 'Target.closeAllAgentTabs') return cdpCloseAllAgentTabs()

      if (!tabId) {
        // Notify relay to clean up stale connectedTargets before returning error.
        // We don't have a local entry, so use the sessionId/targetId from the request
        // to tell relay which entry to remove.
        mgr.notifyStaleTarget(sessionId, targetId)
        throw new Error(`No attached tab for method ${method}`)
      }

      mgr.onCdpCommand?.(tabId)

      if (method === 'Target.closeTarget') return cdpCloseTarget(params, tabId)

      // ── Extension.* virtual commands ──
      if (method === 'Extension.getViewportInfo') {
        await mgr.ensureAttached(tabId)
        return extGetViewportInfo(tabId)
      }
      if (method === 'Extension.ensureZoom') return extEnsureZoom(tabId, params)
      if (method === 'Extension.captureViewport') {
        await mgr.ensureAttached(tabId)
        return extCaptureViewport(tabId, params)
      }
      if (method === 'Extension.extractContent') return extExtractContent(tabId)
      if (method === 'Extension.markElements') return extMarkElements(tabId, params)
      if (method === 'Extension.click') return extClick(tabId, params)
      if (method === 'Extension.input') return extInput(tabId, params)
      // vtab 自动附加：桌面端 browser tool 发现 targetId 是虚拟标签页（vtab-*）时，
      // 通过 relay 调用此命令让扩展执行 chrome.debugger.attach，将虚拟标签页升级为物理附加。
      // 返回附加后的真实 targetId 和 sessionId，供后续 CDP 命令使用。
      // 调用链：browser.ts autoAttachVtab() → relay ensureTargetAttached() → 此处
      if (method === 'Extension.ensureAttach') {
        const ok = await mgr.ensureAttached(tabId)
        if (!ok) throw new Error(`Failed to attach tab ${tabId}`)
        const entry = mgr.get(tabId)
        return { targetId: entry?.targetId, sessionId: entry?.sessionId }
      }

      // ── Standard CDP forwarding (requires debugger attach) ──
      const ok = await mgr.ensureAttached(tabId)
      if (!ok) throw new Error(`Failed to attach debugger to tab ${tabId} for ${method}`)

      /** @type {chrome.debugger.DebuggerSession} */
      const debuggee = { tabId }

      const tabState = mgr.get(tabId)
      const mainSessionId = tabState?.sessionId
      const debuggerSession =
        sessionId && mainSessionId && sessionId !== mainSessionId
          ? { ...debuggee, sessionId }
          : debuggee

      try {
        if (method === 'Runtime.enable') return await cdpRuntimeEnable(debuggee, params)

        return await withTimeout(
          chrome.debugger.sendCommand(debuggerSession, method, params),
          CDP_COMMAND_TIMEOUT,
          method,
        )
      } catch (cmdErr) {
        // Secondary confirmation: if the command failed, check whether the tab/debugger
        // is actually gone and send appropriate cleanup events to relay.
        try {
          const tabStillExists = await chrome.tabs.get(tabId).then(() => true, () => false)
          if (!tabStillExists) {
            mgr.removeTrackedEntry(tabId, 'tab-closed')
            mgr.deleteAgent(tabId)
          } else {
            // Tab exists — check if debugger is still attached
            const dbgTargets = await chrome.debugger.getTargets()
            const stillAttached = dbgTargets.some(t => t.tabId === tabId && t.attached)
            if (!stillAttached && tabState?.state === 'connected') {
              mgr.downgradeToVirtual(tabId, 'debugger-gone')
            }
          }
        } catch {
          // Best-effort: don't mask the original error
        }
        throw cmdErr
      }
    })
  }
}
