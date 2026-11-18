type Child = Node | string | number | null | undefined | false | Child[]
type Props = Record<string, unknown> | null

/** Tiny element builder: h('button', { class: 'btn', onclick: fn }, 'Label') */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined) continue
      if (value === false) {
        // Attributes whose "false" is meaningful rather than the same as absent.
        if (key === 'spellcheck' || key === 'draggable') el.setAttribute(key, 'false')
        continue
      }
      if (key === 'class') el.className = String(value)
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value)
      else if (key === 'dataset' && typeof value === 'object') Object.assign(el.dataset, value)
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value as EventListener)
      else if (key in el && key !== 'list' && typeof value !== 'string') (el as unknown as Record<string, unknown>)[key] = value
      else el.setAttribute(key, value === true ? '' : String(value))
    }
  }
  append(el, children)
  return el
}

function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    if (Array.isArray(c)) append(parent, c)
    else parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)))
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild)
}

// ---- icons (static inline SVG) ---------------------------------------------------

const ICONS: Record<string, string> = {
  folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>',
  file: '<path d="M4 2.5h5L12 5.5v8H4z"/><path d="M9 2.5v3h3"/>',
  image: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1"/><path d="m3 11.5 3-3 2.5 2.5 2-2 2.5 2.5"/>',
  chevron: '<path d="m6 4 4 4-4 4"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3.5 8h9"/>',
  scissors: '<circle cx="4.5" cy="4.5" r="2"/><circle cx="4.5" cy="11.5" r="2"/><path d="M6.2 5.6 13.5 12M6.2 10.4 13.5 4"/>',
  updown: '<path d="m5 6.5 3-3 3 3M5 9.5l3 3 3-3"/>',
  'folder-plus': '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/><path d="M8 7v4M6 9h4"/>',
  upload: '<path d="M8 10.5V3m0 0L5 6m3-3 3 3M3 10.5v2h10v-2"/>',
  download: '<path d="M8 3v7.5m0 0-3-3m3 3 3-3M3 12.5h10"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5"/>',
  settings: '<path d="M7.12 3.38 7.11 1.76h1.78l-.01 1.62 1.76.73 1.14-1.15 1.26 1.26-1.15 1.14.73 1.76 1.62-.01v1.78l-1.62-.01-.73 1.76 1.15 1.14-1.26 1.26-1.14-1.15-1.76.73.01 1.62H7.11l.01-1.62-1.76-.73-1.14 1.15-1.26-1.26 1.15-1.14-.73-1.76-1.62.01V7.11l1.62.01.73-1.76-1.15-1.14 1.26-1.26 1.14 1.15z"/><circle cx="8" cy="8" r="2"/>',
  share: '<circle cx="4" cy="8" r="1.7"/><circle cx="11.5" cy="4" r="1.7"/><circle cx="11.5" cy="12" r="1.7"/><path d="m5.5 7.2 4.5-2.4M5.5 8.8l4.5 2.4"/>',
  history: '<path d="M2.5 8a5.5 5.5 0 1 0 1.7-4"/><path d="M2.5 3v2.5H5M8 5v3.2l2 1.3"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 3v2.5h-2.5"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  back: '<path d="M10 3 5 8l5 5"/>',
  up: '<path d="m4 9.5 4-4 4 4"/>',
  sidebar: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/>',
  'zoom-in': '<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3M7 5v4M5 7h4"/>',
  'zoom-out': '<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3M5 7h4"/>',
  error: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.5M8 10.6v.2"/>',
  warning: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.2v.2"/>',
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.2V11M8 5v.2"/>',
  check: '<path d="m3.5 8.5 3 3 6-7"/>',
  more: '<circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M3 10.5V3.7c0-.4.3-.7.7-.7h6.8"/>',
  target: '<circle cx="8" cy="8" r="4.5"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/>',
  cloud: '<path d="M4.5 12a2.8 2.8 0 0 1-.3-5.6A4 4 0 0 1 12 7a2.5 2.5 0 0 1-.3 5z"/>',
  logout: '<path d="M6.5 3H3.5v10h3M10 5l3 3-3 3M13 8H6.5"/>',
  list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.1M2.5 8h.1M2.5 12h.1"/>',
  pdf: '<path d="M4 2.5h5L12 5.5v8H4z"/><path d="M9 2.5v3h3M6 9.5h4M6 11.5h2.5"/>',
  sparkle: '<path d="M7 2.5 8.2 6 11.5 7 8.2 8.2 7 11.5 5.8 8.2 2.5 7 5.8 6z"/><path d="M12.2 10.5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z"/>',
  send: '<path d="M2.5 8 13.5 3l-3.2 10.2L8 9z"/><path d="M8 9l5.5-6"/>',
  stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.2"/>',
  sun: '<circle cx="8" cy="8" r="2.6"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1"/>',
  moon: '<path d="M13 9.8A5.5 5.5 0 0 1 6.2 3a5.5 5.5 0 1 0 6.8 6.8z"/>',
  contrast: '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11a5.5 5.5 0 0 0 0-11z" fill="currentColor" stroke="none"/>',
}

export function icon(name: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.4')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('icon')
  svg.innerHTML = ICONS[name] ?? ''
  return svg
}

export function iconButton(name: string, title: string, onclick: (e: MouseEvent) => void, extraClass = ''): HTMLButtonElement {
  return h('button', { class: `icon-btn ${extraClass}`, title, 'aria-label': title, type: 'button', onclick }, icon(name))
}

// ---- toasts ------------------------------------------------------------------------

let toastHost: HTMLElement | null = null

export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info', ms = 4000, action?: { label: string; onclick: () => void }): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' })
    document.body.appendChild(toastHost)
  }
  const el = h('div', { class: `toast toast-${kind}` }, h('span', null, message),
    action ? h('button', { class: 'toast-action', type: 'button', onclick: action.onclick }, action.label) : null)
  toastHost.appendChild(el)
  setTimeout(() => {
    el.classList.add('leaving')
    setTimeout(() => el.remove(), 250)
  }, ms)
}

// ---- modals ------------------------------------------------------------------------

/** While a dialog is open, the page behind it cannot be clicked, focused or typed into. */
function setBackgroundInert(): void {
  const backdrops = [...document.querySelectorAll<HTMLElement>('.modal-backdrop')]
  document.getElementById('app')?.toggleAttribute('inert', backdrops.length > 0)
  backdrops.forEach((b, i) => b.toggleAttribute('inert', i < backdrops.length - 1))
}

const openModals = new Set<() => void>()

/** Closes every dialog and menu; used when the screen underneath goes away. */
export function closeOverlays(): void {
  for (const close of [...openModals]) close()
  document.querySelectorAll('.menu').forEach((el) => el.remove())
}

export type Modal = { close: () => void; body: HTMLElement; footer: HTMLElement; root: HTMLElement }

export function openModal(opts: { title: string; wide?: boolean; onClose?: () => void }): Modal {
  const body = h('div', { class: 'modal-body' })
  const footer = h('div', { class: 'modal-footer' })
  const previouslyFocused = document.activeElement as HTMLElement | null
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    openModals.delete(close)
    document.removeEventListener('keydown', onKey, true)
    root.remove()
    setBackgroundInert()
    opts.onClose?.()
    previouslyFocused?.focus?.()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && root === document.querySelector('.modal-backdrop:last-of-type')) {
      e.stopPropagation()
      close()
    }
  }
  const dialog = h('div', { class: `modal ${opts.wide ? 'modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
    h('div', { class: 'modal-header' }, h('h2', null, opts.title), iconButton('close', 'Close', close)),
    body,
    footer,
  )
  const root = h('div', { class: 'modal-backdrop', onmousedown: (e: MouseEvent) => e.target === root && close() }, dialog)
  document.body.appendChild(root)
  document.addEventListener('keydown', onKey, true)
  openModals.add(close)
  setBackgroundInert()
  dialog.tabIndex = -1
  dialog.focus()
  return { close, body, footer, root }
}

export function confirmDialog(opts: { title: string; message: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false
    const m = openModal({ title: opts.title, onClose: () => resolve(result) })
    m.body.appendChild(h('p', null, opts.message))
    const ok = h('button', { class: `btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', onclick: () => { result = true; m.close() } }, opts.confirmLabel)
    m.footer.append(h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), ok)
    ok.focus()
  })
}

export function promptDialog(opts: { title: string; label: string; value?: string; confirmLabel: string; placeholder?: string; selectStem?: boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null
    const m = openModal({ title: opts.title, onClose: () => resolve(result) })
    const input = h('input', { class: 'input', type: 'text', value: opts.value ?? '', placeholder: opts.placeholder ?? '', autocomplete: 'off', spellcheck: false })
    const submit = (): void => {
      const v = input.value.trim()
      if (!v) return
      result = v
      m.close()
    }
    m.body.appendChild(h('form', { onsubmit: (e: Event) => { e.preventDefault(); submit() } }, h('label', { class: 'field' }, h('span', null, opts.label), input)))
    m.footer.append(h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', type: 'button', onclick: submit }, opts.confirmLabel))
    input.focus()
    const dot = opts.selectStem ? input.value.lastIndexOf('.') : -1
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
  })
}

// ---- context menu ------------------------------------------------------------------

export type MenuItem = { label: string; icon?: string; danger?: boolean; shortcut?: string; onclick: () => void } | 'separator'

export function showMenu(x: number, y: number, items: MenuItem[]): void {
  document.querySelector('.menu')?.remove()
  const menu = h('div', { class: 'menu', role: 'menu' })
  const close = (): void => {
    menu.remove()
    document.removeEventListener('mousedown', onDown, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', close)
  }
  const onDown = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) close()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close()
  }
  for (const item of items) {
    if (item === 'separator') {
      menu.appendChild(h('div', { class: 'menu-sep' }))
      continue
    }
    menu.appendChild(h('button', {
      class: `menu-item ${item.danger ? 'danger' : ''}`, type: 'button', role: 'menuitem',
      onclick: () => { close(); item.onclick() },
    }, item.icon ? icon(item.icon) : h('span', { class: 'menu-spacer' }), item.label,
      item.shortcut ? h('span', { class: 'menu-shortcut' }, item.shortcut) : null))
  }
  document.body.appendChild(menu)
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
  })
}

// ---- small helpers -------------------------------------------------------------------

/** Clipboard write that also works on plain-HTTP LAN pages, where navigator.clipboard is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {}
  const ta = h('textarea', { style: { position: 'fixed', opacity: '0', top: '0' }, readOnly: true })
  ta.value = text
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {}
  ta.remove()
  return ok
}

/**
 * A copy button that shows it worked: for a moment it turns into a check mark and "Copied".
 * label: the button text ('' for just the icon, where space is tight); what: for its tooltip.
 */
export function copyButton(get: () => string, opts: { label?: string; what?: string } = {}): HTMLButtonElement {
  const label = opts.label ?? 'Copy'
  const title = `Copy ${opts.what ?? 'this'}`
  const btn = h('button', { class: `copy-btn ${label ? '' : 'icon-only'}`, type: 'button', title, 'aria-label': title }) as HTMLButtonElement
  let timer: ReturnType<typeof setTimeout> | null = null
  const show = (copied: boolean): void => {
    clear(btn)
    btn.append(icon(copied ? 'check' : 'copy', 13), label ? (copied ? 'Copied' : label) : '')
    btn.classList.toggle('copied', copied)
    btn.setAttribute('aria-label', copied ? 'Copied' : title)
  }
  show(false)
  btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    if (!(await copyText(get()))) return toast('Could not copy. Select the text and copy it.', 'error')
    show(true)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => show(false), 1500)
  })
  return btn
}

/**
 * Text to copy, shown as code with its copy button inside: at the right end of a one-line field,
 * or in the top-right corner of a block (several lines, or long text that wraps).
 */
export function copyBox(text: string, opts: { what?: string; block?: boolean; class?: string } = {}): HTMLElement {
  const block = opts.block ?? (text.includes('\n') || text.length > 90)
  return h('div', { class: `copy-box ${block ? 'block' : 'line'} ${opts.class ?? ''}`, onclick: (e: Event) => e.stopPropagation() },
    h(block ? 'pre' : 'code', { class: 'copy-text' }, text),
    copyButton(() => text, { what: opts.what }))
}

export function store(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(`lw.${key}`)
    if (value === null) localStorage.removeItem(`lw.${key}`)
    else localStorage.setItem(`lw.${key}`, value)
  } catch {}
  return value ?? null
}

export function timeAgo(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 14) return `${Math.floor(s / 86400)} d ago`
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}
