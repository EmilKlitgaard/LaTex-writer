import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'

// Build output lives outside iCloud, next to the dependencies.
const appHome = process.env.LATEXWRITER_HOME ?? path.join(os.homedir(), 'Library/Application Support/LaTeXWriter')
const outDir = path.join(appHome, 'build/web')

/** PDF.js loads character maps, fallback fonts and image decoders at run time; ship them so the app works offline. */
function pdfjsAssets(): Plugin {
  return {
    name: 'pdfjs-assets',
    apply: 'build',
    closeBundle() {
      const from = fs.realpathSync(path.resolve(import.meta.dirname, 'node_modules/pdfjs-dist'))
      for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
        fs.cpSync(path.join(from, dir), path.join(outDir, 'pdfjs', dir), { recursive: true })
      }
    },
  }
}

export default defineConfig({
  root: 'web',
  base: './',
  plugins: [pdfjsAssets()],
  build: {
    outDir,
    emptyOutDir: true,
    target: 'safari17',
    chunkSizeWarningLimit: 4000,
  },
})
