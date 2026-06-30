import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

function loadSecurity() {
  const scriptPath = join(import.meta.dir, '..', 'security.js')
  const source = readFileSync(scriptPath, 'utf8')
  const sandbox = { window: {} }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: scriptPath })
  return sandbox.window.AccioSecurity
}

describe('AccioSecurity.escapeHtml', () => {
  test('escapes HTML metacharacters for HTML sinks', () => {
    const security = loadSecurity()

    expect(security.escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;',
    )
  })

  test('normalizes nullish values before escaping', () => {
    const security = loadSecurity()

    expect(security.escapeHtml(null)).toBe('')
    expect(security.escapeHtml(undefined)).toBe('')
  })
})
