/**
 * External Bridge — Protocol Constants
 *
 * App 侧（puppeteer-core/browser runtime）通过 chrome.runtime.connect() 建立
 * 持久 external port，与扩展 background.js 通信。
 *
 * 消息格式：
 *   App→Extension: { type: 'tydbuddy.ext.cmd', id, method, params? }
 *   Extension→App: { type: 'tydbuddy.ext.result', id, result?, error? }
 *   Extension→App: { type: 'tydbuddy.ext.event', method, params }
 *   Handshake:     { type: 'tydbuddy.ext.hello' } / { type: 'tydbuddy.ext.helloAck', version, tabCount }
 */

export const EXT_PORT_NAME = 'tydbuddy.browser.external.v1'

export const MSG_HELLO = 'tydbuddy.ext.hello'
export const MSG_HELLO_ACK = 'tydbuddy.ext.helloAck'
export const MSG_CMD = 'tydbuddy.ext.cmd'
export const MSG_RESULT = 'tydbuddy.ext.result'
export const MSG_EVENT = 'tydbuddy.ext.event'

export const PROTOCOL_VERSION = 1
