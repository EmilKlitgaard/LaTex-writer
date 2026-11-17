import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { EditorSelection, EditorState, StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import {
  Decoration, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers,
  type DecorationSet,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { api, q, type ChatContext, type Hunk, type LogEntry, type ProjectIndex, type User } from './api.ts'
import { debounce, h } from './dom.ts'
import { latexCompletions, latexKeymap } from './latex.ts'

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const CLOSE_STALE = 4001

// Lines changed by the assistant and not yet accepted or declined are tinted in the editor.
const setReviewMarks = StateEffect.define<DecorationSet>()
const reviewMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const e of tr.effects) if (e.is(setReviewMarks)) return e.value
    return marks.map(tr.changes)
  },
  provide: (field) => EditorView.decorations.from(field),
})
const addedLine = Decoration.line({ class: 'cm-ai-added' })
const removedBefore = Decoration.line({ class: 'cm-ai-removed' })

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-font-size)', color: 'var(--fg)', backgroundColor: 'var(--editor-bg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--fg)', padding: '10px 0 40vh' },
  '.cm-line': { padding: '0 14px 0 6px' },
  '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--fg-faint)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '28px' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)', color: 'var(--fg-muted)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)', borderLeftWidth: '1.5px' },
  '.cm-selectionBackground': { backgroundColor: 'var(--selection-blur)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--match)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--match)', outline: '1px solid var(--border-strong)' },
  '.cm-searchMatch': { backgroundColor: 'var(--search-match)', borderRadius: '2px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--search-match-active)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface-raised)', color: 'var(--fg)', border: '1px solid var(--border-strong)', borderRadius: '6px', boxShadow: 'var(--shadow)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: '12.5px', maxHeight: '16em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--on-accent)' },
  '.cm-completionDetail': { color: 'inherit', opacity: '0.65', fontStyle: 'normal', marginLeft: '1em' },
  '.cm-completionIcon': { display: 'none' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--fg)', borderColor: 'var(--border)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '8px 10px', fontFamily: 'var(--sans)', fontSize: '12.5px' },
  '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '12px' },
  '.cm-textfield': { backgroundColor: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border-strong)', borderRadius: '5px', padding: '3px 6px', fontSize: '12.5px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--surface-raised)', color: 'var(--fg)', border: '1px solid var(--border-strong)', borderRadius: '5px', padding: '3px 8px', fontSize: '12px' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--fg-muted)', fontSize: '18px', cursor: 'pointer' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--danger)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warn)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px' },
  '.cm-lintRange-info': { backgroundImage: 'none' },
  '.cm-tooltip-lint': { fontFamily: 'var(--sans)', fontSize: '12.5px' },
  '.cm-diagnostic': { padding: '5px 9px', borderLeftWidth: '3px' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--warn)' },
  '.cm-ySelectionInfo': { fontFamily: 'var(--sans)', fontSize: '11px', padding: '1px 5px', borderRadius: '4px 4px 4px 0', opacity: '1', top: '-1.5em' },
  '.cm-flash-line': { animation: 'cm-flash 1.2s ease-out' },
  '.cm-ai-added': { backgroundColor: 'var(--ai-added)', boxShadow: 'inset 3px 0 0 var(--ok)' },
  '.cm-ai-removed': { boxShadow: 'inset 0 2px 0 var(--danger)' },
})

const highlight = HighlightStyle.define([
  { tag: t.tagName, color: 'var(--tok-command)' },
  { tag: t.keyword, color: 'var(--tok-math)' },
  { tag: [t.comment, t.lineComment], color: 'var(--tok-comment)', fontStyle: 'italic' },
  { tag: [t.atom, t.string], color: 'var(--tok-arg)' },
  { tag: [t.bracket, t.brace, t.squareBracket], color: 'var(--tok-bracket)' },
  { tag: t.number, color: 'var(--tok-math)' },
  { tag: [t.variableName, t.special(t.variableName), t.standard(t.variableName)], color: 'var(--tok-math)' },
  { tag: t.invalid, color: 'var(--danger)' },
])

export type EditorCallbacks = {
  user: () => User
  index: () => ProjectIndex
  onContentChange: (text: string) => void
  onCompile: () => void
  onJumpToPdf: () => void
  onReloaded: (path: string) => void
  onOpenFailed: (path: string, message: string) => void
  onSelectionChange: () => void
}

type Session = { path: string; doc: Y.Doc; provider: WebsocketProvider; undo: Y.UndoManager }

export class CodeEditor {
  readonly element: HTMLElement
  private view: EditorView
  private session: Session | null = null
  private openToken = 0
  private callbacks: EditorCallbacks
  private positions = new Map<string, { anchor: number; scrollTop: number }>()
  private diagnostics: LogEntry[] = []
  private reviewHunks: Hunk[] = []
  private loading: HTMLElement
  path: string | null = null

  constructor(callbacks: EditorCallbacks) {
    this.callbacks = callbacks
    this.loading = h('div', { class: 'editor-loading', hidden: true }, 'Opening…')
    this.element = h('div', { class: 'code-editor' }, this.loading)
    this.view = new EditorView({ parent: this.element, state: EditorState.create({ doc: '', extensions: [theme, EditorState.readOnly.of(true)] }) })
  }

  private baseExtensions(): Extension[] {
    const notify = debounce((text: string) => this.callbacks.onContentChange(text), 250)
    const selectionMoved = debounce(() => this.callbacks.onSelectionChange(), 200)
    return [
      reviewMarks,
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      indentUnit.of('  '),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      lintGutter(),
      StreamLanguage.define(stex),
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off', 'aria-label': 'LaTeX source' }),
      autocompletion({
        override: [latexCompletions({ get: () => this.callbacks.index(), localLabels: () => this.localLabels() })],
        activateOnTyping: true,
        icons: false,
      }),
      keymap.of([
        { key: 'Mod-Enter', run: () => (this.callbacks.onCompile(), true) },
        { key: 'Mod-s', run: () => (this.callbacks.onCompile(), true) },
        { key: 'Mod-j', run: () => (this.callbacks.onJumpToPdf(), true) },
        ...latexKeymap,
        ...closeBracketsKeymap,
        ...yUndoManagerKeymap,
        ...searchKeymap,
        ...completionKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
      // ⌘-double-click (Ctrl on Windows) on a word shows it in the PDF, like ⌘J with the cursor there.
      EditorView.domEventHandlers({
        dblclick: (e, view) => {
          if (!(IS_MAC ? e.metaKey : e.ctrlKey)) return false
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
          if (pos === null) return false
          // The modifier made the clicks add cursors: keep one, on the word that was clicked.
          const word = view.state.wordAt(pos)
          view.dispatch({ selection: word ? EditorSelection.single(word.from, word.to) : EditorSelection.single(pos) })
          this.callbacks.onJumpToPdf()
          return true
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) notify(update.state.doc.toString())
        if (update.selectionSet) selectionMoved()
      }),
      theme,
    ]
  }

  private localLabels(): string[] {
    return [...this.view.state.doc.toString().matchAll(/\\label\{([^}]+)\}/g)].map((m) => m[1])
  }

  private rememberPosition(): void {
    if (!this.session) return
    this.positions.set(this.session.path, { anchor: this.view.state.selection.main.head, scrollTop: this.view.scrollDOM.scrollTop })
  }

  private teardown(): void {
    const s = this.session
    this.session = null
    if (!s) return
    s.provider.destroy()
    s.undo.destroy()
    s.doc.destroy()
  }

  /** Opens a text file for collaborative editing. Resolves once its content is on screen. */
  async open(path: string, line?: number): Promise<boolean> {
    if (this.session?.path === path) {
      if (line) this.goto(line)
      return true
    }
    const token = ++this.openToken
    this.rememberPosition()
    this.teardown()
    this.path = path
    this.loading.hidden = false
    this.view.setState(EditorState.create({ doc: '', extensions: [theme, EditorState.readOnly.of(true)] }))

    let info: { path: string; instance: string }
    try {
      info = await api('GET', `/api/project/doc?${q({ path })}`)
    } catch (err) {
      if (token === this.openToken) {
        this.loading.hidden = true
        this.path = null
        this.callbacks.onOpenFailed(path, (err as Error).message)
      }
      return false
    }
    if (token !== this.openToken) return false

    const doc = new Y.Doc()
    const ytext = doc.getText('content')
    const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    const provider = new WebsocketProvider(wsBase, 'doc', doc, { params: { path: info.path, inst: info.instance }, disableBc: true })
    const user = this.callbacks.user()
    provider.awareness.setLocalStateField('user', { name: user.name, color: user.color, colorLight: user.color + '40' })
    const undo = new Y.UndoManager(ytext)
    const session: Session = { path: info.path, doc, provider, undo }
    this.session = session

    provider.on('connection-close', (ev) => {
      if (this.session !== session || ev?.code !== CLOSE_STALE) return
      // The server loaded this file afresh (it restarted, for example). Start over from its copy.
      setTimeout(() => {
        if (this.session !== session) return
        this.teardown()
        void this.open(path).then((ok) => ok && this.callbacks.onReloaded(path))
      })
    })

    await new Promise<void>((resolve) => {
      if (provider.synced) return resolve()
      const done = (): void => {
        provider.off('sync', onSync)
        clearTimeout(timer)
        resolve()
      }
      const onSync = (synced: boolean): void => {
        if (synced) done()
      }
      const timer = setTimeout(done, 8000)
      provider.on('sync', onSync)
    })
    if (token !== this.openToken || this.session !== session) return false
    if (!provider.synced) {
      this.teardown()
      this.loading.hidden = true
      this.path = null
      this.callbacks.onOpenFailed(path, 'The file could not be loaded. Check the connection and try again.')
      return false
    }

    this.view.setState(EditorState.create({
      doc: ytext.toString(),
      extensions: [...this.baseExtensions(), yCollab(ytext, provider.awareness, { undoManager: undo })],
    }))
    this.loading.hidden = true
    this.applyDiagnostics()
    this.applyReview()
    this.callbacks.onContentChange(ytext.toString())
    this.callbacks.onSelectionChange()

    const saved = this.positions.get(info.path)
    if (line) this.goto(line)
    else if (saved) {
      const anchor = Math.min(saved.anchor, this.view.state.doc.length)
      this.view.dispatch({ selection: { anchor } })
      requestAnimationFrame(() => (this.view.scrollDOM.scrollTop = saved.scrollTop))
    }
    return true
  }

  close(): void {
    this.openToken++
    this.rememberPosition()
    this.teardown()
    this.path = null
    this.loading.hidden = true
    this.view.setState(EditorState.create({ doc: '', extensions: [theme, EditorState.readOnly.of(true)] }))
  }

  /** Forget the remembered cursor of a path (after a move or delete). */
  forget(path: string): void {
    for (const key of [...this.positions.keys()]) if (key === path || key.startsWith(path + '/')) this.positions.delete(key)
  }

  goto(line: number, flash = true): void {
    const doc = this.view.state.doc
    const l = doc.line(Math.max(1, Math.min(doc.lines, line)))
    this.view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) })
    this.view.focus()
    if (flash) {
      requestAnimationFrame(() => {
        const el = this.view.domAtPos(l.from).node
        const lineEl = (el instanceof HTMLElement ? el : el.parentElement)?.closest('.cm-line')
        if (lineEl) {
          lineEl.classList.remove('cm-flash-line')
          void (lineEl as HTMLElement).offsetWidth
          lineEl.classList.add('cm-flash-line')
        }
      })
    }
  }

  cursor(): { line: number; column: number } {
    const head = this.view.state.selection.main.head
    const line = this.view.state.doc.lineAt(head)
    return { line: line.number, column: head - line.from }
  }

  focus(): void {
    this.view.focus()
  }

  /** Marks compile errors and warnings of the open file in the gutter and the text. */
  setLog(entries: LogEntry[]): void {
    this.diagnostics = entries
    this.applyDiagnostics()
  }

  private applyDiagnostics(): void {
    if (!this.session) return
    const doc = this.view.state.doc
    const list: Diagnostic[] = []
    for (const e of this.diagnostics) {
      if (e.file !== this.session.path || !e.line || e.line > doc.lines || e.severity === 'info') continue
      const line = doc.line(e.line)
      const indent = /^\s*/.exec(line.text)![0].length
      list.push({
        from: Math.min(line.from + indent, line.to),
        to: line.to,
        severity: e.severity,
        message: e.hint ? `${e.message}\n${e.hint}` : e.message,
      })
    }
    list.sort((a, b) => a.from - b.from)
    this.view.dispatch(setDiagnostics(this.view.state, list))
  }

  /** Tints the lines of changes that are waiting for the user's decision. */
  setReview(hunks: Hunk[]): void {
    this.reviewHunks = hunks
    this.applyReview()
  }

  private applyReview(): void {
    if (!this.session) return
    const doc = this.view.state.doc
    const marks: Range<Decoration>[] = []
    for (const hunk of this.reviewHunks) {
      if (hunk.newLines.length) {
        for (let i = 0; i < hunk.newLines.length; i++) {
          const n = hunk.newStart + 1 + i
          if (n >= 1 && n <= doc.lines) marks.push(addedLine.range(doc.line(n).from))
        }
      } else {
        // Text was only removed: mark the line that now sits where it was.
        const n = Math.min(doc.lines, hunk.newStart + 1)
        marks.push(removedBefore.range(doc.line(n).from))
      }
    }
    this.view.dispatch({ effects: setReviewMarks.of(Decoration.set(marks, true)) })
  }

  /** What the user is looking at, for the assistant: the cursor line and any selected text. */
  selectionContext(): ChatContext {
    if (!this.session) return {}
    const { state } = this.view
    const sel = state.selection.main
    const context: ChatContext = { file: this.session.path, line: state.doc.lineAt(sel.head).number }
    if (!sel.empty) {
      context.selection = state.sliceDoc(sel.from, sel.to)
      context.selectionStart = state.doc.lineAt(sel.from).number
      context.selectionEnd = state.doc.lineAt(sel.to).number
    }
    return context
  }

  refreshLayout(): void {
    this.view.requestMeasure()
  }

  destroy(): void {
    this.teardown()
    this.view.destroy()
  }
}
