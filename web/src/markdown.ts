import katex from 'katex'
import 'katex/dist/katex.min.css'
import { h } from './dom.ts'

// A small, safe Markdown renderer for chat replies. It builds DOM nodes directly and never
// parses HTML, so nothing the model writes can inject markup into the page. Math ($...$, $$...$$,
// \(...\), \[...\]) is typeset with KaTeX, which never runs scripts or links (trust is off).

function math(tex: string, display: boolean): HTMLElement {
  const el = h(display ? 'div' : 'span', { class: display ? 'md-math md-math-block' : 'md-math' })
  try {
    katex.render(tex, el, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' })
  } catch {
    el.textContent = tex
  }
  return el
}

/** A display formula that starts on line `i`: `$$ ... $$` or `\[ ... \]`, on one line or several. */
function blockMath(lines: string[], i: number): { tex: string; end: number } | null {
  const open = /^\s*(\$\$|\\\[)/.exec(lines[i])
  if (!open) return null
  const close = open[1] === '$$' ? '$$' : '\\]'
  const parts: string[] = []
  for (let j = i; j < lines.length; j++) {
    const text = j === i ? lines[i].slice(open[0].length) : lines[j]
    const at = text.indexOf(close)
    if (at < 0) {
      parts.push(text)
      continue
    }
    if (text.slice(at + close.length).trim()) return null
    parts.push(text.slice(0, at))
    const tex = parts.join('\n').trim()
    return tex ? { tex, end: j } : null
  }
  return null
}

/** Lets the renderer turn mentions of project files into links that open them in the editor. */
export type FileLinks = {
  files: () => string[]
  open: (file: string, line?: number) => void
  /** Where a \label or citation key is defined, if the project defines it. */
  symbol?: (name: string) => { file: string; line: number; what: string } | null
}

/** The project file a mention like `main.tex`, `./sections/intro.tex` or `intro.tex` refers to, if exactly one does. */
function resolveFile(name: string, files: string[]): string | null {
  const wanted = name.replace(/^\.\//, '')
  if (files.includes(wanted)) return wanted
  const tail = files.filter((f) => f.endsWith(`/${wanted}`))
  return tail.length === 1 ? tail[0] : null
}

function fileLink(label: Node | string, file: string, line: number | undefined, links: FileLinks, title?: string): HTMLElement {
  return h('a', {
    class: 'md-file', href: '#', title: title ?? (line ? `Open ${file} at line ${line}` : `Open ${file}`),
    onclick: (e: Event) => {
      e.preventDefault()
      links.open(file, line)
    },
  }, label)
}

const FILE_REF = /^([\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]{1,5})(?::(\d+)(?:[-–]\d+)?)?$/
const FILE_REF_IN_TEXT = /(?<![\w./-])[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]{1,5}(?::\d+(?:[-–]\d+)?)?(?![\w])/g

// A label or citation key in code style: `eq:E`, `\\ref{eq:E}`, `\\cite{knuth1984}`.
const SYMBOL_REF = /^(?:\\[A-Za-z]*(?:ref|cite[A-Za-z]*|label)\*?(?:\[[^\]]*\])*\{([^{},\s]+)\}|([A-Za-z][\w.:-]*))$/

function symbolRef(text: string, links?: FileLinks): { file: string; line: number; what: string } | null {
  const m = links?.symbol ? SYMBOL_REF.exec(text) : null
  return m ? links!.symbol!(m[1] ?? m[2]) : null
}

/** A reference to a project file, as `name` or `name:line`. */
function fileRef(text: string, links?: FileLinks): { file: string; line?: number } | null {
  const m = links ? FILE_REF.exec(text) : null
  const file = m && resolveFile(m[1], links!.files())
  return file ? { file, line: m![2] ? Number(m![2]) : undefined } : null
}

/** Plain text, with mentions of project files turned into links. */
function plain(text: string, parent: HTMLElement, links?: FileLinks): void {
  if (!links || !text.includes('.')) return void parent.append(text)
  let last = 0
  for (const m of text.matchAll(FILE_REF_IN_TEXT)) {
    const ref = fileRef(m[0], links)
    if (!ref) continue
    if (m.index > last) parent.append(text.slice(last, m.index))
    parent.append(fileLink(m[0], ref.file, ref.line, links))
    last = m.index + m[0].length
  }
  if (last < text.length) parent.append(text.slice(last))
}

function inline(text: string, parent: HTMLElement, links?: FileLinks): void {
  // Math comes first so a `*` or `_` inside a formula is never read as emphasis. A single `$` only
  // opens math when followed by a non-space and only closes before a non-digit, so prices stay text.
  const pattern = /(`[^`\n]+`)|(\\\$)|(\$\$[^\n]+?\$\$)|(\\\[.+?\\\])|(\\\(.+?\\\))|(\$(?![\s$])(?:[^$\n\\]|\\.)+?(?<!\s)\$(?!\d))|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text))) {
    if (m.index > last) plain(text.slice(last, m.index), parent, links)
    const token = m[0]
    if (m[1]) {
      const code = h('code', null, token.slice(1, -1))
      const ref = fileRef(token.slice(1, -1), links)
      const sym = ref ? null : symbolRef(token.slice(1, -1), links)
      if (ref) parent.append(fileLink(code, ref.file, ref.line, links!))
      else if (sym) parent.append(fileLink(code, sym.file, sym.line, links!, `${sym.what} in ${sym.file}:${sym.line}`))
      else parent.append(code)
    }
    else if (m[2]) parent.append('$')
    else if (m[3] || m[4]) parent.append(math(token.slice(2, -2), true))
    else if (m[5]) parent.append(math(token.slice(2, -2), false))
    else if (m[6]) parent.append(math(token.slice(1, -1), false))
    else if (m[7]) parent.append(h('strong', null, token.slice(2, -2)))
    else if (m[8]) parent.append(h('em', null, token.slice(1, -1)))
    else {
      const parts = /^\[([^\]]+)\]\((.+)\)$/.exec(token)!
      parent.append(h('a', { href: parts[2], target: '_blank', rel: 'noopener noreferrer' }, parts[1]))
    }
    last = m.index + token.length
  }
  if (last < text.length) plain(text.slice(last), parent, links)
}

export function renderMarkdown(source: string, links?: FileLinks): DocumentFragment {
  const out = document.createDocumentFragment()
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let paragraph: string[] = []
  let list: HTMLElement | null = null

  const flushParagraph = (): void => {
    if (!paragraph.length) return
    const p = h('p')
    paragraph.forEach((line, i) => {
      if (i) p.append(h('br'))
      inline(line, p, links)
    })
    out.append(p)
    paragraph = []
  }
  const closeList = (): void => {
    list = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^\s*```/.test(line)
    if (fence) {
      flushParagraph()
      closeList()
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
      out.append(h('pre', { class: 'md-code' }, h('code', null, code.join('\n'))))
      continue
    }
    const block = blockMath(lines, i)
    if (block) {
      flushParagraph()
      closeList()
      out.append(math(block.tex, true))
      i = block.end
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flushParagraph()
      const tag = bullet ? 'ul' : 'ol'
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = h(tag)
        out.append(list)
      }
      const li = h('li')
      inline((bullet ?? numbered)![1], li, links)
      list.append(li)
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      closeList()
      const p = h('p', { class: 'md-heading' })
      inline(heading[1], p, links)
      out.append(p)
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      closeList()
      continue
    }
    closeList()
    paragraph.push(line)
  }
  flushParagraph()
  return out
}
