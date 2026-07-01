# TydBuddy Browser Relay — Chrome Extension

Connect the TydBuddy Work agent to your Chrome browser so it can see and interact with web pages via CDP (Chrome DevTools Protocol).

## Installation

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked** → select this `tydbuddy-browser-relay` folder
4. Pin the extension to the toolbar for easy access

## Usage

1. Make sure TydBuddy is running with browser control enabled
2. Click the toolbar icon — badge shows **ON** when connected
3. Navigate to any webpage
4. Send a browser-related query to TydBuddy — it can now control your tabs

## Temporary Pre-Release Hosts

`manifest.json` currently allows `https://pre-www.tydbuddy.com/*` and `https://local.tydbuddy.com/*` for pre-release testing. Remove these two hosts from both `externally_connectable.matches` and `content_scripts.matches` before production release.

## File Structure

```
tydbuddy-browser-relay/
├── background.js              # Service worker entry — relay lifecycle, event listeners
├── content-script.js          # Injected script — page-to-extension bridge
├── manifest.json              # Extension manifest (MV3)
├── lib/
│   ├── cdp/                   # CDP protocol logic
│   │   ├── commands/          #   CDP commands (Target, viewport, DOM actions)
│   │   ├── events/            #   CDP event interceptors
│   │   ├── relay/             #   Relay connection manager
│   │   └── tabs/              #   Tab management, groups, indicators, debugger attaching
│   ├── constants.js           # Shared constants and enums
│   ├── crypto.js              # Transport encryption helpers (Web Crypto API)
│   └── logger.js              # Debug logger utility
├── pages/                     # Extension UI pages (Popup, Options, Guides)
│   ├── scripts/               #   UI page scripts and unit tests
│   ├── styles/                #   UI styles (popup, options, guides)
│   ├── compare-methods.html   #   Direct CDP vs Extension comparison guide
│   ├── install-direct-cdp.html#   Direct CDP guide
│   ├── install-extension.html #   Extension guide
│   ├── options.html           #   Options page
│   ├── popup.html             #   Toolbar popup page
│   └── reinstall-extension.html#  Reinstall/Upgrade guide
└── test/
    └── cdp-events-test.html   # CDP event handlers test page
```

## Badge States

The toolbar icon shows the current relay connection status:

| Badge | State | Description | Action if stuck |
|---|---|---|---|
| **ON** (Blue) | Connected | Active WebSocket connection with local relay | Ready to use |
| **…** (Yellow) | Connecting | Searching for active relay server | Check if TydBuddy app is running |
| **OFF** (Grey) | Disabled | Relay is switched off by user | Toggle extension switch to connect |
| Red `!` badge | Error | Cannot connect or handshake failed | Make sure TydBuddy is running with browser control enabled |

---

## `manifest.json` Configuration Reference

```jsonc
{
  "manifest_version": 3,            // MV3 (required for modern Chrome extensions)
  "name": "TydBuddy Browser Relay", // Display name in chrome://extensions
  "version": "0.1.0",               // Extension version (semver)
  "description": "...",             // Short description

  "icons": {                        // Extension icons at various sizes
    "16": "icons/icon16.png",       //   Favicon, context menus
    "32": "icons/icon32.png",       //   Windows toolbar
    "48": "icons/icon48.png",       //   Extensions management page
    "128": "icons/icon128.png"      //   Chrome Web Store, install dialog
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
    "default_title": "TydBuddy Browser Relay",
    "default_icon": { ... }             // Toolbar icon
  },

  "options_ui": {
    "page": "pages/options.html",       // Options page URL
    "open_in_tab": true                 // Open in a new tab (vs popup)
  }
}
```

### MV3 Service Worker Notes

- Service workers can be suspended at any time by Chrome
- The `alarms` permission + keep-alive alarm prevents premature suspension
- All event listeners must be registered synchronously at startup (top-level)
- ES modules (`"type": "module"`) enable `import`/`export` for code splitting
