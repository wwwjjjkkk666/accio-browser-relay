// 重新注入时（插件安装/更新后对已打开 tab 的补注入），先清理旧实例的 listener，
// 避免同一 isolated world 内出现重复监听。
if (window._accioCSCleanup) {
  try {
    window._accioCSCleanup()
  } catch {
    // old instance cleanup may throw if its context was already invalidated
  }
}

function isContextValid() {
  try {
    return !!chrome.runtime?.id
  } catch {
    return false
  }
}

function postReady() {
  if (!isContextValid()) return
  try {
    window.postMessage(
      {
        type: 'accio.extension.ready',
        extensionId: chrome.runtime.id,
        extensionVersion: chrome.runtime.getManifest().version,
      },
      window.location.origin,
    )
  } catch {
    // extension context invalidated — ignore
  }
}

const _onMessage = (event) => {
  if (event.source !== window) return
  const data = event.data
  if (!data) return
  if (!isContextValid()) return
  if (data.type === 'accio.extension.request') {
    postReady()
    return
  }
  if (data.type === 'accio.extension.status.request') {
    try {
      chrome.runtime.sendMessage({ type: 'getRelayStatus' }, (status) => {
        try {
          if (chrome.runtime.lastError) return
          window.postMessage(
            {
              type: 'accio.extension.status',
              status,
            },
            window.location.origin,
          )
        } catch {
          // page may have entered bfcache or the extension context may be invalidated
        }
      })
    } catch {
      // extension context invalidated — ignore
    }
    return
  }
  if (data.type === 'accio.extension.openInstallGuide') {
    try {
      chrome.runtime.sendMessage({
        type: 'openInstallGuide',
        lang: typeof data.lang === 'string' ? data.lang : undefined,
      })
    } catch {
      // extension context invalidated — ignore
    }
  }
}

window.addEventListener('message', _onMessage)
window._accioCSCleanup = () => window.removeEventListener('message', _onMessage)

postReady()
