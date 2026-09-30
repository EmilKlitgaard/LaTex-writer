import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createCanvas, type Canvas } from '@napi-rs/canvas'
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

/**
 * Several pages side by side in one small image, each labelled with its page number: enough to
 * judge page breaks, where figures landed and empty space, for about the cost of one page.
 */
export async function renderSheet(file: string, pageNumbers: number[], tileHeight = 420): Promise<{ png: Buffer; width: number; height: number; pages: number }> {
  const doc = await load(file)
  const wanted = [...new Set(pageNumbers.map((n) => Math.floor(n)))].filter((n) => n >= 1 && n <= doc.numPages)
  if (!wanted.length) throw new Error(`None of those pages exist. The PDF has ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}.`)
  const tiles: { canvas: Canvas; n: number }[] = []
  for (const n of wanted) {
    const page = await doc.getPage(n)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: tileHeight / base.height })
    const canvas: Canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise
    tiles.push({ canvas, n })
  }
  const gap = 8
  const columns = Math.min(4, tiles.length)
  const rows = Math.ceil(tiles.length / columns)
  const tileWidth = Math.max(...tiles.map((t) => t.canvas.width))
  const sheet: Canvas = createCanvas(columns * tileWidth + (columns + 1) * gap, rows * tileHeight + (rows + 1) * gap)
  const ctx = sheet.getContext('2d')
  ctx.fillStyle = '#8a8f96'
  ctx.fillRect(0, 0, sheet.width, sheet.height)
  tiles.forEach((t, i) => {
    const x = gap + (i % columns) * (tileWidth + gap)
    const y = gap + Math.floor(i / columns) * (tileHeight + gap)
    ctx.drawImage(t.canvas, x, y)
    ctx.fillStyle = '#c92a2a'
    ctx.fillRect(x, y, 42, 20)
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 14px sans-serif'
    ctx.fillText(`p.${t.n}`, x + 5, y + 15)
  })
  return { png: sheet.toBuffer('image/png'), width: sheet.width, height: sheet.height, pages: doc.numPages }
}

export type PageGeometry = {
  page: number
  /** How far down the page the last line of body text reaches, as a fraction of the page height. */
  textEndsAt: number
  lines: number
  /** Figure and table captions: their label and vertical position (fraction from the top). */
  captions: { label: string; at: number }[]
}

const CAPTION = /^(Figure|Fig\.|Table|Figur|Tabel|Tabelle|Abbildung)\s*\d+[.:]?/i

/** Where text sits on each page, read from the PDF itself. Lets layout be checked without images. */
export async function pageGeometry(file: string, firstPage = 1, lastPage = Infinity): Promise<{ pages: PageGeometry[]; total: number }> {
  const doc = await load(file)
  const first = Math.max(1, Math.floor(firstPage))
  const last = Math.min(doc.numPages, Math.floor(lastPage), first + 59)
  const pages: PageGeometry[] = []
  for (let n = first; n <= last; n++) {
    const page = await doc.getPage(n)
    const height = page.getViewport({ scale: 1 }).height
    const content = await page.getTextContent()
    let lowest = height
    let lines = 0
    const captions: PageGeometry['captions'] = []
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue
      const y = item.transform[5]
      const fromTop = 1 - y / height
      // A lone page number in the footer says nothing about how full the page is.
      if (fromTop > 0.88 && /^[\divxlc]+$/i.test(item.str.trim())) continue
      lines += item.hasEOL ? 1 : 0
      lowest = Math.min(lowest, y)
      const caption = CAPTION.exec(item.str.trim())
      if (caption) captions.push({ label: caption[0].replace(/[.:]$/, ''), at: Math.round(fromTop * 100) / 100 })
    }
    pages.push({ page: n, textEndsAt: lowest === height ? 0 : Math.round((1 - lowest / height) * 100) / 100, lines, captions })
  }
  return { pages, total: doc.numPages }
}

/** Lines of the PDF text that contain the query, with their page numbers. */
export async function searchText(file: string, query: string, limit = 60): Promise<{ hits: string[]; total: number; pages: number }> {
  const doc = await load(file)
  const needle = query.toLowerCase()
  const hits: string[] = []
  let total = 0
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent()
    let line = ''
    const flush = (): void => {
      if (line.toLowerCase().includes(needle)) {
        total++
        if (hits.length < limit) hits.push(`p.${n}: ${line.trim().slice(0, 220)}`)
      }
      line = ''
    }
    for (const item of content.items) {
      if (!('str' in item)) continue
      line += item.str
      if (item.hasEOL) flush()
    }
    flush()
  }
  return { hits, total, pages: doc.numPages }
}
