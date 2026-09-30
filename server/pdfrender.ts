import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'

// Reads the compiled PDF for the assistant: as plain text (cheap) or as a page image (for layout).

const pdfjsDir = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))

type Loaded = { file: string; mtimeMs: number; doc: PDFDocumentProxy }
let cache: Loaded | null = null

async function load(file: string): Promise<PDFDocumentProxy> {
  const mtimeMs = fs.statSync(file).mtimeMs
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.doc
  void cache?.doc.loadingTask.destroy()
  cache = null
  const doc = await getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    standardFontDataUrl: path.join(pdfjsDir, 'standard_fonts') + path.sep,
    cMapUrl: path.join(pdfjsDir, 'cmaps') + path.sep,
    cMapPacked: true,
    wasmUrl: path.join(pdfjsDir, 'wasm') + path.sep,
    verbosity: 0,
  }).promise
  cache = { file, mtimeMs, doc }
  return doc
}

export async function pageCount(file: string): Promise<number> {
  return (await load(file)).numPages
}

export type RenderOptions = {
  /** Longest edge of the full page in pixels. Image cost grows with the pixel count. */
  maxEdge?: number
  /** Vertical slice of the page as fractions from the top, e.g. 0 to 0.5 for the upper half. */
  from?: number
  to?: number
}

/** Renders one page (or a horizontal band of it) to PNG. */
export async function renderPage(file: string, pageNumber: number, opts: RenderOptions = {}): Promise<{ png: Buffer; width: number; height: number; pages: number }> {
  const doc = await load(file)
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) {
    throw new Error(`Page ${pageNumber} does not exist. The PDF has ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}.`)
  }
  const page = await doc.getPage(pageNumber)
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(4, Math.max(200, Math.min(2400, opts.maxEdge ?? 1200)) / Math.max(base.width, base.height))
  const viewport = page.getViewport({ scale })
  const from = Math.max(0, Math.min(1, opts.from ?? 0))
  const to = Math.max(from + 0.05, Math.min(1, opts.to ?? 1))
  const width = Math.ceil(viewport.width)
  const top = Math.floor(viewport.height * from)
  const height = Math.ceil(viewport.height * to) - top
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport,
    transform: top ? [1, 0, 0, 1, 0, -top] : undefined,
  }).promise
  return { png: canvas.toBuffer('image/png'), width, height, pages: doc.numPages }
}

/** The text of a page range, one block per page. Far cheaper for a model to read than an image. */
export async function extractText(file: string, firstPage = 1, lastPage = Infinity): Promise<{ text: string; pages: number }> {
  const doc = await load(file)
  const first = Math.max(1, Math.floor(firstPage))
  const last = Math.min(doc.numPages, Math.floor(lastPage))
  const out: string[] = []
  for (let n = first; n <= last; n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    let text = ''
    for (const item of content.items) {
      if (!('str' in item)) continue
      text += item.str
      if (item.hasEOL) text += '\n'
    }
    out.push(`--- page ${n} ---\n${text.trim()}`)
  }
  return { text: out.join('\n\n'), pages: doc.numPages }
}
