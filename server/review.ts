import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { diffArrays } from 'diff'
import { writeFileAtomic } from './config.ts'
import { HttpError, INTERNAL_DIR } from './paths.ts'

/**
 * Changes made by the assistant are applied to the live document straight away, and the text
 * from before the change is kept as a backup until the user accepts or declines.
 *
 * "Pending" is simply the difference between the backup and the current text, so accepting a
 * change folds it into the backup, and declining it puts the backup text back into the document.
 * When nothing differs any more the backup is deleted.
 */

export type Hunk = {
  id: string
  /** 0-based line index in the backup, and how many backup lines the change replaces. */
  oldStart: number
  oldLines: string[]
  /** 0-based line index in the current text, and the lines that are there now. */
  newStart: number
  newLines: string[]
}

export type ReviewFile = { path: string; status: 'modified' | 'added'; hunks: Hunk[] }
export type ReviewSummary = { files: ReviewFile[]; changeCount: number; hasBeforePdf: boolean }

export type ReviewHost = {
  /** Current text of a file, or null if it does not exist. */
  read: (rel: string) => string | null
  /** Replace the text of a file through the live document. */
  write: (rel: string, content: string) => void
  /** Remove a file the assistant created. */
  remove: (rel: string) => void
  /** The compiled PDF as it is right now, if any. */
  currentPdf: () => string | null
  onChange: () => void
}

export function diffHunks(oldText: string, newText: string): Hunk[] {
  const hunks: Hunk[] = []
  let oldPos = 0
  let newPos = 0
  let open: Hunk | null = null
  for (const part of diffArrays(oldText.split('\n'), newText.split('\n'))) {
    if (!part.added && !part.removed) {
      oldPos += part.value.length
      newPos += part.value.length
      open = null
      continue
    }
    if (!open) {
      open = { id: '', oldStart: oldPos, oldLines: [], newStart: newPos, newLines: [] }
      hunks.push(open)
    }
    if (part.removed) {
      open.oldLines.push(...part.value)
      oldPos += part.value.length
    } else {
      open.newLines.push(...part.value)
      newPos += part.value.length
    }
  }
  for (const h of hunks) {
    h.id = crypto.createHash('sha1').update(`${h.oldStart}\n${h.oldLines.join('\n')}\n--\n${h.newLines.join('\n')}`).digest('hex').slice(0, 12)
  }
  return hunks
}

type State = { files: Record<string, { existed: boolean }> }

export class Review {
  private dir: string
  private state: State = { files: {} }
  private host: ReviewHost

  constructor(root: string, host: ReviewHost) {
    this.dir = path.join(root, INTERNAL_DIR, 'review')
    this.host = host
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, 'state.json'), 'utf8'))
      if (raw && typeof raw.files === 'object') this.state = raw
    } catch {}
  }

  private backupFile(rel: string): string {
    return path.join(this.dir, 'files', crypto.createHash('sha1').update(rel).digest('hex') + '.bak')
  }

  private beforePdf(): string {
    return path.join(this.dir, 'before.pdf')
  }

  private persist(): void {
    if (!fs.existsSync(path.dirname(path.dirname(this.dir)))) return
    if (!Object.keys(this.state.files).length) {
      // Nothing pending: the backups have done their job.
      fs.rmSync(this.dir, { recursive: true, force: true })
    } else {
      fs.mkdirSync(path.join(this.dir, 'files'), { recursive: true })
      writeFileAtomic(path.join(this.dir, 'state.json'), JSON.stringify(this.state))
    }
    this.host.onChange()
  }

  private baseline(rel: string): string | null {
    const entry = this.state.files[rel]
    if (!entry) return null
    if (!entry.existed) return ''
    try {
      return fs.readFileSync(this.backupFile(rel), 'utf8')
    } catch {
      return null
    }
  }

  private setBaseline(rel: string, content: string): void {
    fs.mkdirSync(path.join(this.dir, 'files'), { recursive: true })
    fs.writeFileSync(this.backupFile(rel), content)
  }

  private forget(rel: string): void {
    delete this.state.files[rel]
    fs.rmSync(this.backupFile(rel), { force: true })
  }

  has(rel: string): boolean {
    return rel in this.state.files
  }

  get pending(): boolean {
    return Object.keys(this.state.files).length > 0
  }

  /** Call before the assistant changes a file: keeps the text from before its first change. */
  capture(rel: string): void {
    if (this.has(rel)) return
    if (!this.pending) {
      // First change of a round: keep the PDF as it was, for the before/after comparison.
      const pdf = this.host.currentPdf()
      fs.mkdirSync(this.dir, { recursive: true })
      if (pdf) fs.copyFileSync(pdf, this.beforePdf())
    }
    const current = this.host.read(rel)
    this.state.files[rel] = { existed: current !== null }
    if (current !== null) this.setBaseline(rel, current)
    this.persist()
  }

  beforePdfPath(): string | null {
    return this.pending && fs.existsSync(this.beforePdf()) ? this.beforePdf() : null
  }

  summary(): ReviewSummary {
    const files: ReviewFile[] = []
    let changed = false
    for (const rel of Object.keys(this.state.files).sort()) {
      const base = this.baseline(rel)
      const current = this.host.read(rel)
      const existed = this.state.files[rel].existed
      // The file vanished, its backup is unreadable, or it is back to what it was: nothing to review.
      if (current === null || base === null || (existed && base === current)) {
        this.forget(rel)
        changed = true
        continue
      }
      files.push({ path: rel, status: existed ? 'modified' : 'added', hunks: existed ? diffHunks(base, current) : diffHunks('', current) })
    }
    if (changed) this.persist()
    return {
      files,
      changeCount: files.reduce((n, f) => n + (f.status === 'added' ? 1 : f.hunks.length), 0),
      hasBeforePdf: this.beforePdfPath() !== null,
    }
  }

  private findHunk(rel: string, id: string): { base: string; current: string; hunk: Hunk } {
    const base = this.baseline(rel)
    const current = this.host.read(rel)
    if (base === null || current === null) throw new HttpError(404, 'No pending changes in that file')
    const hunk = diffHunks(base, current).find((h) => h.id === id)
    if (!hunk) throw new HttpError(409, 'That change is no longer there. The file has changed since.')
    return { base, current, hunk }
  }

  /** Keep a change: it becomes part of the backup, so it no longer shows as pending. */
  accept(rel?: string, hunkId?: string): void {
    if (rel && hunkId && this.state.files[rel]?.existed) {
      const { base, hunk } = this.findHunk(rel, hunkId)
      const lines = base.split('\n')
      lines.splice(hunk.oldStart, hunk.oldLines.length, ...hunk.newLines)
      this.setBaseline(rel, lines.join('\n'))
    } else {
      for (const key of Object.keys(this.state.files)) if (!rel || key === rel) this.forget(key)
    }
    this.persist()
    this.summary()
  }

  /** Undo a change: the backup text goes back into the document. */
  decline(rel?: string, hunkId?: string): void {
    if (rel && hunkId && this.state.files[rel]?.existed) {
      const { current, hunk } = this.findHunk(rel, hunkId)
      const lines = current.split('\n')
      lines.splice(hunk.newStart, hunk.newLines.length, ...hunk.oldLines)
      this.host.write(rel, lines.join('\n'))
    } else {
      for (const key of Object.keys(this.state.files)) {
        if (rel && key !== rel) continue
        const base = this.baseline(key)
        const existed = this.state.files[key].existed
        if (!existed) {
          if (this.host.read(key) !== null) this.host.remove(key)
        } else if (base !== null && this.host.read(key) !== null) {
          this.host.write(key, base)
        }
        this.forget(key)
      }
    }
    this.persist()
    this.summary()
  }

  /** Keeps backups attached when a file or folder is renamed. */
  rename(from: string, to: string): void {
    let changed = false
    for (const key of Object.keys(this.state.files)) {
      if (key !== from && !key.startsWith(from + '/')) continue
      const target = to + key.slice(from.length)
      const base = this.baseline(key)
      const entry = this.state.files[key]
      this.forget(key)
      this.state.files[target] = entry
      if (entry.existed && base !== null) this.setBaseline(target, base)
      changed = true
    }
    if (changed) this.persist()
  }

  /** A file was deleted by someone: there is nothing left to review in it. */
  drop(rel: string): void {
    let changed = false
    for (const key of Object.keys(this.state.files)) {
      if (key === rel || key.startsWith(rel + '/')) {
        this.forget(key)
        changed = true
      }
    }
    if (changed) this.persist()
  }
}
