/**
 * Relay connection management.
 *
 * 3-state model:
 *   disabled     — relay off, badge empty
 *   disconnected — relay enabled but WS not open, badge …, auto-reconnecting
 *   connected    — relay enabled + WS open, badge ON
 *
 * Timer strategy (MV3 compatible):
 *   All deferred work uses chrome.alarms instead of setTimeout/setInterval
 *   so that timers survive Service Worker suspension.
 *
 *   Alarm names:
 *     relayKeepAlive        — 1-min heartbeat, created when relay is enabled
 *     relayReconnect        — exponential-backoff reconnect delay
 *     relayDisconnectNotify — delayed disconnect notification (5 s)
 */

import { RelayState, STATE_UI, DEFAULT_CONTROL_PORT, RELAY_PORT_OFFSET, clampPort, computeRelayPort } from '../../constants.js'
import { setIconWithDot } from '../../icon-badge.js'
import { createLogger } from '../../logger.js'
import { prepareSessionKey, activateEncryption, resetEncryption, encryptMessage, decryptMessage, isEncryptionActive } from '../../crypto.js'

const log = createLogger('relay')

// Service Worker 启动时缓存版本号，避免运行期间磁盘 manifest 变化导致不一致
const LOADED_VERSION = chrome.runtime.getManifest().version

const WS_CONNECT_TIMEOUT = 5000
const PREFLIGHT_TIMEOUT = 2000
const HANDSHAKE_TIMEOUT = 5000
const DISCONNECT_NOTIFY_DELAY_MIN = 5 / 60 // 5 seconds in minutes (chrome.alarms minimum granularity is ~1 s via delayInMinutes)

// ── Alarm names (centralized) ──

const ALARM_KEEP_ALIVE = 'relayKeepAlive'
const ALARM_RECONNECT = 'relayReconnect'
const ALARM_DISCONNECT_NOTIFY = 'relayDisconnectNotify'

// ── Operation log ring buffer (O(1) push, O(n) read) ──
const LOG_BUFFER_MAX = 200
const _logRing = new Array(LOG_BUFFER_MAX)
let _logHead = 0   // next write position
let _logCount = 0   // total entries written (clamped to max)

function pushLog(direction, method, detail) {
  _logRing[_logHead] = { ts: Date.now(), dir: direction, method, detail }
  _logHead = (_logHead + 1) % LOG_BUFFER_MAX
  if (_logCount < LOG_BUFFER_MAX) _logCount++
}

export function getLogBuffer(limit = 100) {
  const n = Math.min(limit, _logCount)
  const result = new Array(n)
  // read oldest-first: start = (head - count) mod max, then advance
  let idx = (_logHead - _logCount + LOG_BUFFER_MAX) % LOG_BUFFER_MAX
  const skip = _logCount - n
  idx = (idx + skip) % LOG_BUFFER_MAX
  for (let i = 0; i < n; i++) {
    result[i] = _logRing[idx]
    idx = (idx + 1) % LOG_BUFFER_MAX
  }
  return result
}

// ── State model ──

let _state = RelayState.DISABLED

function setState(newState) {
  _state = newState
  const ui = STATE_UI[newState]
  void setIconWithDot(ui.dotColor).catch(() => {})
  void chrome.action.setTitle({ title: ui.title })
  void chrome.storage.local.set({ _relayState: newState })
}

export function getRelayState() {
  return _state
}

// ── Self-reload (auto-update support) ──
//
// 桌面端在 Extension.helloAck 里下发 { action: 'reload', reloadTargetKey }
// 来请求扩展调用 chrome.runtime.reload() 拾取磁盘上的新版文件。
//
// 守卫策略（防 reload 循环）：
//   chrome.storage.local.relayReloadState = { targetKey, at }
//   - 如果上次 reload 针对同一个 targetKey 且距今 < RELOAD_COOLDOWN_MS，跳过
//   - 否则写入新 state 然后 reload（500ms 延迟给 storage flush 留时间）
//
// targetKey 格式：
//   'ext:<version>'  — extensionVersion 不一致
//   'proto:<n>'      — protocolVersion 不兼容
const RELOAD_STORAGE_KEY = 'relayReloadState'
const RELOAD_COOLDOWN_MS = 10 * 60 * 1000 // 10 分钟，避免磁盘未更新时无限 reload
const RELOAD_DEBOUNCE_MS = 500             // 给日志/storage 写入 flush 的缓冲

let _reloadScheduled = false

async function maybeSelfReload(targetKey) {
  log.info('maybeSelfReload: in')
  if (_reloadScheduled) return

  // 防御：ext:<version> 类型用启动时缓存的版本号自验证，
  // 避免运行期间磁盘 manifest 已更新但 Service Worker 还是旧代码的误判
  if (targetKey.startsWith('ext:')) {
    const wanted = targetKey.slice(4)
    if (LOADED_VERSION === wanted) {
      log.info(`maybeSelfReload: loaded version ${LOADED_VERSION} already matches target, skip`)
      return
    }
  }

  try {
    const store = await chrome.storage.local.get([RELOAD_STORAGE_KEY])
    const prev = store[RELOAD_STORAGE_KEY]
    if (
      prev &&
      prev.targetKey === targetKey &&
      typeof prev.at === 'number' &&
      Date.now() - prev.at < RELOAD_COOLDOWN_MS
    ) {
      const ageMin = ((Date.now() - prev.at) / 60000).toFixed(1)
      log.warn(
        `maybeSelfReload: cooldown active for targetKey=${targetKey} (last attempt ${ageMin}min ago) — skip`,
      )
      return
    }

    await chrome.storage.local.set({
      [RELOAD_STORAGE_KEY]: { targetKey, at: Date.now() },
    })
  } catch (err) {
    log.warn('maybeSelfReload: storage failed, aborting', err)
    return
  }

  _reloadScheduled = true
  log.info(`maybeSelfReload: scheduling chrome.runtime.reload() for targetKey=${targetKey}`)
  setTimeout(() => {
    try {
      chrome.runtime.reload()
    } catch (err) {
      log.error('maybeSelfReload: chrome.runtime.reload() threw', err)
      _reloadScheduled = false
    }
  }, RELOAD_DEBOUNCE_MS)
}

// ── Notifications ──

function notifyError(title, message) {
  chrome.notifications.create('accio-relay-error', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `Accio Relay: ${title}`,
    message,
    priority: 2,
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[accio-relay] notification create failed:', chrome.runtime.lastError.message)
    }
  })
}

// ── Port helpers ──

async function getControlPort() {
  const stored = await chrome.storage.local.get(['controlPort', 'relayPort'])
  const raw = Number.parseInt(String(stored.controlPort || ''), 10)
  if (Number.isFinite(raw) && raw > 0 && raw <= 65535) return raw
  const relayRaw = Number.parseInt(String(stored.relayPort || ''), 10)
  if (Number.isFinite(relayRaw) && relayRaw > 0 && relayRaw <= 65535) {
    const inferred = clampPort(relayRaw - RELAY_PORT_OFFSET)
    void chrome.storage.local.set({ controlPort: inferred })
    return inferred
  }
  return DEFAULT_CONTROL_PORT
}

// ── Multi-port auto-detect ──

// Alternate relay port to probe alongside the default
const ALT_RELAY_PORT = DEFAULT_CONTROL_PORT + 1 + RELAY_PORT_OFFSET

async function getRelayPort() {
  return computeRelayPort(await getControlPort())
}

/**
 * Whether to race multiple candidate ports.
 * Returns true only when the user hasn't manually configured a port.
 */
async function shouldProbeMultiplePorts() {
  return (await getControlPort()) === DEFAULT_CONTROL_PORT
}

// ── Relay enabled persistence ──

export async function setRelayEnabled(enabled) {
  await chrome.storage.local.set({ relayEnabled: enabled })
}

export async function isRelayEnabled() {
  const stored = await chrome.storage.local.get(['relayEnabled'])
  return stored.relayEnabled === true
}

// ── Connection state ──

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null
/** @type {AbortController|null} */
let connectAbortCtrl = null

// Handshake gate: ensureConnection waits for helloAck before resolving,
// so that onConnected callbacks only fire after encryption is active.
/** @type {((value?: any) => void)|null} */
let _handshakeResolve = null
/** @type {((reason?: any) => void)|null} */
let _handshakeReject = null

let reconnectAttempt = 0

/**
 * Reset the exponential-backoff counter so the next reconnect starts fresh.
 * Called when the keepAlive alarm fires while disconnected — the SW may have
 * been suspended and resumed, so stale backoff state should not penalize the
 * next attempt.
 */
export function resetReconnectBackoff() {
  reconnectAttempt = 0
}

/**
 * Callbacks injected by background.js at init time.
 *
 * onShutdown(reason) merges the old onClosed + onDisabled into a single
 * atomic callback so callers can handle group dissolution and tab cleanup
 * in one place, avoiding ordering bugs.
 *
 * @type {{ onMessage: (msg: any) => Promise<any>, onShutdown: (reason: 'connectionLost'|'disabled') => Promise<any>|void, onConnected: () => void, installDebuggerListeners: () => void }}
 */
let callbacks = {
  onMessage: async () => null,
  onShutdown: async (_reason) => {},
  onConnected: () => {},
  installDebuggerListeners: () => {},
}

export function initRelay(cbs) {
  callbacks = { ...callbacks, ...cbs }
}

// ── Derived state queries ──

export function isRelayConnected() {
  return relayWs !== null && relayWs.readyState === WebSocket.OPEN
}

export function isRelayActive() {
  return isRelayConnected() || relayConnectPromise !== null ||
    (relayWs !== null && relayWs.readyState === WebSocket.CONNECTING)
}

export function isReconnecting() {
  return _reconnectPending
}

// ── Messaging ──

// Sequential send chain to ensure message ordering when encryption is active.
// Web Crypto API is always async; chaining ensures encrypted messages
// are sent in the same order as the corresponding sendToRelay calls.
let _sendChain = Promise.resolve()

export function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Relay not connected')
  }
  pushLog('↑', payload.method || `id:${payload.id}`, payload.params?.method || payload.error || '')
  const raw = JSON.stringify(payload)
  if (isEncryptionActive()) {
    _sendChain = _sendChain.then(async () => {
      const encrypted = await encryptMessage(raw)
      if (ws.readyState === WebSocket.OPEN) ws.send(encrypted)
    }).catch(() => {})
  } else {
    ws.send(raw)
  }
}

export function trySendToRelay(payload) {
  try {
    sendToRelay(payload)
  } catch (err) {
    console.debug('[accio-relay] trySendToRelay failed:', err)
  }
}

// ── Alarm-based timer management ──

/**
 * Ensure the keep-alive alarm exists. Safe to call multiple times —
 * chrome.alarms.create with the same name replaces the previous alarm.
 */
export function ensureKeepAliveAlarm() {
  chrome.alarms.create(ALARM_KEEP_ALIVE, { periodInMinutes: 0.5 })
}

function clearKeepAliveAlarm() {
  chrome.alarms.clear(ALARM_KEEP_ALIVE)
}

let _reconnectPending = false

function cancelReconnect() {
  _reconnectPending = false
  chrome.alarms.clear(ALARM_RECONNECT)
}

function cancelDisconnectNotify() {
  chrome.alarms.clear(ALARM_DISCONNECT_NOTIFY)
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.serverUnreachable] — when true the relay server was
 *   not reachable (preflight failed). We still back off, but cap the delay at
 *   a short ceiling so the extension retries quickly once the desktop app
 *   starts.  reconnectAttempt is still incremented so the delay ramps up to
 *   the cap, but uses a separate (lower) cap to avoid long waits.
 */
function scheduleReconnect(opts) {
  if (_reconnectPending) return
  const serverUnreachable = opts?.serverUnreachable === true

  const baseMs = 500
  const maxMs = serverUnreachable ? 3_000 : 30_000
  const baseDelay = Math.min(maxMs, baseMs * Math.pow(2, reconnectAttempt))
  let delay = baseDelay + Math.floor(Math.random() * Math.min(baseDelay, 1000))
  if (!Number.isFinite(delay) || delay < baseMs) delay = baseMs

  reconnectAttempt++

  _reconnectPending = true
  // chrome.alarms minimum delay is ~1 second; convert ms → minutes
  const delayInMinutes = Math.max(delay / 60_000, 1 / 60)
  chrome.alarms.create(ALARM_RECONNECT, { delayInMinutes })
}

/**
 * Handle alarm events relevant to relay connection.
 * Called from background.js onAlarm listener.
 * Returns true if the alarm was handled.
 */
export function handleConnectionAlarm(alarmName) {
  if (alarmName === ALARM_RECONNECT) {
    _reconnectPending = false
    // connectAndAttach auto-schedules reconnect on failure
    void connectAndAttach()
    return true
  }

  if (alarmName === ALARM_DISCONNECT_NOTIFY) {
    if (_state === RelayState.DISCONNECTED) {
      notifyError('Disconnected', 'Relay connection lost. Auto-reconnecting…')
    }
    return true
  }

  return false
}

// ── WebSocket connection ──

let debuggerListenersInstalled = false

/**
 * Connect to a single relay port: HEAD preflight → WebSocket open.
 * @param {number} port
 * @param {AbortSignal} signal - allows the caller to cancel (e.g. when another port wins the race)
 * @returns {Promise<WebSocket>}
 */
function connectToPort(port, signal) {
  const httpBase = `http://127.0.0.1:${port}`
  const wsUrl = `ws://127.0.0.1:${port}/extension`

  return (async () => {
    const preflightCtrl = new AbortController()
    const preflightTimer = setTimeout(() => preflightCtrl.abort(), PREFLIGHT_TIMEOUT)
    if (signal) signal.addEventListener('abort', () => preflightCtrl.abort(), { once: true })
    try {
      await fetch(`${httpBase}/`, { method: 'HEAD', signal: preflightCtrl.signal })
        .catch((err) => {
          if (signal.aborted) throw new Error('Connection cancelled')
          throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`)
        })
    } finally {
      clearTimeout(preflightTimer)
    }

    if (signal.aborted) throw new Error('Connection cancelled')

    const ws = new WebSocket(wsUrl)

    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), WS_CONNECT_TIMEOUT)
        const cleanup = () => { clearTimeout(t); signal.removeEventListener('abort', onAbort) }
        const onAbort = () => { cleanup(); reject(new Error('Connection cancelled')) }
        signal.addEventListener('abort', onAbort, { once: true })
        ws.onopen = () => { cleanup(); resolve() }
        ws.onerror = () => { cleanup(); reject(new Error('WebSocket connect failed')) }
        ws.onclose = (ev) => { cleanup(); reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`)) }
      })
    } catch (err) {
      try { ws.close() } catch { /* already closing */ }
      throw err
    }

    if (signal.aborted) {
      try { ws.close() } catch { /* noop */ }
      throw new Error('Connection cancelled')
    }

    return ws
  })()
}

/**
 * Race multiple candidate ports in parallel via Promise.any.
 * First port to complete preflight + WS open wins; losers are aborted and closed.
 * Falls back to single-port connect when only one candidate.
 *
 * @param {number[]} ports
 * @param {AbortSignal} signal
 * @returns {Promise<WebSocket>}
 */
async function raceConnectPorts(ports, signal) {
  if (ports.length === 1) return connectToPort(ports[0], signal)

  const perPort = ports.map((port) => {
    const ctrl = new AbortController()
    signal.addEventListener('abort', () => ctrl.abort(), { once: true })
    return { port, ctrl, promise: connectToPort(port, ctrl.signal) }
  })

  const winner = await Promise.any(perPort.map(async (entry) => {
    const ws = await entry.promise
    return { ws, port: entry.port }
  }))

  for (const entry of perPort) {
    if (entry.port !== winner.port) {
      entry.ctrl.abort()
      entry.promise.then((ws) => { try { ws.close() } catch {} }).catch(() => {})
    }
  }

  log.info('connected to relay port', winner.port)
  return winner.ws
}

async function ensureConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  const currentAbortCtrl = new AbortController()
  connectAbortCtrl = currentAbortCtrl
  const { signal } = currentAbortCtrl

  relayConnectPromise = (async () => {
    const defaultPort = await getRelayPort()
    const multiProbe = await shouldProbeMultiplePorts()
    const ports = multiProbe && ALT_RELAY_PORT !== defaultPort
      ? [ALT_RELAY_PORT, defaultPort]
      : [defaultPort]

    const ws = await raceConnectPorts(ports, signal)

    relayWs = ws
    ws.onmessage = (event) => void onRelayMessage(String(event.data || ''))
    ws.onclose = () => { if (relayWs === ws) onRelayClosed('closed') }
    ws.onerror = () => { if (relayWs === ws) onRelayClosed('error') }

    // Handshake: send Extension.hello so the server knows our protocol version.
    //
    // protocolVersion: 桌面端与扩展之间的通信协议兼容性标识（整数），
    //   与 manifest.json 中的 version（展示版本号）是两个独立概念。
    //   仅在通信协议发生不兼容变更时才递增。
    //
    // extensionVersion: 从 manifest.json 读取的展示版本号，
    //   仅用于 mismatch 时桌面端展示给用户，不参与兼容性判断。
    //
    // encryptedSessionKey: AES-256 session key encrypted with the embedded RSA public key.
    //   If present, the server will decrypt and enable transport encryption.
    //   If absent (old extension), communication continues in plaintext.
    //
    // ⚠️ 如果升级 protocolVersion，必须同步修改以下位置：
    //   1. 此处的 protocolVersion 值
    //   2. 桌面端 server.ts — 搜索 `protocolVersion !== 1` 和 `requiredProtocol: 1`
    //      路径: packages/sdk/src/browser/relay/server.ts
    const helloParams = { protocolVersion: 1, extensionVersion: LOADED_VERSION, extensionId: chrome.runtime.id }
    try {
      const { encryptedSessionKey } = await prepareSessionKey()
      helloParams.encryptedSessionKey = encryptedSessionKey
      log.info('Prepared encrypted session key for handshake')
    } catch (err) {
      log.warn('Failed to prepare session key — handshake will proceed without encryption:', err)
    }
    ws.send(JSON.stringify({
      method: 'Extension.hello',
      params: helloParams,
    }))

    // Wait for helloAck to confirm encryption before resolving.
    await new Promise((resolve, reject) => {
      _handshakeResolve = resolve
      _handshakeReject = reject
      setTimeout(() => {
        if (_handshakeReject === reject) {
          _handshakeResolve = null
          _handshakeReject = null
          try { ws.close(4002, 'Handshake timeout') } catch { /* ignore */ }
          reject(new Error('Handshake timeout — no helloAck received'))
        }
      }, HANDSHAKE_TIMEOUT)
    })

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true
      callbacks.installDebuggerListeners()
    }
  })()

  try {
    await relayConnectPromise
  } finally {
    if (connectAbortCtrl === currentAbortCtrl) connectAbortCtrl = null
    relayConnectPromise = null
  }
}

function onRelayClosed(reason) {
  log.info('onRelayClosed:', reason)
  if (_handshakeReject) {
    _handshakeReject(new Error(`Connection closed during handshake: ${reason}`))
    _handshakeResolve = null
    _handshakeReject = null
  }
  relayWs = null
  resetEncryption()
  _sendChain = Promise.resolve()

  void Promise.resolve(callbacks.onShutdown('connectionLost')).catch((err) => {
    log.warn('onRelayClosed: onShutdown error:', err)
  })

  setState(RelayState.DISCONNECTED)

  cancelDisconnectNotify()
  chrome.alarms.create(ALARM_DISCONNECT_NOTIFY, { delayInMinutes: DISCONNECT_NOTIFY_DELAY_MIN })

  void (async () => {
    if (await isRelayEnabled()) scheduleReconnect()
  })()
}

async function onRelayMessage(rawText) {
  let text = rawText
  try {
    text = await decryptMessage(rawText)
  } catch (err) {
    log.warn('decryptMessage failed, dropping:', err)
    return
  }
  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  if (msg?.method === 'ping') {
    trySendToRelay({ method: 'pong' })
    return
  }

  // 处理桌面端对 Extension.hello 的应答。
  // status === 'ok' 表示协议版本匹配，连接可正常使用；
  // 其他状态（如 'version_mismatch'）表示桌面端要求更高的 protocolVersion，
  // 此时桌面端会主动关闭 WebSocket（4001），扩展侧触发 onRelayClosed 重连。
  //
  // 自动升级：当 params.action === 'reload' 且带上 reloadTargetKey 时，
  // 扩展尝试 chrome.runtime.reload()（unpacked 模式会重新读磁盘上的新版文件）。
  // 两种触发来源统一走 maybeSelfReload：
  //   - protocolVersion 不匹配 → reloadTargetKey = 'proto:<n>'（随后 ws 会被关闭）
  //   - extensionVersion 不一致但协议兼容 → reloadTargetKey = 'ext:<version>'（连接保持可用）
  // 桌面端主动要求扩展 reload（独立于 helloAck 的显式指令）
  if (msg?.method === 'Extension.reload') {
    log.info('Extension.reload: received reload command from desktop')
    void maybeSelfReload(msg.params?.reloadTargetKey || 'ext:forced')
    return
  }

  if (msg?.method === 'Extension.helloAck') {
    const p = msg.params || {}
    if (p.status === 'ok') {
      if (p.encrypted === true) {
        activateEncryption()
        void chrome.storage.local.remove('_relayError')
        log.info('Extension.helloAck: handshake OK — transport encryption activated (AES-256-GCM)')
        if (_handshakeResolve) {
          _handshakeResolve()
          _handshakeResolve = null
          _handshakeReject = null
        }
      } else {
        log.warn('Extension.helloAck: server does not support encryption — disconnecting')
        void chrome.storage.local.set({
          _relayError: 'encryption_unsupported',
        })
        if (_handshakeReject) {
          _handshakeReject(new Error('Server does not support encryption'))
          _handshakeResolve = null
          _handshakeReject = null
        }
        disconnect()
        return
      }
    } else {
      log.warn('Extension.helloAck: server rejected —', p.status)
      if (_handshakeReject) {
        _handshakeReject(new Error(`Server rejected handshake: ${p.status}`))
        _handshakeResolve = null
        _handshakeReject = null
      }
    }
    if (p.action === 'reload' && typeof p.reloadTargetKey === 'string' && p.reloadTargetKey.length > 0) {
      void maybeSelfReload(p.reloadTargetKey)
    }
    return
  }

  const MESSAGE_EXPIRE_MS = 130_000
  if (typeof msg?.ts === 'number') {
    const age = Date.now() - msg.ts
    if (age > MESSAGE_EXPIRE_MS) {
      log.warn('dropping expired message:', msg.method || msg.id, 'age:', age, 'ms')
      if (typeof msg.id === 'number') {
        trySendToRelay({ id: msg.id, error: `Message expired (age ${age}ms > ${MESSAGE_EXPIRE_MS}ms)` })
      }
      return
    }
  }

  if (typeof msg?.id === 'number' && msg.method === 'forwardCDPCommand') {
    const cdpMethod = msg.params?.method || ''
    pushLog('↓', msg.method, cdpMethod)
    try {
      const result = await callbacks.onMessage(msg)
      trySendToRelay({ id: msg.id, result })
    } catch (err) {
      trySendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

// ── Public lifecycle methods ──

/**
 * Attempt to connect. On failure, automatically schedules reconnect
 * if relay is still enabled — callers do NOT need to call scheduleReconnect.
 */
export async function connectAndAttach() {
  const t0 = performance.now()
  log.debug('connectAndAttach: begin, connected:', isRelayConnected(), 'reconnecting:', _reconnectPending)
  if (isRelayConnected()) return true
  if (_reconnectPending) { log.debug('connectAndAttach: reconnect already scheduled, skip'); return false }
  if (!(await isRelayEnabled())) { log.debug('connectAndAttach: relay not enabled'); return false }
  try {
    await ensureConnection()
    log.info('connectAndAttach: connected in', (performance.now() - t0).toFixed(1), 'ms')
    cancelDisconnectNotify()
    setState(RelayState.CONNECTED)
    reconnectAttempt = 0
    void callbacks.onConnected()
    return true
  } catch (err) {
    log.warn('connectAndAttach: failed in', (performance.now() - t0).toFixed(1), 'ms', err)
    if (await isRelayEnabled()) {
      const msg = err instanceof Error ? err.message : String(err)
      const serverUnreachable = msg.includes('not reachable') || msg.includes('AbortError')
      scheduleReconnect({ serverUnreachable })
    }
    return false
  }
}

/**
 * Disable relay: close WS, cancel timers, set state to disabled.
 *
 * The sync neutralization block (relayWs = null, cancel timers, abort connect)
 * runs BEFORE any await so that isRelayConnected() returns false immediately.
 *
 * onShutdown('disabled') handles both group dissolution and tab cleanup
 * atomically — the callback decides internally what to do based on the reason.
 */
export async function disconnect() {
  const t0 = performance.now()
  log.info('disconnect: begin, current state:', _state, 'ws:', relayWs ? 'open' : 'null')
  void chrome.storage.local.remove('_relayError')

  if (_handshakeReject) {
    _handshakeReject(new Error('Relay disabled during handshake'))
    _handshakeResolve = null
    _handshakeReject = null
  }

  const wsToClose = relayWs
  relayWs = null
  resetEncryption()
  _sendChain = Promise.resolve()

  cancelReconnect()
  reconnectAttempt = 0
  cancelDisconnectNotify()
  clearKeepAliveAlarm()

  if (connectAbortCtrl) {
    connectAbortCtrl.abort()
    connectAbortCtrl = null
  }
  relayConnectPromise = null

  if (wsToClose) {
    log.debug('disconnect: closing WebSocket')
    try { wsToClose.close() } catch { /* ignore */ }
  }

  log.debug('disconnect: awaiting storage write + shutdown...')
  await Promise.all([
    setRelayEnabled(false),
    Promise.resolve(callbacks.onShutdown('disabled')).catch((err) => {
      log.warn('disconnect: onShutdown(disabled) failed:', err)
    }),
  ])

  log.info('disconnect: done in', (performance.now() - t0).toFixed(1), 'ms')

  setState(RelayState.DISABLED)
}

export async function toggle() {
  const t0 = performance.now()
  if (_state !== RelayState.DISABLED) {
    await disconnect()
    log.info('toggle: disconnect done in', (performance.now() - t0).toFixed(1), 'ms')
    return
  }

  await setRelayEnabled(true)
  ensureKeepAliveAlarm()
  setState(RelayState.DISCONNECTED)

  try {
    cancelReconnect()
    await ensureConnection()
    cancelDisconnectNotify()
    setState(RelayState.CONNECTED)
    void callbacks.onConnected()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('cancelled')) return
    console.warn('[accio-relay] initial connect failed:', message)
    notifyError('Connection Failed', `${message}\n\nRetrying automatically…`)
    scheduleReconnect()
  }
}

export async function initFromStorage() {
  if (await isRelayEnabled()) {
    ensureKeepAliveAlarm()
    setState(RelayState.DISCONNECTED)
  }
}


