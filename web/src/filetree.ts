import { api, q, type TreeNode } from './api.ts'
import { clear, confirmDialog, h, icon, iconButton, promptDialog, showMenu, toast, type MenuItem } from './dom.ts'

const DRAG_TYPE = 'application/x-latexwriter-path'

export type TreeCallbacks = {
  onOpen: (node: TreeNode) => void
  isHost: () => boolean
  mainFile: () => string
  outputPdf: () => string
  onSetMain: (path: string) => void
}

const dirname = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name)

export class FileTree {
  readonly element: HTMLElement
  private listEl: HTMLElement
  private nodes: TreeNode[] = []
  private collapsed = new Set<string>()
  private active: string | null = null
  private cb: TreeCallbacks
  private fileInput: HTMLInputElement
  private uploadTarget = ''

  constructor(cb: TreeCallbacks) {
    this.cb = cb
    this.fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => {
      const files = [...(this.fileInput.files ?? [])]
      this.fileInput.value = ''
      void this.uploadFiles(this.uploadTarget, files)
    } })
    this.listEl = h('div', { class: 'tree-list', role: 'tree' })
    this.element = h('div', { class: 'tree' },
      h('div', { class: 'tree-toolbar' },
        iconButton('plus', 'New file', () => void this.newEntry(this.contextDir(), 'file')),
        iconButton('folder-plus', 'New folder', () => void this.newEntry(this.contextDir(), 'dir')),
        iconButton('upload', 'Upload files', () => this.pickFiles(this.contextDir())),
      ),
      this.listEl,
      this.fileInput,
    )
    this.listEl.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.tree-row')) return
      e.preventDefault()
      showMenu(e.clientX, e.clientY, this.dirMenu(''))
    })
    this.bindDropTarget(this.listEl, '', true)
  }

  setTree(nodes: TreeNode[]): void {
    this.nodes = nodes
    this.render()
  }

  setActive(path: string | null): void {
    this.active = path
    this.render()
  }

  find(path: string, nodes = this.nodes): TreeNode | null {
    for (const n of nodes) {
      if (n.path === path) return n
      if (n.children && path.startsWith(n.path + '/')) {
        const found = this.find(path, n.children)
        if (found) return found
      }
    }
    return null
  }

  firstTextFile(): TreeNode | null {
    const walk = (nodes: TreeNode[]): TreeNode | null => {
      for (const n of nodes) {
        if (n.type === 'file' && n.kind === 'text' && !n.cloud) return n
        const inner = n.children ? walk(n.children) : null
        if (inner) return inner
      }
      return null
    }
    return walk(this.nodes)
  }

  /** The folder new items go into: the active folder, or the folder of the active file. */
  private contextDir(): string {
    if (!this.active) return ''
    const node = this.find(this.active)
    if (!node) return ''
    return node.type === 'dir' ? node.path : dirname(node.path)
  }

  private render(): void {
    clear(this.listEl)
    if (!this.nodes.length) {
      this.listEl.appendChild(h('div', { class: 'tree-empty' }, 'No files yet. Create one or drop files here.'))
      return
    }
    const build = (nodes: TreeNode[], depth: number): void => {
      for (const node of nodes) {
        this.listEl.appendChild(this.row(node, depth))
        if (node.type === 'dir' && !this.collapsed.has(node.path)) build(node.children ?? [], depth + 1)
      }
    }
    build(this.nodes, 0)
  }

  private row(node: TreeNode, depth: number): HTMLElement {
    const isDir = node.type === 'dir'
    const open = isDir && !this.collapsed.has(node.path)
    const iconName = isDir ? 'folder' : node.cloud ? 'cloud' : node.kind === 'image' ? 'image' : node.kind === 'pdf' ? 'pdf' : 'file'
    const badges: HTMLElement[] = []
    if (node.path === this.cb.mainFile()) badges.push(h('span', { class: 'badge', title: 'This file is compiled' }, 'main'))
    if (node.path === this.cb.outputPdf()) badges.push(h('span', { class: 'badge badge-muted', title: 'The compiled PDF' }, 'output'))
    const row = h('div', {
      class: `tree-row ${node.path === this.active ? 'active' : ''} ${node.cloud ? 'cloud' : ''}`,
      role: 'treeitem',
      tabindex: '0',
      draggable: !node.cloud,
      title: node.cloud ? `${node.path} (in iCloud, not downloaded)` : node.path,
      style: { paddingLeft: `${8 + depth * 14}px` },
      'aria-expanded': isDir ? String(open) : null,
      onclick: () => this.activate(node),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          this.activate(node)
        }
      },
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        showMenu(e.clientX, e.clientY, isDir ? this.dirMenu(node.path, node) : this.fileMenu(node))
      },
      ondragstart: (e: DragEvent) => {
        e.dataTransfer?.setData(DRAG_TYPE, node.path)
        e.dataTransfer!.effectAllowed = 'move'
      },
    },
      h('span', { class: `tree-chevron ${open ? 'open' : ''}` }, isDir ? icon('chevron', 12) : null),
      icon(iconName, 15),
      h('span', { class: 'tree-name' }, node.name),
      badges,
      iconButton('more', 'More actions', (e) => {
        e.stopPropagation()
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        showMenu(r.left, r.bottom + 2, isDir ? this.dirMenu(node.path, node) : this.fileMenu(node))
      }, 'tree-more'),
    )
    if (isDir) this.bindDropTarget(row, node.path, false)
    return row
  }

  private activate(node: TreeNode): void {
    if (node.type === 'dir') {
      if (this.collapsed.has(node.path)) this.collapsed.delete(node.path)
      else this.collapsed.add(node.path)
      this.active = node.path
      this.render()
      return
    }
    if (node.cloud) {
      void this.downloadFromCloud(node)
      return
    }
    this.cb.onOpen(node)
  }

  private async downloadFromCloud(node: TreeNode): Promise<void> {
    const ok = await confirmDialog({
      title: 'File is not downloaded',
      message: `"${node.name}" is stored in iCloud and has not been downloaded to this Mac. Download it now?`,
      confirmLabel: 'Download now',
    })
    if (!ok) return
    try {
      await api('POST', '/api/project/cloud-download', { path: node.path })
      toast('Download started. The file appears when iCloud has fetched it.', 'info')
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  // ---- menus ------------------------------------------------------------------------

  private fileMenu(node: TreeNode): MenuItem[] {
    const items: MenuItem[] = []
    if (node.cloud) return [{ label: 'Download from iCloud', icon: 'cloud', onclick: () => void this.downloadFromCloud(node) }]
    items.push({ label: 'Open', icon: 'file', onclick: () => this.cb.onOpen(node) })
    items.push({ label: 'Rename…', onclick: () => void this.rename(node) })
    items.push({ label: 'Download', icon: 'download', onclick: () => this.download(node.path) })
    if (this.cb.isHost() && node.path.toLowerCase().endsWith('.tex') && node.path !== this.cb.mainFile()) {
      items.push({ label: 'Set as main file', icon: 'check', onclick: () => this.cb.onSetMain(node.path) })
    }
    items.push('separator', { label: 'Delete', icon: 'trash', danger: true, onclick: () => void this.remove(node) })
    return items
  }

  private dirMenu(dir: string, node?: TreeNode): MenuItem[] {
    const items: MenuItem[] = [
      { label: 'New file…', icon: 'plus', onclick: () => void this.newEntry(dir, 'file') },
      { label: 'New folder…', icon: 'folder-plus', onclick: () => void this.newEntry(dir, 'dir') },
      { label: 'Upload files…', icon: 'upload', onclick: () => this.pickFiles(dir) },
    ]
    if (node) {
      items.push('separator', { label: 'Rename…', onclick: () => void this.rename(node) })
      items.push({ label: 'Delete', icon: 'trash', danger: true, onclick: () => void this.remove(node) })
    }
    return items
  }

  // ---- actions ------------------------------------------------------------------------

  private async newEntry(dir: string, type: 'file' | 'dir'): Promise<void> {
    let name = await promptDialog({
      title: type === 'file' ? 'New file' : 'New folder',
      label: dir ? `Name (in ${dir}/)` : 'Name',
      value: type === 'file' ? 'untitled.tex' : '',
      placeholder: type === 'file' ? 'chapter.tex' : 'figures',
      confirmLabel: 'Create',
      selectStem: true,
    })
    if (!name) return
    if (type === 'file' && !name.includes('.')) name += '.tex'
    try {
      const res = await api<{ path: string }>('POST', '/api/project/create', { parent: dir, name, type })
      this.collapsed.delete(dir)
      if (type === 'file') this.cb.onOpen({ name, path: res.path, type: 'file', kind: 'text' })
      else this.active = res.path
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  private async rename(node: TreeNode): Promise<void> {
    const name = await promptDialog({ title: 'Rename', label: 'New name', value: node.name, confirmLabel: 'Rename', selectStem: node.type === 'file' })
    if (!name || name === node.name) return
    await this.move(node.path, join(dirname(node.path), name))
  }

  private async move(from: string, to: string): Promise<void> {
    if (from === to) return
    try {
      await api('POST', '/api/project/move', { from, to })
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  private async remove(node: TreeNode): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete ${node.type === 'dir' ? 'folder' : 'file'}`,
      message: `Delete "${node.name}"${node.type === 'dir' ? ' and everything in it' : ''}? It can be restored from History for 30 days.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    try {
      await api('POST', '/api/project/delete', { path: node.path })
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  private download(path: string): void {
    const a = h('a', { href: `/api/project/raw?${q({ path, download: '1' })}`, download: basename(path) })
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  private pickFiles(dir: string): void {
    this.uploadTarget = dir
    this.fileInput.click()
  }

  async uploadFiles(dir: string, files: File[]): Promise<void> {
    if (!files.length) return
    let done = 0
    for (const file of files) {
      try {
        await api('PUT', `/api/project/upload?${q({ path: join(dir, file.name) })}`, file)
        done++
      } catch (err) {
        toast(`${file.name}: ${(err as Error).message}`, 'error', 6000)
      }
    }
    if (done) toast(done === 1 ? `Uploaded ${files[0].name}` : `Uploaded ${done} files`, 'success')
  }

  /** Uploads a dropped Finder folder, recreating its structure. */
  private async uploadEntry(dir: string, entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
      if (file.name === '.DS_Store') return
      await this.uploadFiles(dir, [file])
      return
    }
    try {
      await api('POST', '/api/project/create', { parent: dir, name: entry.name, type: 'dir' })
    } catch {}
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
      if (!batch.length) break
      for (const child of batch) await this.uploadEntry(join(dir, entry.name), child)
    }
  }

  private bindDropTarget(el: HTMLElement, dir: string, isRoot: boolean): void {
    const accepts = (e: DragEvent): boolean => {
      const types = e.dataTransfer?.types ?? []
      return types.includes(DRAG_TYPE) || types.includes('Files')
    }
    el.addEventListener('dragover', (e) => {
      if (!accepts(e)) return
      if (isRoot && (e.target as HTMLElement).closest('.tree-row[aria-expanded]')) return
      e.preventDefault()
      e.stopPropagation()
      el.classList.add('drop-target')
    })
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'))
    el.addEventListener('drop', (e) => {
      if (!accepts(e)) return
      if (isRoot && (e.target as HTMLElement).closest('.tree-row[aria-expanded]')) return
      e.preventDefault()
      e.stopPropagation()
      el.classList.remove('drop-target')
      const from = e.dataTransfer!.getData(DRAG_TYPE)
      if (from) {
        if (dirname(from) !== dir && from !== dir) void this.move(from, join(dir, basename(from)))
        return
      }
      const entries = [...(e.dataTransfer?.items ?? [])].map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => Boolean(x))
      if (entries.some((en) => en.isDirectory)) {
        void (async () => {
          for (const en of entries) {
            try {
              await this.uploadEntry(dir, en)
            } catch (err) {
              toast(`${en.name}: ${(err as Error).message}`, 'error')
            }
          }
        })()
      } else {
        void this.uploadFiles(dir, [...(e.dataTransfer?.files ?? [])])
      }
    })
  }
}
