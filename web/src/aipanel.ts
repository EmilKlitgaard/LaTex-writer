import {
  api, type AiSettings, type AiUsage, type ChatContext, type ChatMessage, type ChatPart, type Hunk, type ReviewFile, type ReviewSummary, type ServerEvent,
} from './api.ts'
import { app } from './app.ts'
import { clear, confirmDialog, h, icon, iconButton, toast } from './dom.ts'
import { renderMarkdown } from './markdown.ts'

export type AiPanelHooks = {
  /** What the user is looking at in the editor right now. */
  context: () => ChatContext
  onJump: (file: string, line: number) => void
  onReview: (review: ReviewSummary) => void
  onClose: () => void
}

const SUGGESTIONS = ['Fix the compile errors', 'Proofread the selected text', 'Make the selected paragraph shorter', 'Check the PDF for layout problems']
const MODEL_LABELS: Record<string, string> = { sonnet: 'Sonnet', haiku: 'Haiku (lightest)', opus: 'Opus (heaviest)' }
const MAX_LINES_SHOWN = 14

/** The assistant sidebar: a chat, and the list of changes waiting for a decision. */
export class AiPanel {
  readonly element: HTMLElement
  private hooks: AiPanelHooks
  private messages: ChatMessage[] = []
  private busy = false
  private usage: AiUsage = {}
  private review: ReviewSummary = { files: [], changeCount: 0, hasBeforePdf: false }
  private listEl: HTMLElement
  private reviewEl: HTMLElement
  private input: HTMLTextAreaElement
  private sendBtn: HTMLButtonElement
  private contextEl: HTMLElement
  private usageEl: HTMLElement
  private modelSelect: HTMLSelectElement
  private nodes = new Map<string, HTMLElement>()
  private renderQueued = new Set<string>()
  private stickToBottom = true

  constructor(hooks: AiPanelHooks) {
    this.hooks = hooks
    this.listEl = h('div', { class: 'ai-messages', 'aria-live': 'polite' })
    this.listEl.addEventListener('scroll', () => {
      this.stickToBottom = this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight < 40
    })
    this.reviewEl = h('div', { class: 'ai-review', hidden: true })
    this.contextEl = h('div', { class: 'ai-context' })
    this.usageEl = h('div', { class: 'ai-usage' })
    this.input = h('textarea', {
      class: 'ai-input', rows: 2, placeholder: 'Ask for a change, or a question about the document', 'aria-label': 'Message to the assistant',
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          void this.send()
        }
      },
      oninput: () => this.autosize(),
      onfocus: () => this.updateContext(),
    })
    this.sendBtn = h('button', { class: 'btn btn-primary ai-send', type: 'button', onclick: () => (this.busy ? void this.stop() : void this.send()) })
    this.modelSelect = h('select', { class: 'ai-model', title: 'Model', 'aria-label': 'Model', onchange: () => void this.setModel(this.modelSelect.value) })

    this.element = h('aside', { class: 'pane ai-pane', 'aria-label': 'Assistant' },
      h('div', { class: 'pane-header' },
        icon('sparkle'), h('strong', null, 'Assistant'), h('span', { class: 'grow' }),
        this.modelSelect,
        iconButton('plus', 'New chat', () => void this.reset()),
        iconButton('close', 'Hide the assistant', () => this.hooks.onClose()),
      ),
      this.listEl,
      this.reviewEl,
      h('div', { class: 'ai-composer' }, this.contextEl, h('div', { class: 'ai-input-row' }, this.input, this.sendBtn), this.usageEl),
    )
    this.applySettings()
    this.renderAll()
    this.updateSendButton()
    void this.refresh()
  }

  // ---- state ------------------------------------------------------------------------

  async refresh(): Promise<void> {
    try {
      const res = await api<{ ai: AiSettings; chat: { messages: ChatMessage[]; busy: boolean; usage: AiUsage } | null; review: ReviewSummary | null }>('GET', '/api/host/ai/state')
      app.ai = res.ai
      this.applySettings()
      this.messages = res.chat?.messages ?? []
      this.busy = res.chat?.busy ?? false
      this.usage = res.chat?.usage ?? {}
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
    for (const m of ai?.models ?? []) this.modelSelect.appendChild(h('option', { value: m, selected: m === ai?.model }, MODEL_LABELS[m] ?? m))
    this.modelSelect.value = ai?.model ?? ''
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
        this.updateSendButton()
        if (!this.busy) for (const m of this.messages) this.renderMessage(m.id)
        break
      case 'usage':
        this.usage = e.usage
        this.renderUsage()
        break
      case 'reset':
        this.messages = []
        this.renderAll()
        break
      case 'settings':
        app.ai = e.ai
        this.applySettings()
        break
    }
  }

  // ---- chat -------------------------------------------------------------------------

  private async send(text = this.input.value): Promise<void> {
    const message = text.trim()
    if (!message || this.busy) return
    this.input.value = ''
    this.autosize()
    this.stickToBottom = true
    try {
      await api('POST', '/api/host/ai/send', { text: message, context: this.hooks.context() })
    } catch (err) {
      this.input.value = message
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
    try {
      await api('POST', '/api/host/ai/reset', {})
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  private async setModel(model: string): Promise<void> {
    try {
      await api('POST', '/api/host/settings', { aiModel: model })
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  private autosize(): void {
    this.input.style.height = 'auto'
    this.input.style.height = `${Math.min(160, this.input.scrollHeight + 2)}px`
  }

  private updateSendButton(): void {
    clear(this.sendBtn)
    this.sendBtn.append(icon(this.busy ? 'stop' : 'send'))
    this.sendBtn.title = this.busy ? 'Stop' : 'Send (Enter)'
    this.sendBtn.setAttribute('aria-label', this.sendBtn.title)
    this.sendBtn.classList.toggle('btn-primary', !this.busy)
  }

  updateContext(): void {
    const c = this.hooks.context()
    clear(this.contextEl)
    if (!c.file) return
    const lines = c.selection ? (c.selectionEnd ?? 0) - (c.selectionStart ?? 0) + 1 : 0
    this.contextEl.append(icon('file', 13), ` ${c.file}`, lines ? ` · ${lines} line${lines === 1 ? '' : 's'} selected` : c.line ? ` · line ${c.line}` : '')
    this.contextEl.title = 'The assistant is told which file you have open and what you have selected'
  }

  private renderUsage(): void {
    clear(this.usageEl)
    const u = this.usage.fiveHour
    if (typeof u !== 'number') return
    const pct = Math.round(u * 100)
    this.usageEl.textContent = `${pct}% of your plan's 5-hour limit used`
    this.usageEl.classList.toggle('warn', pct >= 80)
  }

  focus(): void {
    this.input.focus()
  }

  // ---- messages -----------------------------------------------------------------------

  private renderAll(): void {
    clear(this.listEl)
    this.nodes.clear()
    if (!app.ai?.available) {
      this.listEl.append(h('div', { class: 'ai-empty' },
        h('p', null, h('strong', null, 'Claude Code was not found on this Mac.')),
        h('p', { class: 'muted' }, 'The assistant runs through Claude Code with your Claude subscription. Install Claude Code, run "claude" once in Terminal to sign in, then reopen this panel.')))
      return
    }
    if (!this.messages.length) {
      this.listEl.append(h('div', { class: 'ai-empty' },
        h('p', { class: 'muted' }, 'Ask for changes to the document. Every change shows up below for you to accept or decline.'),
        h('div', { class: 'ai-suggestions' }, SUGGESTIONS.map((s) => h('button', { class: 'ai-suggestion', type: 'button', onclick: () => void this.send(s) }, s)))))
      return
    }
    for (const m of this.messages) this.renderMessage(m.id)
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
      node.append(m.parts.map((p) => (p.kind === 'text' ? p.text : '')).join(''))
    } else {
      for (const p of m.parts) {
        if (p.kind === 'text') node.append(h('div', { class: 'md' }, renderMarkdown(p.text)))
        else node.append(h('div', { class: `ai-tool ai-tool-${p.status}` }, icon(p.status === 'error' ? 'error' : p.status === 'done' ? 'check' : 'refresh', 13), p.label))
      }
      const last = this.messages[this.messages.length - 1]
      if (this.busy && last?.id === m.id && !m.error) node.append(h('div', { class: 'ai-thinking' }, m.parts.length ? '' : 'Thinking…'))
      if (m.error) node.append(h('div', { class: m.error === 'Stopped.' ? 'ai-note' : 'ai-error' }, m.error))
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

  private renderReview(): void {
    clear(this.reviewEl)
    const r = this.review
    this.reviewEl.hidden = r.changeCount === 0
    if (!r.changeCount) return
    this.reviewEl.append(h('div', { class: 'ai-review-head' },
      h('strong', { class: 'grow' }, `${r.changeCount} change${r.changeCount === 1 ? '' : 's'} to review`),
      h('button', { class: 'btn btn-small', type: 'button', onclick: async () => {
        const ok = r.changeCount < 2 || await confirmDialog({ title: 'Decline all changes', message: `Undo all ${r.changeCount} pending changes and put the earlier text back?`, confirmLabel: 'Decline all', danger: true })
        if (ok) void this.decide('decline')
      } }, 'Decline all'),
      h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => void this.decide('accept') }, 'Accept all'),
    ))
    const list = h('div', { class: 'ai-review-list' })
    for (const file of r.files) list.append(...this.fileBlocks(file))
    this.reviewEl.append(list)
  }

  private fileBlocks(file: ReviewFile): HTMLElement[] {
    if (file.status === 'added') {
      const lines = file.hunks.flatMap((x) => x.newLines)
      return [this.hunkBlock(file.path, `${file.path} (new file)`, 1, [], lines, undefined)]
    }
    return file.hunks.map((x) => this.hunkBlock(file.path, `${file.path}:${x.newStart + 1}`, x.newStart + 1, x.oldLines, x.newLines, x))
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
        h('button', { class: 'link hunk-where', type: 'button', title: 'Show in the editor', onclick: () => this.hooks.onJump(path, line) }, title),
        h('span', { class: 'grow' }),
        h('button', { class: 'icon-btn hunk-decline', type: 'button', title: 'Decline: put the earlier text back', 'aria-label': 'Decline this change', onclick: () => void this.decide('decline', path, hunk?.id) }, icon('close', 14)),
        h('button', { class: 'icon-btn hunk-accept', type: 'button', title: 'Accept: keep this change', 'aria-label': 'Accept this change', onclick: () => void this.decide('accept', path, hunk?.id) }, icon('check', 14)),
      ),
      side(oldLines, 'hunk-old', '−'),
      side(newLines, 'hunk-new', '+'),
    )
  }
}
