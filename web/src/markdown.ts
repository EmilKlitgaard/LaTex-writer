import { h } from './dom.ts'

// A small, safe Markdown renderer for chat replies. It builds DOM nodes directly and never
// parses HTML, so nothing the model writes can inject markup into the page.

function inline(text: string, parent: HTMLElement): void {
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index))
    const token = m[0]
    if (m[1]) parent.append(h('code', null, token.slice(1, -1)))
    else if (m[2]) parent.append(h('strong', null, token.slice(2, -2)))
    else if (m[3]) parent.append(h('em', null, token.slice(1, -1)))
    else {
      const parts = /^\[([^\]]+)\]\((.+)\)$/.exec(token)!
      parent.append(h('a', { href: parts[2], target: '_blank', rel: 'noopener noreferrer' }, parts[1]))
    }
    last = m.index + token.length
  }
  if (last < text.length) parent.append(text.slice(last))
}

export function renderMarkdown(source: string): DocumentFragment {
  const out = document.createDocumentFragment()
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let paragraph: string[] = []
  let list: HTMLElement | null = null

  const flushParagraph = (): void => {
    if (!paragraph.length) return
    const p = h('p')
    paragraph.forEach((line, i) => {
      if (i) p.append(h('br'))
      inline(line, p)
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
      inline((bullet ?? numbered)![1], li)
      list.append(li)
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      closeList()
      const p = h('p', { class: 'md-heading' })
      inline(heading[1], p)
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
