// The "legacy" build of PDF.js carries its own polyfills. The default build relies on JavaScript
// features only the very newest browsers have, which breaks the page on an older phone or tablet.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { debounce, h } from './dom.ts'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

// One worker thread for every document this tab opens; a rebuild every few seconds should not respawn it.
let sharedWorker: pdfjs.PDFWorker | null = null
const worker = (): pdfjs.PDFWorker => (sharedWorker ??= new pdfjs.PDFWorker())

const asset = (dir: string): string => new URL(`pdfjs/${dir}/`, document.baseURI).href
const CSS_UNITS = 96 / 72
const PAGE_GAP = 12
const PADDING = 16
const MAX_CANVAS_PIXELS = 16_000_000
const MAX_RENDERED = 14
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]

type Slot = {
  index: number
  wrapper: HTMLElement
  canvas: HTMLCanvasElement | null
  textLayer: HTMLElement | null
  /** Clickable areas for the PDF's links (\ref, \cite, table of contents, URLs). */
  linkLayer: HTMLElement | null
  size: { width: number; height: number } | null
  renderedKey: string
  pendingKey: string
  task: RenderTask | null
  lastVisible: number
}

export type PdfViewOptions = {
  /** Double-click position in PDF points, measured from the top-left of the page. */
  onDoubleClick?: (page: number, x: number, y: number) => void
  onState?: (state: { page: number; pages: number; zoom: 'fit' | number; percent: number }) => void
}

/** A continuous-scroll PDF viewer that keeps its place when the document is replaced by a new build. */
export class PdfView {
  readonly element: HTMLElement
  private pagesEl: HTMLElement
  private emptyEl: HTMLElement
  private pdf: PDFDocumentProxy | null = null
  private slots: Slot[] = []
  private generation = 0
  private zoom: 'fit' | number = 'fit'
  private scale = 1
  private defaultSize = { width: 595, height: 842 }
  private observer: IntersectionObserver
  private resizeObserver: ResizeObserver
  private opts: PdfViewOptions
  private currentPage = 1
  private loadToken = 0
  private visibleTick = 0

  constructor(opts: PdfViewOptions = {}, emptyText = 'No PDF yet') {
    this.opts = opts
    this.pagesEl = h('div', { class: 'pdf-pages' })
    this.emptyEl = h('div', { class: 'pdf-empty' }, emptyText)
    this.element = h('div', { class: 'pdf-scroll', tabindex: '0' }, this.emptyEl, this.pagesEl)
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const slot = this.slots[Number((e.target as HTMLElement).dataset.index)]
        if (slot && e.isIntersecting) {
          slot.lastVisible = ++this.visibleTick
          void this.render(slot)
        }
      }
      this.evict()
    }, { root: this.element, rootMargin: '500px 0px' })
    this.resizeObserver = new ResizeObserver(debounce(() => {
      if (this.zoom === 'fit' && this.pdf) this.applyScale()
    }, 80))
    this.resizeObserver.observe(this.element)
    this.element.addEventListener('scroll', () => this.updateCurrentPage(), { passive: true })
    this.pagesEl.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.pdf-link')) return
      const wrapper = (e.target as HTMLElement).closest<HTMLElement>('.pdf-page')
      if (!wrapper || !this.opts.onDoubleClick) return
      const rect = wrapper.getBoundingClientRect()
      this.opts.onDoubleClick(Number(wrapper.dataset.index) + 1, (e.clientX - rect.left) / this.scale, (e.clientY - rect.top) / this.scale)
    })
  }

  get hasDocument(): boolean {
    return this.pdf !== null
  }

  setEmptyText(text: string): void {
    this.emptyEl.textContent = text
  }

  /** Loads a PDF, replacing the current one in place so the reader does not lose their position. */
  async load(url: string): Promise<boolean> {
    const token = ++this.loadToken
    let data: ArrayBuffer
    try {
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) return false
      data = await res.arrayBuffer()
    } catch {
      return false
    }
    if (token !== this.loadToken) return false
    let pdf: PDFDocumentProxy
    try {
      pdf = await pdfjs.getDocument({
        data,
        worker: worker(),
        cMapUrl: asset('cmaps'),
        cMapPacked: true,
        standardFontDataUrl: asset('standard_fonts'),
        wasmUrl: asset('wasm'),
        iccUrl: asset('iccs'),
      }).promise
    } catch (err) {
      console.error('Could not open the PDF', err)
      return false
    }
    if (token !== this.loadToken) {
      void pdf.loadingTask.destroy()
      return false
    }
    const first = await pdf.getPage(1)
    const vp = first.getViewport({ scale: 1 })
    if (token !== this.loadToken) {
      void pdf.loadingTask.destroy()
      return false
    }

    const anchor = this.pdf ? this.anchor() : null
    const old = this.pdf
    this.pdf = pdf
    this.generation++
    this.defaultSize = { width: vp.width, height: vp.height }
    this.emptyEl.hidden = true

    // Reuse page slots so the old rendering stays visible until the new one is ready.
    while (this.slots.length > pdf.numPages) {
      const slot = this.slots.pop()!
      slot.task?.cancel()
      this.observer.unobserve(slot.wrapper)
      slot.wrapper.remove()
    }
    for (const slot of this.slots) {
      slot.size = null
      slot.pendingKey = ''
    }
    while (this.slots.length < pdf.numPages) {
      const index = this.slots.length
      const wrapper = h('div', { class: 'pdf-page', dataset: { index: String(index) } })
      const slot: Slot = { index, wrapper, canvas: null, textLayer: null, linkLayer: null, size: null, renderedKey: '', pendingKey: '', task: null, lastVisible: 0 }
      this.slots.push(slot)
      this.pagesEl.appendChild(wrapper)
      this.observer.observe(wrapper)
    }
    this.scale = this.computeScale()
    this.layout()
    if (anchor) this.restore(anchor)
    for (const slot of this.slots) if (this.isNear(slot)) void this.render(slot)
    this.updateCurrentPage()
    this.emitState()
    if (old) setTimeout(() => void old.loadingTask.destroy(), 3000)
    return true
  }

  clear(): void {
    this.loadToken++
    for (const slot of this.slots) {
      slot.task?.cancel()
      this.observer.unobserve(slot.wrapper)
      slot.wrapper.remove()
    }
    this.slots = []
    void this.pdf?.loadingTask.destroy()
    this.pdf = null
    this.emptyEl.hidden = false
    this.emitState()
  }

  // ---- zoom ---------------------------------------------------------------------

  private computeScale(): number {
    if (this.zoom === 'fit') {
      const available = Math.max(200, this.element.clientWidth - 2 * PADDING)
      return available / this.defaultSize.width
    }
    return this.zoom * CSS_UNITS
  }

  private applyScale(): void {
    const next = this.computeScale()
    if (Math.abs(next - this.scale) < 0.001) return
    const anchor = this.anchor()
    this.scale = next
    this.layout()
    this.restore(anchor)
    for (const slot of this.slots) if (this.isNear(slot)) void this.render(slot)
    this.emitState()
  }

  setZoom(zoom: 'fit' | number): void {
    this.zoom = zoom
    if (this.pdf) this.applyScale()
    this.emitState()
  }

  zoomBy(direction: 1 | -1): void {
    const current = this.scale / CSS_UNITS
    const next = direction > 0 ? ZOOM_STEPS.find((z) => z > current + 0.01) : [...ZOOM_STEPS].reverse().find((z) => z < current - 0.01)
    if (next) this.setZoom(next)
  }

  // ---- layout and position ------------------------------------------------------

  private sizeOf(slot: Slot): { width: number; height: number } {
    return slot.size ?? this.defaultSize
  }

  private layout(): void {
    for (const slot of this.slots) {
      const size = this.sizeOf(slot)
      slot.wrapper.style.width = `${Math.floor(size.width * this.scale)}px`
      slot.wrapper.style.height = `${Math.floor(size.height * this.scale)}px`
      slot.wrapper.style.setProperty('--total-scale-factor', String(this.scale))
      // Stretch the existing rendering until the sharp one replaces it.
      if (slot.canvas) {
        slot.canvas.style.width = '100%'
        slot.canvas.style.height = '100%'
      }
      if (slot.textLayer && slot.renderedKey !== this.key()) slot.textLayer.hidden = true
      // Link areas are positioned for the old zoom; hide them until the page is redrawn.
      if (slot.linkLayer && slot.renderedKey !== this.key()) slot.linkLayer.hidden = true
    }
  }

  private anchor(): { index: number; fraction: number } {
    const top = this.element.scrollTop
    for (const slot of this.slots) {
      const bottom = slot.wrapper.offsetTop + slot.wrapper.offsetHeight + PAGE_GAP
      if (bottom > top) return { index: slot.index, fraction: (top - slot.wrapper.offsetTop) / Math.max(1, slot.wrapper.offsetHeight) }
    }
    return { index: 0, fraction: 0 }
  }

  private restore(anchor: { index: number; fraction: number }): void {
    const slot = this.slots[Math.min(anchor.index, this.slots.length - 1)]
    if (slot) this.element.scrollTop = slot.wrapper.offsetTop + anchor.fraction * slot.wrapper.offsetHeight
  }

  private isNear(slot: Slot): boolean {
    const top = slot.wrapper.offsetTop
    const bottom = top + slot.wrapper.offsetHeight
    return bottom > this.element.scrollTop - 500 && top < this.element.scrollTop + this.element.clientHeight + 500
  }

  private updateCurrentPage(): void {
    const middle = this.element.scrollTop + this.element.clientHeight / 3
    let page = 1
    for (const slot of this.slots) {
      if (slot.wrapper.offsetTop <= middle) page = slot.index + 1
      else break
    }
    if (page !== this.currentPage) {
      this.currentPage = page
      this.emitState()
    } else if (!this.slots.length) this.emitState()
  }

  private emitState(): void {
    this.opts.onState?.({ page: this.currentPage, pages: this.slots.length, zoom: this.zoom, percent: Math.round((this.scale / CSS_UNITS) * 100) })
  }

  gotoPage(page: number): void {
    const slot = this.slots[Math.max(0, Math.min(this.slots.length - 1, page - 1))]
    if (slot) this.element.scrollTop = slot.wrapper.offsetTop - PAGE_GAP
  }

  /** Scrolls to a spot (PDF points from the top-left of the page) and flashes a marker there. */
  highlight(page: number, x: number, y: number, width: number, height: number): void {
    const slot = this.slots[page - 1]
    if (!slot) return
    const top = (y - Math.max(height, 8)) * this.scale
    const marker = h('div', {
      class: 'pdf-highlight',
      style: {
        left: `${Math.max(0, x * this.scale - 4)}px`,
        top: `${top - 3}px`,
        width: `${Math.max(width * this.scale, 40) + 8}px`,
        height: `${Math.max(height, 8) * this.scale + 6}px`,
      },
    })
    slot.wrapper.appendChild(marker)
    this.element.scrollTo({ top: slot.wrapper.offsetTop + top - this.element.clientHeight / 3, behavior: 'smooth' })
    setTimeout(() => marker.remove(), 2200)
  }

  // ---- links ----------------------------------------------------------------------

  /** Transparent clickable areas over the page's link annotations. */
  private async buildLinks(page: pdfjs.PDFPageProxy, viewport: pdfjs.PageViewport): Promise<HTMLElement | null> {
    let annotations: any[]
    try {
      annotations = await page.getAnnotations({ intent: 'display' })
    } catch {
      return null
    }
    const layer = h('div', { class: 'pdf-links' })
    for (const a of annotations) {
      if (a.subtype !== 'Link' || !Array.isArray(a.rect)) continue
      const [x1, y1] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]) as number[]
      const [x2, y2] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]) as number[]
      const style = {
        left: `${Math.min(x1, x2)}px`,
        top: `${Math.min(y1, y2)}px`,
        width: `${Math.max(4, Math.abs(x2 - x1))}px`,
        height: `${Math.max(4, Math.abs(y2 - y1))}px`,
      }
      const url = typeof a.url === 'string' ? a.url : typeof a.unsafeUrl === 'string' ? a.unsafeUrl : null
      if (url && /^(https?:|mailto:)/i.test(url)) {
        // Web links open in a new tab; anything else (javascript:, file:) is ignored.
        layer.append(h('a', { class: 'pdf-link pdf-link-external', href: url, target: '_blank', rel: 'noopener noreferrer', title: url, style }))
      } else if (a.dest) {
        const dest = a.dest
        layer.append(h('a', {
          class: 'pdf-link', href: '#', title: 'Go to the link target', style,
          onclick: (e: MouseEvent) => {
            e.preventDefault()
            void this.goToDestination(dest)
          },
        }))
      }
    }
    return layer.childElementCount ? layer : null
  }

  /** Scrolls to a destination inside the PDF, such as the target of a \ref or a table-of-contents entry. */
  async goToDestination(dest: string | unknown[]): Promise<void> {
    const pdf = this.pdf
    if (!pdf) return
    let explicit: unknown[] | null = null
    try {
      explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
    } catch {}
    if (!Array.isArray(explicit) || !explicit.length) return
    const [ref, mode, ...args] = explicit as [unknown, { name?: string } | undefined, ...(number | null)[]]
    let index: number | null = null
    if (typeof ref === 'number') index = ref
    else if (ref && typeof ref === 'object') {
      try {
        index = await pdf.getPageIndex(ref as Parameters<typeof pdf.getPageIndex>[0])
      } catch {}
    }
    const slot = index === null ? undefined : this.slots[index]
    if (!slot || this.pdf !== pdf) return
    // Destinations give the top of the target in PDF units, measured from the bottom of the page.
    const pageHeight = this.sizeOf(slot).height
    let top: number | null = null
    if (mode?.name === 'XYZ') top = args[1] ?? null
    else if (mode?.name === 'FitH' || mode?.name === 'FitBH') top = args[0] ?? null
    else if (mode?.name === 'FitR') top = args[3] ?? null
    const y = top === null ? 0 : Math.max(0, pageHeight - top) * this.scale
    this.element.scrollTo({ top: slot.wrapper.offsetTop + y - 16, behavior: 'smooth' })
    const marker = h('div', { class: 'pdf-target', style: { top: `${Math.max(0, y - 4)}px` } })
    slot.wrapper.appendChild(marker)
    setTimeout(() => marker.remove(), 1600)
  }

  // ---- rendering ------------------------------------------------------------------

  private key(): string {
    return `${this.generation}:${this.scale.toFixed(4)}:${window.devicePixelRatio}`
  }

  private async render(slot: Slot): Promise<void> {
    const pdf = this.pdf
    const key = this.key()
    if (!pdf || slot.renderedKey === key || slot.pendingKey === key) return
    slot.pendingKey = key
    slot.task?.cancel()
    slot.task = null
    const scale = this.scale
    try {
      const page = await pdf.getPage(slot.index + 1)
      if (slot.pendingKey !== key || this.pdf !== pdf) return
      const viewport = page.getViewport({ scale })
      const natural = page.getViewport({ scale: 1 })
      if (!slot.size || slot.size.width !== natural.width || slot.size.height !== natural.height) {
        const anchor = this.anchor()
        slot.size = { width: natural.width, height: natural.height }
        slot.wrapper.style.width = `${Math.floor(viewport.width)}px`
        slot.wrapper.style.height = `${Math.floor(viewport.height)}px`
        this.restore(anchor)
      }
      let ratio = window.devicePixelRatio || 1
      const pixels = viewport.width * viewport.height * ratio * ratio
      if (pixels > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / pixels)
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width * ratio)
      canvas.height = Math.floor(viewport.height * ratio)
      const task = page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined })
      slot.task = task
      await task.promise
      if (slot.pendingKey !== key || this.pdf !== pdf) return
      slot.task = null

      const textLayer = h('div', { class: 'textLayer' })
      try {
        await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport }).render()
      } catch {}
      const linkLayer = await this.buildLinks(page, viewport)
      if (slot.pendingKey !== key || this.pdf !== pdf) return

      canvas.style.width = '100%'
      canvas.style.height = '100%'
      slot.canvas?.remove()
      slot.textLayer?.remove()
      slot.linkLayer?.remove()
      slot.wrapper.prepend(canvas, textLayer)
      if (linkLayer) slot.wrapper.append(linkLayer)
      slot.canvas = canvas
      slot.textLayer = textLayer
      slot.linkLayer = linkLayer
      slot.renderedKey = key
    } catch (err) {
      if ((err as Error)?.name !== 'RenderingCancelledException') console.error('PDF render failed', err)
    } finally {
      if (slot.pendingKey === key) slot.pendingKey = ''
    }
  }

  /** Frees canvases of pages that scrolled far away, so long documents stay light. */
  private evict(): void {
    const rendered = this.slots.filter((s) => s.canvas)
    if (rendered.length <= MAX_RENDERED) return
    rendered.sort((a, b) => a.lastVisible - b.lastVisible)
    for (const slot of rendered.slice(0, rendered.length - MAX_RENDERED)) {
      if (this.isNear(slot)) continue
      slot.canvas?.remove()
      slot.textLayer?.remove()
      slot.linkLayer?.remove()
      slot.canvas = null
      slot.textLayer = null
      slot.linkLayer = null
      slot.renderedKey = ''
    }
  }

  destroy(): void {
    this.loadToken++
    this.observer.disconnect()
    this.resizeObserver.disconnect()
    for (const slot of this.slots) slot.task?.cancel()
    void this.pdf?.loadingTask.destroy()
    this.pdf = null
  }
}
