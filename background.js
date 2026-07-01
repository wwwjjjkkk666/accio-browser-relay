/**
 * TydBuddy Browser Relay — MV3 Service Worker entry point.
 *
 * Thin orchestration layer: wires up relay, tabs, and CDP modules,
 * then registers Chrome event listeners.
 *
 * CDP channel            → lib/cdp/            (WebSocket relay, tab management, CDP dispatch)
 * Content Script channel → lib/content_script/  (DOM interaction via chrome.scripting)
 */

import {
  TabManager,
  createDispatcher,
  initRelay,
  trySendToRelay,
  isRelayConnected,
  isRelayActive,
  isRelayEnabled,
  isReconnecting,
  getRelayState,
  toggle,
  disconnect,
  connectAndAttach,
  initFromStorage,
  setRelayEnabled,
  getLogBuffer,
  ensureKeepAliveAlarm,
  handleConnectionAlarm,
  resetReconnectBackoff,
} from './lib/cdp/index.js'
import { RelayState, SETTINGS_KEYS, getSetting } from './lib/constants.js'
import { createLogger, setDebug } from './lib/logger.js'
import { initExternalBridge } from './lib/external/bridge.js'

setDebug(true)

const log = createLogger('bg')

// ── Wire modules together ──

const mgr = new TabManager(trySendToRelay)
const handleCdp = createDispatcher(mgr)

initRelay({
  async onMessage(msg) {
    return handleCdp(msg)
  },
  async onShutdown(reason) {
    log.info('onShutdown callback:', reason)
    if (reason === 'connectionLost') {
      log.info('onShutdown: connectionLost — preserving tab/debugger state for reconnect')
      mgr.stopSessionIndicators()
      return
    }
    let dissolveGroup = false
    if (reason === 'disabled') {
      const shouldClose = await getSetting(SETTINGS_KEYS.CLOSE_GROUP_ON_DISABLE)
      log.info('onShutdown: closeGroupOnDisable setting =', shouldClose)
      if (shouldClose) {
        log.info('onShutdown: dissolving agent tab group per user setting')
        dissolveGroup = true
      }
    }
    await mgr.shutdown({ dissolveGroup })
    log.info('onShutdown: done, dissolveGroup =', dissolveGroup)
  },
  async onConnected() {
    log.info('onConnected callback: discovering tabs (lazy attach)')
    await mgr.loadCancelled()
    const restored = await mgr.loadTabs()
    if (restored) {
      try { await mgr.reconcileTabs() } catch (e) { log.warn('reconcileTabs failed:', e) }
    }
    mgr.startSessionIndicators()
    mgr.resyncAttachedTabs()
    void mgr.discoverAll(isRelayConnected)
  },
  installDebuggerListeners() {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      mgr.onDebuggerEvent(source, method, params)
    })
    chrome.debugger.onDetach.addListener((source, reason) => {
      log.info('chrome.debugger.onDetach:', source.tabId, reason)
      mgr.onDebuggerDetach(source, reason)
      if (reason === 'canceled_by_user' && source.tabId) {
        mgr.markCancelled(source.tabId)
      }
    })
  },
})

// ── External bridge (App layer via chrome.runtime.connect) ──
initExternalBridge(mgr, handleCdp)

// ── Helpers ──

async function handleToggle() {
  log.info('handleToggle: state =', getRelayState())
  if (getRelayState() === RelayState.DISABLED) {
    await toggle()
  } else {
    await disconnect()
  }
  log.info('handleToggle: done, state =', getRelayState())
}

// ── Event listeners ──

chrome.tabs.onActivated.addListener(() => {
  if (getRelayState() === RelayState.DISABLED || isRelayConnected() || isReconnecting()) return
  void connectAndAttach()
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!isRelayConnected()) return

  if (mgr.has(tabId) && (changeInfo.title || changeInfo.url)) {
    mgr.updateTab(tabId, changeInfo.url, changeInfo.title)
  }

  if (changeInfo.status === 'complete') {
    mgr.discover(tabId, tab.url, tab.title)
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  mgr.deleteAgent(tabId)
  mgr.removeCancelled(tabId)
  if (!mgr.has(tabId)) return
  void mgr.detach(tabId, 'tab-closed')
})

// Keep-alive alarm: created conditionally, cleared on disconnect.
void (async () => {
  if (await isRelayEnabled()) {
    ensureKeepAliveAlarm()
  }
})()

chrome.alarms.onAlarm.addListener((alarm) => {
  // Let connection module handle reconnect / disconnect-notify alarms
  if (handleConnectionAlarm(alarm.name)) return

  // Let session indicators handle idle-check alarm
  if (mgr.handleIndicatorAlarm(alarm.name)) return

  if (alarm.name !== 'relayKeepAlive') return

  if (isRelayConnected()) {
    trySendToRelay({ method: 'ping' })
    return
  }
  if (isReconnecting()) return

  // SW may have restarted — in-memory state is DISABLED but storage says enabled.
  // Reset backoff so stale exponential delays from a previous SW lifetime
  // don't cause a long wait before the first reconnect attempt.
  if (getRelayState() === RelayState.DISABLED || getRelayState() === RelayState.DISCONNECTED) {
    void (async () => {
      if (getRelayState() === RelayState.DISABLED) {
        await initFromStorage()
      }
      if (await isRelayEnabled()) {
        log.info('alarm: relay enabled but disconnected, attempting reconnect')
        resetReconnectBackoff()
        await connectAndAttach()
      }
    })()
  }
})

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await initFromStorage()
    if (!(await isRelayEnabled())) return
    console.info('[tydbuddy-relay] browser started with relay enabled, attempting connection')
    await connectAndAttach()
  })()
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'getRelayStatus') {
    chrome.tabs.query({}, (tabs) => {
      sendResponse({
        state: getRelayState(),
        connected: isRelayConnected(),
        active: isRelayActive(),
        reconnecting: isReconnecting(),
        tabCount: tabs.length,
        totalTabs: tabs.length,
        attachedTabs: mgr.size,
        agentTabs: mgr.agentTabCount,
        retainedTabs: mgr.retainedTabCount,
      })
    })
    return true
  }
  if (msg?.type === 'toggleRelay') {
    handleToggle()
      .then(() => {
        try { sendResponse({ state: getRelayState() }) } catch { /* channel closed */ }
      })
      .catch((e) => {
        log.error('handleToggle failed:', e)
        try { sendResponse({ state: getRelayState(), error: e?.message }) } catch { /* channel closed */ }
      })
    return true
  }
  if (msg?.type === 'getTabList') {
    const tabs = []
    for (const [tabId, entry] of mgr.entries()) {
      tabs.push({
        tabId,
        state: entry.state,
        sessionId: entry.sessionId,
        targetId: entry.targetId,
        url: entry.url || '',
        title: entry.title || '',
        isAgent: mgr.isAgent(tabId),
        isRetained: mgr.isRetained(tabId),
      })
    }
    sendResponse({ tabs })
    return false
  }
  if (msg?.type === 'openInstallGuide') {
    const lang = typeof msg.lang === 'string' && msg.lang ? msg.lang : 'en'
    const url = chrome.runtime.getURL(`pages/install-extension.html?lang=${encodeURIComponent(lang)}`)
    chrome.tabs.create({ url })
    sendResponse({ ok: true })
    return false
  }
  if (msg?.type === 'getLogs') {
    sendResponse({ logs: getLogBuffer(msg.limit || 100) })
    return false
  }
})

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    if (details.reason === 'install') {
      await setRelayEnabled(true)
      void chrome.runtime.openOptionsPage()
    }

    ensureKeepAliveAlarm()
    log.info('onInstalled:', details.reason, '— attempting connection')
    await connectAndAttach()
  })()
})
