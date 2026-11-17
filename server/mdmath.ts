/**
 * Finds math that a Markdown file leaves as plain text, such as `Theta_length`, `x^2` or `\alpha`
 * outside `$...$`, so an agent that wrote it is told at once (see server/markdown-rules.md). The
 * Markdown preview typesets only what is inside dollar signs; everything else shows as typed.
 */

const GREEK = 'alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|varphi|chi|psi|omega'

const SUSPECTS: { re: RegExp }[] = [
  // \alpha, \frac{a}{b}, \sum ... in the text.
  { re: /\\[A-Za-z]+(?:\{[^}\s]*\})*/g },
  // Theta_length, omega^2, sigma_{xy}: a Greek letter's name with a sub- or superscript.
  { re: new RegExp(`(?<![\\w\\\\])(?:${GREEK})[_^](?:\\{[^}\\s]*\\}|[A-Za-z0-9]+)`, 'gi') },
  // x_1, v_max, T_0, x^2, e^{-t}: one letter with a sub- or superscript.
  { re: /(?<![\w\\/.:-])[A-Za-z][_^](?:\{[^}\s]*\}|[A-Za-z0-9]+)(?![\w/]|\.\w)/g },
  // 10^3, 2^{-1}.
  { re: /(?<![\w.])\d+(?:\.\d+)?\^(?:\{[^}\s]*\}|-?\d+)/g },
]

/** One line with its code, math, links and web addresses taken out: what is left shows as plain text. */
function plainText(line: string): string {
  return line
    .replace(/`[^`]*`/g, ' ')
    .replace(/\\\$/g, ' ')
    .replace(/\$\$.*?\$\$/g, ' ')
    .replace(/\$(?:[^$\\]|\\.)+?\$/g, ' ')
    .replace(/\\\(.*?\\\)|\\\[.*?\\\]/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ')
    .replace(/<[^>\s]+>/g, ' ')
    .replace(/(?:https?|mailto|file):\S+/gi, ' ')
}

/**
 * Lines of a Markdown text with math outside dollar signs, as short notes ("line 12: Theta_length").
 * Lines that are also in `before` (the file before an edit) are skipped, so an agent hears only
 * about what it wrote itself.
 */
export function markdownMathIssues(source: string, before = ''): string[] {
  const old = new Set(before.split('\n'))
  const notes: string[] = []
  const lines = source.split('\n')
  let fence: string | null = null
  let display = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const f = /^\s*(```+|~~~+)/.exec(line)
    if (f) {
      if (!fence) fence = f[1]
      else if (line.trim().startsWith(fence)) fence = null
      continue
    }
    if (fence) continue
    // A display block whose $$ stand on lines of their own.
    if (/^\s*\$\$\s*$/.test(line) || (!display && /^\s*\$\$/.test(line) && !/\$\$.*\$\$/.test(line))) {
      display = !display
      continue
    }
    if (display) {
      if (/\$\$\s*$/.test(line)) display = false
      continue
    }
    if (old.has(line)) continue
    const text = plainText(line)
    const found = new Set<string>()
    for (const { re } of SUSPECTS) {
      for (const m of text.matchAll(re)) if (![...found].some((f) => f.includes(m[0]))) found.add(m[0])
    }
    if (found.size) notes.push(`line ${i + 1}: ${[...found].slice(0, 4).map((s) => `"${s}"`).join(', ')}`)
  }
  return notes
}

/** The note an edit of a Markdown file ends with, or '' when its math is all in dollar signs. */
export function markdownMathNote(file: string, source: string, before = ''): string {
  if (!/\.(md|markdown)$/i.test(file)) return ''
  const issues = markdownMathIssues(source, before)
  if (!issues.length) return ''
  const shown = issues.slice(0, 8).join('\n')
  const more = issues.length > 8 ? `\n[${issues.length - 8} more lines]` : ''
  return `\nMath outside $...$ in ${file}; it shows as plain text in the preview. Put it in dollar signs (for example $\\Theta_{\\text{length}}$, $x^2$), or in backticks if it is code:\n${shown}${more}`
}
