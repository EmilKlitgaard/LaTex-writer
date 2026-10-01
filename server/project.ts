import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import chokidar, { type FSWatcher } from 'chokidar'
import { AiChat } from './ai.ts'
import { PROJECT_NOTES_FILE } from './notes.ts'
import { Compiler, type BuildResult } from './compile.ts'
import { writeFileAtomic } from './config.ts'
import { DocManager } from './docs.ts'
import { History, SNAPSHOT_INTERVAL_MS } from './history.ts'
import { broadcast } from './hub.ts'
import { Review } from './review.ts'
import {
  extensionOf, HttpError, INTERNAL_DIR, isHiddenName, isTextFile, resolveInside, validateEntryName,
} from './paths.ts'

const AUTO_COMPILE_DELAY_MS = 1500
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000

export type ProjectSettings = { name: string; mainFile: string; autoCompile: boolean }

export type TreeNode = {
  name: string
  path: string
  type: 'dir' | 'file'
  kind?: 'text' | 'image' | 'pdf' | 'binary'
  /** True for iCloud placeholders: the file exists in iCloud but is not downloaded to this Mac. */
  cloud?: boolean
  children?: TreeNode[]
}

export type TrashItem = { id: string; path: string; type: 'dir' | 'file'; t: number }

function fileKind(abs: string, rel: string): TreeNode['kind'] {
  const ext = extensionOf(rel)
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  return isTextFile(abs, rel) ? 'text' : 'binary'
}

function guessMainFile(root: string): string {
  if (fs.existsSync(path.join(root, 'main.tex'))) return 'main.tex'
  let firstTex: string | null = null
  try {
    for (const name of fs.readdirSync(root).sort()) {
      if (!name.toLowerCase().endsWith('.tex')) continue
      firstTex ??= name
      const head = fs.readFileSync(path.join(root, name), 'utf8').slice(0, 20_000)
      if (/\\documentclass/.test(head)) return name
    }
  } catch {}
  return firstTex ?? 'main.tex'
}

export function readProjectSettings(root: string): ProjectSettings {
  const fallback = { name: path.basename(root), mainFile: guessMainFile(root), autoCompile: true }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, INTERNAL_DIR, 'project.json'), 'utf8'))
    return {
      name: typeof raw.name === 'string' && raw.name ? raw.name : fallback.name,
      mainFile: typeof raw.mainFile === 'string' && raw.mainFile ? raw.mainFile : fallback.mainFile,
      autoCompile: typeof raw.autoCompile === 'boolean' ? raw.autoCompile : true,
    }
  } catch {
    return fallback
  }
}

export function writeProjectSettings(root: string, settings: ProjectSettings): void {
  fs.mkdirSync(path.join(root, INTERNAL_DIR), { recursive: true })
  writeFileAtomic(path.join(root, INTERNAL_DIR, 'project.json'), JSON.stringify(settings, null, 2))
}

export class Project {
  readonly root: string
  settings: ProjectSettings
  readonly docs: DocManager
  readonly history: History
  readonly compiler: Compiler
  readonly review: Review
  readonly ai: AiChat
  private reviewTimer: NodeJS.Timeout | null = null
  private watcher: FSWatcher
  private dirty = new Set<string>()
  private autoCompileTimer: NodeJS.Timeout | null = null
  private snapshotTimer: NodeJS.Timeout
  private treeTimer: NodeJS.Timeout | null = null
  private indexCache: ProjectIndex | null = null
  private closed = false
  private rootTimer: NodeJS.Timeout

  constructor(root: string, onGone: (project: Project) => void = () => {}) {
    this.root = root
    // Folders get renamed and moved in Finder while a project is open. Notice it quickly.
    this.rootTimer = setInterval(() => {
      if (!this.closed && !fs.existsSync(root)) onGone(this)
    }, 1500)
    this.settings = readProjectSettings(root)
    writeProjectSettings(root, this.settings)
    this.history = new History(root)
    this.docs = new DocManager(root, {
      onFirstEdit: (rel, previous) => this.history.snapshot(rel, previous, 'before-edit'),
      onChange: (rel) => {
        this.dirty.add(rel)
        this.indexCache = null
        this.scheduleAutoCompile()
        if (this.review.has(rel)) this.scheduleReviewBroadcast()
      },
    })
    this.review = new Review(root, {
      read: (rel) => {
        try {
          return fs.existsSync(path.join(root, rel)) ? this.docs.read(rel) : null
        } catch {
          return null
        }
      },
      write: (rel, content) => {
        this.docs.setContent(rel, content)
        this.dirty.add(rel)
        this.scheduleAutoCompile()
      },
      remove: (rel) => this.remove(rel),
      currentPdf: () => this.compiler.currentPdf()?.file ?? null,
      onChange: () => this.scheduleReviewBroadcast(),
    })
    this.compiler = new Compiler(root, {
      getMainFile: () => this.settings.mainFile,
      beforeCompile: () => this.docs.flushAll(),
      onStatus: (status) => {
        if (status.state === 'compiling') broadcast('compile', { state: 'compiling' })
        else broadcast('compile', { state: 'done', result: status.result })
      },
    })
    this.ai = new AiChat({ root, overview: () => this.overview() })
    this.pruneTrash()
    this.snapshotTimer = setInterval(() => this.takeSnapshots(), SNAPSHOT_INTERVAL_MS)
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      ignored: (p) => p !== root && isHiddenName(path.basename(p)) && !path.basename(p).endsWith('.icloud'),
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    })
    this.watcher.on('all', (event, abs) => this.onFsEvent(event, abs))
    this.watcher.on('error', (err) => console.error('File watcher error:', (err as Error).message))
  }

  info(): Record<string, unknown> {
    return {
      name: this.settings.name,
      mainFile: this.settings.mainFile,
      autoCompile: this.settings.autoCompile,
      outputPdf: this.compiler.projectPdfRel(),
    }
  }

  /** A few lines describing the project, given to the assistant at the start of a conversation. */
  overview(): string {
    const files: string[] = []
    const walk = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        if (n.type === 'dir') walk(n.children ?? [])
        else if (!n.cloud && files.length < 60) files.push(n.path)
      }
    }
    walk(this.tree())
    return `Project "${this.settings.name}". Main file: ${this.settings.mainFile}. Files: ${files.join(', ')}.`
  }

  private broadcastInfo(): void {
    broadcast('project-info', { project: this.info() })
  }

  updateSettings(patch: Partial<ProjectSettings>): void {
    if (patch.name !== undefined) {
      const name = String(patch.name).trim().slice(0, 100)
      if (!name) throw new HttpError(400, 'The name cannot be empty')
      this.settings.name = name
    }
    if (patch.mainFile !== undefined) {
      const { rel, abs } = resolveInside(this.root, patch.mainFile)
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(400, 'That file does not exist')
      this.settings.mainFile = rel
    }
    if (patch.autoCompile !== undefined) this.settings.autoCompile = Boolean(patch.autoCompile)
    writeProjectSettings(this.root, this.settings)
    this.broadcastInfo()
    if (patch.mainFile !== undefined || patch.autoCompile) this.scheduleAutoCompile(0)
  }

  // ---- assistant edits and their review ---------------------------------------

  private scheduleReviewBroadcast(): void {
    if (this.reviewTimer || this.closed) return
    this.reviewTimer = setTimeout(() => {
      this.reviewTimer = null
      if (!this.closed) broadcast('review', { review: this.review.summary() }, 'host')
    }, 250)
  }

  /**
   * An edit made by the assistant: applied to the live document at once, with the previous text
   * kept as a backup until the user accepts or declines.
   */
  applyAssistantEdit(relInput: string, content: string): void {
    const { rel, abs } = resolveInside(this.root, relInput)
    validateEntryName(path.basename(rel))
    this.docs.flush(rel)
    this.review.capture(rel)
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, '', { flag: 'wx' })
      this.scheduleTreeBroadcast()
    } else {
      // Also keep the pre-edit text in the version history.
      this.history.snapshot(rel, this.docs.read(rel), 'before-edit')
    }
    this.docs.setContent(rel, content)
    this.dirty.add(rel)
    this.indexCache = null
    this.scheduleReviewBroadcast()
    this.scheduleAutoCompile()
  }

  /**
   * Writes the project notes file (INSTRUCTIONS.md). Unlike the assistant's edits to the document,
   * this does not wait for review: it is the assistant's own memory, and the author can read and edit it.
   */
  writeNotes(content: string): void {
    const { abs } = resolveInside(this.root, PROJECT_NOTES_FILE)
    if (!fs.existsSync(abs)) {
      fs.writeFileSync(abs, '', { flag: 'wx' })
      this.scheduleTreeBroadcast()
    }
    this.docs.setContent(PROJECT_NOTES_FILE, content)
  }

  // ---- compile ----------------------------------------------------------------

  scheduleAutoCompile(delay = AUTO_COMPILE_DELAY_MS): void {
    if (!this.settings.autoCompile || this.closed) return
    if (this.autoCompileTimer) clearTimeout(this.autoCompileTimer)
    this.autoCompileTimer = setTimeout(() => {
      this.autoCompileTimer = null
      void this.compile()
    }, delay)
  }

  compile(force = false): Promise<BuildResult> {
    if (this.autoCompileTimer) clearTimeout(this.autoCompileTimer)
    this.autoCompileTimer = null
    return this.compiler.compile(force)
  }

  // ---- file watching ----------------------------------------------------------

  private toRel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/')
  }

  private onFsEvent(event: string, abs: string): void {
    if (this.closed) return
    const rel = this.toRel(abs)
    if (!rel || rel.startsWith('..')) return
    if (event === 'add' || event === 'unlink' || event === 'addDir' || event === 'unlinkDir') this.scheduleTreeBroadcast()
    if (path.basename(rel).endsWith('.icloud')) return
    if (event === 'change' || event === 'add') {
      if (this.docs.has(rel)) {
        // A no-op for our own saves; merges edits made by another program or by iCloud.
        this.docs.syncFromDisk(rel)
      } else if (rel !== this.compiler.projectPdfRel()) {
        this.indexCache = null
        this.scheduleAutoCompile()
      }
    } else if (event === 'unlink') {
      // Editors that save atomically remove and recreate the file. Only drop it if it stays gone.
      setTimeout(() => {
        if (this.closed || !this.docs.has(rel)) return
        if (fs.existsSync(abs)) this.docs.syncFromDisk(rel)
        else {
          this.docs.drop(rel, false)
          broadcast('file-deleted', { path: rel })
        }
      }, 400)
      this.indexCache = null
      if (rel !== this.compiler.projectPdfRel()) this.scheduleAutoCompile()
    }
  }

  private scheduleTreeBroadcast(): void {
    this.indexCache = null
    if (this.treeTimer) return
    this.treeTimer = setTimeout(() => {
      this.treeTimer = null
      this.indexCache = null
      if (!this.closed) broadcast('tree', {})
    }, 150)
  }

  // ---- history ----------------------------------------------------------------

  takeSnapshots(): void {
    if (!this.dirty.size || !fs.existsSync(this.root)) return
    this.docs.flushAll()
    let added = false
    for (const rel of this.dirty) {
      try {
        if (fs.existsSync(path.join(this.root, rel))) added = this.history.snapshot(rel, this.docs.read(rel), 'auto') || added
      } catch {}
    }
    this.dirty.clear()
    if (added) this.history.prune()
  }

  restoreSnapshot(relInput: string, id: string): void {
    const { rel, abs } = resolveInside(this.root, relInput)
    const content = this.history.read(rel, id)
    if (fs.existsSync(abs)) {
      this.docs.flush(rel)
      this.history.snapshot(rel, this.docs.read(rel), 'before-restore')
      this.docs.setContent(rel, content)
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
      this.scheduleTreeBroadcast()
    }
    this.dirty.add(rel)
    this.scheduleAutoCompile()
  }

  // ---- file tree --------------------------------------------------------------

  tree(): TreeNode[] {
    const walk = (relDir: string, depth: number): TreeNode[] => {
      if (depth > 12) return []
      const nodes: TreeNode[] = []
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(path.join(this.root, relDir), { withFileTypes: true })
      } catch {
        return []
      }
      for (const ent of entries) {
        const cloud = /^\.(.+)\.icloud$/.exec(ent.name)
        if (cloud) {
          const rel = relDir ? `${relDir}/${cloud[1]}` : cloud[1]
          nodes.push({ name: cloud[1], path: rel, type: 'file', kind: 'binary', cloud: true })
          continue
        }
        if (isHiddenName(ent.name) || ent.isSymbolicLink()) continue
        const rel = relDir ? `${relDir}/${ent.name}` : ent.name
        if (ent.isDirectory()) nodes.push({ name: ent.name, path: rel, type: 'dir', children: walk(rel, depth + 1) })
        else if (ent.isFile()) nodes.push({ name: ent.name, path: rel, type: 'file', kind: fileKind(path.join(this.root, rel), rel) })
      }
      return nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1))
    }
    return walk('', 0)
  }

  /** Asks iCloud to download a placeholder file. */
  downloadFromCloud(relInput: string): Promise<void> {
    const { abs } = resolveInside(this.root, relInput)
    return new Promise((resolve, reject) => {
      execFile('/usr/bin/brctl', ['download', abs], { timeout: 15_000 }, (err) => {
        if (err) reject(new HttpError(500, 'iCloud could not start the download'))
        else resolve()
      })
    })
  }

  create(parentInput: string, nameInput: string, type: 'file' | 'dir'): string {
    const parent = resolveInside(this.root, parentInput, true)
    const name = validateEntryName(nameInput)
    const rel = parent.rel ? `${parent.rel}/${name}` : name
    const { abs } = resolveInside(this.root, rel)
    if (fs.existsSync(abs)) throw new HttpError(409, `"${name}" already exists`)
    if (!fs.existsSync(parent.abs) || !fs.statSync(parent.abs).isDirectory()) throw new HttpError(400, 'The folder does not exist')
    if (type === 'dir') fs.mkdirSync(abs)
    else fs.writeFileSync(abs, '', { flag: 'wx' })
    this.scheduleTreeBroadcast()
    return rel
  }

  move(fromInput: string, toInput: string): string {
    const from = resolveInside(this.root, fromInput)
    const to = resolveInside(this.root, toInput)
    validateEntryName(path.basename(to.rel))
    if (from.rel === to.rel) return to.rel
    if (!fs.existsSync(from.abs)) throw new HttpError(404, 'Not found')
    if (to.rel.startsWith(from.rel + '/')) throw new HttpError(400, 'A folder cannot be moved into itself')
    const sameFile = from.rel.toLowerCase() === to.rel.toLowerCase()
    if (fs.existsSync(to.abs) && !sameFile) throw new HttpError(409, `"${path.basename(to.rel)}" already exists there`)
    const parent = path.dirname(to.abs)
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new HttpError(400, 'The target folder does not exist')
    this.docs.dropTree(from.rel, true)
    fs.renameSync(from.abs, to.abs)
    this.history.rename(from.rel, to.rel)
    this.review.rename(from.rel, to.rel)
    for (const rel of [...this.dirty]) {
      if (rel === from.rel || rel.startsWith(from.rel + '/')) {
        this.dirty.delete(rel)
        this.dirty.add(to.rel + rel.slice(from.rel.length))
      }
    }
    const main = this.settings.mainFile
    if (main === from.rel || main.startsWith(from.rel + '/')) {
      this.settings.mainFile = to.rel + main.slice(from.rel.length)
      writeProjectSettings(this.root, this.settings)
      this.broadcastInfo()
    }
    broadcast('file-moved', { from: from.rel, to: to.rel })
    this.scheduleTreeBroadcast()
    this.scheduleAutoCompile()
    return to.rel
  }

  // ---- trash ------------------------------------------------------------------

  private trashDir(): string {
    return path.join(this.root, INTERNAL_DIR, 'trash')
  }

  /** Deleting moves the item into the project's hidden trash, so nothing is lost for good. */
  remove(relInput: string): void {
    const { rel, abs } = resolveInside(this.root, relInput)
    if (!fs.existsSync(abs)) throw new HttpError(404, 'Not found')
    const isDir = fs.statSync(abs).isDirectory()
    this.docs.dropTree(rel, true)
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    const dir = path.join(this.trashDir(), id)
    fs.mkdirSync(dir, { recursive: true })
    fs.renameSync(abs, path.join(dir, 'item'))
    const meta: TrashItem = { id, path: rel, type: isDir ? 'dir' : 'file', t: Date.now() }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta))
    for (const d of [...this.dirty]) if (d === rel || d.startsWith(rel + '/')) this.dirty.delete(d)
    this.review.drop(rel)
    broadcast('file-deleted', { path: rel })
    this.scheduleTreeBroadcast()
    this.scheduleAutoCompile()
  }

  listTrash(): TrashItem[] {
    const items: TrashItem[] = []
    try {
      for (const id of fs.readdirSync(this.trashDir())) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(this.trashDir(), id, 'meta.json'), 'utf8'))
          if (fs.existsSync(path.join(this.trashDir(), id, 'item'))) items.push({ id, path: String(meta.path), type: meta.type === 'dir' ? 'dir' : 'file', t: Number(meta.t) })
        } catch {}
      }
    } catch {}
    return items.sort((a, b) => b.t - a.t)
  }

  restoreFromTrash(id: string): string {
    if (!/^[0-9]+-[0-9a-f]+$/.test(id)) throw new HttpError(400, 'Invalid id')
    const item = this.listTrash().find((i) => i.id === id)
    if (!item) throw new HttpError(404, 'Not in the trash')
    let target = resolveInside(this.root, item.path)
    if (fs.existsSync(target.abs)) {
      const ext = path.extname(item.path)
      const stem = item.path.slice(0, item.path.length - ext.length)
      for (let i = 1; fs.existsSync(target.abs); i++) target = resolveInside(this.root, `${stem} (restored${i > 1 ? ` ${i}` : ''})${ext}`)
    }
    fs.mkdirSync(path.dirname(target.abs), { recursive: true })
    fs.renameSync(path.join(this.trashDir(), id, 'item'), target.abs)
    fs.rmSync(path.join(this.trashDir(), id), { recursive: true, force: true })
    this.scheduleTreeBroadcast()
    this.scheduleAutoCompile()
    return target.rel
  }

  private pruneTrash(): void {
    for (const item of this.listTrash()) {
      if (Date.now() - item.t > TRASH_KEEP_MS) fs.rmSync(path.join(this.trashDir(), item.id), { recursive: true, force: true })
    }
  }

  // ---- upload -----------------------------------------------------------------

  async upload(relInput: string, body: Readable): Promise<string> {
    let target = resolveInside(this.root, relInput)
    validateEntryName(path.basename(target.rel))
    const parent = path.dirname(target.abs)
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new HttpError(400, 'The target folder does not exist')
    const tmpDir = path.join(this.root, INTERNAL_DIR, 'tmp')
    fs.mkdirSync(tmpDir, { recursive: true })
    const tmp = path.join(tmpDir, crypto.randomBytes(8).toString('hex'))
    let bytes = 0
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length
        if (bytes > MAX_UPLOAD_BYTES) cb(new HttpError(413, 'The file is larger than 50 MB'))
        else cb(null, chunk)
      },
    })
    try {
      await pipeline(body, limiter, fs.createWriteStream(tmp))
      if (fs.existsSync(target.abs) && fs.statSync(target.abs).isDirectory()) throw new HttpError(409, 'A folder with that name exists')
      if (fs.existsSync(target.abs)) {
        // Keep both: never overwrite silently.
        const ext = path.extname(target.rel)
        const stem = target.rel.slice(0, target.rel.length - ext.length)
        for (let i = 2; fs.existsSync(target.abs); i++) target = resolveInside(this.root, `${stem} (${i})${ext}`)
      }
      fs.renameSync(tmp, target.abs)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
    this.scheduleTreeBroadcast()
    this.scheduleAutoCompile()
    return target.rel
  }

  // ---- index for autocomplete -------------------------------------------------

  index(): ProjectIndex {
    if (this.indexCache) return this.indexCache
    const labels: ProjectIndex['labels'] = []
    const bibKeys: ProjectIndex['bibKeys'] = []
    const files: string[] = []
    const visit = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        if (n.type === 'dir') {
          visit(n.children ?? [])
          continue
        }
        if (n.cloud) continue
        files.push(n.path)
        if (n.kind !== 'text') continue
        const ext = extensionOf(n.path)
        if (ext !== 'tex' && ext !== 'bib') continue
        let content: string
        try {
          content = this.docs.read(n.path)
        } catch {
          continue
        }
        const lineAt = (offset: number): number => {
          let line = 1
          for (let i = content.indexOf('\n'); i >= 0 && i < offset; i = content.indexOf('\n', i + 1)) line++
          return line
        }
        if (ext === 'tex') {
          for (const m of content.matchAll(/\\label\{([^}]+)\}/g)) labels.push({ name: m[1], file: n.path, line: lineAt(m.index) })
        } else {
          for (const m of content.matchAll(/@(\w+)\s*\{\s*([^,\s}]+)\s*,/g)) {
            if (/^(string|comment|preamble)$/i.test(m[1])) continue
            const rest = content.slice(m.index, m.index + 1500)
            const title = /\btitle\s*=\s*[{"]+([^}"]+)/i.exec(rest)?.[1]
            const author = /\bauthor\s*=\s*[{"]+([^}"]+)/i.exec(rest)?.[1]
            bibKeys.push({ key: m[2], file: n.path, line: lineAt(m.index), title: title?.replace(/\s+/g, ' '), author: author?.replace(/\s+/g, ' ') })
          }
        }
      }
    }
    visit(this.tree())
    this.indexCache = { labels, bibKeys, files }
    return this.indexCache
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.autoCompileTimer) clearTimeout(this.autoCompileTimer)
    if (this.treeTimer) clearTimeout(this.treeTimer)
    if (this.reviewTimer) clearTimeout(this.reviewTimer)
    clearInterval(this.snapshotTimer)
    clearInterval(this.rootTimer)
    this.ai.dispose()
    await this.watcher.close()
    await this.compiler.dispose()
    this.takeSnapshots()
    this.docs.close()
    if (fs.existsSync(this.root)) fs.rmSync(path.join(this.root, INTERNAL_DIR, 'tmp'), { recursive: true, force: true })
  }
}

export type ProjectIndex = {
  labels: { name: string; file: string; line: number }[]
  bibKeys: { key: string; file: string; line: number; title?: string; author?: string }[]
  files: string[]
}

// ---- the one project that is open ---------------------------------------------

let current: Project | null = null

export function currentProject(): Project | null {
  return current
}

/** The open project's folder was renamed, moved or deleted: close it and tell everyone. */
async function projectGone(project: Project): Promise<void> {
  if (current !== project) return
  current = null
  const name = project.settings.name
  await project.close().catch((err) => console.error(err))
  broadcast('project', { project: null })
  broadcast('notice', {
    kind: 'error',
    message: `The folder of "${name}" was renamed, moved or deleted, so the project was closed. Open it again from where it is now.`,
  }, 'host')
}

export function requireProject(): Project {
  if (!current) throw new HttpError(409, 'No project is open')
  if (!fs.existsSync(current.root)) {
    void projectGone(current)
    throw new HttpError(409, 'The project folder was renamed, moved or deleted. Open the project again from where it is now.')
  }
  return current
}

export async function openProject(root: string): Promise<Project> {
  const real = fs.realpathSync(root)
  if (current?.root === real) return current
  await closeProject(false)
  current = new Project(real, (p) => void projectGone(p))
  broadcast('project', { project: current.info() })
  current.scheduleAutoCompile(200)
  return current
}

export async function closeProject(announce = true): Promise<void> {
  const p = current
  current = null
  if (p) await p.close()
  if (announce) broadcast('project', { project: null })
}

