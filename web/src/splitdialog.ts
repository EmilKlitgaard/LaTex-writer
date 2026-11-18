import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { api } from './api.ts'
import { app, OS } from './app.ts'
import { clear, h, icon, openModal, store, toast } from './dom.ts'
import { openPdfDocument } from './pdfview.ts'
import { cleanCuts, cutBefore, findFurniture, inkRuns, normalizeCut, pageRange, planParts, snapCut, type Cut, type Furniture, type PageInk, type Piece } from './splitplan.ts'

// The advanced exporter: saves the PDF as several PDFs, cut where you choose.
//
// It opens on one cut, just before the abstract, and offers the document's own contents (its
// bookmarks, or its headings when it has none) as quick picks. Cuts can also be placed and dragged
// right on the page preview; they snap to the blank space between lines, so nothing is ever cut
// in half. A cut in the middle of a page moves the rest of that page to the top of the next part.

/** Pages are measured at this scale (pixels per point) to find the blank space between lines. */
const ANALYSIS_SCALE = 2
/** Width in device pixels of the page images in the preview. */
const THUMB_PX = 360
/** The heading of an abstract, in the languages LaTeX's babel prints most often. */
const ABSTRACT_WORDS = new Set(['abstract', 'summary', 'resume', 'résumé', 'resumé', 'sammenfatning', 'sammendrag', 'resumen', 'zusammenfassung', 'samenvatting', 'sammanfattning', 'tiivistelmä', 'riassunto', 'resumo', 'streszczenie'])
const PART_COLORS = 6

type TextLine = { text: string; top: number; size: number }
/** A place the quick pick offers: just before the abstract or a heading. */
type Target = { id: string; label: string; level: number; page: number; y: number; abstract: boolean }
/** A cut the user has (normalised: at a page start, or between two lines of a page). */
type SplitPoint = { id: number; cut: Cut; target: string | null }
type Analyzed = { ink: PageInk; thumb: HTMLCanvasElement }

const norm = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '')
const ABSTRACT_NORM = new Set([...ABSTRACT_WORDS].map(norm))
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** The text of a page as lines, top to bottom, with their height and size. */
async function textLines(page: PDFPageProxy): Promise<TextLine[]> {
  const vp = page.getViewport({ scale: 1 })
  // Not page.getTextContent(): that reads the stream with for await, which Safari's streams do not support.
  const reader = page.streamTextContent().getReader()
  const items: unknown[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    items.push(...(value as { items: unknown[] }).items)
  }
  const rows: { y: number; size: number; parts: { x: number; s: string }[] }[] = []
  for (const item of items as Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items']) {
    if (!('str' in item) || !item.str.trim()) continue
    const [a, b, c, d, e, f] = item.transform as number[]
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0) continue // rotated text is no heading
    const size = Math.abs(d) || item.height
    const [x, y] = vp.convertToViewportPoint(e, f)
    let row = rows.find((r) => Math.abs(r.y - y) < Math.max(1.5, Math.min(r.size, size) * 0.3))
    if (!row) rows.push((row = { y, size, parts: [] }))
    row.size = Math.max(row.size, size)
    row.parts.push({ x, s: item.str })
  }
  return rows.sort((p, q) => p.y - q.y).map((r) => ({
    text: r.parts.sort((p, q) => p.x - q.x).map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim(),
    top: r.y - r.size * 0.8,
    size: r.size,
  }))
}

/** The size most of the text is set in. */
function bodySize(lines: TextLine[][]): number {
  const count = new Map<number, number>()
  for (const l of lines.flat()) {
    const k = Math.round(l.size * 2) / 2
    count.set(k, (count.get(k) ?? 0) + l.text.length)
  }
  let best = 10, most = -1
  for (const [k, n] of count) if (n > most) [best, most] = [k, n]
  return best
}

/**
 * The quick picks: the abstract, and the document's bookmarks (\section and friends with hyperref).
 * Without bookmarks, lines set noticeably larger than the body text stand in for the headings.
 */
async function findTargets(pdf: PDFDocumentProxy, lines: TextLine[][]): Promise<Target[]> {
  const out: Target[] = []
  const size = bodySize(lines)
  const findLine = (page: number, title: string, from: number): TextLine | null => {
    const t = norm(title)
    if (!t) return null
    const ok = (l: TextLine): boolean => {
      const n = norm(l.text)
      return !!n && (n.includes(t) || (t.startsWith(n) && n.length >= 3))
    }
    return lines[page - 1]?.find((l) => l.top >= from - 6 && ok(l)) ?? lines[page - 1]?.find(ok) ?? null
  }

  type Item = { title: string; dest: unknown; items?: Item[] }
  let outline: Item[] | null = null
  try {
    outline = (await pdf.getOutline()) as Item[] | null
  } catch {}
  const resolve = async (destIn: unknown): Promise<{ page: number; y: number } | null> => {
    try {
      const dest = typeof destIn === 'string' ? await pdf.getDestination(destIn) : destIn
      if (!Array.isArray(dest) || !dest.length) return null
      const ref = dest[0]
      const index = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref)
      const page = await pdf.getPage(index + 1)
      const vp = page.getViewport({ scale: 1 })
      const mode = (dest[1] as { name?: string } | undefined)?.name
      const top = mode === 'XYZ' ? dest[3] : mode === 'FitH' || mode === 'FitBH' ? dest[2] : null
      return { page: index + 1, y: typeof top === 'number' ? Math.max(0, vp.convertToViewportPoint(0, top)[1]) : 0 }
    } catch {
      return null
    }
  }
  if (outline?.length) {
    const walk = async (items: Item[], level: number): Promise<void> => {
      for (const item of items) {
        const pos = await resolve(item.dest)
        if (pos) {
          const line = findLine(pos.page, item.title, pos.y)
          out.push({ id: `o${out.length}`, label: item.title.trim(), level, page: pos.page, y: line ? line.top : pos.y, abstract: ABSTRACT_NORM.has(norm(item.title)) })
        }
        if (item.items?.length && level < 3) await walk(item.items, level + 1)
      }
    }
    await walk(outline, 1)
  } else {
    // Headings by size: consecutive large lines ("Chapter 1" over "Introduction") are one heading.
    const sizes = new Set<number>()
    const found: { page: number; line: TextLine; text: string }[] = []
    lines.forEach((ls, i) => {
      let prev: (typeof found)[number] | null = null
      for (const l of ls) {
        const big = l.size >= size * 1.15 && l.text.length <= 100 && /\p{L}/u.test(l.text) && !ABSTRACT_NORM.has(norm(l.text))
        if (!big) { prev = null; continue }
        if (prev && l.top - (prev.line.top + prev.line.size) < l.size * 1.6) {
          prev.text += ` ${l.text}`
          prev.line = { ...prev.line, size: Math.max(prev.line.size, l.size) }
          continue
        }
        prev = { page: i + 1, line: l, text: l.text }
        found.push(prev)
      }
    })
    for (const f of found) sizes.add(Math.round(f.line.size))
    const rank = [...sizes].sort((a, b) => b - a)
    for (const f of found) {
      out.push({ id: `t${out.length}`, label: f.text, level: Math.min(3, rank.indexOf(Math.round(f.line.size)) + 1), page: f.page, y: f.line.top, abstract: false })
    }
  }

  // The abstract itself: its heading is a line of its own ("Abstract"), so a contents line
  // ("Abstract ........ iii") does not count. The largest one wins.
  if (!out.some((t) => t.abstract)) {
    let best: { page: number; line: TextLine } | null = null
    lines.forEach((ls, i) => ls.forEach((l) => {
      if (ABSTRACT_NORM.has(norm(l.text)) && (!best || l.size > best.line.size + 0.1)) best = { page: i + 1, line: l }
    }))
    if (best) {
      const b = best as { page: number; line: TextLine }
      out.push({ id: 'abstract', label: b.line.text, level: 1, page: b.page, y: b.line.top, abstract: true })
    }
  }
  return out.sort((a, b) => a.page - b.page || a.y - b.y)
}

export async function openSplitDialog(opts: { projectName: string; isHost: boolean }): Promise<void> {
  let disposed = false
  const offs: (() => void)[] = []
  /** The build the dialog shows, from the server; a save names it, so a newer build is never cut by an older plan. */
  let version = 0
  // Builds that finish from the moment the dialog opens, even while it is still loading.
  let newerBuild = 0
  let showRebuilt = (): void => {}
  offs.push(app.events.on((e) => {
    if (e.type !== 'compile' || e.state === 'compiling' || !e.result?.pdfVersion) return
    newerBuild = e.result.pdfVersion
    showRebuilt()
  }))
  let pdf: PDFDocumentProxy | null = null
  let dragTimer: ReturnType<typeof setInterval> | null = null
  const m = openModal({
    title: 'Advanced exporter',
    onClose: () => {
      disposed = true
      offs.forEach((off) => off())
      observer.disconnect()
      if (dragTimer) clearInterval(dragTimer)
      const p = pdf
      setTimeout(() => void p?.loadingTask.destroy(), 500)
    },
  })
  m.root.querySelector('.modal')!.classList.add('split-modal')
  const loadingText = h('span', null, 'Reading the document…')
  const loading = h('div', { class: 'sp-loading' }, h('span', { class: 'ai-spinner' }), loadingText)
  m.body.append(loading)
  m.footer.append(h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'))

  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      observer.unobserve(e.target)
      lazyWork.get(e.target)?.()
    }
  }, { rootMargin: '400px 0px' })
  const lazyWork = new WeakMap<Element, () => void>()
  const lazy = (el: Element, fn: () => void): void => {
    lazyWork.set(el, fn)
    observer.observe(el)
  }

  // ---- the document --------------------------------------------------------------------------
  let lines: TextLine[][] = []
  let sizes: { width: number; height: number; rotated: boolean }[] = []
  /** Resolves when the compile that is running now has finished (or the dialog closes). */
  const buildDone = (): Promise<void> => new Promise((resolve) => {
    const off = app.events.on((e) => {
      if (e.type === 'compile' && e.state !== 'compiling') { off(); resolve() }
    })
    offs.push(() => { off(); resolve() })
  })
  const compiling = async (): Promise<boolean> => {
    try {
      return !!(await api<{ compiling: boolean }>('GET', '/api/project/build')).compiling
    } catch {
      return false
    }
  }
  try {
    // The PDF already made is used straight away. Only when there is none yet, or what comes is not
    // a whole PDF, does the dialog say it waits for the compile, and it loads the PDF when that ends.
    for (let attempt = 0; !pdf; attempt++) {
      let failure: Error | null = null
      try {
        const res = await fetch('/api/project/pdf', { credentials: 'same-origin', cache: 'no-store' })
        if (!res.ok) throw new Error('There is no PDF yet. Compile first.')
        const data = await res.arrayBuffer()
        version = Number(res.headers.get('X-PDF-Version')) || 0
        pdf = await openPdfDocument(data)
      } catch (err) {
        failure = err as Error
      }
      if (disposed) return
      if (pdf) break
      if (attempt >= 3) throw failure ?? new Error('The PDF could not be read.')
      if (await compiling()) {
        loadingText.textContent = 'Generating the PDF… It opens here when it is ready.'
        await buildDone()
        if (disposed) return
        loadingText.textContent = 'Reading the document…'
      } else if (attempt === 0 && failure?.name !== 'Error') {
        // A build may just have finished writing it: one more try after a moment.
        await new Promise((r) => setTimeout(r, 700))
      } else {
        throw failure?.message === 'There is no PDF yet. Compile first.' ? failure : new Error('The PDF could not be read. Recompile, then open the exporter again.')
      }
    }
    const opened = pdf!
    for (let n = 1; n <= opened.numPages; n++) {
      if (disposed) return
      const page = await opened.getPage(n)
      const vp = page.getViewport({ scale: 1 })
      sizes.push({ width: vp.width, height: vp.height, rotated: page.rotate % 360 !== 0 })
      lines.push(await textLines(page))
    }
  } catch (err) {
    if (disposed) return
    clear(m.body)
    m.body.append(h('div', { class: 'sp-loading sp-failed' },
      icon('warning', 18),
      h('span', null, (err as Error).message || 'Could not read the PDF.'),
      h('button', { class: 'btn btn-small', type: 'button', onclick: () => { m.close(); void openSplitDialog(opts) } }, 'Try again')))
    return
  }
  const doc = pdf
  const pageCount = doc.numPages
  const targets = await findTargets(doc, lines)
  lines = []

  // Every page is measured once, one at a time, on demand: where its ink is, and a small image.
  const analyzed = new Map<number, Analyzed>()
  const pending = new Map<number, Promise<Analyzed | null>>()
  let chain: Promise<unknown> = Promise.resolve()
  const analyze = (n: number): Promise<Analyzed | null> => {
    const known = pending.get(n)
    if (known) return known
    const job = chain.then(async (): Promise<Analyzed | null> => {
      if (disposed) return null
      const page = await doc.getPage(n)
      const vp = page.getViewport({ scale: ANALYSIS_SCALE })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(vp.width)
      canvas.height = Math.ceil(vp.height)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const rows = new Uint8Array(height)
      for (let y = 0; y < height; y++) {
        for (let i = y * width * 4, end = i + width * 4; i < end; i += 4) {
          if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) { rows[y] = 1; break }
        }
      }
      let runs = inkRuns(rows, ANALYSIS_SCALE)
      // A turned page cannot be cut across (its top is a side of the paper), so it is one block.
      if (sizes[n - 1].rotated && runs.length) runs = [{ top: runs[0].top, bottom: runs[runs.length - 1].bottom }]
      const thumb = document.createElement('canvas')
      thumb.width = THUMB_PX
      thumb.height = Math.round(THUMB_PX * canvas.height / canvas.width)
      thumb.getContext('2d')!.drawImage(canvas, 0, 0, thumb.width, thumb.height)
      canvas.width = canvas.height = 0
      page.cleanup()
      const a: Analyzed = { ink: { width: sizes[n - 1].width, height: sizes[n - 1].height, runs }, thumb }
      analyzed.set(n, a)
      furniture = findFurniture([...analyzed.values()].map((x) => x.ink))
      return a
    }).catch((err) => {
      console.error('Could not measure page', n, err)
      return null
    })
    chain = job
    pending.set(n, job)
    return job
  }
  let furniture: Furniture = { headerBottom: null, footerTop: null, bodyTop: null }
  const inks = (): PageInk[] => sizes.map((s, i) => analyzed.get(i + 1)?.ink ?? { width: s.width, height: s.height, runs: [] })

  // A running header and page number are found by comparing pages, so measure a spread of them
  // first, along with the pages the quick picks point to.
  const sample = new Set<number>([1, 2, 3, 4, Math.ceil(pageCount / 2), pageCount])
  const abstract = targets.find((t) => t.abstract)
  if (abstract) sample.add(abstract.page)
  await Promise.all([...sample].filter((n) => n <= pageCount).map(analyze))
  if (disposed) return

  const cutFor = async (t: Target): Promise<Cut | null> => {
    const a = await analyze(t.page)
    if (!a) return null
    return normalizeCut({ page: t.page, y: cutBefore(a.ink, furniture, t.y) }, inks(), furniture)
  }

  // ---- state -------------------------------------------------------------------------------
  let nextId = 1
  let points: SplitPoint[] = []
  let view: 'document' | 'result' = store('splitView') === 'result' ? 'result' : 'document'
  let asZip = store('splitZip') === '1'
  const names: string[] = []
  const edited: boolean[] = []

  const defaultCut = async (): Promise<SplitPoint | null> => {
    const firstValid = async (list: Target[]): Promise<SplitPoint | null> => {
      for (const t of list) {
        const cut = await cutFor(t)
        if (cut) return { id: nextId++, cut, target: t.id }
      }
      return null
    }
    const pick = (abstract && (await firstValid([abstract])))
      ?? (await firstValid(targets.filter((t) => t.level === 1 && t.page > 1)))
      ?? (await firstValid(targets))
    if (pick) return pick
    if (pageCount > 1) return { id: nextId++, cut: { page: 2, y: 0 }, target: null }
    const a = analyzed.get(1)
    const y = a && snapCut(a.ink, furniture, a.ink.height / 2)
    const cut = y ? normalizeCut({ page: 1, y }, inks(), furniture) : null
    return cut ? { id: nextId++, cut, target: null } : null
  }
  const first = await defaultCut()
  if (first) points.push(first)
  if (disposed) return

  /** The cuts that count, in order, with the points they came from; doubles are left out. */
  const effective = (): { cuts: Cut[]; dupes: Set<number> } => {
    const dupes = new Set<number>()
    const seen: Cut[] = []
    for (const p of [...points].sort((a, b) => a.cut.page - b.cut.page || a.cut.y - b.cut.y)) {
      if (seen.some((c) => c.page === p.cut.page && Math.abs(c.y - p.cut.y) < 0.5)) dupes.add(p.id)
      else seen.push(p.cut)
    }
    return { cuts: cleanCuts(seen, inks(), furniture), dupes }
  }
  const plan = (): Piece[][] => planParts(effective().cuts, inks(), furniture)
  const defaultName = (i: number): string => `${opts.projectName} - Part ${i + 1}`

  // ---- layout ------------------------------------------------------------------------------
  clear(m.body)
  const pointsEl = h('div', { class: 'sp-points' })
  const partsEl = h('div', { class: 'sp-parts' })
  const addBtn = h('button', { class: 'btn btn-small sp-add', type: 'button', onclick: () => void addPoint() }, icon('plus', 14), 'Add split point')
  const sidebar = h('aside', { class: 'sp-side' },
    h('div', { class: 'sp-intro' },
      h('div', { class: 'sp-intro-icon' }, icon('scissors', 20)),
      h('div', null,
        h('strong', null, 'Save the PDF as separate files'),
        h('p', null, 'Each part keeps the layout of the original. A split in the middle of a page moves the rest of that page to the top of the next part.'))),
    h('section', { class: 'sp-section' },
      h('h3', null, 'Split points'),
      pointsEl,
      addBtn),
    h('section', { class: 'sp-section' },
      h('h3', null, 'Files'),
      partsEl),
  )

  const docSeg = h('button', { class: 'segment', type: 'button', onclick: () => setView('document') }, 'Pages')
  const resSeg = h('button', { class: 'segment', type: 'button', onclick: () => setView('result') }, 'Result')
  const hint = h('span', { class: 'sp-hint' })
  // A newer build while the dialog is open: the splits were made on the old one, so say so and
  // offer to start again on the new PDF (saving the old plan would be refused anyway).
  const rebuilt = h('div', { class: 'sp-rebuilt', hidden: true },
    icon('refresh', 14), h('span', null, 'The PDF was rebuilt.'),
    h('button', { class: 'btn btn-small', type: 'button', onclick: () => { m.close(); void openSplitDialog(opts) } }, 'Refresh'))
  showRebuilt = () => {
    if (!newerBuild || newerBuild === version) return
    rebuilt.hidden = false
    hint.hidden = true
  }
  const scroller = h('div', { class: 'sp-scroller' })
  const preview = h('div', { class: 'sp-preview' },
    h('div', { class: 'sp-toolbar' }, h('div', { class: 'segmented sp-seg', role: 'group', 'aria-label': 'Preview' }, docSeg, resSeg), hint, rebuilt),
    scroller)
  m.body.append(h('div', { class: 'sp-layout' }, sidebar, preview))

  const summary = h('span', { class: 'sp-summary' })
  const zipToggle = h('input', { type: 'checkbox', checked: asZip, onchange: () => { asZip = zipToggle.checked; store('splitZip', asZip ? '1' : null); renderFooter() } }) as HTMLInputElement
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => void save() }, 'Save')
  clear(m.footer)
  m.footer.append(
    h('div', { class: 'sp-footer-left' },
      opts.isHost ? h('label', { class: 'check', title: 'Save one .zip file to Downloads instead of separate PDFs' }, zipToggle, 'As one .zip file') : null,
      summary),
    h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'),
    saveBtn)

  // ---- the "Pages" view: the original, with the cuts on it -----------------------------------
  type Card = { el: HTMLElement; overlay: HTMLElement; n: number }
  const cards: Card[] = []
  const pagesGrid = h('div', { class: 'sp-grid' })
  for (let n = 1; n <= pageCount; n++) {
    const s = sizes[n - 1]
    const overlay = h('div', { class: 'sp-overlay' })
    const ghost = h('div', { class: 'sp-ghost', hidden: true }, h('span', { class: 'sp-pill' }, icon('plus', 11), 'Split here'))
    const el = h('div', { class: 'sp-page', dataset: { page: String(n) }, style: { aspectRatio: `${s.width} / ${s.height}` } }, overlay, ghost)
    const card: Card = { el, overlay, n }
    cards.push(card)
    pagesGrid.append(h('figure', { class: 'sp-card' }, el, h('figcaption', null, String(n))))
    lazy(el, () => void analyze(n).then((a) => {
      if (!a || disposed) return
      const img = a.thumb
      const c = h('canvas', { class: 'sp-thumb' }) as HTMLCanvasElement
      c.width = img.width
      c.height = img.height
      c.getContext('2d')!.drawImage(img, 0, 0)
      el.prepend(c)
      el.classList.add('ready')
      renderOverlays()
    }))
    const yAt = (e: PointerEvent): number => ((e.clientY - el.getBoundingClientRect().top) / el.getBoundingClientRect().height) * s.height
    el.addEventListener('pointermove', (e) => {
      const a = analyzed.get(n)
      if (dragging || !a) return
      const y = snapCut(a.ink, furniture, yAt(e))
      const cut = y === null ? null : normalizeCut({ page: n, y }, inks(), furniture)
      const taken = !cut || points.some((p) => p.cut.page === cut.page && Math.abs(p.cut.y - cut.y) < 0.5)
      ghost.hidden = taken
      if (!taken && y !== null) ghost.style.top = `${(y / s.height) * 100}%`
      el.classList.toggle('can-cut', !taken)
    })
    el.addEventListener('pointerleave', () => { ghost.hidden = true; el.classList.remove('can-cut') })
    el.addEventListener('click', (e) => {
      const a = analyzed.get(n)
      if (!a || (e.target as HTMLElement).closest('.sp-cut')) return
      const y = snapCut(a.ink, furniture, yAt(e as PointerEvent))
      const cut = y === null ? null : normalizeCut({ page: n, y }, inks(), furniture)
      if (!cut || points.some((p) => p.cut.page === cut.page && Math.abs(p.cut.y - cut.y) < 0.5)) return
      ghost.hidden = true
      points.push({ id: nextId++, cut, target: null })
      update()
    })
  }

  /** Which part each stretch of each page goes to, and where the cut lines are drawn. */
  function renderOverlays(): void {
    const { cuts } = effective()
    const numbered = [...points].sort((a, b) => a.cut.page - b.cut.page || a.cut.y - b.cut.y)
    let part = 0
    let tagged = -1
    for (const card of cards) {
      clear(card.overlay)
      const H = sizes[card.n - 1].height
      const here = cuts.filter((c) => c.page === card.n)
      if (here.some((c) => c.y === 0)) part++
      const ys = here.filter((c) => c.y > 0).map((c) => c.y)
      const stops = [0, ...ys, H]
      for (let i = 0; i < stops.length - 1; i++) {
        if (i > 0) part++
        card.overlay.append(h('div', { class: `sp-tint pc${part % PART_COLORS}`, style: { top: `${(stops[i] / H) * 100}%`, height: `${((stops[i + 1] - stops[i]) / H) * 100}%` } },
          tagged !== part ? h('span', { class: 'sp-tag' }, `Part ${part + 1}`) : null))
        tagged = part
      }
      for (const p of numbered.filter((p) => p.cut.page === card.n)) {
        const label = numbered.indexOf(p) + 1
        const line = h('div', { class: `sp-cut ${p.cut.y === 0 ? 'at-top' : ''} ${dragging?.id === p.id ? 'dragging' : ''}`, style: { top: `${(p.cut.y / H) * 100}%` }, title: 'Drag to move this split' },
          h('span', { class: 'sp-pill' }, icon('scissors', 11), String(label),
            h('button', { class: 'sp-pill-x', type: 'button', title: 'Remove this split', 'aria-label': `Remove split ${label}`, onclick: (e: Event) => { e.stopPropagation(); removePoint(p.id) } }, icon('close', 10))))
        line.addEventListener('pointerdown', (e) => startDrag(e, p))
        card.overlay.append(line)
      }
    }
  }

  // Dragging a cut: it follows the pointer from page to page, snapping to the space between lines.
  let dragging: SplitPoint | null = null
  let lastPointer = { x: 0, y: 0 }
  function startDrag(e: PointerEvent, p: SplitPoint): void {
    if ((e.target as HTMLElement).closest('.sp-pill-x') || e.button !== 0) return
    e.preventDefault()
    dragging = p
    lastPointer = { x: e.clientX, y: e.clientY }
    scroller.classList.add('is-dragging')
    const move = (ev: PointerEvent): void => {
      lastPointer = { x: ev.clientX, y: ev.clientY }
      follow()
    }
    const up = (): void => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointercancel', up)
      if (dragTimer) clearInterval(dragTimer)
      dragTimer = null
      dragging = null
      scroller.classList.remove('is-dragging')
      update()
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', up)
    // Near the top or bottom edge the preview scrolls, so a cut can be taken to any page.
    dragTimer = setInterval(() => {
      const r = scroller.getBoundingClientRect()
      const edge = 48
      const dy = lastPointer.y < r.top + edge ? -(r.top + edge - lastPointer.y) : lastPointer.y > r.bottom - edge ? lastPointer.y - (r.bottom - edge) : 0
      if (dy) {
        scroller.scrollTop += Math.max(-24, Math.min(24, dy / 2))
        follow()
      }
    }, 16)
  }
  function follow(): void {
    if (!dragging) return
    const el = document.elementsFromPoint(lastPointer.x, lastPointer.y).find((x) => x.classList.contains('sp-page')) as HTMLElement | undefined
    if (!el) return
    const n = Number(el.dataset.page)
    const a = analyzed.get(n)
    if (!a) return
    const r = el.getBoundingClientRect()
    const y = snapCut(a.ink, furniture, ((lastPointer.y - r.top) / r.height) * a.ink.height)
    const cut = y === null ? null : normalizeCut({ page: n, y }, inks(), furniture)
    if (!cut || (cut.page === dragging.cut.page && Math.abs(cut.y - dragging.cut.y) < 0.5)) return
    dragging.cut = cut
    dragging.target = null
    renderOverlays()
    renderSide()
  }

  // ---- the "Result" view: the pages of every file, as they will be saved -------------------------
  const resultEl = h('div', { class: 'sp-results' })
  function renderResult(): void {
    clear(resultEl)
    const parts = plan()
    parts.forEach((part, i) => {
      const grid = h('div', { class: 'sp-grid' })
      part.forEach((piece, k) => {
        const s = sizes[piece.page - 1]
        const el = h('div', { class: 'sp-page', style: { aspectRatio: `${s.width} / ${s.height}` } })
        const moved = piece.bands?.some((b) => b.dy !== 0)
        grid.append(h('figure', { class: 'sp-card' }, el,
          h('figcaption', null, `${k + 1}`, h('span', { class: 'sp-from' }, piece.bands ? (moved ? ` · rest of p. ${piece.page}` : ` · top of p. ${piece.page}`) : ` · p. ${piece.page}`))))
        lazy(el, () => void analyze(piece.page).then((a) => {
          if (!a || disposed) return
          const c = h('canvas', { class: 'sp-thumb' }) as HTMLCanvasElement
          c.width = a.thumb.width
          c.height = a.thumb.height
          const ctx = c.getContext('2d')!
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, c.width, c.height)
          if (!piece.bands) ctx.drawImage(a.thumb, 0, 0)
          else {
            const k = c.height / s.height
            for (const b of piece.bands) {
              const sy = Math.max(0, Math.floor(b.from * k)), sh = Math.min(c.height, Math.ceil(b.to * k)) - sy
              if (sh > 0) ctx.drawImage(a.thumb, 0, sy, c.width, sh, 0, sy + Math.round(b.dy * k), c.width, sh)
            }
          }
          el.prepend(c)
          el.classList.add('ready')
        }))
      })
      resultEl.append(h('section', { class: `sp-result pc${i % PART_COLORS}` },
        h('header', null, h('span', { class: 'sp-dot' }), h('strong', null, `${names[i] || defaultName(i)}.pdf`), h('span', { class: 'muted' }, `${plural(part.length, 'page')} · ${pageRange(part)}`)),
        grid))
    })
  }

  function setView(next: 'document' | 'result'): void {
    view = next
    store('splitView', next === 'result' ? 'result' : null)
    docSeg.classList.toggle('active', next === 'document')
    resSeg.classList.toggle('active', next === 'result')
    docSeg.setAttribute('aria-pressed', String(next === 'document'))
    resSeg.setAttribute('aria-pressed', String(next === 'result'))
    hint.textContent = next === 'document' ? 'Click between two lines to split there. Drag a split to move it.' : 'The files as they will be saved.'
    clear(scroller)
    if (next === 'document') {
      scroller.append(pagesGrid)
      renderOverlays()
    } else {
      renderResult()
      scroller.append(resultEl)
    }
  }

  // ---- the sidebar ---------------------------------------------------------------------------
  function describe(cut: Cut, partAfter: number): string {
    if (cut.y === 0) return `Part ${partAfter} starts on page ${cut.page}.`
    return `Mid-page ${cut.page}: the rest of the page moves to the top of part ${partAfter}.`
  }
  function renderSide(): void {
    clear(pointsEl)
    const { dupes } = effective()
    const sorted = [...points].sort((a, b) => a.cut.page - b.cut.page || a.cut.y - b.cut.y)
    let after = 1
    sorted.forEach((p, i) => {
      const select = h('select', { class: 'popup', 'aria-label': `Split ${i + 1}: where` }) as HTMLSelectElement
      select.append(h('option', { value: '', disabled: true, selected: !p.target }, p.cut.y === 0 ? `Start of page ${p.cut.page}` : `Page ${p.cut.page}, mid-page`))
      const abs = targets.filter((t) => t.abstract)
      const heads = targets.filter((t) => !t.abstract)
      if (abs.length) select.append(h('optgroup', { label: 'Front matter' }, abs.map((t) => h('option', { value: t.id, selected: p.target === t.id }, `Before “${t.label}”`))))
      if (heads.length) {
        select.append(h('optgroup', { label: 'Contents' }, heads.map((t) =>
          h('option', { value: t.id, selected: p.target === t.id }, `${' '.repeat(t.level - 1)}${t.label}  ·  p. ${t.page}`))))
      }
      select.addEventListener('change', async () => {
        const t = targets.find((x) => x.id === select.value)
        if (!t) return
        const cut = await cutFor(t)
        if (!cut) {
          toast(`A split before “${t.label}” would leave an empty part.`, 'info')
          renderSide()
          return
        }
        p.cut = cut
        p.target = t.id
        update()
        scrollToPage(cut.page)
      })
      const dupe = dupes.has(p.id)
      if (!dupe) after++
      pointsEl.append(h('div', { class: `sp-point ${dupe ? 'is-dupe' : ''}` },
        h('span', { class: 'sp-badge' }, String(i + 1)),
        h('div', { class: 'sp-point-main' },
          h('div', { class: 'popup-wrap' }, select, icon('updown', 12)),
          h('button', { class: 'sp-point-info', type: 'button', title: 'Show in the preview', onclick: () => scrollToPage(p.cut.page) },
            dupe ? 'Same place as another split; it is left out.' : describe(p.cut, after))),
        h('button', { class: 'icon-btn sp-remove', type: 'button', title: 'Remove this split', 'aria-label': `Remove split ${i + 1}`, onclick: () => removePoint(p.id) }, icon('minus'))))
    })
    if (!points.length) pointsEl.append(h('p', { class: 'muted sp-empty' }, 'No split points. Add one, or click between two lines in the preview.'))

    const parts = plan()
    clear(partsEl)
    parts.forEach((part, i) => {
      if (!edited[i]) names[i] = defaultName(i)
      const input = h('input', { class: 'input', type: 'text', value: names[i], spellcheck: false, autocomplete: 'off', 'aria-label': `File name of part ${i + 1}` }) as HTMLInputElement
      input.addEventListener('input', () => {
        names[i] = input.value
        edited[i] = !!input.value.trim() && input.value !== defaultName(i)
      })
      input.addEventListener('change', () => {
        if (!input.value.trim()) { names[i] = defaultName(i); edited[i] = false; input.value = names[i] }
        if (view === 'result') renderResult()
      })
      partsEl.append(h('div', { class: `sp-part pc${i % PART_COLORS}` },
        h('span', { class: 'sp-dot' }),
        h('div', { class: 'sp-part-main' },
          h('div', { class: 'sp-name' }, input, h('span', { class: 'sp-ext' }, '.pdf')),
          h('span', { class: 'sp-part-meta' }, `${plural(part.length, 'page')} · ${pageRange(part)}`))))
    })
    renderFooter()
  }
  function renderFooter(): void {
    const parts = plan()
    const pages = parts.reduce((n, p) => n + p.length, 0)
    const ok = parts.length >= 2
    summary.textContent = ok ? `${plural(parts.length, 'file')} · ${plural(pages, 'page')} in all` : 'Add a split point to make two parts.'
    saveBtn.disabled = !ok
    const where = opts.isHost ? (asZip ? 'as .zip' : 'to Downloads') : 'as .zip'
    saveBtn.textContent = ok ? `Save ${parts.length} PDFs ${where}` : 'Save'
  }

  function update(): void {
    renderSide()
    if (view === 'document') renderOverlays()
    else renderResult()
  }
  function removePoint(id: number): void {
    points = points.filter((p) => p.id !== id)
    update()
  }
  function scrollToPage(n: number): void {
    if (view !== 'document') setView('document')
    const card = cards[n - 1]?.el.parentElement
    card?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  /** A new split: the next heading after the last split, or the next page. */
  async function addPoint(): Promise<void> {
    const last = [...points].sort((a, b) => b.cut.page - a.cut.page || b.cut.y - a.cut.y)[0]?.cut ?? { page: 1, y: 0 }
    const after = (c: Cut): boolean => c.page > last.page || (c.page === last.page && c.y > last.y + 0.5)
    const preferred = [...targets.filter((t) => t.level === 1), ...targets.filter((t) => t.level > 1)]
    for (const t of preferred.filter((t) => t.page >= last.page).sort((a, b) => a.page - b.page || a.y - b.y)) {
      const cut = await cutFor(t)
      if (cut && after(cut) && !points.some((p) => p.cut.page === cut.page && Math.abs(p.cut.y - cut.y) < 0.5)) {
        points.push({ id: nextId++, cut, target: t.id })
        update()
        scrollToPage(cut.page)
        return
      }
    }
    for (let n = last.page + 1; n <= pageCount; n++) {
      if (!points.some((p) => p.cut.page === n && p.cut.y === 0)) {
        points.push({ id: nextId++, cut: { page: n, y: 0 }, target: null })
        update()
        scrollToPage(n)
        return
      }
    }
    toast('There is no room for another split after the last one. Click between two lines in the preview instead.', 'info')
  }

  // ---- saving ----------------------------------------------------------------------------------
  async function save(): Promise<void> {
    const parts = plan()
    if (parts.length < 2) return
    const body = { version, parts, names: parts.map((_, i) => names[i] || defaultName(i)), target: opts.isHost && !asZip ? 'downloads' : 'zip' }
    saveBtn.disabled = true
    const label = saveBtn.textContent
    saveBtn.textContent = 'Saving…'
    try {
      if (body.target === 'downloads') {
        const res = await api<{ files: { file: string; name: string }[] }>('POST', '/api/project/pdf/parts', body)
        m.close()
        toast(`Saved ${plural(res.files.length, 'PDF')} to Downloads`, 'success', 7000, {
          label: `Show in ${OS.fileManager}`,
          onclick: () => void api('POST', '/api/host/reveal', { path: res.files[0].file }).catch(() => {}),
        })
        return
      }
      const res = await fetch('/api/project/pdf/parts', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-LW': '1' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const json = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(json?.error ?? `Saving failed (${res.status})`)
      }
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1] ?? `${opts.projectName}.zip`)
      const url = URL.createObjectURL(blob)
      const a = h('a', { href: url, download: name })
      document.body.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      m.close()
      toast(opts.isHost ? `Saved “${name}”` : `Downloading “${name}”`, 'success')
    } catch (err) {
      toast((err as Error).message, 'error', 7000)
      saveBtn.disabled = false
      saveBtn.textContent = label
    }
  }

  renderSide()
  setView(view)
  showRebuilt()
  if (points[0] && view === 'document') requestAnimationFrame(() => cards[points[0].cut.page - 1]?.el.parentElement?.scrollIntoView({ block: 'center' }))
}
