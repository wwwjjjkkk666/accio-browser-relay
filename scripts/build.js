'use strict'

const fs = require('fs')
const path = require('path')
const obfuscator = require('javascript-obfuscator')

const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')

// Paths (relative to ROOT, posix-style) that must never be copied into dist/.
const EXCLUDE = new Set([
  '.git',
  'node_modules',
  'dist',
  'test',
  'docs',
  'scripts',
  'README.md',
  'package.json',
  'package-lock.json',
  '.gitignore',
  'pages/scripts/__tests__',
  'lib/cdp/tabs/manager.test.js',
])

function isExcluded(relPath) {
  const posixPath = relPath.split(path.sep).join('/')
  return EXCLUDE.has(posixPath)
}

// Tier A: files whose functions get toString()-serialized by
// chrome.scripting.executeScript({ func }) and re-evaluated standalone in the
// page. Must stay self-contained — no hoisted string-array decoder, no
// structural transforms that could leak an outside reference.
function isTierA(relPath) {
  const posixPath = relPath.split(path.sep).join('/')
  return posixPath.startsWith('lib/content_script/')
}

const COMMON_OPTIONS = {
  compact: true,
  renameGlobals: false,
  identifierNamesGenerator: 'hexadecimal',
  unicodeEscapeSequence: true,
  numbersToExpressions: true,
  simplify: true,
  transformObjectKeys: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  target: 'browser',
}

const TIER_A_OPTIONS = {
  ...COMMON_OPTIONS,
  stringArray: false,
  splitStrings: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
}

const TIER_B_OPTIONS = {
  ...COMMON_OPTIONS,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  rotateStringArray: true,
  shuffleStringArray: true,
  splitStrings: false,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
}

function copyRecursive(srcDir, destDir, relBase) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name)
    const relPath = relBase ? path.join(relBase, entry.name) : entry.name
    if (isExcluded(relPath)) continue

    const destPath = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true })
      copyRecursive(srcPath, destPath, relPath)
    } else {
      fs.mkdirSync(destDir, { recursive: true })
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function walkAndObfuscate(dir, relBase) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    const relPath = relBase ? path.join(relBase, entry.name) : entry.name
    if (entry.isDirectory()) {
      walkAndObfuscate(fullPath, relPath)
      continue
    }
    if (!entry.name.endsWith('.js')) continue

    const source = fs.readFileSync(fullPath, 'utf8')
    const options = isTierA(relPath) ? TIER_A_OPTIONS : TIER_B_OPTIONS
    const result = obfuscator.obfuscate(source, options).getObfuscatedCode()
    fs.writeFileSync(fullPath, result, 'utf8')
    const tierLabel = isTierA(relPath) ? 'A' : 'B'
    console.log(`  [${tierLabel}] ${relPath.split(path.sep).join('/')}`)
  }
}

function main() {
  fs.rmSync(DIST, { recursive: true, force: true })
  fs.mkdirSync(DIST, { recursive: true })

  console.log('Copying source files to dist/ ...')
  copyRecursive(ROOT, DIST, '')

  console.log('Obfuscating .js files ...')
  walkAndObfuscate(DIST, '')

  console.log(`\nDone. Output: ${DIST}`)
}

main()
