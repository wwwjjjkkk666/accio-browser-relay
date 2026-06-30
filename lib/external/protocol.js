/**
 * External Bridge — Protocol Constants
 *
 * App 侧（puppeteer-core/browser runtime）通过 chrome.runtime.connect() 建立
 * 持久 external port，与扩展 background.js 通信。
 *
 * 消息格式：
 *   App→Extension: { type: 'accio.ext.cmd', id, method, params? }
 *   Extension→App: { type: 'accio.ext.result', id, result?, error? }
 *   Extension→App: { type: 'accio.ext.event', method, params }
 *   Handshake:     { type: 'accio.ext.hello' } / { type: 'accio.ext.helloAck', version, tabCount }
 */

export const EXT_PORT_NAME = 'accio.browser.external.v1'

export const MSG_HELLO = 'accio.ext.hello'
export const MSG_HELLO_ACK = 'accio.ext.helloAck'
export const MSG_CMD = 'accio.ext.cmd'
export const MSG_RESULT = 'accio.ext.result'
export const MSG_EVENT = 'accio.ext.event'

export const PROTOCOL_VERSION = 1
