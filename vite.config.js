import { defineConfig } from 'vite'
import { resolve } from 'path'
import fs from 'fs'
import path from 'path'
import obfuscator from 'javascript-obfuscator'

// Obfuscator options matching the original build.js
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

// Pure JS recursive directory copying helper
function copyFolderRecursive(src, dest) {
  if (!fs.existsSync(src)) return
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyFolderRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    cssCodeSplit: false,
    rollupOptions: {
      // Only compile JS modules to avoid altering HTML & CSS paths
      input: {
        background: resolve(__dirname, 'background.js'),
        'content-script': resolve(__dirname, 'content-script.js'),
        'pages/scripts/popup': resolve(__dirname, 'pages/scripts/popup.js'),
        'pages/scripts/options': resolve(__dirname, 'pages/scripts/options.js'),
      },
      output: {
        preserveModules: true,
        preserveModulesRoot: __dirname,
        entryFileNames: '[name].js',
      }
    }
  },
  plugins: [
    {
      name: 'copy-extension-assets',
      closeBundle() {
        const outDir = 'dist'
        try {
          // 1. Copy manifest.json
          if (fs.existsSync('manifest.json')) {
            fs.copyFileSync('manifest.json', path.join(outDir, 'manifest.json'))
            console.log('Copied manifest.json')
          }

          // 2. Copy icons folder
          if (fs.existsSync('icons')) {
            copyFolderRecursive('icons', path.join(outDir, 'icons'))
            console.log('Copied icons/')
          }

          // 3. Copy HTML pages
          if (fs.existsSync('pages')) {
            const htmlFiles = fs.readdirSync('pages').filter(f => f.endsWith('.html'))
            for (const file of htmlFiles) {
              fs.copyFileSync(path.join('pages', file), path.join(outDir, 'pages', file))
            }
            console.log(`Copied HTML pages: ${htmlFiles.join(', ')}`)
          }

          // 4. Copy CSS stylesheets (preserving exact original path styles/options.css etc.)
          if (fs.existsSync('pages/styles')) {
            copyFolderRecursive('pages/styles', path.join(outDir, 'pages/styles'))
            console.log('Copied CSS stylesheets')
          }

          // 5. Copy and obfuscate classic JS scripts
          const classicScripts = ['security.js', 'install-i18n.js', 'install-helpers.js']
          fs.mkdirSync(path.join(outDir, 'pages/scripts'), { recursive: true })
          for (const file of classicScripts) {
            const srcPath = path.join('pages/scripts', file)
            const destPath = path.join(outDir, 'pages/scripts', file)
            if (fs.existsSync(srcPath)) {
              const code = fs.readFileSync(srcPath, 'utf8')
              const result = obfuscator.obfuscate(code, TIER_B_OPTIONS).getObfuscatedCode()
              fs.writeFileSync(destPath, result, 'utf8')
              console.log(`  [B] (Classic) pages/scripts/${file}`)
            }
          }
        } catch (e) {
          console.error('Error copying extension assets:', e)
          throw e
        }
      }
    },
    {
      name: 'vite-plugin-obfuscator',
      enforce: 'post',
      generateBundle(options, bundle) {
        console.log('Obfuscating JS module files ...')
        for (const [fileName, file] of Object.entries(bundle)) {
          if (file.type === 'chunk' && fileName.endsWith('.js')) {
            const isTierA = fileName.startsWith('lib/content_script/')
            const obfuscationOptions = isTierA ? TIER_A_OPTIONS : TIER_B_OPTIONS

            const result = obfuscator.obfuscate(file.code, obfuscationOptions)
            file.code = result.getObfuscatedCode()

            const tierLabel = isTierA ? 'A' : 'B'
            console.log(`  [${tierLabel}] ${fileName}`)
          }
        }
      }
    }
  ]
})
