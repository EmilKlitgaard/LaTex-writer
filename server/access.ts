import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './config.ts'
import { broadcast } from './hub.ts'
import { HttpError, INTERNAL_DIR, isHiddenName, isTextFile, resolveInside } from './paths.ts'

/** The same test as the workspace list uses (kept here to avoid an import cycle through project.ts). */
function isProjectDir(dir: string): boolean {
  if (fs.existsSync(path.join(dir, INTERNAL_DIR, 'project.json'))) return true
  try {
    return fs.readdirSync(dir).some((n) => n.toLowerCase().endsWith('.tex'))
  } catch {
    return false
  }
}

/**
 * What the assistant may read beyond the open project, always read-only:
 * - other projects in the same folder, once the user has allowed it. The permission belongs to
 *   the open project and lasts until the user takes it back.
 * - files and folders the user attached to one conversation with the + button. They last for
 *   that conversation only.
 */

/** A place the assistant can read from: a folder, or a single attached file. */
export type Source = { kind: 'project' | 'folder' | 'file'; name: string; root: string; only?: string }
export type AccessRequest = { id: string; project: string; path: string; reason: string; t: number }
export type Sibling = { name: string; path: string; granted: boolean }

/** How long a permission question waits for an answer before it counts as a no. */
export const ACCESS_TIMEOUT_MS = 5 * 60 * 1000
const MAX_LISTED = 400

const grantsFile = (root: string): string => path.join(root, INTERNAL_DIR, 'access.json')

export function readGrants(root: string): string[] {
  try {
    const saved = JSON.parse(fs.readFileSync(grantsFile(root), 'utf8')) as { projects?: unknown }
    return Array.isArray(saved.projects) ? saved.projects.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

function writeGrants(root: string, list: string[]): void {
  fs.mkdirSync(path.dirname(grantsFile(root)), { recursive: true })
  writeFileAtomic(grantsFile(root), JSON.stringify({ projects: [...new Set(list)] }, null, 2))
}

export function grant(root: string, other: string): void {
  writeGrants(root, [...readGrants(root), other])
}

export function revoke(root: string, other: unknown): void {
  writeGrants(root, readGrants(root).filter((p) => p !== other))
}

/** The other projects in the folder that holds this one. */
export function siblings(root: string): Sibling[] {
  const parent = path.dirname(root)
  const granted = new Set(readGrants(root))
  const out: Sibling[] = []
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  } catch {}
  for (const ent of entries) {
    if (ent.name.startsWith('.') || !ent.isDirectory()) continue
    const full = path.join(parent, ent.name)
    if (full === root || !isProjectDir(full)) continue
    out.push({ name: ent.name, path: full, granted: granted.has(full) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

export function findSibling(root: string, name: unknown): Sibling | undefined {
  if (typeof name !== 'string') return undefined
  const wanted = name.trim().toLowerCase()
  return siblings(root).find((s) => s.name.toLowerCase() === wanted || s.path === name)
}

/** The sources an attachment list and the grants of a project make available. */
export function sources(root: string, attachments: string[]): Source[] {
  const out: Source[] = siblings(root).filter((s) => s.granted).map((s) => ({ kind: 'project', name: s.name, root: s.path }))
  for (const a of attachments) {
    try {
      const stat = fs.statSync(a)
      if (stat.isDirectory()) out.push({ kind: 'folder', name: a, root: a })
      else if (stat.isFile()) out.push({ kind: 'file', name: a, root: path.dirname(a), only: path.basename(a) })
    } catch {}
  }
  return out
}

/**
 * Finds the source a tool call names: another project by its folder name, or an attachment by
 * its path. A path inside an attached folder also works, and so does a project's full path.
 */
export function findSource(list: Source[], name: unknown): { source: Source; prefix: string } | undefined {
  if (typeof name !== 'string' || !name.trim()) return undefined
  const wanted = name.trim().replace(/\/+$/, '')
  for (const s of list) {
    if (s.name === wanted || s.name.toLowerCase() === wanted.toLowerCase() || s.root === wanted && s.kind !== 'file') return { source: s, prefix: '' }
  }
  for (const s of list) {
    if (s.kind === 'file') continue
    const rel = path.relative(s.root, wanted)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return { source: s, prefix: rel }
  }
  return undefined
}

/** Resolves a path inside a source. Throws when it leaves the source or names a hidden file. */
export function resolveInSource(source: Source, relInput: unknown, prefix = ''): { rel: string; abs: string } {
  const given = typeof relInput === 'string' ? relInput : ''
  if (source.kind === 'file') {
    if (given && given !== source.only && given !== path.join(source.root, source.only!)) throw new HttpError(400, `Only the attached file ${source.only} can be read here.`)
    return { rel: source.only!, abs: path.join(source.root, source.only!) }
  }
  // An absolute path inside the source is fine: that is how attached folders are usually named.
  const rel = path.isAbsolute(given) ? path.relative(source.root, given) : path.posix.join(prefix, given)
  const out = resolveInside(source.root, rel, true)
  if (out.rel.split('/').some((p) => isHiddenName(p))) throw new HttpError(400, 'That path is not readable')
  return out
}

/** Every file of a source, relative to its root, skipping internal and hidden files. */
export function listFiles(source: Source, under = ''): { rel: string; abs: string; text: boolean }[] {
  if (source.kind === 'file') {
    const abs = path.join(source.root, source.only!)
    return [{ rel: source.only!, abs, text: isTextFile(abs, source.only!) }]
  }
  const out: { rel: string; abs: string; text: boolean }[] = []
  const walk = (relDir: string, depth: number): void => {
    if (depth > 12 || out.length >= MAX_LISTED * 5) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(source.root, relDir), { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    for (const ent of entries) {
      if (ent.name.startsWith('.') || isHiddenName(ent.name) || ent.isSymbolicLink()) continue
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(rel, depth + 1)
      else if (ent.isFile()) {
        const abs = path.join(source.root, rel)
        out.push({ rel, abs, text: isTextFile(abs, rel) })
      }
    }
  }
  walk(under, 0)
  return out
}

export const MAX_FILES_LISTED = MAX_LISTED

/**
 * Permission questions waiting for the user. A tool call that asks waits here until the user
 * answers in the assistant panel, the turn is stopped, or the question times out.
 */
export class AccessRequests {
  private pending = new Map<string, { request: AccessRequest; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>()

  list(): AccessRequest[] {
    return [...this.pending.values()].map((p) => p.request)
  }

  ask(project: Sibling, reason: string, timeout = ACCESS_TIMEOUT_MS): Promise<boolean> {
    // The same question twice at once gets the same answer.
    const same = [...this.pending.values()].find((p) => p.request.path === project.path)
    if (same) return new Promise((resolve) => {
      const previous = same.resolve
      same.resolve = (ok) => {
        previous(ok)
        resolve(ok)
      }
    })
    const request: AccessRequest = { id: crypto.randomUUID(), project: project.name, path: project.path, reason: reason.slice(0, 500), t: Date.now() }
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.answer(request.id, false), timeout)
      timer.unref()
      this.pending.set(request.id, { request, resolve, timer })
      broadcast('ai', { kind: 'access', requests: this.list() }, 'host')
    })
  }

  /** Returns false when there is no such question (already answered or timed out). */
  answer(id: unknown, ok: boolean): boolean {
    const p = typeof id === 'string' ? this.pending.get(id) : undefined
    if (!p) return false
    clearTimeout(p.timer)
    this.pending.delete(p.request.id)
    p.resolve(ok)
    broadcast('ai', { kind: 'access', requests: this.list() }, 'host')
    return true
  }

  /** Every open question counts as a no, for example when the turn is stopped. */
  denyAll(): void {
    for (const id of [...this.pending.keys()]) this.answer(id, false)
  }
}
