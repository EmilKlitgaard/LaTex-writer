import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { writeFileAtomic } from './config.ts'
import { HttpError, INTERNAL_DIR } from './paths.ts'

export const HISTORY_CAP_BYTES = 50 * 1024 * 1024
export const SNAPSHOT_INTERVAL_MS = 2 * 60 * 1000
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

export type Snapshot = {
  id: string
  /** Time the snapshot was taken (ms since epoch). */
  t: number
  hash: string
  /** Size of the text in bytes. */
  size: number
  reason: 'auto' | 'before-edit' | 'before-restore' | 'external' | 'deleted'
}

type Index = { files: Record<string, Snapshot[]> }

/**
 * Retention: everything from the last hour, then the newest per hour for a day,
 * then the newest per day. Input and output are oldest-first.
 */
export function thin(snapshots: Snapshot[], now: number): Snapshot[] {
  const keep = new Set<Snapshot>()
  const buckets = new Map<string, Snapshot>()
  for (const s of snapshots) {
    const age = now - s.t
    if (age < HOUR) keep.add(s)
    else {
      const key = age < DAY ? `h${Math.floor(s.t / HOUR)}` : `d${Math.floor(s.t / DAY)}`
      const prev = buckets.get(key)
      if (!prev || s.t >= prev.t) buckets.set(key, s)
    }
  }
  for (const s of buckets.values()) keep.add(s)
  return snapshots.filter((s) => keep.has(s))
}

/** Content-addressed, compressed snapshots of text files, stored inside the project's hidden folder. */
export class History {
  private dir: string
  private blobDir: string
  private indexFile: string
  private index: Index = { files: {} }
  private cap: number

  constructor(root: string, cap = HISTORY_CAP_BYTES) {
    this.dir = path.join(root, INTERNAL_DIR, 'history')
    this.blobDir = path.join(this.dir, 'blobs')
    this.indexFile = path.join(this.dir, 'index.json')
    this.cap = cap
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'))
      if (raw && typeof raw.files === 'object') this.index = raw
    } catch {}
  }

  private blobPath(hash: string): string {
    return path.join(this.blobDir, `${hash}.gz`)
  }

  private persist(): void {
    fs.mkdirSync(this.dir, { recursive: true })
    writeFileAtomic(this.indexFile, JSON.stringify(this.index))
  }

  /** Stores a snapshot unless the content equals the newest one. Returns true if one was added. */
  snapshot(rel: string, content: string, reason: Snapshot['reason'], t = Date.now()): boolean {
    const hash = crypto.createHash('sha256').update(content).digest('hex')
    const list = (this.index.files[rel] ??= [])
    if (list.length && list[list.length - 1].hash === hash) return false
    fs.mkdirSync(this.blobDir, { recursive: true })
    const blob = this.blobPath(hash)
    if (!fs.existsSync(blob)) fs.writeFileSync(blob, zlib.gzipSync(content))
    list.push({ id: `${t}-${hash.slice(0, 8)}`, t, hash, size: Buffer.byteLength(content), reason })
    this.persist()
    return true
  }

  /** Newest first. */
  list(rel: string): Snapshot[] {
    return [...(this.index.files[rel] ?? [])].reverse()
  }

  /** Every path that has history, including files that no longer exist. */
  paths(): string[] {
    return Object.keys(this.index.files).filter((p) => this.index.files[p].length)
  }

  read(rel: string, id: string): string {
    const snap = (this.index.files[rel] ?? []).find((s) => s.id === id)
    if (!snap) throw new HttpError(404, 'Snapshot not found')
    try {
      return zlib.gunzipSync(fs.readFileSync(this.blobPath(snap.hash))).toString('utf8')
    } catch {
      throw new HttpError(404, 'Snapshot data is missing')
    }
  }

  /** Keeps history attached to a file (or a whole folder) when it is renamed or moved. */
  rename(from: string, to: string): void {
    let changed = false
    for (const key of Object.keys(this.index.files)) {
      if (key === from || key.startsWith(from + '/')) {
        const target = to + key.slice(from.length)
        this.index.files[target] = [...(this.index.files[target] ?? []), ...this.index.files[key]].sort((a, b) => a.t - b.t)
        delete this.index.files[key]
        changed = true
      }
    }
    if (changed) this.persist()
  }

  totalBytes(): number {
    let total = 0
    try {
      for (const name of fs.readdirSync(this.blobDir)) total += fs.statSync(path.join(this.blobDir, name)).size
    } catch {}
    return total
  }

  /** Applies the retention rules and the size cap, then deletes blobs nothing refers to. */
  prune(now = Date.now()): void {
    for (const key of Object.keys(this.index.files)) {
      this.index.files[key] = thin(this.index.files[key], now)
      if (!this.index.files[key].length) delete this.index.files[key]
    }
    const blobSize = (hash: string): number => {
      try {
        return fs.statSync(this.blobPath(hash)).size
      } catch {
        return 0
      }
    }
    const referenced = (): Map<string, number> => {
      const refs = new Map<string, number>()
      for (const list of Object.values(this.index.files)) for (const s of list) refs.set(s.hash, (refs.get(s.hash) ?? 0) + 1)
      return refs
    }
    let refs = referenced()
    let total = 0
    for (const hash of refs.keys()) total += blobSize(hash)
    while (total > this.cap) {
      // Drop the oldest snapshot anywhere, but always keep the newest one of each file.
      let oldestKey: string | null = null
      for (const [key, list] of Object.entries(this.index.files)) {
        if (list.length > 1 && (oldestKey === null || list[0].t < this.index.files[oldestKey][0].t)) oldestKey = key
      }
      if (oldestKey === null) break
      const removed = this.index.files[oldestKey].shift()!
      const left = (refs.get(removed.hash) ?? 1) - 1
      if (left <= 0) {
        refs.delete(removed.hash)
        total -= blobSize(removed.hash)
      } else refs.set(removed.hash, left)
    }
    refs = referenced()
    try {
      for (const name of fs.readdirSync(this.blobDir)) {
        if (!refs.has(name.replace(/\.gz$/, ''))) fs.rmSync(path.join(this.blobDir, name), { force: true })
      }
    } catch {}
    this.persist()
  }
}
