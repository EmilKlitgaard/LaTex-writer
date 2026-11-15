import fs from 'node:fs'
import path from 'node:path'

export const INTERNAL_DIR = '.latexwriter'

export class HttpError extends Error {
  status: number
  /** A machine-readable reason, when the page should react to this error in a particular way. */
  code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const HIDDEN_NAMES = new Set([INTERNAL_DIR, '.DS_Store', '.git', 'node_modules'])

export function isHiddenName(name: string): boolean {
  return HIDDEN_NAMES.has(name) || name.endsWith('.icloud')
}

/** Normalizes a client-supplied project-relative path. Throws on anything that could leave the root. */
export function normalizeRel(rel: unknown): string {
  if (typeof rel !== 'string') throw new HttpError(400, 'Path is required')
  if (rel.includes('\0')) throw new HttpError(400, 'Invalid path')
  if (path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) throw new HttpError(400, 'Absolute paths are not allowed')
  const parts = rel.split(/[\\/]+/).filter((p) => p !== '' && p !== '.')
  for (const p of parts) {
    if (p === '..') throw new HttpError(400, 'Path may not contain ".."')
    if (p === INTERNAL_DIR) throw new HttpError(400, 'Path is reserved')
  }
  return parts.join('/')
}

function realpathOfDeepestExisting(abs: string): string {
  let current = abs
  const tail: string[] = []
  for (;;) {
    try {
      const real = fs.realpathSync(current)
      return tail.length ? path.join(real, ...tail.reverse()) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return abs
      tail.push(path.basename(current))
      current = parent
    }
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Resolves a project-relative path to an absolute one, guaranteed to stay inside root
 * even when symlinks are involved. `allowRoot` permits the empty path.
 */
export function resolveInside(root: string, rel: unknown, allowRoot = false): { rel: string; abs: string } {
  const clean = normalizeRel(rel)
  if (!clean && !allowRoot) throw new HttpError(400, 'Path is required')
  const abs = path.join(root, clean)
  const realRoot = fs.realpathSync(root)
  const real = realpathOfDeepestExisting(abs)
  if (!isInside(realRoot, real)) throw new HttpError(400, 'Path leaves the project folder')
  return { rel: clean, abs }
}

/** Turns a user-typed project name into a safe folder name. */
export function sanitizeFolderName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\/\\:*?"<>|\0]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .slice(0, 80)
    .trim()
  if (!cleaned) throw new HttpError(400, 'Please give the project a name')
  return cleaned
}

/** Validates a single new file or folder name (no separators). */
export function validateEntryName(name: string): string {
  const n = name.normalize('NFC').trim()
  if (!n || n === '.' || n === '..' || /[\/\\\0]/.test(n) || n.length > 200) {
    throw new HttpError(400, 'Invalid name')
  }
  if (isHiddenName(n)) throw new HttpError(400, 'That name is reserved')
  return n
}

const TEXT_EXTENSIONS = new Set([
  'tex', 'bib', 'sty', 'cls', 'txt', 'md', 'bst', 'bbx', 'cbx', 'lbx', 'dbx', 'tikz', 'csv', 'tsv', 'dat', 'def',
  'cfg', 'clo', 'ltx', 'dtx', 'ins', 'json', 'yml', 'yaml', 'xml', 'py', 'r', 'm', 'c', 'cpp', 'h', 'java', 'js',
  'ts', 'html', 'css', 'sh', 'lua', 'gitignore', 'latexmkrc', 'log', 'pgf', 'mp', 'asy', 'gnuplot', 'ist', 'glo',
])

const BINARY_EXTENSIONS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'eps', 'ps', 'zip', 'gz', 'ttf', 'otf', 'woff', 'woff2', 'svg',
  'bmp', 'tif', 'tiff', 'ico', 'mp4', 'mov', 'docx', 'xlsx', 'pptx',
])

export const MAX_TEXT_BYTES = 2 * 1024 * 1024

export function extensionOf(rel: string): string {
  const base = rel.split('/').pop() ?? ''
  const i = base.lastIndexOf('.')
  return i <= 0 ? base.replace(/^\./, '').toLowerCase() : base.slice(i + 1).toLowerCase()
}

/** Decides whether a file is edited as collaborative text or treated as an opaque binary. */
export function isTextFile(abs: string, rel: string): boolean {
  const ext = extensionOf(rel)
  if (BINARY_EXTENSIONS.has(ext)) return false
  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch {
    return TEXT_EXTENSIONS.has(ext)
  }
  if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return false
  if (TEXT_EXTENSIONS.has(ext)) return true
  // Unknown extension: sniff the first bytes for NULs.
  const fd = fs.openSync(abs, 'r')
  try {
    const buf = Buffer.alloc(Math.min(stat.size, 8192))
    fs.readSync(fd, buf, 0, buf.length, 0)
    return !buf.includes(0)
  } finally {
    fs.closeSync(fd)
  }
}
