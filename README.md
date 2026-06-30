# Accio Browser Relay — Chrome Extension

Connect the Accio Work agent to your Chrome browser so it can see and interact with web pages via CDP (Chrome DevTools Protocol).

## Installation

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked** → select this `assets/chrome-extension` folder
4. Pin the extension to the toolbar for easy access

## Usage

1. Make sure Accio is running with browser control enabled
2. Click the toolbar icon — badge shows **ON** when connected
3. Navigate to any webpage
4. Send a browser-related query to Accio — it can now control your tabs

## Temporary Pre-Release Hosts

`manifest.json` currently allows `https://pre-www.accio.com/*` and `https://local.accio.com/*` for pre-release testing. Remove these two hosts from both `externally_connectable.matches` and `content_scripts.matches` before production release.

## File Structure

```
accio-browser-relay/
├── background.js              # Service worker entry — relay lifecycle, event listeners
├── manifest.json              # Extension manifest (MV3)
├── options.html               # Options page — usage guide & advanced settings
├── lib/
│   ├── cdp/                   # CDP command dispatch (modular)
│   │   ├── index.js           #   Barrel export
│   │   ├── dispatch.js        #   Main routing: Target/Extension/CDP forwarding
│   │   ├── target-ops.js      #   Target.* commands (create, close, activate tabs)
│   │   ├── extension-ops.js   #   Extension.* virtual commands (viewport, content, elements, DOM)
│   │   └── utils.js           #   Shared constants + withTimeout
│   ├── tab-manager.js         # TabManager class — tab state, discovery, agent tracking, spinner
│   ├── debugger-attach.js     # Low-level chrome.debugger API operations
│   ├── relay.js               # WebSocket relay connection management
│   ├── constants.js           # Shared constants and enums
│   ├── logger.js              # Debug logger utility
│   └── options.js             # Options page logic
├── install/                   # Installation guide pages (extension + direct CDP)
├── styles/
│   └── options.css            # Options page styles
└── icons/                     # Extension icons (16, 32, 48, 128)
```

## Badge States

| Badge | Color | Meaning |
|-------|-------|---------|
| **ON** | Purple | Connected and ready |
| **…** | Yellow | Connecting to relay server |
| **!** | Red | Connection failed |
| *(empty)* | — | Relay is off |

## Features

- **One-click toggle**: Click to connect, click again to disconnect (works in any state)
- **Auto-reconnect**: Exponential backoff reconnection when relay drops
- **Persistent**: Stays active across browser restarts
- **Cancellable**: Mid-connection clicks properly abort and clean up
- **Tab safety**: Agent can only close tabs it created
- **Auto-attach**: All compatible tabs are attached when relay connects

## Troubleshooting

| Symptom | Solution |
|---------|----------|
| Red `!` badge | Make sure Accio is running with browser control enabled |
| Page not responding | Internal pages (`chrome://`, extensions) can't be controlled — use a regular webpage |
| Stuck on `…` | Click the icon to cancel, then click again to retry |

---

## `manifest.json` Configuration Reference

```jsonc
{
  "manifest_version": 3,          // MV3 (required for modern Chrome extensions)
  "name": "Accio Browser Relay",  // Display name in chrome://extensions
  "version": "0.1.0",             // Extension version (semver)
  "description": "...",           // Short description

  "icons": {                      // Extension icons at various sizes
    "16": "icons/icon16.png",     //   Favicon, context menus
    "32": "icons/icon32.png",     //   Windows toolbar
    "48": "icons/icon48.png",     //   Extensions management page
    "128": "icons/icon128.png"    //   Chrome Web Store, install dialog
  },

  "permissions": [
    "debugger",       // Chrome DevTools Protocol access (core functionality)
    "tabs",           // Query/create/update/remove tabs
    "tabGroups",      // Manage tab groups (agent tab grouping + spinner)
    "windows",        // Create/focus windows for new tabs
    "activeTab",      // Access the currently active tab
    "scripting",      // Inject scripts for Extension.* commands (content, elements, click, input)
    "storage",        // Persist settings (port, enabled state)
    "alarms",         // Keep-alive timer for service worker
    "notifications"   // Error notifications when relay disconnects
  ],

  "host_permissions": [
    "<all_urls>"      // Required for chrome.scripting.executeScript on any page
  ],

  "background": {
    "service_worker": "background.js",  // MV3 service worker (replaces background page)
    "type": "module"                    // ES module support (import/export)
  },

  "action": {
    "default_title": "Accio Browser Relay (click to attach/detach)",
    "default_icon": { ... }    // Toolbar icon (same as extension icons)
  },

  "options_ui": {
    "page": "options.html",    // Options page URL
    "open_in_tab": true        // Open in a new tab (vs popup)
  }
}
```

### Additional Available Permissions

These are **not used** by this extension but available for future features:

| Permission | Use Case |
|------------|----------|
| `webNavigation` | Monitor page navigation events |
| `contextMenus` | Add right-click menu items |
| `downloads` | Manage file downloads |
| `cookies` | Read/write cookies |
| `webRequest` | Intercept/modify network requests |
| `offscreen` | Create offscreen documents for background processing |

### MV3 Service Worker Notes

- Service workers can be suspended at any time by Chrome
- The `alarms` permission + keep-alive alarm prevents premature suspension
- All event listeners must be registered synchronously at startup (top-level)
- ES modules (`"type": "module"`) enable `import`/`export` for code splitting
