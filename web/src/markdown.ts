import katex from 'katex'
import 'katex/dist/katex.min.css'
import { copyButton, h } from './dom.ts'

// A small, safe Markdown renderer for chat replies and the editor's Markdown preview. It builds DOM nodes directly and never
// parses HTML, so nothing the model or a project file says can inject markup into the page. Math ($...$, $$...$$,
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


/** Rendering a whole Markdown file (the editor's preview) rather than a chat reply. */
export type DocumentOptions = {
  /** The project path of the file being shown; relative links and images resolve against its folder. */
  path: string
  /** The address an image in the project is loaded from. */
  imageUrl: (file: string) => string
}

type Ctx = { links?: FileLinks; doc?: DocumentOptions; slugs: Map<string, number> }

/** `target` (a link or image address in the file at `from`) as a project path, or null if it leaves the project. */
function resolveRelative(from: string, target: string): string | null {
  let t = target
  try {
    t = decodeURIComponent(t)
  } catch {}
  const parts = t.startsWith('/') ? [] : from.split('/').slice(0, -1)
  for (const seg of t.replace(/^\/+/, '').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(seg)
  }
  return parts.length ? parts.join('/') : null
}

function slugOf(text: string, ctx: Ctx): string {
  const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section'
  const n = ctx.slugs.get(base) ?? 0
  ctx.slugs.set(base, n + 1)
  return n ? `${base}-${n}` : base
}

/** A `[label](target)` link. Only web and mail links leave the app; project paths open in the editor. */
function link(label: string, target: string, ctx: Ctx): HTMLElement {
  const content = h('span')
  inline(label, content, { ...ctx, links: undefined })
  if (/^(https?:|mailto:)/i.test(target)) return h('a', { href: target, target: '_blank', rel: 'noopener noreferrer', title: target }, ...content.childNodes)
  if (target.startsWith('#') && ctx.doc) {
    const id = `md-${target.slice(1).toLowerCase()}`
    return h('a', {
      href: '#', title: `Go to ${target}`,
      onclick: (e: Event) => {
        e.preventDefault()
        const root = (e.currentTarget as HTMLElement).closest('.md-doc')
        root?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      },
    }, ...content.childNodes)
  }
  if (ctx.doc && ctx.links && !/^[a-z][\w+.-]*:/i.test(target)) {
    const [pathPart, hash = ''] = target.split('#')
    const file = pathPart ? resolveRelative(ctx.doc.path, pathPart.split('?')[0]) : null
    const line = /^L(\d+)/.exec(hash)?.[1]
    if (file && ctx.links.files().includes(file)) return fileLink(h('span', null, ...content.childNodes), file, line ? Number(line) : undefined, ctx.links)
    return h('span', { class: 'md-broken-link', title: `${target} is not in the project` }, ...content.childNodes)
  }
  return h('span', null, ...content.childNodes)
}

function image(alt: string, target: string, ctx: Ctx): HTMLElement {
  let src: string | null = null
  if (/^https?:/i.test(target)) src = target
  else if (ctx.doc && !/^[a-z][\w+.-]*:/i.test(target)) {
    const file = resolveRelative(ctx.doc.path, target.split(/[?#]/)[0])
    if (file) src = ctx.doc.imageUrl(file)
  }
  if (!src) return h('span', { class: 'md-broken-link' }, alt || target)
  return h('img', { class: 'md-image', src, alt, title: alt || null, loading: 'lazy' })
}

function inline(text: string, parent: HTMLElement, ctx: Ctx): void {
  // Math comes first so a `*` or `_` inside a formula is never read as emphasis. A single `$` only
  // opens math when followed by a non-space and only closes before a non-digit, so prices stay text.
  const pattern = new RegExp([
    /(`[^`\n]+`)/, // 1 code
    /(\\\$)/, // 2 escaped dollar
    /(\$\$[^\n]+?\$\$)/, // 3 display math
    /(\\\[.+?\\\])/, // 4
    /(\\\(.+?\\\))/, // 5 inline math
    /(\$(?![\s$])(?:[^$\n\\]|\\.)+?(?<!\s)\$(?!\d))/, // 6
    /(\\[\\`*_{}[\]()#+\-.!|~>])/, // 7 escaped punctuation
    /(!\[[^\]\n]*\]\([^)\s]+(?:\s+"[^"\n]*")?\))/, // 8 image
    /(\[[^\]\n]+\]\([^)\s]+(?:\s+"[^"\n]*")?\))/, // 9 link
    /(<https?:\/\/[^\s<>]+>|https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_])/, // 10 bare web address
    /(\*\*[^*\n]+?\*\*|(?<![\w])__[^_\n]+?__(?![\w]))/, // 11 strong
    /(\*[^*\s][^*\n]*?\*|(?<![\w])_[^_\s][^_\n]*?_(?![\w]))/, // 12 emphasis
    /(~~[^~\n]+~~)/, // 13 strikethrough
  ].map((r) => r.source).join('|'), 'g')
  let last = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text))) {
    if (m.index > last) plain(text.slice(last, m.index), parent, ctx.links)
    const token = m[0]
    if (m[1]) {
      const code = h('code', null, token.slice(1, -1))
      const ref = fileRef(token.slice(1, -1), ctx.links)
      const sym = ref ? null : symbolRef(token.slice(1, -1), ctx.links)
      if (ref) parent.append(fileLink(code, ref.file, ref.line, ctx.links!))
      else if (sym) parent.append(fileLink(code, sym.file, sym.line, ctx.links!, `${sym.what} in ${sym.file}:${sym.line}`))
      else parent.append(code)
    }
    else if (m[2]) parent.append('$')
    else if (m[3] || m[4]) parent.append(math(token.slice(2, -2), true))
    else if (m[5]) parent.append(math(token.slice(2, -2), false))
    else if (m[6]) parent.append(math(token.slice(1, -1), false))
    else if (m[7]) parent.append(token.slice(1))
    else if (m[8] || m[9]) {
      const parts = /^!?\[([^\]]*)\]\(([^)\s]+)/.exec(token)!
      parent.append(m[8] ? image(parts[1], parts[2], ctx) : link(parts[1], parts[2], ctx))
    }
    else if (m[10]) {
      const url = token.replace(/^<|>$/g, '')
      parent.append(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url))
    }
    else if (m[11] || m[12] || m[13]) {
      const strip = m[12] ? 1 : 2
      const el = h(m[11] ? 'strong' : m[12] ? 'em' : 'del')
      inline(token.slice(strip, -strip), el, ctx)
      parent.append(el)
    }
    last = m.index + token.length
  }
  if (last < text.length) plain(text.slice(last), parent, ctx.links)
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const FENCE = /^\s*(```+|~~~+)/
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return trimmed.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

/** Is line `i` the start of something other than paragraph text? Such lines end a paragraph. */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]
  return FENCE.test(line) || RULE.test(line) || /^\s{0,3}#{1,6}\s/.test(line) || /^\s{0,3}>/.test(line) || LIST_ITEM.test(line)
    || (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]) && lines[i + 1].includes('-'))
}

function renderBlocks(lines: string[], offset: number, out: HTMLElement | DocumentFragment, ctx: Ctx): void {
  let paragraph: string[] = []
  let paragraphLine = 0
  // Open lists, outermost first, each with the indent of its items.
  let lists: { indent: number; el: HTMLElement; item: HTMLElement | null }[] = []

  const at = <T extends HTMLElement>(el: T, i: number): T => {
    el.dataset.line = String(offset + i + 1)
    return el
  }
  const flushParagraph = (): void => {
    if (!paragraph.length) return
    const p = at(h('p'), paragraphLine)
    paragraph.forEach((line, j) => {
      if (j) {
        // A line break only where the writer asked for one (two trailing spaces or a backslash) in a
        // document; in a chat reply every new line is kept, as the model means it.
        if (!ctx.doc || /( {2,}|\\)$/.test(paragraph[j - 1])) p.append(h('br'))
        else p.append(' ')
      }
      inline(ctx.doc ? line.replace(/( {2,}|\\)$/, '') : line, p, ctx)
    })
    out.append(p)
    paragraph = []
  }
  const closeLists = (): void => {
    lists = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fence = FENCE.exec(line)
    if (fence) {
      flushParagraph()
      closeLists()
      const start = i
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++])
      const source = code.join('\n')
      // The copy button sits in the block's top-right corner, as an icon: the chat is narrow.
      out.append(at(h('div', { class: 'copy-box block md-code-box' }, h('pre', { class: 'md-code' }, h('code', null, source)), copyButton(() => source, { label: '', what: 'the code' })), start))
      continue
    }
    const block = blockMath(lines, i)
    if (block) {
      flushParagraph()
      closeLists()
      out.append(at(math(block.tex, true), i))
      i = block.end
      continue
    }
    if (RULE.test(line)) {
      flushParagraph()
      closeLists()
      out.append(at(h('hr'), i))
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item) {
      flushParagraph()
      const indent = item[1].replace(/\t/g, '    ').length
      const ordered = /\d/.test(item[2])
      const tag = ordered ? 'ol' : 'ul'
      while (lists.length && lists[lists.length - 1].indent > indent) lists.pop()
      let top = lists[lists.length - 1]
      if (top && top.indent === indent && top.el.tagName.toLowerCase() !== tag) {
        lists.pop()
        top = lists[lists.length - 1]
      }
      if (!top || top.indent < indent) {
        const el = at(h(tag), i)
        const start = ordered ? parseInt(item[2], 10) : 1
        if (ordered && start !== 1) el.setAttribute('start', String(start))
        if (top?.item) top.item.append(el)
        else out.append(el)
        top = { indent, el, item: null }
        lists.push(top)
      }
      const li = at(h('li'), i)
      let text = item[3]
      const task = /^\[([ xX])\]\s+(.*)$/.exec(text)
      if (task) {
        li.classList.add('md-task')
        li.append(h('input', { type: 'checkbox', checked: task[1] !== ' ', disabled: true, tabindex: -1 }))
        text = task[2]
      }
      inline(text, li, ctx)
      top.el.append(li)
      top.item = li
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line)
    if (heading) {
      flushParagraph()
      closeLists()
      if (ctx.doc) {
        const el = at(h(`h${heading[1].length}` as 'h1', { id: `md-${slugOf(heading[2], ctx)}` }), i)
        inline(heading[2], el, ctx)
        out.append(el)
      } else {
        const p = at(h('p', { class: 'md-heading' }), i)
        inline(heading[2], p, ctx)
        out.append(p)
      }
      continue
    }
    if (/^\s{0,3}>/.test(line)) {
      flushParagraph()
      closeLists()
      const start = i
      const inner: string[] = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) inner.push(lines[i++].replace(/^\s{0,3}> ?/, ''))
      i--
      const quote = at(h('blockquote'), start)
      renderBlocks(inner, offset + start, quote, ctx)
      out.append(quote)
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flushParagraph()
      closeLists()
      const head = tableCells(line)
      const align = tableCells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null))
      const cell = (tag: 'th' | 'td', text: string, col: number): HTMLElement => {
        const el = h(tag, { style: align[col] ? { textAlign: align[col] } : null })
        inline(text, el, ctx)
        return el
      }
      const tbody = h('tbody')
      const table = h('table', null, h('thead', null, h('tr', null, head.map((c, col) => cell('th', c, col)))), tbody)
      const start = i
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = tableCells(lines[i])
        tbody.append(at(h('tr', null, head.map((_, col) => cell('td', cells[col] ?? '', col))), i))
        i++
      }
      i--
      out.append(at(h('div', { class: 'md-table' }, table), start))
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      // A blank line inside a list keeps it open when the list goes on after it.
      let next = i + 1
      while (next < lines.length && !lines[next].trim()) next++
      const goesOn = next < lines.length && lists.length && (LIST_ITEM.test(lines[next]) || /^\s{2,}\S/.test(lines[next]))
      if (!goesOn) closeLists()
      continue
    }
    // Indented text under a list item belongs to that item.
    const open = lists[lists.length - 1]
    if (open?.item && /^\s+\S/.test(line) && !paragraph.length) {
      open.item.append(ctx.doc ? ' ' : h('br'))
      inline(line.trim(), open.item, ctx)
      continue
    }
    if (paragraph.length && startsBlock(lines, i)) flushParagraph()
    closeLists()
    if (!paragraph.length) paragraphLine = i
    paragraph.push(line)
  }
  flushParagraph()
}

/**
 * Markdown as DOM nodes. Without `doc` it renders a chat reply: every line break kept, headings as bold
 * lines. With `doc` it renders a Markdown file of the project, with real headings and project images.
 * Every top-level block carries `data-line`, the source line it starts on.
 */
export function renderMarkdown(source: string, links?: FileLinks, doc?: DocumentOptions): DocumentFragment {
  const out = document.createDocumentFragment()
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const ctx: Ctx = { links, doc, slugs: new Map() }
  let offset = 0
  // Front matter (`---` ... `---` at the very top) is metadata, not text: show it as a quiet block.
  if (doc && lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, j) => j > 0 && /^(---|\.\.\.)\s*$/.test(l))
    if (end > 0) {
      const meta = h('pre', { class: 'md-frontmatter', dataset: { line: '1' } }, lines.slice(1, end).join('\n'))
      out.append(meta)
      offset = end + 1
    }
  }
  renderBlocks(lines.slice(offset), offset, out, ctx)
  return out
}

/** The headings of a Markdown file, for the outline. Headings inside code blocks do not count. */
export function markdownOutline(source: string): { level: number; title: string; line: number }[] {
  const items: { level: number; title: string; line: number }[] = []
  const lines = source.split('\n')
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i])
    if (f) {
      if (!fence) fence = f[1]
      else if (lines[i].trim().startsWith(fence)) fence = null
      continue
    }
    if (fence) continue
    const m = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(lines[i])
    if (m) items.push({ level: m[1].length, title: m[2].replace(/[*_`~]|\[([^\]]*)\]\([^)]*\)/g, '$1').trim() || '(untitled)', line: i + 1 })
  }
  const min = Math.min(...items.map((x) => x.level))
  return items.map((x) => ({ ...x, level: x.level - min }))
}
