export type LogEntry = {
  severity: 'error' | 'warning' | 'info'
  /** Project-relative file, or null when the message has no source location in the project. */
  file: string | null
  line: number | null
  message: string
  detail?: string
  hint?: string
}

const FILE_LINE_ERROR = /^((?:\.{0,2}\/)?[^:()\n]+?\.[A-Za-z0-9]+):(\d+): (.*)$/
const BANG_ERROR = /^! (.*)$/
const WARNING = /^(LaTeX|Package|Class|pdfTeX|LaTeX Font|LaTeX3?) ?([A-Za-z0-9_@-]*) ?(Warning|warning): ?(.*)$/
const BOX = /^(Overfull|Underfull) \\([hv])box \(([^)]*)\) (.*)$/
const MISSING_FILE = /File [`']([^']+)\.(sty|cls|def|clo|fd)' not found/
const IGNORED_WARNINGS = [
  /There were undefined references/,
  /Label\(s\) may have changed/,
  /There were multiply-defined labels/,
  /Rerun to get/,
  /Please \(re\)run (Biber|BibTeX)/,
]

/** Follow-up lines TeX prints after a fatal error; they add nothing once the real error is listed. */
function isNoise(message: string): boolean {
  return /^Emergency stop|^==> Fatal error/.test(message)
}

function looksLikeFile(token: string): boolean {
  return /^(\.{0,2}\/|[A-Za-z]:[\\/])/.test(token) || /^[^\s\\{}]+\.[A-Za-z0-9]{1,8}$/.test(token)
}

/** Maps a path as TeX printed it to a project-relative one; null for files outside the project (TeX tree). */
export function toProjectPath(raw: string, buildDir?: string): string | null {
  let p = raw.trim().replace(/^"|"$/g, '')
  if (buildDir && p.startsWith(buildDir + '/')) p = p.slice(buildDir.length + 1)
  if (p.startsWith('/')) return null
  while (p.startsWith('./')) p = p.slice(2)
  if (p.startsWith('../')) return null
  return p || null
}

function missingPackageHint(message: string): string | undefined {
  const m = MISSING_FILE.exec(message)
  if (!m) return undefined
  if (m[2] === 'sty' || m[2] === 'cls') {
    return `The ${m[2] === 'cls' ? 'class' : 'package'} "${m[1]}" is not installed. To install it, run in Terminal: sudo tlmgr install ${m[1]}`
  }
  return undefined
}

/**
 * Parses a TeX .log written with -file-line-error and a very large max_print_line
 * (so lines are not wrapped at 79 characters).
 */
export function parseTexLog(log: string, buildDir?: string): LogEntry[] {
  const lines = log.split(/\r?\n/)
  const entries: LogEntry[] = []
  // Stack of files TeX has open; null marks a parenthesis that was not a file.
  const stack: (string | null)[] = []
  const currentFile = (): string | null => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i]
      if (f !== null) return toProjectPath(f, buildDir)
    }
    return null
  }
  const trackParens = (line: string): void => {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '(') {
        const m = /^[^\s()]*/.exec(line.slice(i + 1))
        const token = m ? m[0] : ''
        stack.push(token && looksLikeFile(token) ? token : null)
        i += token.length
      } else if (ch === ')') {
        stack.pop()
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    let m = FILE_LINE_ERROR.exec(line)
    if (m && !line.startsWith('(')) {
      const message = m[3].trim()
      if (isNoise(message) && entries.some((e) => e.severity === 'error')) continue
      let detail: string[] = []
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
        if (/^l\.\d+/.test(lines[j])) {
          // The source line TeX stopped at says it best; the lines before it are TeX internals.
          detail = [lines[j].replace(/^l\.\d+\s?/, '').trim()]
          break
        }
        if (lines[j].trim() && !/^(Type|See the|You can|Try typing)/.test(lines[j])) detail.push(lines[j].trim())
      }
      entries.push({
        severity: 'error',
        file: toProjectPath(m[1], buildDir),
        line: Number(m[2]),
        message,
        detail: detail.join(' ').slice(0, 300) || undefined,
        hint: missingPackageHint(message),
      })
      continue
    }

    m = BANG_ERROR.exec(line)
    if (m) {
      const message = m[1].trim()
      if (isNoise(message) && entries.some((e) => e.severity === 'error')) continue
      let lineNo: number | null = null
      let detail: string | undefined
      for (let j = i + 1; j < Math.min(lines.length, i + 14); j++) {
        const lm = /^l\.(\d+)\s?(.*)$/.exec(lines[j])
        if (lm) {
          lineNo = Number(lm[1])
          detail = lm[2].trim() || undefined
          break
        }
        if (BANG_ERROR.test(lines[j])) break
      }
      entries.push({ severity: 'error', file: currentFile(), line: lineNo, message, detail, hint: missingPackageHint(message) })
      continue
    }

    m = WARNING.exec(line)
    if (m) {
      const pkg = m[2]
      let message = m[4].trim()
      // Continuation lines: "(pkg)   more text" for packages, plain lines until a blank one for LaTeX.
      let j = i + 1
      for (; j < lines.length && j < i + 8; j++) {
        const next = lines[j]
        if (!next.trim()) break
        const cont = pkg && next.startsWith(`(${pkg})`) ? next.slice(pkg.length + 2) : /^\s{2,}\S/.test(next) ? next : null
        if (cont === null) break
        message += ' ' + cont.trim()
      }
      i = j - 1
      if (IGNORED_WARNINGS.some((r) => r.test(message))) continue
      const lm = /on input line (\d+)/.exec(message)
      const prefix = m[1] === 'LaTeX' && !pkg ? '' : `${[m[1] === 'LaTeX' ? '' : m[1], pkg].filter(Boolean).join(' ')}: `
      entries.push({
        severity: 'warning',
        file: currentFile(),
        line: lm ? Number(lm[1]) : null,
        message: (prefix + message).replace(/\s+/g, ' ').trim(),
      })
      continue
    }

    m = BOX.exec(line)
    if (m) {
      const lm = /at lines? (\d+)/.exec(m[4])
      entries.push({
        severity: 'info',
        file: currentFile(),
        line: lm ? Number(lm[1]) : null,
        message: `${m[1]} \\${m[2]}box (${m[3]}) ${m[4]}`.trim(),
      })
      // The next line dumps the offending text, which is full of stray parentheses. Skip it.
      if (i + 1 < lines.length && lines[i + 1].trim() && !lines[i + 1].startsWith('(')) i++
      continue
    }

    if (/^Missing character: /.test(line)) {
      // Text before \begin{document} is reported once per letter; the real error is already listed.
      if (/in font nullfont/.test(line)) continue
      entries.push({ severity: 'warning', file: currentFile(), line: null, message: line.trim() })
      continue
    }

    trackParens(line)
  }

  return dedupe(entries)
}

/** Parses a BibTeX or Biber .blg file. */
export function parseBibLog(blg: string, buildDir?: string): LogEntry[] {
  const entries: LogEntry[] = []
  const lines = blg.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Biber: "[123] Utils.pm:411> WARN - message"
    let m = /^\[\d+\] [^>]*> (WARN|ERROR) - (.*)$/.exec(line)
    if (m) {
      entries.push({ severity: m[1] === 'ERROR' ? 'error' : 'warning', file: null, line: null, message: `Biber: ${m[2].trim()}` })
      continue
    }
    m = /^Warning--(.*)$/.exec(line)
    if (m) {
      let message = m[1].trim()
      let file: string | null = null
      let lineNo: number | null = null
      const loc = /^--line (\d+) of file (.+)$/.exec(lines[i + 1] ?? '')
      if (loc) {
        lineNo = Number(loc[1])
        file = toProjectPath(loc[2], buildDir)
        i++
      }
      if (file?.endsWith('.aux')) { file = null; lineNo = null }
      message = message.replace(/^I didn't find a database entry for "(.*)"$/, 'Citation "$1" was not found in any .bib file')
      entries.push({ severity: 'warning', file, line: lineNo, message: `BibTeX: ${message}` })
      continue
    }
    m = /^(.*?)---line (\d+) of file (.+)$/.exec(line)
    if (m) {
      let file = toProjectPath(m[3], buildDir)
      let lineNo: number | null = Number(m[2])
      if (file?.endsWith('.aux')) { file = null; lineNo = null }
      const message = m[1].trim() || (lines[i - 1] ?? '').trim()
      if (message) entries.push({ severity: 'error', file, line: lineNo, message: `BibTeX: ${message}` })
      continue
    }
    if (/^I couldn't open (database|style) file /.test(line)) {
      entries.push({ severity: 'error', file: null, line: null, message: `BibTeX: ${line.trim()}` })
      if (/---line \d+ of file/.test(lines[i + 1] ?? '')) i++
    }
  }
  return dedupe(entries)
}

function dedupe(entries: LogEntry[]): LogEntry[] {
  const seen = new Set<string>()
  return entries.filter((e) => {
    const key = `${e.severity}|${e.file}|${e.line}|${e.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
