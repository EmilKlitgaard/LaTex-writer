import {
  api, type AccessRequest, type AiActivity, type GrantedProject, type AiSettings, type AiUsage, type ChatContext, type ChatMessage, type ChatSummary, type ChatPart, type Hunk, type ReviewFile, type ReviewSummary, type ServerEvent, type SkillInfo,
} from './api.ts'
import { app } from './app.ts'
import { clear, confirmDialog, h, icon, iconButton, toast } from './dom.ts'
import { renderMarkdown } from './markdown.ts'

export type AiPanelHooks = {
  /** What the user is looking at in the editor right now. */
  context: () => ChatContext
  onJump: (file: string, line: number) => void
  /** Text files in the project, so file names in replies can link to them. */
  files: () => string[]
  /** Where a \label or citation key is defined, so `eq:E` in a reply can link to it. */
  symbol: (name: string) => { file: string; line: number; what: string } | null
  onReview: (review: ReviewSummary) => void
  onClose: () => void
  /** The assistant started or finished working, so the button that opens it can show it. */
  onBusy?: (busy: boolean) => void
  /** The assistant asks for something only the user can answer, so the panel should be shown. */
  onAttention?: () => void
}

type ChatState = {
  messages: ChatMessage[]; busy: boolean; usage: AiUsage; chats: ChatSummary[]; activity?: AiActivity | null
  attachments?: string[]; granted?: GrantedProject[]; requests?: AccessRequest[]
}

const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p

/** A picture waiting to go with the next message: base64 data for the server, a local URL for the preview. */
type PendingImage = { type: string; data: string; url: string }

const MAX_IMAGES = 4
const SENDABLE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
/** The models take pictures up to 5 MB, and scale anything larger than about this size down anyway. */
const MAX_BYTES = 4.5 * 1024 * 1024
const MAX_SIDE = 2000

const toBase64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
  reader.onerror = () => reject(new Error('That image could not be read.'))
  reader.readAsDataURL(blob)
})

/**
 * Makes a pasted picture something the models take: a PNG, JPEG, GIF or WebP of at most 5 MB.
 * Large pictures (a full-screen Retina screenshot) are scaled down, which also keeps them cheap to send.
 */
async function prepareImage(file: Blob): Promise<PendingImage> {
  let blob: Blob = file
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('That image could not be read. Paste a PNG, JPEG, GIF or WebP picture.')
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  // An animated GIF that fits is sent as it is; anything else that is too big, or of another type, is redrawn.
  if (!SENDABLE.includes(file.type) || file.size > MAX_BYTES || (scale < 1 && file.type !== 'image/gif')) {
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const encode = (type: string, quality?: number): Promise<Blob | null> => new Promise((resolve) => canvas.toBlob(resolve, type, quality))
    blob = (await encode('image/png')) ?? blob
    if (blob.size > MAX_BYTES) blob = (await encode('image/jpeg', 0.88)) ?? blob
  }
  bitmap.close()
  if (blob.size > MAX_BYTES || !SENDABLE.includes(blob.type)) throw new Error('That image is too large to send (at most 5 MB).')
  return { type: blob.type, data: await toBase64(blob), url: URL.createObjectURL(blob) }
}

/** A sent picture at full size, over the app; a click or Escape closes it. */
function showImage(src: string): void {
  const close = (): void => {
    overlay.remove()
    document.removeEventListener('keydown', onKey, true)
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    close()
  }
  const overlay = h('div', { class: 'ai-lightbox', role: 'dialog', 'aria-label': 'Image', onclick: close }, h('img', { src, alt: 'Image' }))
  document.addEventListener('keydown', onKey, true)
  document.body.append(overlay)
}

const SUGGESTIONS = ['Fix the compile errors', 'Proofread the selected text', 'Make the selected paragraph shorter', 'Check the PDF for layout problems']
const EFFORT_LABELS: Record<string, string> = { low: 'Quick', medium: 'Balanced', high: 'Thorough' }
const MAX_LINES_SHOWN = 14
/** Past this size every step of the conversation gets expensive; suggest starting over. */
const LONG_CONVERSATION = 80_000

function formatWhen(t: number): string {
  if (!t) return ''
  const d = new Date(t)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/** The assistant sidebar: a chat, and the list of changes waiting for a decision. */
export class AiPanel {
  readonly element: HTMLElement
  private hooks: AiPanelHooks
  private messages: ChatMessage[] = []
  private busy = false
  /** What the assistant is doing right now, as reported by the server. */
  private activity: AiActivity | null = null
  private clock: ReturnType<typeof setInterval> | null = null
  private usage: AiUsage = {}
  private review: ReviewSummary = { files: [], changeCount: 0, hasBeforePdf: false }
  private listEl: HTMLElement
  private reviewEl: HTMLElement
  /** The list of changes is tucked into a bar until the user opens it. */
  private reviewOpen = false
  private historyEl: HTMLElement
  private historyOpen = false
  /** Chats of this project, as last reported by the server. */
  private chats: ChatSummary[] = []
  private input: HTMLTextAreaElement
  /** The list of /commands shown while the user types one. */
  private slashEl: HTMLElement
  private slashItems: SkillInfo[] = []
  private slashIndex = 0
  private sendBtn: HTMLButtonElement
  private contextEl: HTMLElement
  private usageEl: HTMLElement
  private modelSelect: HTMLSelectElement
  private effortSelect: HTMLSelectElement
  /** Files and folders attached to this chat, and other projects this project may read. */
  private attachments: string[] = []
  private granted: GrantedProject[] = []
  private requests: AccessRequest[] = []
  private sourcesEl: HTMLElement
  private requestsEl: HTMLElement
  private attachMenu: HTMLElement
  /** Pictures pasted into the message being written. */
  private images: PendingImage[] = []
  private imagesEl: HTMLElement
  /** Pictures are added one paste after another, so they keep the order they were pasted in. */
  private imageQueue: Promise<void> = Promise.resolve()
  private nodes = new Map<string, HTMLElement>()
  private renderQueued = new Set<string>()
  private stickToBottom = true

  constructor(hooks: AiPanelHooks) {
    this.hooks = hooks
    this.listEl = h('div', { class: 'ai-messages', 'aria-live': 'polite' })
    // Following the bottom stops only when the user scrolls up, and starts again near the bottom.
    // (The chat's own scrolling while it draws messages fires scroll events late, when more content
    // has been added; those must not count as leaving the bottom.)
    let lastTop = 0
    this.listEl.addEventListener('scroll', () => {
      const top = this.listEl.scrollTop
      const nearBottom = this.listEl.scrollHeight - top - this.listEl.clientHeight < 40
      if (nearBottom) this.stickToBottom = true
      else if (top < lastTop - 1) this.stickToBottom = false
      lastTop = top
    })
    // The area below the chat changes height after it is drawn (the file and source chips, a
    // placeholder that wraps, the usage line): stay at the bottom when the chat was there.
    new ResizeObserver(() => this.keepBottom()).observe(this.listEl)
    this.historyEl = h('div', { class: 'ai-history', hidden: true, role: 'menu' })
    this.reviewEl = h('div', { class: 'ai-review', hidden: true })
    this.contextEl = h('div', { class: 'ai-context' })
    this.usageEl = h('div', { class: 'ai-usage' })
    this.sourcesEl = h('div', { class: 'ai-sources', hidden: true })
    this.imagesEl = h('div', { class: 'ai-images', hidden: true })
    this.requestsEl = h('div', { class: 'ai-requests', hidden: true })
    this.attachMenu = h('div', { class: 'ai-attach-menu', hidden: true, role: 'menu' },
      h('button', { type: 'button', role: 'menuitem', onclick: () => void this.attach('file') }, icon('file', 14), 'Add files…'),
      h('button', { type: 'button', role: 'menuitem', onclick: () => void this.attach('folder') }, icon('folder', 14), 'Add a folder…'),
      h('div', { class: 'ai-attach-note' }, 'The assistant can read them in this chat only, and never changes them.'))
    this.slashEl = h('div', { class: 'ai-slash', hidden: true, role: 'listbox', 'aria-label': 'Writing skills' })
    this.input = h('textarea', {
      class: 'ai-input', rows: 2, placeholder: 'Ask for a change, or type / for writing skills', 'aria-label': 'Message to the assistant',
      onkeydown: (e: KeyboardEvent) => {
        if (this.slashItems.length && !e.isComposing) {
          const n = this.slashItems.length
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            this.slashIndex = (this.slashIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
            return this.renderSlash()
          }
          if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
            e.preventDefault()
            return this.pickSkill(this.slashItems[this.slashIndex])
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            return this.closeSlash()
          }
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          void this.send()
        }
      },
      oninput: () => {
        this.autosize()
        this.updateSlash()
      },
      onfocus: () => this.updateContext(),
      onblur: () => this.closeSlash(),
      // A picture on the clipboard (a screenshot, an image copied from a page) goes with the message.
      // Text wins when the clipboard has both, as it does when copying from Word or Pages.
      onpaste: (e: ClipboardEvent) => {
        const data = e.clipboardData
        if (!data || data.getData('text/plain')) return
        const files = [...data.files].filter((f) => f.type.startsWith('image/'))
        if (!files.length) return
        e.preventDefault()
        this.queueImages(files)
      },
    })
    this.sendBtn = h('button', { class: 'btn btn-primary ai-send', type: 'button', onclick: () => (this.busy ? void this.stop() : void this.send()) })
    this.modelSelect = h('select', { class: 'ai-model', title: 'Model', 'aria-label': 'Model', onchange: () => void this.setSetting({ aiModel: this.modelSelect.value }) })
    this.effortSelect = h('select', { class: 'ai-model', title: 'How much the assistant thinks before acting. Quick uses the least of your plan.', 'aria-label': 'Effort', onchange: () => void this.setSetting({ aiEffort: this.effortSelect.value }) })

    this.element = h('aside', { class: 'pane ai-pane', 'aria-label': 'Assistant' },
      h('div', { class: 'pane-header' },
        icon('sparkle'), h('strong', null, 'Assistant'), h('span', { class: 'grow' }),
        iconButton('history', 'Earlier chats', () => void this.toggleHistory()),
        iconButton('plus', 'New chat (this one stays in the list)', () => void this.reset()),
        iconButton('close', 'Hide the assistant', () => this.hooks.onClose()),
      ),
      this.historyEl,
      this.listEl,
      this.requestsEl,
      this.reviewEl,
      h('div', { class: 'ai-composer' },
        this.slashEl,
        this.attachMenu,
        h('div', { class: 'ai-box' },
          h('div', { class: 'ai-box-top' }, this.contextEl, this.sourcesEl, this.imagesEl),
          this.input,
          h('div', { class: 'ai-box-bar' },
            h('button', { class: 'icon-btn ai-attach', type: 'button', title: 'Let the assistant read files or folders from this Mac in this chat', 'aria-label': 'Add files or folders', 'aria-haspopup': 'menu', onclick: () => this.toggleAttachMenu() }, icon('plus', 15)),
            this.modelSelect, this.effortSelect, h('span', { class: 'grow' }), this.sendBtn)),
        this.usageEl),
    )
    // Pictures dropped on the message box go with the message too.
    const box = this.input.parentElement!
    const hasImage = (e: DragEvent): boolean => [...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file' && i.type.startsWith('image/'))
    box.addEventListener('dragover', (e) => {
      if (!hasImage(e)) return
      e.preventDefault()
      box.classList.add('drop-target')
    })
    box.addEventListener('dragleave', (e) => {
      if (!box.contains(e.relatedTarget as Node | null)) box.classList.remove('drop-target')
    })
    box.addEventListener('drop', (e) => {
      box.classList.remove('drop-target')
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'))
      if (!files.length) return
      e.preventDefault()
      this.queueImages(files)
    })
    this.applySettings()
    this.renderAll()
    this.updateSendButton()
    void this.refresh()
  }

  // ---- pasted pictures -------------------------------------------------------------

  private queueImages(files: File[]): void {
    this.imageQueue = this.imageQueue.then(() => this.addImages(files))
  }

  private async addImages(files: File[]): Promise<void> {
    const room = MAX_IMAGES - this.images.length
    if (room <= 0) {
      toast(`A message can have at most ${MAX_IMAGES} images.`, 'info')
      return
    }
    if (files.length > room) toast(`Only the first ${room === 1 ? 'image was' : `${room} images were`} added: a message can have at most ${MAX_IMAGES}.`, 'info')
    for (const file of files.slice(0, room)) {
      try {
        this.images.push(await prepareImage(file))
      } catch (err) {
        toast((err as Error).message, 'error')
      }
    }
    this.renderImages()
    this.input.focus()
  }

  private removeImage(img: PendingImage): void {
    this.images = this.images.filter((i) => i !== img)
    URL.revokeObjectURL(img.url)
    this.renderImages()
    this.input.focus()
  }

  private renderImages(): void {
    clear(this.imagesEl)
    this.imagesEl.hidden = !this.images.length
    this.images.forEach((img, i) => {
      const label = `Image ${i + 1}`
      this.imagesEl.append(h('span', { class: 'ai-image-chip', title: `${label} goes with your message` },
        h('img', { src: img.url, alt: label }),
        h('button', { class: 'ai-image-remove', type: 'button', title: 'Remove', 'aria-label': `Remove ${label.toLowerCase()}`, onclick: () => this.removeImage(img) }, icon('close', 10))))
    })
    this.keepBottom()
  }

  // ---- state ------------------------------------------------------------------------

  async refresh(): Promise<void> {
    try {
      const res = await api<{ ai: AiSettings; chat: ChatState | null; review: ReviewSummary | null }>('GET', '/api/host/ai/state')
      app.ai = res.ai
      this.applySettings()
      this.messages = res.chat?.messages ?? []
      this.busy = res.chat?.busy ?? false
      this.activity = res.chat?.activity ?? null
      this.usage = res.chat?.usage ?? {}
      this.chats = res.chat?.chats ?? []
      this.setSources(res.chat?.attachments ?? [], res.chat?.granted ?? [])
      this.setRequests(res.chat?.requests ?? [])
      this.renderAll()
      this.updateSendButton()
      this.renderUsage()
      if (res.review) this.setReview(res.review)
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  applySettings(): void {
    const ai = app.ai
    clear(this.modelSelect)
    for (const m of ai?.models ?? []) this.modelSelect.appendChild(h('option', { value: m.id, selected: m.id === ai?.model }, m.label))
    this.modelSelect.value = ai?.model ?? ''
    this.modelSelect.title = `${ai?.providerName ?? 'Assistant'} model (change the assistant in Settings)`
    clear(this.effortSelect)
    for (const e of ai?.efforts ?? []) this.effortSelect.appendChild(h('option', { value: e, selected: e === ai?.effort }, EFFORT_LABELS[e] ?? e))
    this.effortSelect.value = ai?.effort ?? ''
  }

  handleEvent(e: ServerEvent): void {
    if (e.type === 'review') return this.setReview(e.review)
    if (e.type !== 'ai') return
    switch (e.kind) {
      case 'message':
        if (!this.messages.some((m) => m.id === e.message.id)) this.messages.push(e.message)
        this.renderMessage(e.message.id)
        break
      case 'delta': {
        const m = this.messages.find((x) => x.id === e.id)
        if (!m) break
        const last = m.parts[m.parts.length - 1]
        if (last?.kind === 'text') last.text += e.text
        else m.parts.push({ kind: 'text', text: e.text })
        this.queueRender(m.id)
        break
      }
      case 'tool': {
        const m = this.messages.find((x) => x.id === e.id)
        if (!m) break
        const part = e.part as Extract<ChatPart, { kind: 'tool' }>
        const existing = m.parts.find((p) => p.kind === 'tool' && p.id === part.id)
        if (existing) Object.assign(existing, part)
        else m.parts.push(part)
        this.queueRender(m.id)
        break
      }
      case 'done': {
        const i = this.messages.findIndex((x) => x.id === e.message.id)
        if (i >= 0) this.messages[i] = e.message
        this.renderMessage(e.message.id)
        break
      }
      case 'busy':
        this.busy = e.busy
        if (!this.busy) this.activity = null
        this.updateSendButton()
        if (!this.busy) for (const m of this.messages) this.renderMessage(m.id)
        break
      case 'activity': {
        this.activity = e.activity
        const last = this.messages[this.messages.length - 1]
        if (last) this.queueRender(last.id)
        break
      }
      case 'usage':
        this.usage = e.usage
        this.renderUsage()
        break
      case 'loaded':
        // A chat was started, opened or deleted: show whichever one is in use now.
        this.messages = e.messages
        this.busy = e.busy
        this.activity = e.activity ?? null
        this.usage = e.usage ?? {}
        this.chats = e.chats ?? []
        this.setSources(e.attachments ?? [], e.granted ?? [])
        this.stickToBottom = true
        this.renderAll()
        this.renderUsage()
        this.updateSendButton()
        if (this.historyOpen) this.renderHistory()
        break
      case 'settings': {
        const wasAvailable = app.ai?.available
        app.ai = e.ai
        this.applySettings()
        // Another assistant was chosen or found: the empty state may say something else now.
        if (wasAvailable !== e.ai.available || !this.messages.length) this.renderAll()
        break
      }
      case 'sources':
        this.setSources(e.attachments ?? [], e.granted ?? [])
        break
      case 'access':
        this.setRequests(e.requests ?? [])
        break
    }
  }

  // ---- chat -------------------------------------------------------------------------

  private async send(text = this.input.value): Promise<void> {
    const message = text.trim()
    const images = this.images
    if (!message && !images.length) return
    if (this.busy) {
      toast('The assistant is still working on your last message. Wait for it, or press Stop.', 'info')
      return
    }
    this.input.value = ''
    this.images = []
    this.renderImages()
    this.autosize()
    this.stickToBottom = true
    try {
      await api('POST', '/api/host/ai/send', { text: message, context: this.hooks.context(), images: images.map(({ type, data }) => ({ type, data })) })
      for (const img of images) URL.revokeObjectURL(img.url)
    } catch (err) {
      this.input.value = message
      this.images = [...images, ...this.images]
      this.renderImages()
      this.autosize()
      toast((err as Error).message, 'error', 7000)
    }
  }

  private async stop(): Promise<void> {
    try {
      await api('POST', '/api/host/ai/stop', {})
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  private async reset(): Promise<void> {
    if (!this.messages.length) return
    this.closeHistory()
    try {
      await api('POST', '/api/host/ai/reset', {})
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  // ---- attachments and other projects ---------------------------------------------------

  private toggleAttachMenu(open = this.attachMenu.hidden): void {
    this.attachMenu.hidden = !open
    if (open) document.addEventListener('mousedown', this.onOutsideAttach, true)
    else document.removeEventListener('mousedown', this.onOutsideAttach, true)
  }

  private onOutsideAttach = (e: MouseEvent): void => {
    const target = e.target as Element
    if (!this.attachMenu.contains(target) && !target.closest?.('.ai-attach')) this.toggleAttachMenu(false)
  }

  private async attach(kind: 'file' | 'folder'): Promise<void> {
    this.toggleAttachMenu(false)
    try {
      const res = await api<{ attachments: string[] }>('POST', '/api/host/ai/attach', { kind })
      this.setSources(res.attachments, this.granted)
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  private async detach(p: string): Promise<void> {
    try {
      await api('POST', '/api/host/ai/detach', { path: p })
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  private async revoke(p: GrantedProject): Promise<void> {
    const ok = await confirmDialog({ title: 'Remove access', message: `The assistant in this project will no longer be able to read "${p.name}". It can ask again later.`, confirmLabel: 'Remove access' })
    if (!ok) return
    try {
      await api('POST', '/api/host/ai/access/revoke', { path: p.path })
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  private setSources(attachments: string[], granted: GrantedProject[]): void {
    this.attachments = attachments
    this.granted = granted
    clear(this.sourcesEl)
    this.sourcesEl.hidden = !attachments.length && !granted.length
    const chip = (iconName: string, label: string, title: string, removeLabel: string, onRemove: () => void, cls = ''): HTMLElement =>
      h('span', { class: `ai-source ${cls}`, title },
        icon(iconName, 12), h('span', { class: 'ai-source-name' }, label),
        h('button', { class: 'ai-source-remove', type: 'button', title: removeLabel, 'aria-label': `${removeLabel}: ${label}`, onclick: onRemove }, icon('close', 11)))
    for (const p of granted) this.sourcesEl.append(chip('share', p.name, `The assistant may read the project "${p.name}" (read-only). This lasts until you remove it.`, 'Remove access', () => void this.revoke(p), 'granted'))
    for (const a of attachments) this.sourcesEl.append(chip(/\.[a-z0-9]{1,6}$/i.test(a) ? 'file' : 'folder', baseName(a), `${a}\nThe assistant may read this in this chat (read-only).`, 'Remove from this chat', () => void this.detach(a)))
    this.keepBottom()
  }

  private setRequests(requests: AccessRequest[]): void {
    const had = this.requests.length
    this.requests = requests
    clear(this.requestsEl)
    this.requestsEl.hidden = !requests.length
    for (const r of requests) {
      this.requestsEl.append(h('div', { class: 'ai-request', role: 'alertdialog', 'aria-label': `Allow reading ${r.project}?` },
        h('div', { class: 'ai-request-head' }, icon('share', 14), h('strong', null, `Let the assistant read “${r.project}”?`)),
        h('p', { class: 'ai-request-reason' }, r.reason),
        h('p', { class: 'muted ai-request-note' }, 'Read-only: it can look at and copy from that project, never change it. You can take this back from the chip under the message box.'),
        h('div', { class: 'ai-request-actions' },
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => void this.answer(r, false) }, 'Don’t allow'),
          h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => void this.answer(r, true) }, 'Allow for this project'))))
    }
    if (requests.length > had) this.hooks.onAttention?.()
  }

  private async answer(r: AccessRequest, allow: boolean): Promise<void> {
    try {
      await api('POST', '/api/host/ai/access/answer', { id: r.id, allow })
    } catch (err) {
      toast((err as Error).message, 'error')
    }
    this.setRequests(this.requests.filter((x) => x.id !== r.id))
  }

  // ---- earlier chats ------------------------------------------------------------------

  private closeHistory(): void {
    this.historyOpen = false
    this.historyEl.hidden = true
    document.removeEventListener('mousedown', this.onOutside, true)
    document.removeEventListener('keydown', this.onEscape, true)
  }

  private onOutside = (e: MouseEvent): void => {
    const target = e.target as Node
    // The button that opens the list toggles it itself.
    if (!this.historyEl.contains(target) && !(target as Element).closest?.('[aria-label="Earlier chats"]')) this.closeHistory()
  }

  private onEscape = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.closeHistory()
  }

  private async toggleHistory(): Promise<void> {
    if (this.historyOpen) return this.closeHistory()
    try {
      const res = await api<{ chat: { chats: ChatSummary[] } | null }>('GET', '/api/host/ai/state')
      this.chats = res.chat?.chats ?? []
    } catch {}
    this.historyOpen = true
    this.historyEl.hidden = false
    this.renderHistory()
    document.addEventListener('mousedown', this.onOutside, true)
    document.addEventListener('keydown', this.onEscape, true)
  }

  private renderHistory(): void {
    clear(this.historyEl)
    this.historyEl.append(h('div', { class: 'ai-history-head' }, 'Chats in this project (the 10 newest are kept)'))
    if (!this.chats.length) this.historyEl.append(h('div', { class: 'ai-history-empty muted' }, 'No chats yet.'))
    for (const c of this.chats) {
      this.historyEl.append(h('div', { class: `ai-history-row ${c.active ? 'current' : ''}` },
        h('button', {
          class: 'ai-history-open', type: 'button', role: 'menuitem', title: c.active ? 'The chat you are in' : 'Open this chat and continue it',
          onclick: () => void this.openChat(c),
        }, h('span', { class: 'ai-history-title' }, c.title), h('span', { class: 'ai-history-date' }, c.active ? 'Current' : formatWhen(c.t))),
        h('button', { class: 'icon-btn', type: 'button', title: 'Delete this chat', 'aria-label': `Delete chat: ${c.title}`, onclick: () => void this.deleteChat(c) }, icon('trash', 14)),
      ))
    }
  }

  private async openChat(c: ChatSummary): Promise<void> {
    this.closeHistory()
    if (c.active) return
    try {
      await api('POST', '/api/host/ai/open', { id: c.id })
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  private async deleteChat(c: ChatSummary): Promise<void> {
    const ok = await confirmDialog({ title: 'Delete chat', message: `Delete "${c.title}"? This cannot be undone.`, confirmLabel: 'Delete', danger: true })
    if (!ok) return
    try {
      await api('POST', '/api/host/ai/delete', { id: c.id })
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  private async setSetting(patch: Record<string, string>): Promise<void> {
    try {
      await api('POST', '/api/host/settings', patch)
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  // ---- /commands ----------------------------------------------------------------------

  /** Shows the matching skills while the input is a / followed by the start of a name. */
  private updateSlash(): void {
    const m = /^\/([a-z0-9-]*)$/.exec(this.input.value)
    const items = m ? (app.ai?.skills ?? []).filter((s) => s.name.startsWith(m[1])) : []
    if (!items.length) return this.closeSlash()
    if (items.length !== this.slashItems.length || items.some((s, i) => s !== this.slashItems[i])) this.slashIndex = 0
    this.slashItems = items
    this.renderSlash()
  }

  private renderSlash(): void {
    clear(this.slashEl)
    this.slashEl.hidden = false
    this.slashItems.forEach((s, i) => {
      this.slashEl.append(h('button', {
        class: `ai-slash-item ${i === this.slashIndex ? 'active' : ''}`, type: 'button', role: 'option', 'aria-selected': i === this.slashIndex ? 'true' : 'false',
        // mousedown, so the input keeps its focus and the list is not closed by the blur first.
        onmousedown: (e: MouseEvent) => {
          e.preventDefault()
          this.pickSkill(s)
        },
      },
      h('span', { class: 'ai-slash-name' }, `/${s.name}`, h('span', { class: 'ai-slash-hint' }, s.hint)),
      h('span', { class: 'ai-slash-desc' }, s.description)))
    })
  }

  private closeSlash(): void {
    this.slashItems = []
    this.slashEl.hidden = true
  }

  /** Puts /name into the input, ready for what to apply it to; Enter on its own uses the selection. */
  private pickSkill(s: SkillInfo): void {
    this.closeSlash()
    this.input.value = `/${s.name} `
    this.input.focus()
    this.input.setSelectionRange(this.input.value.length, this.input.value.length)
    this.autosize()
  }

  private autosize(): void {
    this.input.style.height = 'auto'
    this.input.style.height = `${Math.min(160, this.input.scrollHeight + 2)}px`
    this.keepBottom()
  }

  /**
   * The area under the chat changes height (chips, the usage line, the input growing): when the
   * chat was at the bottom, keep it there, so the last message is neither cut off nor followed by
   * a gap. Called right after each such change; a ResizeObserver catches the rest.
   */
  private keepBottom(): void {
    if (this.stickToBottom) this.listEl.scrollTop = this.listEl.scrollHeight
  }

  /** The line under a reply in progress: a spinner, what is happening, and how long the turn has run. */
  private statusLine(): HTMLElement {
    return h('div', { class: 'ai-status', role: 'status' },
      h('span', { class: 'ai-spinner', 'aria-hidden': 'true' }),
      h('span', { class: 'ai-status-label' }, this.activity?.label ?? 'Thinking…'),
      h('span', { class: 'ai-status-time' }, this.elapsed()))
  }

  private elapsed(): string {
    if (!this.activity) return ''
    const s = Math.max(0, Math.floor((Date.now() - this.activity.started) / 1000))
    if (s < 2) return ''
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
  }

  /** Keeps the time on the status line current while the assistant works. */
  private tick(): void {
    if (this.busy && !this.clock) {
      this.clock = setInterval(() => {
        const t = this.listEl.querySelector('.ai-status-time')
        if (t) t.textContent = this.elapsed()
      }, 1000)
    } else if (!this.busy && this.clock) {
      clearInterval(this.clock)
      this.clock = null
    }
  }

  private updateSendButton(): void {
    this.tick()
    this.hooks.onBusy?.(this.busy)
    this.input.placeholder = this.busy ? 'The assistant is working… you can write your next message' : 'Ask for a change, or type / for writing skills'
    clear(this.sendBtn)
    this.sendBtn.append(icon(this.busy ? 'stop' : 'send'))
    this.sendBtn.title = this.busy ? 'Stop' : 'Send (Enter)'
    this.sendBtn.setAttribute('aria-label', this.sendBtn.title)
    this.sendBtn.classList.toggle('btn-primary', !this.busy)
    this.keepBottom()
  }

  updateContext(): void {
    const c = this.hooks.context()
    clear(this.contextEl)
    if (!c.file) return this.keepBottom()
    const lines = c.selection ? (c.selectionEnd ?? 0) - (c.selectionStart ?? 0) + 1 : 0
    this.contextEl.append(icon('file', 13), h('span', { class: 'ai-context-name' }, c.file), h('span', { class: 'ai-context-where' }, lines ? `${lines} line${lines === 1 ? '' : 's'} selected` : c.line ? `line ${c.line}` : ''))
    this.contextEl.title = 'The assistant is told which file you have open and what you have selected'
    this.keepBottom()
  }

  private renderUsage(): void {
    clear(this.usageEl)
    const bits: string[] = []
    const context = this.usage.context
    const long = typeof context === 'number' && context > LONG_CONVERSATION && this.messages.length > 0
    if (typeof context === 'number' && this.messages.length) bits.push(`${Math.round(context / 1000)}k tokens in this chat`)
    // Codex reports a whole reply (every step added up, mostly from cache), not the chat's size.
    const last = this.usage.lastReply
    if (!context && last && this.messages.length) bits.push(`Last reply read ${Math.round(last.input / 1000)}k tokens (${Math.round(last.cached / 1000)}k from cache)`)
    const u = this.usage.fiveHour
    const pct = typeof u === 'number' ? Math.round(u * 100) : null
    if (pct !== null) bits.push(`${pct}% of your 5-hour limit`)
    if (bits.length) this.usageEl.append(bits.join(' · '))
    if (long) {
      this.usageEl.append(h('br'), 'Long conversation: every step re-reads it. ',
        h('button', { class: 'link', type: 'button', onclick: () => void this.reset() }, 'Start a new chat'), ' when the task changes.')
    }
    this.usageEl.classList.toggle('warn', long || (pct ?? 0) >= 80)
    // Nothing to say (Codex before its first reply, a new chat): take no room under the message box.
    this.usageEl.hidden = !this.usageEl.childNodes.length
    this.keepBottom()
  }

  focus(): void {
    this.input.focus()
  }

  // ---- messages -----------------------------------------------------------------------

  private renderAll(): void {
    clear(this.listEl)
    this.nodes.clear()
    if (!app.ai?.available) {
      const name = app.ai?.providerName ?? 'Claude Code'
      const others = (app.ai?.providers ?? []).filter((p) => p.available && p.id !== app.ai?.provider)
      this.listEl.append(h('div', { class: 'ai-empty' },
        h('p', null, h('strong', null, `${name} was not found on this Mac.`)),
        h('p', { class: 'muted' }, app.ai?.provider === 'codex'
          ? 'Install the ChatGPT app or the Codex CLI and sign in, then choose Search again in Settings.'
          : 'The assistant runs through Claude Code with your Claude subscription. Install Claude Code, run "claude" once in Terminal to sign in, then reopen this panel.'),
        others.length ? h('p', { class: 'muted' }, `Found instead: ${others.map((p) => p.name).join(', ')}. Choose it in Settings › Assistant.`) : null))
      return
    }
    if (!this.messages.length) {
      this.listEl.append(h('div', { class: 'ai-empty' },
        h('p', { class: 'muted' }, 'Ask for changes to the document. Every change shows up below for you to accept or decline.'),
        h('div', { class: 'ai-suggestions' }, SUGGESTIONS.map((s) => h('button', { class: 'ai-suggestion', type: 'button', onclick: () => void this.send(s) }, s))),
        app.ai?.skills?.length
          ? h('p', { class: 'muted ai-skill-hint' }, 'Writing skills: ', ...app.ai.skills.flatMap((s, i) => [
            i ? ' ' : '',
            h('button', { class: 'ai-skill-chip', type: 'button', title: s.description, onclick: () => this.pickSkill(s) }, `/${s.name}`),
          ]))
          : null))
      return
    }
    for (const m of this.messages) this.renderMessage(m.id)
    // Fonts and typeset math settle a frame later: end at the bottom once they have.
    requestAnimationFrame(() => this.keepBottom())
  }

  private queueRender(id: string): void {
    if (this.renderQueued.has(id)) return
    this.renderQueued.add(id)
    requestAnimationFrame(() => {
      this.renderQueued.delete(id)
      this.renderMessage(id)
    })
  }

  private renderMessage(id: string): void {
    const m = this.messages.find((x) => x.id === id)
    if (!m) return
    if (!this.nodes.size) clear(this.listEl)
    const node = h('div', { class: `ai-msg ai-${m.role}` })
    if (m.role === 'user') {
      const pictures = m.parts.filter((p): p is Extract<ChatPart, { kind: 'image' }> => p.kind === 'image')
      if (pictures.length) {
        node.classList.add('has-images')
        node.append(h('div', { class: 'ai-msg-images' }, pictures.map((p, i) => {
          const src = `/api/host/ai/image/${encodeURIComponent(p.id)}`
          return h('button', { class: 'ai-msg-image', type: 'button', title: 'Show larger', 'aria-label': `Show image ${i + 1} larger`, onclick: () => showImage(src) },
            h('img', { src, alt: `Image ${i + 1}`, loading: 'lazy' }))
        })))
      }
      const text = m.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
      const cmd = /^\/([a-z][a-z0-9-]*)(?=\s|$)\s*/.exec(text)
      if (cmd && app.ai?.skills?.some((s) => s.name === cmd[1])) node.append(h('span', { class: 'ai-skill-chip static' }, `/${cmd[1]}`), text.length > cmd[0].length ? ` ${text.slice(cmd[0].length)}` : '')
      else node.append(text)
    } else {
      const toolRow = (p: Extract<ChatPart, { kind: 'tool' }>): HTMLElement =>
        h('div', { class: `ai-tool ai-tool-${p.status} ${p.parent ? 'ai-tool-nested' : ''}` }, icon(p.status === 'error' ? 'error' : p.status === 'done' ? 'check' : 'refresh', 13), p.label)
      for (const p of m.parts) {
        if (p.kind === 'text') node.append(h('div', { class: 'md' }, renderMarkdown(p.text, { files: this.hooks.files, symbol: this.hooks.symbol, open: (file, line) => this.hooks.onJump(file, line ?? 1) })))
        else if (p.kind === 'tool' && !p.parent) {
          node.append(toolRow(p))
          // Steps a helper agent took, tucked under the helper's own line.
          const steps = m.parts.filter((x): x is Extract<ChatPart, { kind: 'tool' }> => x.kind === 'tool' && x.parent === p.id)
          if (steps.length) node.append(h('div', { class: 'ai-helper-steps' }, steps.map(toolRow)))
        }
      }
      const last = this.messages[this.messages.length - 1]
      if (this.busy && last?.id === m.id && !m.error) node.append(this.statusLine())
      if (m.error) node.append(h('div', { class: m.error === 'Stopped.' || m.error === 'Interrupted.' ? 'ai-note' : 'ai-error' }, m.error))
    }
    const existing = this.nodes.get(id)
    if (existing) existing.replaceWith(node)
    else this.listEl.append(node)
    this.nodes.set(id, node)
    if (this.stickToBottom) this.listEl.scrollTop = this.listEl.scrollHeight
  }

  // ---- pending changes ------------------------------------------------------------------

  private setReview(review: ReviewSummary): void {
    this.review = review
    this.renderReview()
    this.hooks.onReview(review)
  }

  private async decide(action: 'accept' | 'decline', path?: string, hunk?: string): Promise<void> {
    try {
      const res = await api<{ review: ReviewSummary }>('POST', `/api/host/review/${action}`, { path, hunk })
      this.setReview(res.review)
    } catch (err) {
      toast((err as Error).message, 'error')
      void this.refresh()
    }
  }

  /** True while the tray slides up or down. */
  private reviewAnimating = false

  /**
   * Opens the changes tray to fill the whole chat area, or closes it to its header, sliding.
   * The chat above shrinks or grows with it, so nothing jumps. Without animation when the Mac
   * asks for reduced motion.
   */
  private toggleReview(): void {
    if (this.reviewAnimating) return
    const el = this.reviewEl
    const pane = this.element
    const open = !this.reviewOpen
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const done = (): void => {
      this.reviewAnimating = false
      el.style.height = ''
      el.style.flex = ''
      el.style.transition = ''
      if (!open) {
        this.reviewOpen = false
        this.renderReview()
      } else {
        pane.classList.add('review-open')
      }
    }
    if (reduce) {
      this.reviewOpen = open
      pane.classList.toggle('review-open', open)
      pane.classList.toggle('review-flat', open)
      this.renderReview()
      return
    }
    this.reviewAnimating = true
    const from = el.getBoundingClientRect().height
    let to: number
    if (open) {
      // Grow by the height the chat has now: the chat shrinks to nothing as the tray takes its place.
      to = from + this.listEl.getBoundingClientRect().height
      this.reviewOpen = true
      this.renderReview()
      pane.classList.add('review-flat')
    } else {
      pane.classList.remove('review-open', 'review-flat')
      const head = el.querySelector('.ai-review-head') as HTMLElement | null
      to = (head?.getBoundingClientRect().height ?? 0) + 1
      el.classList.remove('open')
      el.querySelector('.ai-review-toggle')?.setAttribute('aria-expanded', 'false')
    }
    el.style.flex = 'none'
    el.style.height = `${from}px`
    void el.offsetHeight
    el.style.transition = 'height 0.28s cubic-bezier(0.2, 0.8, 0.2, 1)'
    el.style.height = `${to}px`
    let finished = false
    // Only the tray's own height transition ends the slide: the chevron's turn ends earlier and bubbles up.
    const onEnd = (e: TransitionEvent): void => {
      if (e.target === el && e.propertyName === 'height') finish()
    }
    const finish = (): void => {
      if (finished) return
      finished = true
      el.removeEventListener('transitionend', onEnd)
      done()
    }
    el.addEventListener('transitionend', onEnd)
    setTimeout(finish, 450)
  }

  private renderReview(): void {
    clear(this.reviewEl)
    const r = this.review
    this.reviewEl.hidden = r.changeCount === 0
    if (!r.changeCount) {
      this.reviewOpen = false
      this.element.classList.remove('review-open', 'review-flat')
      return
    }
    let added = 0
    let removed = 0
    for (const f of r.files) for (const x of f.hunks) {
      added += x.newLines.length
      removed += x.oldLines.length
    }
    const files = r.files.length
    this.reviewEl.classList.toggle('open', this.reviewOpen)
    // Two rows: what changed, across the full width, then the two decisions side by side.
    this.reviewEl.append(h('div', { class: 'ai-review-head' },
      h('button', {
        class: 'ai-review-toggle', type: 'button', 'aria-expanded': String(this.reviewOpen),
        title: this.reviewOpen ? 'Hide the changes' : 'Show the changes',
        onclick: () => this.toggleReview(),
      },
      icon('chevron', 14),
      h('span', { class: 'ai-review-title' },
        h('strong', null, `${files} file${files === 1 ? '' : 's'} changed`),
        h('span', { class: 'ai-review-count' }, `${r.changeCount} change${r.changeCount === 1 ? '' : 's'}`)),
      h('span', { class: 'ai-review-lines', title: `${added} line${added === 1 ? '' : 's'} added, ${removed} removed` },
        h('span', { class: 'ai-lines-added' }, `+${added}`), h('span', { class: 'ai-lines-removed' }, `−${removed}`))),
      h('div', { class: 'ai-review-actions' },
        h('button', { class: 'btn btn-small', type: 'button', onclick: async () => {
          const ok = r.changeCount < 2 || await confirmDialog({ title: 'Decline all changes', message: `Undo all ${r.changeCount} pending changes and put the earlier text back?`, confirmLabel: 'Decline all', danger: true })
          if (ok) void this.decide('decline')
        } }, 'Decline all'),
        h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => void this.decide('accept') }, 'Accept all')),
    ))
    if (!this.reviewOpen) return
    const list = h('div', { class: 'ai-review-list' })
    for (const file of r.files) list.append(...this.fileBlocks(file))
    this.reviewEl.append(list)
  }

  private fileBlocks(file: ReviewFile): HTMLElement[] {
    if (file.status === 'added') {
      const lines = file.hunks.flatMap((x) => x.newLines)
      return [this.hunkBlock(file.path, 'new file', 1, [], lines, undefined)]
    }
    return file.hunks.map((x) => this.hunkBlock(file.path, `line ${x.newStart + 1}`, x.newStart + 1, x.oldLines, x.newLines, x))
  }

  private hunkBlock(path: string, title: string, line: number, oldLines: string[], newLines: string[], hunk: Hunk | undefined): HTMLElement {
    const side = (lines: string[], cls: string, sign: string): HTMLElement | null => {
      if (!lines.length) return null
      const shown = lines.slice(0, MAX_LINES_SHOWN).map((l) => `${sign} ${l}`)
      if (lines.length > MAX_LINES_SHOWN) shown.push(`  … ${lines.length - MAX_LINES_SHOWN} more line${lines.length - MAX_LINES_SHOWN === 1 ? '' : 's'}`)
      return h('pre', { class: `hunk-lines ${cls}` }, shown.join('\n'))
    }
    return h('div', { class: 'hunk' },
      h('div', { class: 'hunk-head' },
        h('button', { class: 'hunk-where', type: 'button', title: `Show ${path} in the editor`, onclick: () => this.hooks.onJump(path, line) },
          icon('file', 13),
          h('span', { class: 'hunk-name' }, path.split('/').pop()),
          path.includes('/') ? h('span', { class: 'hunk-dir' }, path.slice(0, path.lastIndexOf('/'))) : null,
          h('span', { class: 'hunk-at' }, title)),
        h('span', { class: 'grow' }),
        h('button', { class: 'icon-btn hunk-decline', type: 'button', title: 'Decline: put the earlier text back', 'aria-label': 'Decline this change', onclick: () => void this.decide('decline', path, hunk?.id) }, icon('close', 14)),
        h('button', { class: 'icon-btn hunk-accept', type: 'button', title: 'Accept: keep this change', 'aria-label': 'Accept this change', onclick: () => void this.decide('accept', path, hunk?.id) }, icon('check', 14)),
      ),
      side(oldLines, 'hunk-old', '−'),
      side(newLines, 'hunk-new', '+'),
    )
  }
}
