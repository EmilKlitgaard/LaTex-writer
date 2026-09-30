import type { BuildResult, LogEntry } from './api.ts'
import { openRawLog } from './dialogs.ts'
import { clear, copyText, h, icon, iconButton, store, toast } from './dom.ts'

export type LogPanelCallbacks = {
  onJump: (file: string, line: number | null) => void
  onToggle: (open: boolean) => void
}

/** The problems list under the PDF: errors, warnings and layout notes from the last compile. */
export class LogPanel {
  readonly element: HTMLElement
  private listEl: HTMLElement
  private summaryEl: HTMLElement
  private chevron: HTMLElement
  private onlyErrors: HTMLInputElement
  private result: BuildResult | null = null
  private cb: LogPanelCallbacks
  open = store('logOpen') === '1'

  constructor(cb: LogPanelCallbacks) {
    this.cb = cb
    this.listEl = h('div', { class: 'log-list' })
    this.summaryEl = h('span', { class: 'log-summary' }, 'No compile yet')
    this.chevron = h('span', { class: 'tree-chevron' }, icon('chevron', 12))
    this.onlyErrors = h('input', { type: 'checkbox', checked: store('onlyErrors') === '1', onchange: () => {
      store('onlyErrors', this.onlyErrors.checked ? '1' : '0')
      this.render()
    } })
    this.element = h('div', { class: 'log-panel' },
      h('div', { class: 'log-header' },
        h('button', { class: 'log-toggle', type: 'button', 'aria-expanded': String(this.open), onclick: () => this.setOpen(!this.open) }, this.chevron, h('strong', null, 'Problems'), this.summaryEl),
        h('label', { class: 'check', title: 'Hide warnings and layout notes' }, this.onlyErrors, 'Only show errors'),
        iconButton('list', 'Show the full LaTeX log', () => void openRawLog()),
      ),
      this.listEl,
    )
    this.applyOpen()
  }

  setOpen(open: boolean): void {
    if (this.open === open) return
    this.open = open
    store('logOpen', open ? '1' : '0')
    this.applyOpen()
    this.cb.onToggle(open)
  }

  private applyOpen(): void {
    this.element.classList.toggle('open', this.open)
    this.chevron.classList.toggle('open', this.open)
    this.element.querySelector('.log-toggle')?.setAttribute('aria-expanded', String(this.open))
  }

  setResult(result: BuildResult | null): void {
    const hadErrors = (this.result?.errorCount ?? 0) > 0
    this.result = result
    this.render()
    // Bring new errors to attention, without reopening the panel on every keystroke.
    if (result && result.errorCount > 0 && !hadErrors) this.setOpen(true)
  }

  private render(): void {
    clear(this.listEl)
    clear(this.summaryEl)
    const r = this.result
    if (!r) {
      this.summaryEl.textContent = 'No compile yet'
      return
    }
    const infoCount = r.entries.length - r.errorCount - r.warningCount
    if (!r.entries.length) this.summaryEl.append(h('span', { class: 'pill pill-ok' }, 'No problems'))
    if (r.errorCount) this.summaryEl.append(h('span', { class: 'pill pill-error' }, `${r.errorCount} error${r.errorCount === 1 ? '' : 's'}`))
    if (r.warningCount) this.summaryEl.append(h('span', { class: 'pill pill-warn' }, `${r.warningCount} warning${r.warningCount === 1 ? '' : 's'}`))
    if (infoCount) this.summaryEl.append(h('span', { class: 'pill' }, `${infoCount} note${infoCount === 1 ? '' : 's'}`))

    const entries = this.onlyErrors.checked ? r.entries.filter((e) => e.severity === 'error') : r.entries
    if (!entries.length) {
      this.listEl.appendChild(h('div', { class: 'log-empty' },
        r.entries.length ? 'No errors. Warnings are hidden.' : r.status === 'success' ? 'The document compiled without problems.' : 'Nothing to show.'))
      return
    }
    for (const e of entries) this.listEl.appendChild(this.row(e))
  }

  private row(e: LogEntry): HTMLElement {
    const location = e.file ? `${e.file}${e.line ? `:${e.line}` : ''}` : null
    const command = e.hint ? /sudo tlmgr install \S+/.exec(e.hint)?.[0] : null
    const body = h('div', { class: 'log-body' },
      h('div', { class: 'log-message' }, e.message),
      e.detail ? h('code', { class: 'log-detail' }, e.detail) : null,
      e.hint ? h('div', { class: 'log-hint' }, e.hint,
        command ? h('button', { class: 'btn btn-small', type: 'button', onclick: async (ev: Event) => {
          ev.stopPropagation()
          toast((await copyText(command)) ? 'Command copied. Paste it into Terminal.' : 'Could not copy', 'info')
        } }, icon('copy'), ' Copy command') : null) : null,
    )
    const attrs = { class: `log-row log-${e.severity} ${e.file ? 'clickable' : ''}` }
    const iconEl = h('span', { class: 'log-icon', title: e.severity }, icon(e.severity === 'info' ? 'info' : e.severity))
    if (!e.file) return h('div', attrs, iconEl, body)
    const jump = (): void => this.cb.onJump(e.file!, e.line)
    // Not a <button>: the row can contain the "Copy command" button.
    return h('div', {
      ...attrs, role: 'button', tabindex: '0', title: `Go to ${location}`, onclick: jump,
      onkeydown: (ev: KeyboardEvent) => {
        if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault()
          jump()
        }
      },
    }, iconEl, body, h('span', { class: 'log-location' }, location))
  }
}
