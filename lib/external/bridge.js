/**
 * External Bridge — background.js 侧的连接管理
 *
 * App 通过 chrome.runtime.connect({ name: EXT_PORT_NAME }) 建立持久 port。
 * 每个连接对应一个 session。
 *
 * 支持的 method（由 App 侧发起）：
 *   Target.getTargets         — 获取已附加的标签页列表
 *   Target.attachToTarget     — 确保标签页已通过 chrome.debugger.attach
 *   Target.activateTarget     — 激活（focus）指定标签页
 *   Target.closeTarget        — 关闭指定标签页
 *   Target.openTarget         — 打开新标签页
 *   CDP.send                  — 向已附加的标签页发送 CDP 命令，结果透传回来
 *
 * 实现原理：
 *   - 上述命令路由到现有 mgr（TabManager）和 handleCdp（createDispatcher 的结果）
 *   - 不重新实现浏览器自动化；只作 port → 现有逻辑 的薄适配层
 */

import {
  MSG_HELLO, MSG_HELLO_ACK, MSG_CMD, MSG_RESULT, MSG_EVENT,
  EXT_PORT_NAME, PROTOCOL_VERSION,
} from './protocol.js'
import { createLogger } from '../logger.js'

const log = createLogger('ext-bridge')

/** @type {Set<chrome.runtime.Port>} */
const activePorts = new Set()

function readRuntimeLastErrorMessage() {
  try {
    return chrome.runtime.lastError?.message
  } catch {
    return undefined
  }
}

function postToPort(port, payload) {
  if (!activePorts.has(port)) return false
  try {
    port.postMessage(payload)
    return true
  } catch (e) {
    activePorts.delete(port)
    const message = e instanceof Error ? e.message : String(e)
    log.debug('Skip message to disconnected external port:', message)
    return false
  }
}

/**
 * 注册 external port 监听。
 * 在 background.js 顶层调用一次，传入 TabManager 实例和 CDP dispatcher。
 *
 * @param {import('../cdp/tabs/manager.js').TabManager} mgr
 * @param {(msg: any) => Promise<any>} handleCdp
 */
export function initExternalBridge(mgr, handleCdp) {
  if (!chrome.runtime.onConnectExternal) {
    log.warn('onConnectExternal not available — external bridge disabled')
    return
  }

  chrome.runtime.onConnectExternal.addListener((port) => {
    if (port.name !== EXT_PORT_NAME) {
      log.info('Rejecting unknown external port name:', port.name)
      port.disconnect()
      return
    }

    log.info('External port connected from', port.sender?.origin ?? port.sender?.url ?? 'unknown')
    activePorts.add(port)

    port.onMessage.addListener((msg) => {
      handlePortMessage(port, msg, mgr, handleCdp).catch((e) => {
        log.error('handlePortMessage error:', e)
      })
    })

    port.onDisconnect.addListener(() => {
      const lastErrorMessage = readRuntimeLastErrorMessage()
      activePorts.delete(port)
      log.info(
        lastErrorMessage
          ? `External port disconnected: ${lastErrorMessage}`
          : 'External port disconnected',
      )
    })
  })

  log.info('External bridge initialized, listening for connections')
}

/**
 * 向所有已连接的 App 广播扩展内部事件（debugger events 等）。
 * @param {string} method
 * @param {any} params
 */
export function broadcastEventToExternal(method, params) {
  for (const port of activePorts) {
    postToPort(port, { type: MSG_EVENT, method, params })
  }
}

/**
 * 处理单条来自 App 的消息。
 * @param {chrome.runtime.Port} port
 * @param {any} msg
 * @param {import('../cdp/tabs/manager.js').TabManager} mgr
 * @param {(msg: any) => Promise<any>} handleCdp
 */
async function handlePortMessage(port, msg, mgr, handleCdp) {
  if (!msg || typeof msg !== 'object') return

  // 握手
  if (msg.type === MSG_HELLO) {
    let tabCount = 0
    try { tabCount = mgr.size } catch { /* ignore */ }
    postToPort(port, {
      type: MSG_HELLO_ACK,
      version: PROTOCOL_VERSION,
      tabCount,
    })
    return
  }

  if (msg.type !== MSG_CMD) return

  const { id, method, params } = msg
  if (!id || !method) return

  try {
    const result = await dispatchExternalCommand(method, params ?? {}, mgr, handleCdp)
    postToPort(port, { type: MSG_RESULT, id, result })
  } catch (e) {
    postToPort(port, {
      type: MSG_RESULT,
      id,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

/**
 * 将 App 侧发来的命令路由到现有 Tab Manager / CDP dispatcher。
 * @param {string} method
 * @param {any} params
 * @param {import('../cdp/tabs/manager.js').TabManager} mgr
 * @param {(msg: any) => Promise<any>} handleCdp
 */
async function dispatchExternalCommand(method, params, mgr, handleCdp) {
  switch (method) {
    case 'Target.getTargets': {
      const targets = []
      for (const [tabId, entry] of mgr.entries()) {
        targets.push({
          tabId,
          targetId: entry.targetId ?? String(tabId),
          url: entry.url ?? '',
          title: entry.title ?? '',
          state: entry.state,
          isAgent: mgr.isAgent(tabId),
          isRetained: mgr.isRetained(tabId),
        })
      }
      return { targetInfos: targets }
    }

    case 'Target.attachToTarget': {
      // ensureAttached: 如果是 vtab- 前缀，触发 attach 并返回真实 targetId
      const { targetId } = params
      if (!targetId) throw new Error('targetId is required')
      // 使用现有 relay ensureTargetAttached 逻辑（通过 handleCdp 路由）
      const res = await handleCdp({
        method: 'forwardCDPCommand',
        params: { method: 'Extension.ensureAttach', params: { targetId } },
      })
      return res ?? { sessionId: targetId }
    }

    case 'Target.activateTarget': {
      const { targetId } = params
      if (!targetId) throw new Error('targetId is required')
      await handleCdp({
        method: 'forwardCDPCommand',
        params: { method: 'Target.activateTarget', params: { targetId } },
      })
      return { activated: true }
    }

    case 'Target.closeTarget': {
      const { targetId } = params
      if (!targetId) throw new Error('targetId is required')
      await handleCdp({
        method: 'forwardCDPCommand',
        params: { method: 'Target.closeTarget', params: { targetId } },
      })
      return { success: true }
    }

    case 'Target.openTarget': {
      const { url, createInWindow, retain } = params
      // dispatch.js 的 handleForwardCdpCommand 读取 msg.params.method，
      // 所以必须包一层 forwardCDPCommand 结构，内部 method 用 Target.createTarget
      const res = await handleCdp({
        method: 'forwardCDPCommand',
        params: {
          method: 'Target.createTarget',
          params: { url, createInWindow: !!createInWindow, retain: !!retain },
        },
      })
      return res
    }

    case 'CDP.send': {
      // 透传任意 CDP 命令到已附加标签页
      const { targetId, cdpMethod, cdpParams } = params
      if (!targetId || !cdpMethod) throw new Error('targetId and cdpMethod are required')
      const res = await handleCdp({
        method: 'forwardCDPCommand',
        params: { targetId, method: cdpMethod, params: cdpParams ?? {} },
      })
      return res
    }

    default:
      throw new Error(`Unknown external command method: ${method}`)
  }
}
