import { AiPanel } from './aipanel.ts'
import { api, q, type BuildResult, type Hunk, type ProjectIndex, type ReviewSummary, type ServerEvent, type TreeNode } from './api.ts'
import { app } from './app.ts'
import { CodeEditor } from './codeeditor.ts'
import { initials, openConnectDialog, openHistoryDialog, openSettingsDialog, openShareDialog, texFilesOf, textFilesOf } from './dialogs.ts'
import { clear, closeOverlays, debounce, h, icon, iconButton, showMenu, store, toast } from './dom.ts'
import { FileTree } from './filetree.ts'
import { parseOutline, type OutlineItem } from './latex.ts'
import { LogPanel } from './logpanel.ts'
import { openSplitDialog } from './splitdialog.ts'
import { markdownOutline, renderMarkdown, type FileLinks } from './markdown.ts'
import { PdfView } from './pdfview.ts'
import { OS } from './app.ts'

export type WorkbenchHooks = {
  /** Host: back to the project list. */
  onBack: () => void
  /** Guest: leave the session. */
  onLeave: () => void
}

const isMarkdown = (path: string | null): boolean => Boolean(path && /\.(md|markdown)$/i.test(path))

/** Every file of the project that is on this computer (not only in the cloud). */
function allFilesOf(nodes: TreeNode[]): string[] {
  const out: string[] = []
  const walk = (list: TreeNode[]): void => {
    for (const n of list) {
      if (n.type === 'dir') walk(n.children ?? [])
      else if (!n.cloud) out.push(n.path)
    }
  }
  walk(nodes)
  return out
}

/** The editor screen: file tree, source editor, PDF preview. Returns a function that tears it down. */
export function mountWorkbench(root: HTMLElement, hooks: WorkbenchHooks): () => void {
  const isHost = app.user?.role === 'host'
  const cleanup: (() => void)[] = []
  let tree: TreeNode[] = []
  let currentFile: string | null = null
  let index: ProjectIndex = { labels: [], bibKeys: [], files: [] }
  let result: BuildResult | null = null
  let shownPdfVersion = 0
  let disposed = false
  let filePreview: PdfView | null = null
  let aiPanel: AiPanel | null = null
  let review: ReviewSummary = { files: [], changeCount: 0, hasBeforePdf: false }
  let pdfMode: 'after' | 'before' = 'after'
  let latestPdfVersion = 0
  const hunksFor = (path: string | null): Hunk[] => (path ? (review.files.find((f) => f.path === path)?.hunks ?? []) : [])
  const lastFileKey = (): string => `lastFile.${app.project?.name ?? ''}`

  // ---- editor pane ------------------------------------------------------------------

  const editor = new CodeEditor({
    user: () => app.user!,
    index: () => index,
    onContentChange: (text) => {
      if (!isMarkdown(currentFile)) return renderOutline(parseOutline(text))
      markdownText = text
      markdownFor = currentFile
      renderOutline(markdownOutline(text))
      if (markdownMode === 'preview') renderPreview()
    },
    onCompile: () => void compile(),
    onJumpToPdf: () => void showInPdf(),
    onReloaded: () => toast('The file was reloaded from the server', 'info'),
    onOpenFailed: (path, message) => {
      toast(`${path}: ${message}`, 'error')
      showEmpty()
    },
    onSelectionChange: () => aiPanel?.updateContext(),
  })
  const fileTitle = h('span', { class: 'pane-title' }, 'No file open')
  const showInPdfBtn = iconButton('target', 'Show this place in the PDF (⌘J, or ⌘-double-click a word)', () => void showInPdf())
  const binaryView = h('div', { class: 'binary-view', hidden: true })

  // A Markdown file can be read rendered: the Source / Preview switch in the editor's header.
  // The choice is remembered per file; jumping to a line always shows the source.
  let markdownMode: 'source' | 'preview' = 'source'
  let markdownText = ''
  /** The file `markdownText` is the content of. */
  let markdownFor: string | null = null
  let previewEnteredAt = 0
  const markdownKey = (path: string): string => `mdView.${app.project?.name ?? ''}.${path}`
  const sourceBtn = h('button', { class: 'tab', type: 'button', title: 'Edit the Markdown (⇧⌘V)', onclick: () => setMarkdownMode('source') }, 'Source')
  const previewBtn = h('button', { class: 'tab', type: 'button', title: 'Read it rendered (⇧⌘V)', onclick: () => setMarkdownMode('preview') }, 'Preview')
  const markdownSwitch = h('span', { class: 'before-after md-switch', role: 'group', 'aria-label': 'Show the Markdown as source or rendered', hidden: true }, sourceBtn, previewBtn)
  const previewDoc = h('article', { class: 'md md-doc' })
  const markdownPreview = h('div', {
    class: 'md-preview', hidden: true, tabindex: 0, 'aria-label': 'Markdown preview',
    // Double-clicking a passage opens the source there.
    ondblclick: (e: Event) => {
      const at = (e.target as HTMLElement).closest<HTMLElement>('[data-line]')
      if (!at || (e.target as HTMLElement).closest('a, input')) return
      window.getSelection()?.removeAllRanges()
      setMarkdownMode('source', true, Number(at.dataset.line))
    },
  }, previewDoc)
  const previewLinks: FileLinks = {
    files: () => allFilesOf(tree),
    open: (file, line) => void openFileWhenListed(file, line),
    symbol: (name) => symbolOf(name),
  }

  function renderPreview(): void {
    if (!currentFile || markdownFor !== currentFile) return
    const top = markdownPreview.scrollTop
    clear(previewDoc)
    previewDoc.append(renderMarkdown(markdownText, previewLinks, { path: currentFile, imageUrl: (file) => `/api/project/raw?${q({ path: file })}` }))
    if (!markdownText.trim()) previewDoc.append(h('p', { class: 'muted' }, 'This file is empty.'))
    markdownPreview.scrollTop = top
  }

  /** The rendered block that starts on `line` or the last one before it. */
  function previewBlockAt(line: number): HTMLElement | null {
    let best: HTMLElement | null = null
    for (const el of previewDoc.querySelectorAll<HTMLElement>('[data-line]')) {
      if (Number(el.dataset.line) <= line) best = el
      else break
    }
    return best
  }

  /** The source line of the first block at the top of the preview. */
  function previewTopLine(): number {
    const top = markdownPreview.getBoundingClientRect().top
    for (const el of previewDoc.querySelectorAll<HTMLElement>('[data-line]')) {
      if (el.getBoundingClientRect().bottom > top + 4) return Number(el.dataset.line)
    }
    return 1
  }

  function applyMarkdownMode(): void {
    const md = isMarkdown(currentFile) && showing === 'editor'
    const preview = md && markdownMode === 'preview'
    markdownSwitch.hidden = !md
    sourceBtn.classList.toggle('active', !preview)
    previewBtn.classList.toggle('active', preview)
    sourceBtn.setAttribute('aria-pressed', String(!preview))
    previewBtn.setAttribute('aria-pressed', String(preview))
    if (md) {
      editor.element.hidden = preview
      markdownPreview.hidden = !preview
      showInPdfBtn.hidden = true
    } else markdownPreview.hidden = true
    if (preview) renderPreview()
  }

  /** `line`: where the source should open, when leaving the preview. */
  function setMarkdownMode(mode: 'source' | 'preview', remember = true, line?: number): void {
    if (!isMarkdown(currentFile)) return
    if (remember) store(markdownKey(currentFile!), mode)
    if (mode === markdownMode) return
    const leaving = markdownMode
    markdownMode = mode
    applyMarkdownMode()
    if (mode === 'preview') {
      // Open the preview where the cursor is.
      const line = editor.cursor().line + 1
      const block = previewBlockAt(line)
      previewEnteredAt = block ? Number(block.dataset.line) : 1
      markdownPreview.scrollTop = block && previewEnteredAt > 1 ? block.offsetTop - 12 : 0
      markdownPreview.focus({ preventScroll: true })
    } else if (leaving === 'preview') {
      editor.refreshLayout()
      // If the reader scrolled on, take the cursor to where they were reading. The editor was
      // hidden, so it lays itself out again first.
      const reading = previewTopLine()
      if (line) requestAnimationFrame(() => editor.goto(line))
      else if (reading !== previewEnteredAt) requestAnimationFrame(() => editor.goto(reading, false))
      else editor.focus()
    }
  }
  const emptyView = h('div', { class: 'empty-view' }, h('p', null, 'Select a file on the left to start writing.'))
  const editorPane = h('section', { class: 'pane editor-pane', 'aria-label': 'Editor' },
    h('div', { class: 'pane-header' }, fileTitle, h('span', { class: 'grow' }), markdownSwitch, showInPdfBtn),
    h('div', { class: 'pane-body' }, editor.element, markdownPreview, binaryView, emptyView),
  )
  editorPane.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v' && isMarkdown(currentFile) && showing === 'editor') {
      e.preventDefault()
      e.stopPropagation()
      setMarkdownMode(markdownMode === 'preview' ? 'source' : 'preview')
    }
  }, true)

  let showing: 'editor' | 'binary' | 'empty' = 'empty'
  const showOnly = (which: 'editor' | 'binary' | 'empty'): void => {
    showing = which
    editor.element.hidden = which !== 'editor'
    binaryView.hidden = which !== 'binary'
    emptyView.hidden = which !== 'empty'
    showInPdfBtn.hidden = which !== 'editor'
    markdownPreview.hidden = true
    markdownSwitch.hidden = true
    if (which !== 'binary') {
      filePreview?.destroy()
      filePreview = null
      clear(binaryView)
    }
  }

  const showEmpty = (): void => {
    currentFile = null
    editor.close()
    fileTitle.textContent = 'No file open'
    fileTree.setActive(null)
    renderOutline([])
    showOnly('empty')
  }

  async function openFile(path: string, line?: number, reveal = true): Promise<void> {
    const node = fileTree.find(path)
    if (!node || node.type !== 'file') {
      toast(`"${path}" is not in the project`, 'error')
      return
    }
    if (node.cloud) return
    currentFile = path
    fileTitle.textContent = path
    fileTree.setActive(path)
    store(lastFileKey(), path)
    // Opening a file the user asked for brings the editor back; the automatic first open does not.
    if (reveal) showEditor()
    setNarrowView('editor')
    if (narrow.matches) setSidebarOpen(false, false)
    if (node.kind === 'text') {
      showOnly('editor')
      if (isMarkdown(path)) {
        // A jump to a line is a jump into the source; otherwise the file opens as it was last seen.
        markdownMode = line ? 'source' : store(markdownKey(path)) === 'source' ? 'source' : 'preview'
        // Opening the file that is already open keeps its text: the editor does not load it again.
        if (markdownFor !== path) {
          markdownText = ''
          markdownFor = null
          clear(previewDoc)
        }
        applyMarkdownMode()
      }
      const ok = await editor.open(path, line)
      if (ok && currentFile === path) {
        editor.setLog(result?.entries ?? [])
        editor.setReview(hunksFor(path))
        if (!line && markdownPreview.hidden) editor.focus()
      }
      return
    }
    editor.close()
    renderOutline([])
    showOnly('binary')
    clear(binaryView)
    const src = `/api/project/raw?${q({ path })}`
    if (node.kind === 'image') {
      binaryView.appendChild(h('img', { class: 'image-preview', src: `${src}&t=${Date.now()}`, alt: node.name }))
    } else if (node.kind === 'pdf') {
      filePreview = new PdfView({}, 'Loading…')
      binaryView.appendChild(filePreview.element)
      const view = filePreview
      void view.load(src).then((ok) => !ok && view.setEmptyText('This PDF could not be shown.'))
    } else {
      binaryView.appendChild(h('div', { class: 'empty-view' },
        h('p', null, `"${node.name}" cannot be shown here.`),
        h('a', { class: 'btn', href: `${src}&download=1`, download: node.name }, icon('download'), ' Download')))
    }
  }

  // ---- sidebar ----------------------------------------------------------------------

  const fileTree = new FileTree({
    onOpen: (node) => void openFileWhenListed(node.path),
    isHost: () => isHost,
    mainFile: () => app.project?.mainFile ?? '',
    outputPdf: () => app.project?.outputPdf ?? '',
    onSetMain: (path) => void api('POST', '/api/project/settings', { mainFile: path }).catch((err) => toast((err as Error).message, 'error')),
  })
  const outlineEl = h('div', { class: 'outline' })
  let sidebarTab: 'files' | 'outline' = 'files'
  const tabFiles = h('button', { class: 'tab active', type: 'button', onclick: () => setSidebarTab('files') }, 'Files')
  const tabOutline = h('button', { class: 'tab', type: 'button', onclick: () => setSidebarTab('outline') }, 'Outline')
  const sidebar = h('aside', { class: 'sidebar', 'aria-label': 'Project files' },
    h('div', { class: 'pane-header tabs' }, tabFiles, tabOutline, h('span', { class: 'grow' }), iconButton('sidebar', 'Hide the sidebar', () => setSidebarOpen(false))),
    h('div', { class: 'pane-body' }, fileTree.element, outlineEl),
  )
  const setSidebarTab = (tab: 'files' | 'outline'): void => {
    sidebarTab = tab
    tabFiles.classList.toggle('active', tab === 'files')
    tabOutline.classList.toggle('active', tab === 'outline')
    fileTree.element.hidden = tab !== 'files'
    outlineEl.hidden = tab !== 'outline'
  }
  const sidebarToggle = iconButton('sidebar', 'Show the sidebar', () => setSidebarOpen(true), 'sidebar-show')
  // On a narrow screen the sidebar lies over the editor, so it starts closed and closes after a choice.
  const narrow = window.matchMedia('(max-width: 820px)')
  const setSidebarOpen = (open: boolean, remember = true): void => {
    if (remember && !narrow.matches) store('sidebar', open ? '1' : '0')
    workbench.classList.toggle('sidebar-closed', !open)
    sidebarToggle.hidden = open
    editor.refreshLayout()
  }

  function renderOutline(items: OutlineItem[]): void {
    clear(outlineEl)
    if (!items.length) {
      outlineEl.appendChild(h('div', { class: 'tree-empty' }, 'Sections of the open file appear here.'))
      return
    }
    for (const item of items) {
      outlineEl.appendChild(h('button', {
        class: 'outline-item', type: 'button', style: { paddingLeft: `${10 + item.level * 14}px` }, title: item.title,
        onclick: () => gotoLine(item.line),
      }, item.title))
    }
  }

  /** Shows a line of the open file: in the editor, or in the Markdown preview when that is showing. */
  function gotoLine(line: number): void {
    if (markdownPreview.hidden) return editor.goto(line)
    const block = previewBlockAt(line)
    if (block) markdownPreview.scrollTo({ top: block.offsetTop - 12, behavior: 'smooth' })
  }

  /** Opens a file that may have been created a moment ago and is not in our copy of the tree yet. */
  async function openFileWhenListed(path: string, line?: number): Promise<void> {
    if (!fileTree.find(path)) await refreshTree()
    await openFile(path, line)
  }

  // ---- preview pane -----------------------------------------------------------------

  const pageInput = h('input', { class: 'page-input', type: 'text', inputmode: 'numeric', value: '1', 'aria-label': 'Page', onchange: () => pdfView.gotoPage(Number(pageInput.value) || 1) })
  const pageTotal = h('span', { class: 'muted' }, '/ 0')
  const zoomLabel = h('button', { class: 'zoom-label', type: 'button', title: 'Zoom' }, 'Fit')
  zoomLabel.addEventListener('click', () => {
    const r = zoomLabel.getBoundingClientRect()
    showMenu(r.left, r.bottom + 2, [
      { label: 'Fit width', onclick: () => pdfView.setZoom('fit') },
      'separator',
      ...[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((z) => ({ label: `${z * 100}%`, onclick: () => pdfView.setZoom(z) })),
    ])
  })
  const pdfView = new PdfView({
    onDoubleClick: (page, x, y) => void jumpToSource(page, x, y),
    onState: (s) => {
      if (document.activeElement !== pageInput) pageInput.value = String(s.pages ? s.page : 0)
      pageTotal.textContent = `/ ${s.pages}`
      zoomLabel.textContent = s.zoom === 'fit' ? 'Fit' : `${s.percent}%`
      store('zoom', String(s.zoom))
    },
  }, 'The PDF appears here after the first compile.')
  const savedZoom = store('zoom')
  if (savedZoom && savedZoom !== 'fit' && Number(savedZoom) > 0) pdfView.setZoom(Number(savedZoom))

  const logPanel = new LogPanel({
    onJump: (file, line) => void openFileWhenListed(file, line ?? undefined),
    onToggle: () => {},
  })
  const beforeBtn = h('button', { class: 'tab', type: 'button', title: 'The PDF as it was before the pending changes', onclick: () => setPdfMode('before') }, 'Before')
  const afterBtn = h('button', { class: 'tab active', type: 'button', title: 'The PDF with the pending changes', onclick: () => setPdfMode('after') }, 'After')
  const beforeAfter = h('span', { class: 'before-after', hidden: true, role: 'group', 'aria-label': 'Compare with the PDF before the pending changes' }, beforeBtn, afterBtn)
  const previewPane = h('section', { class: 'pane preview-pane', 'aria-label': 'PDF preview' },
    h('div', { class: 'pane-header' },
      h('span', { class: 'page-nav' }, pageInput, pageTotal),
      beforeAfter,
      h('span', { class: 'grow' }),
      iconButton('zoom-out', 'Zoom out', () => pdfView.zoomBy(-1)),
      zoomLabel,
      iconButton('zoom-in', 'Zoom in', () => pdfView.zoomBy(1)),
    ),
    h('div', { class: 'pane-body preview-body' }, pdfView.element, logPanel.element),
  )

  function setPdfMode(mode: 'after' | 'before'): void {
    if (pdfMode === mode) return
    pdfMode = mode
    beforeBtn.classList.toggle('active', mode === 'before')
    afterBtn.classList.toggle('active', mode === 'after')
    previewPane.classList.toggle('showing-before', mode === 'before')
    shownPdfVersion = -1
    if (mode === 'before') void pdfView.load(`/api/host/review/before.pdf?t=${Date.now()}`)
    else void loadPdf(latestPdfVersion)
  }

  async function loadPdf(version: number): Promise<void> {
    latestPdfVersion = version
    // While the earlier PDF is on screen, new builds wait until the user switches back.
    if (pdfMode === 'before') return
    if (!version) {
      if (shownPdfVersion > 0) pdfView.clear()
      shownPdfVersion = 0
      return
    }
    if (version === shownPdfVersion) return
    shownPdfVersion = version
    const ok = await pdfView.load(`/api/project/pdf?v=${version}`)
    if (!ok && shownPdfVersion === version) shownPdfVersion = 0
  }

  async function jumpToSource(page: number, x: number, y: number): Promise<void> {
    try {
      const res = await api<{ position: { file: string; line: number } | null }>('POST', '/api/project/synctex/edit', { page, x, y })
      if (!res.position) return toast('That place could not be traced back to the source', 'info')
      await openFileWhenListed(res.position.file, res.position.line)
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  async function showInPdf(): Promise<void> {
    if (!currentFile || !editor.path) return
    const { line, column } = editor.cursor()
    try {
      const res = await api<{ position: { page: number; h: number; v: number; width: number; height: number } | null }>(
        'POST', '/api/project/synctex/view', { file: currentFile, line, column })
      if (!res.position) return toast('That line is not in the PDF. Compile first, or check that the file is included.', 'info')
      showViewer()
      setNarrowView('pdf')
      void pdfView.highlight(res.position.page, res.position.h, res.position.v, res.position.width, res.position.height)
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  // ---- assistant ---------------------------------------------------------------------

  /** Where a \\label or citation key is defined, for links in rendered Markdown. */
  function symbolOf(name: string): { file: string; line: number; what: string } | null {
    const label = index.labels.find((l) => l.name === name)
    if (label) return { file: label.file, line: label.line, what: `\\label{${name}}` }
    const key = index.bibKeys.find((k) => k.key === name)
    return key ? { file: key.file, line: key.line, what: `Citation ${name}` } : null
  }

  const aiSlot = h('div', { class: 'ai-slot' })
  const aiBadge = h('span', { class: 'ai-badge', hidden: true })
  const aiButton = h('button', { class: 'btn ai-toggle', type: 'button', title: 'Show or hide the assistant', hidden: true, onclick: () => setAiOpen(!workbench.classList.contains('ai-open')) },
    icon('sparkle'), h('span', { class: 'btn-label' }, 'Assistant'), aiBadge)
  const narrowAiTab = h('button', { class: 'tab', type: 'button', hidden: true, dataset: { view: 'ai' }, onclick: () => setNarrowView('ai') }, 'AI')

  function applyReview(r: ReviewSummary): void {
    review = r
    // The same count as the changes tray in the assistant: files with changes waiting for review.
    const files = r.files.length
    aiBadge.textContent = files ? String(files) : ''
    aiBadge.hidden = !files
    aiBadge.title = `${r.changeCount} change${r.changeCount === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'} to review`
    editor.setReview(hunksFor(currentFile))
    const canCompare = r.changeCount > 0 && r.hasBeforePdf
    beforeAfter.hidden = !canCompare
    if (!canCompare) setPdfMode('after')
  }

  function ensureAiPanel(): AiPanel | null {
    if (!isHost || !app.ai?.enabled) return null
    if (!aiPanel) {
      aiPanel = new AiPanel({
        context: () => editor.selectionContext(),
        onJump: (file, line) => void openFileWhenListed(file, line),
        files: () => textFilesOf(tree),
        symbol: symbolOf,
        onReview: applyReview,
        onClose: () => setAiOpen(false),
        // A permission question waits for the user: make sure they can see it.
        onAttention: () => {
          if (!workbench.classList.contains('ai-open')) setAiOpen(true, false)
        },
        onBusy: (busy) => {
          // Seen even with the sidebar closed: the assistant is still at work.
          for (const el of [aiButton, narrowAiTab]) el.classList.toggle('working', busy)
          aiButton.title = busy ? 'The assistant is working. Show or hide it.' : 'Show or hide the assistant'
        },
      })
      aiSlot.appendChild(aiPanel.element)
    }
    return aiPanel
  }

  function setAiOpen(open: boolean, remember = true): void {
    const panel = open ? ensureAiPanel() : null
    const show = open && panel !== null
    if (remember) store('aiOpen', show ? '1' : '0')
    workbench.classList.toggle('ai-open', show)
    aiButton.classList.toggle('active', show)
    aiButton.setAttribute('aria-pressed', String(show))
    if (show) {
      panel!.updateContext()
      if (remember) panel!.focus()
    } else if (workbench.dataset.view === 'ai') setNarrowView('editor')
    editor.refreshLayout()
  }

  /** The assistant is an add-on: when it is off in Settings, nothing of it shows. */
  function applyAiAvailability(): void {
    const enabled = isHost && Boolean(app.ai?.enabled)
    aiButton.hidden = !enabled
    narrowAiTab.hidden = !enabled
    if (enabled) ensureAiPanel()
    else {
      setAiOpen(false, false)
      applyReview({ files: [], changeCount: 0, hasBeforePdf: false })
    }
  }

  // ---- top bar ----------------------------------------------------------------------

  const titleEl = h('span', { class: 'project-title' }, app.project?.name ?? '')
  const compileLabel = h('span', null, 'Recompile')
  const compileBtn = h('button', { class: 'btn btn-primary compile-btn', type: 'button', title: 'Compile now (⌘ Enter)', onclick: () => void compile() }, icon('refresh'), h('span', { class: 'compile-label' }, compileLabel))
  const autoToggle = h('input', { type: 'checkbox', checked: app.project?.autoCompile ?? true, onchange: () => {
    void api('POST', '/api/project/settings', { autoCompile: autoToggle.checked }).catch((err) => toast((err as Error).message, 'error'))
  } })
  const statusEl = h('span', { class: 'compile-status', role: 'status' })
  const peopleEl = h('div', { class: 'avatars' })
  const narrowSwitch = h('div', { class: 'narrow-switch' },
    h('button', { class: 'tab active', type: 'button', dataset: { view: 'editor' }, onclick: () => setNarrowView('editor') }, 'Source'),
    h('button', { class: 'tab', type: 'button', dataset: { view: 'pdf' }, onclick: () => setNarrowView('pdf') }, 'PDF'),
    narrowAiTab,
  )
  // Desktop layout: only the editor, both side by side, or only the PDF. Remembered per browser.
  type Layout = 'editor' | 'split' | 'viewer'
  const LAYOUTS: { id: Layout; label: string; title: string; key: string }[] = [
    { id: 'editor', label: 'Editor', title: 'Only the editor', key: '1' },
    { id: 'split', label: 'Split', title: 'Editor and PDF side by side', key: '2' },
    { id: 'viewer', label: 'Viewer', title: 'Only the PDF', key: '3' },
  ]
  const layoutSwitch = h('div', { class: 'layout-switch', role: 'group', 'aria-label': 'Layout' },
    LAYOUTS.map((l) => h('button', { class: 'tab', type: 'button', title: `${l.title} (⌘${l.key})`, 'aria-keyshortcuts': `Meta+${l.key}`, dataset: { layout: l.id }, onclick: () => setLayout(l.id) }, l.label)))
  let layout: Layout = 'split'
  function setLayout(next: Layout, remember = true): void {
    layout = next
    if (remember) store('layout', next)
    workbench.dataset.layout = next
    layoutSwitch.querySelectorAll<HTMLElement>('.tab').forEach((t) => {
      const on = t.dataset.layout === next
      t.classList.toggle('active', on)
      t.setAttribute('aria-pressed', String(on))
    })
    // Panes that were hidden have no size; let them measure themselves again.
    requestAnimationFrame(() => editor.refreshLayout())
    if (next !== 'editor') aiPanel?.updateContext()
  }
  /** Something needs the editor on screen (opening a file, jumping to a source line). */
  function showEditor(): void {
    if (layout === 'viewer') setLayout('split', false)
  }
  /** Something needs the PDF on screen (showing a line in the PDF). */
  function showViewer(): void {
    if (layout === 'editor') setLayout('split', false)
  }

  /**
   * The compile status in the top bar opens and closes the Problems list. That list sits under the
   * PDF, so when the PDF is not on screen it is brought into view first, and the list opened.
   */
  function toggleProblems(): void {
    const pdfHidden = narrow.matches ? workbench.dataset.view !== 'pdf' : layout === 'editor'
    if (pdfHidden) {
      if (narrow.matches) setNarrowView('pdf')
      else showViewer()
      logPanel.setOpen(true)
      return
    }
    logPanel.setOpen(!logPanel.open)
  }

  function setNarrowView(view: 'editor' | 'pdf' | 'ai'): void {
    if (view === 'ai' && !workbench.classList.contains('ai-open')) setAiOpen(true, false)
    workbench.dataset.view = view
    narrowSwitch.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view))
  }

  // Getting the work out: the PDF, the whole project, or (host) the editor on the network.
  const shareMenu = (e: MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    showMenu(r.right - 230, r.bottom + 4, [
      isHost
        ? { label: 'Save PDF to Downloads', icon: 'download', onclick: () => void exportPdf() }
        : { label: 'Download PDF', icon: 'download', onclick: downloadPdf },
      { label: 'Download project as .zip', icon: 'download', onclick: () => downloadUrl('/api/project/zip') },
      { label: 'Advanced exporter…', icon: 'download', shortcut: '⇧⌘E', onclick: openExporter },
      ...(isHost ? [
        'separator' as const,
        { label: 'Share on your network…', icon: 'share', onclick: openShareDialog },
        ...(app.ai ? [{ label: 'Connect an AI app…', icon: 'sparkle', onclick: openConnectDialog }] : []),
      ] : []),
    ])
  }

  const moreMenu = (e: MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    showMenu(r.right - 210, r.bottom + 4, [
      { label: 'History and deleted files…', icon: 'history', onclick: () => openHistoryDialog({ current: currentFile, textFiles: textFilesOf(tree) }) },
      { label: 'Settings…', icon: 'settings', onclick: () => openSettingsDialog({ texFiles: texFilesOf(tree), onLeave: hooks.onLeave }) },
    ])
  }

  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-left' },
      isHost ? iconButton('back', 'Back to projects', hooks.onBack) : null,
      sidebarToggle,
      titleEl,
    ),
    h('div', { class: 'topbar-center' },
      compileBtn,
      h('label', { class: 'check', title: 'Compile automatically shortly after you stop typing' }, autoToggle, 'Auto'),
      statusEl,
      narrowSwitch,
    ),
    h('div', { class: 'topbar-right' },
      layoutSwitch,
      peopleEl,
      h('button', { class: 'btn', type: 'button', title: isHost ? 'Save the PDF, download the project, or share on your network' : 'Download the PDF or the project', 'aria-haspopup': 'menu', onclick: shareMenu },
        icon('share'), h('span', { class: 'btn-label' }, 'Share')),
      aiButton,
      iconButton('more', 'More', moreMenu),
    ),
  )

  function downloadUrl(url: string): void {
    const a = h('a', { href: url, download: '' })
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
  function openExporter(): void {
    if (document.querySelector('.modal-backdrop')) return
    // The current build, even while the review shows the earlier PDF.
    if (latestPdfVersion <= 0) return toast('There is no PDF yet. Compile first.', 'info')
    void openSplitDialog({ version: latestPdfVersion, projectName: app.project?.name || 'Document', isHost })
  }
  function downloadPdf(): void {
    if (!shownPdfVersion) return toast('There is no PDF yet. Compile first.', 'info')
    downloadUrl('/api/project/pdf?download=1')
  }
  async function exportPdf(): Promise<void> {
    try {
      const res = await api<{ file: string; name: string }>('POST', '/api/host/export', {})
      toast(`Saved to Downloads as "${res.name}"`, 'success', 7000, {
        label: `Show in ${OS.fileManager}`,
        onclick: () => void api('POST', '/api/host/reveal', { path: res.file }).catch(() => {}),
      })
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  async function compile(): Promise<void> {
    setCompiling(true)
    try {
      await api('POST', '/api/project/compile', {})
    } catch (err) {
      setCompiling(false)
      toast((err as Error).message, 'error')
    }
  }

  function setCompiling(on: boolean): void {
    compileBtn.classList.toggle('busy', on)
    compileLabel.textContent = on ? 'Compiling…' : 'Recompile'
    // The last result stays, dimmed, so the centred controls do not shift on every compile.
    statusEl.classList.toggle('stale', on)
  }

  function setResult(r: BuildResult | null): void {
    // A compile replaced by a newer one says nothing about the document: keep showing the last real
    // result, so the error count and the Problems list do not flicker, and a list the user closed
    // is not opened again as if the errors were new.
    if (r?.status === 'cancelled') return
    result = r
    logPanel.setResult(r)
    editor.setLog(r?.entries ?? [])
    clear(statusEl)
    if (!r) return
    if (r.status === 'success') {
      statusEl.append(h('button', { class: 'status-ok', type: 'button', title: 'Show or hide the Problems list', onclick: toggleProblems },
        icon('check'), ` ${(r.durationMs / 1000).toFixed(1)} s`))
    } else {
      statusEl.append(h('button', { class: 'status-error', type: 'button', title: 'Show or hide the Problems list', onclick: toggleProblems },
        icon('error'), r.status === 'timeout' ? ' Timed out' : ` ${r.errorCount || 1} error${r.errorCount > 1 ? 's' : ''}`))
    }
  }

  function renderPeople(): void {
    clear(peopleEl)
    const others = app.people.filter((p) => p.id !== app.user?.id)
    for (const p of others.slice(0, 5)) peopleEl.appendChild(h('span', { class: 'avatar', style: { background: p.color }, title: p.name }, initials(p.name)))
    if (others.length > 5) peopleEl.appendChild(h('span', { class: 'avatar avatar-more', title: others.slice(5).map((p) => p.name).join(', ') }, `+${others.length - 5}`))
  }

  // ---- layout -----------------------------------------------------------------------

  const banner = h('div', { class: 'banner', hidden: true, role: 'alert' }, 'Connection lost. Reconnecting… Changes you make now may not be saved.')
  const dividerA = h('div', { class: 'divider', role: 'separator', 'aria-orientation': 'vertical' })
  const dividerB = h('div', { class: 'divider divider-preview', role: 'separator', 'aria-orientation': 'vertical' })
  const dividerC = h('div', { class: 'divider divider-ai', role: 'separator', 'aria-orientation': 'vertical' })
  const panes = h('div', { class: 'panes' }, sidebar, dividerA, editorPane, dividerB, previewPane, dividerC, aiSlot)
  const workbench = h('div', { class: 'workbench', dataset: { view: 'editor' } }, topbar, banner, panes)

  const setSidebarWidth = (px: number): void => {
    const w = Math.max(160, Math.min(480, px))
    sidebar.style.width = `${w}px`
    store('sidebarWidth', String(w))
  }
  const setSplit = (ratio: number): void => {
    const r = Math.max(0.2, Math.min(0.8, ratio))
    editorPane.style.flexGrow = String(r)
    previewPane.style.flexGrow = String(1 - r)
    store('split', String(r))
  }
  const setAiWidth = (px: number): void => {
    const w = Math.max(260, Math.min(620, px))
    aiSlot.style.width = `${w}px`
    store('aiWidth', String(w))
  }
  setAiWidth(Number(store('aiWidth')) || 340)
  setSidebarWidth(Number(store('sidebarWidth')) || 230)
  setSplit(Number(store('split')) || 0.5)

  const drag = (divider: HTMLElement, onMove: (x: number) => void): void => {
    divider.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      divider.setPointerCapture(e.pointerId)
      workbench.classList.add('dragging')
      const move = (ev: PointerEvent): void => onMove(ev.clientX)
      const up = (): void => {
        divider.removeEventListener('pointermove', move)
        divider.removeEventListener('pointerup', up)
        divider.removeEventListener('pointercancel', up)
        workbench.classList.remove('dragging')
        editor.refreshLayout()
      }
      divider.addEventListener('pointermove', move)
      divider.addEventListener('pointerup', up)
      divider.addEventListener('pointercancel', up)
    })
  }
  drag(dividerA, (x) => setSidebarWidth(x - panes.getBoundingClientRect().left))
  drag(dividerC, (x) => setAiWidth(panes.getBoundingClientRect().right - x))
  drag(dividerB, (x) => {
    const left = editorPane.getBoundingClientRect().left
    const right = previewPane.getBoundingClientRect().right
    setSplit((x - left) / Math.max(1, right - left))
  })

  clear(root)
  root.appendChild(workbench)
  setSidebarTab(sidebarTab)
  setSidebarOpen(store('sidebar') !== '0' && !narrow.matches, false)
  showOnly('empty')
  renderPeople()
  applyAiAvailability()
  if (store('aiOpen') === '1' && !narrow.matches) setAiOpen(true, false)
  {
    const saved = store('layout')
    setLayout(saved === 'editor' || saved === 'viewer' ? saved : 'split', false)
  }
  document.title = `${app.project?.name ?? 'Project'} · LaTeX Writer`

  // ---- data -------------------------------------------------------------------------

  async function refreshTree(): Promise<void> {
    try {
      const res = await api<{ tree: TreeNode[]; project: typeof app.project }>('GET', '/api/project/tree')
      if (disposed) return
      tree = res.tree
      app.project = res.project
      fileTree.setTree(tree)
      if (currentFile && !fileTree.find(currentFile)) showEmpty()
    } catch (err) {
      if (!disposed) toast((err as Error).message, 'error')
    }
  }

  const refreshIndex = debounce(() => {
    api<ProjectIndex>('GET', '/api/project/index').then((res) => (index = res)).catch(() => {})
  }, 400)

  async function refreshBuild(): Promise<void> {
    try {
      const res = await api<{ compiling: boolean; result: BuildResult | null; pdfVersion: number }>('GET', '/api/project/build')
      if (disposed) return
      setCompiling(res.compiling)
      setResult(res.result)
      await loadPdf(res.pdfVersion)
    } catch {}
  }

  function applyProjectInfo(): void {
    titleEl.textContent = app.project?.name ?? ''
    autoToggle.checked = app.project?.autoCompile ?? true
    document.title = `${app.project?.name ?? 'Project'} · LaTeX Writer`
    fileTree.setTree(tree)
  }

  function onEvent(e: ServerEvent): void {
    switch (e.type) {
      case 'tree':
        void refreshTree()
        refreshIndex()
        break
      case 'project-info':
        app.project = e.project
        applyProjectInfo()
        break
      case 'compile':
        if (e.state === 'compiling') setCompiling(true)
        else {
          setCompiling(false)
          setResult(e.result)
          void loadPdf(e.result.pdfVersion)
          refreshIndex()
        }
        break
      case 'presence':
        app.people = e.people
        renderPeople()
        break
      case 'ai':
        if (e.kind === 'settings') {
          app.ai = e.ai
          applyAiAvailability()
        }
        // The panel reads the open question itself when it is first created.
        if (e.kind === 'access' && e.requests?.length && !aiPanel) setAiOpen(true, false)
        else aiPanel?.handleEvent(e)
        break
      case 'review':
        if (aiPanel) aiPanel.handleEvent(e)
        else applyReview(e.review)
        break
      case 'file-moved': {
        editor.forget(e.from)
        if (currentFile && (currentFile === e.from || currentFile.startsWith(e.from + '/'))) {
          const next = e.to + currentFile.slice(e.from.length)
          editor.close()
          currentFile = null
          void refreshTree().then(() => openFile(next))
        }
        break
      }
      case 'file-deleted':
        editor.forget(e.path)
        if (currentFile && (currentFile === e.path || currentFile.startsWith(e.path + '/'))) {
          showEmpty()
          toast('The file you had open was deleted', 'info')
        }
        break
    }
  }
  cleanup.push(app.events.on(onEvent))
  let wasConnected = app.events.connected
  cleanup.push(app.events.onStatus((connected) => {
    banner.hidden = connected
    if (connected && !wasConnected) {
      void refreshTree()
      void refreshBuild()
      void aiPanel?.refresh()
    }
    wasConnected = connected
  }))
  banner.hidden = app.events.connected

  const onKey = (e: KeyboardEvent): void => {
    // The editor handles its own shortcuts first.
    if (e.defaultPrevented) return
    if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !narrow.matches) {
      const target = LAYOUTS.find((l) => l.key === e.key)
      if (target && !document.querySelector('.modal-backdrop')) {
        e.preventDefault()
        setLayout(target.id)
        return
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
      e.preventDefault()
      openExporter()
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void compile()
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      // Everything is saved to disk as you type, so saving has nothing left to do: compile, from
      // anywhere on the page (inside the editor the same key is handled there).
      e.preventDefault()
      void compile()
    }
  }
  document.addEventListener('keydown', onKey)
  cleanup.push(() => document.removeEventListener('keydown', onKey))

  void (async () => {
    await refreshTree()
    if (disposed) return
    refreshIndex()
    void refreshBuild()
    const last = store(lastFileKey())
    const main = app.project?.mainFile
    const first = [last, main].find((p) => p && fileTree.find(p)?.kind === 'text') ?? fileTree.firstTextFile()?.path
    if (first) await openFile(first, undefined, false)
  })()

  return () => {
    disposed = true
    for (const fn of cleanup) fn()
    filePreview?.destroy()
    editor.destroy()
    pdfView.destroy()
    closeOverlays()
  }
}
