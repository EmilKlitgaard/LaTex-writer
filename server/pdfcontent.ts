// Takes the text out of a page's content stream that lies outside a horizontal strip.
//
// When the exporter cuts a page in two, each half is the whole page drawn through a window. What
// falls outside the window is not visible, but its text would still be in the file: a search in
// the second part would find the first half of the page, and copying could pick it up. So for each
// strip the page's drawing instructions are copied with every text-showing operator outside the
// strip left out. Everything else (positioning, fonts, colours, lines, images) is kept as it was,
// so what is shown does not move by a hair.
//
// This follows PDF's text state the way a viewer does: the current transformation (cm, q, Q), the
// text and line matrices (BT, Tm, Td, TD, T*), the leading (TL, TD) and the font size and rise
// (Tf, Ts). Text inside form XObjects (an included PDF figure) is left alone.

type Matrix = [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
/** a × b, in PDF's row-vector convention. */
const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
]

const WHITE = new Set([0, 9, 10, 12, 13, 32])
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37])
const SHOW = new Set(['Tj', 'TJ', "'", '"'])

/**
 * Returns the content with the text that cannot be seen between yMin and yMax (page coordinates,
 * counting up from the bottom) removed. Glyphs are taken to reach a little below the baseline and
 * most of a font size above it; the cut always sits in blank space, so a line is either in or out.
 */
export function keepTextBetween(content: Uint8Array, yMin: number, yMax: number): Uint8Array {
  const s = Buffer.from(content).toString('latin1')
  const n = s.length
  const out: string[] = []
  let ctm: Matrix = [...IDENTITY]
  let tm: Matrix = [...IDENTITY]
  let tlm: Matrix = [...IDENTITY]
  let fontSize = 0, leading = 0, rise = 0
  const stack: { ctm: Matrix; fontSize: number; leading: number; rise: number }[] = []
  let operands: string[] = []
  let opStart = 0 // where the operands of the next operator begin
  let i = 0

  const skipWhite = (): void => {
    while (i < n) {
      const c = s.charCodeAt(i)
      if (WHITE.has(c)) i++
      else if (c === 37) { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++ } // a comment
      else break
    }
  }
  const num = (k: number): number => Number(operands[operands.length - k]) || 0
  const visible = (): boolean => {
    const m = mul(tm, ctm)
    const y = m[3] * rise + m[5]
    const h = Math.abs(fontSize * m[3]) || Math.abs(fontSize * m[1]) || 10
    return y + h * 0.9 >= yMin && y - h * 0.3 <= yMax
  }
  const nextLine = (tx: number, ty: number): void => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm)
    tm = [...tlm]
  }

  while (true) {
    skipWhite()
    if (i >= n) break
    if (operands.length === 0) opStart = i
    const c = s.charCodeAt(i)
    let token: string
    if (c === 40) { // (literal string), with nesting and escapes
      let depth = 0
      const start = i
      for (; i < n; i++) {
        const ch = s[i]
        if (ch === '\\') { i++; continue }
        if (ch === '(') depth++
        else if (ch === ')' && --depth === 0) { i++; break }
      }
      token = s.slice(start, i)
    } else if (c === 60 && s[i + 1] === '<') { token = '<<'; i += 2 }
    else if (c === 62 && s[i + 1] === '>') { token = '>>'; i += 2 }
    else if (c === 60) { // <hex string>
      const end = s.indexOf('>', i)
      token = s.slice(i, end < 0 ? n : end + 1)
      i = end < 0 ? n : end + 1
    } else if (c === 91 || c === 93 || c === 123 || c === 125) { token = s[i]; i++ }
    else if (c === 47) { // /Name
      const start = i++
      while (i < n && !WHITE.has(s.charCodeAt(i)) && !DELIM.has(s.charCodeAt(i))) i++
      token = s.slice(start, i)
    } else {
      const start = i
      while (i < n && !WHITE.has(s.charCodeAt(i)) && !DELIM.has(s.charCodeAt(i))) i++
      if (i === start) i++ // a stray delimiter: step over it
      token = s.slice(start, i)
    }

    const first = token.charCodeAt(0)
    const isOperand = token === '<<' || token === '>>' || token === '[' || token === ']' || token === '{' || token === '}'
      || first === 40 || first === 60 || first === 47 || /^[+\-.\d]/.test(token) || token === 'true' || token === 'false' || token === 'null'
    if (isOperand) {
      operands.push(token)
      continue
    }

    // An operator; its operands are everything since the last one.
    const op = token
    if (op === 'BI') {
      // An inline image: its data is binary and ends at a whitespace-delimited EI. Kept as is.
      const id = s.indexOf('ID', i)
      let j = id < 0 ? n : id + 3
      while (j < n) {
        const e = s.indexOf('EI', j)
        if (e < 0) { j = n; break }
        if (WHITE.has(s.charCodeAt(e - 1)) && (e + 2 >= n || WHITE.has(s.charCodeAt(e + 2)))) { j = e + 2; break }
        j = e + 2
      }
      i = j
      out.push(s.slice(opStart, i))
      operands = []
      continue
    }
    let keep = true
    switch (op) {
      case 'q': stack.push({ ctm: [...ctm], fontSize, leading, rise }); break
      case 'Q': { const g = stack.pop(); if (g) ({ ctm, fontSize, leading, rise } = g); break }
      case 'cm': ctm = mul([num(6), num(5), num(4), num(3), num(2), num(1)], ctm); break
      case 'BT': tm = [...IDENTITY]; tlm = [...IDENTITY]; break
      case 'Tm': tlm = [num(6), num(5), num(4), num(3), num(2), num(1)]; tm = [...tlm]; break
      case 'Td': nextLine(num(2), num(1)); break
      case 'TD': leading = -num(1); nextLine(num(2), num(1)); break
      case 'T*': nextLine(0, -leading); break
      case 'TL': leading = num(1); break
      case 'Tf': fontSize = num(1); break
      case 'Ts': rise = num(1); break
      case "'": nextLine(0, -leading); keep = visible(); break
      case '"': nextLine(0, -leading); keep = visible(); break
      default: if (SHOW.has(op)) keep = visible()
    }
    if (keep) out.push(s.slice(opStart, i))
    else if (op === "'") out.push('T*') // the text goes, but the line still moves down
    else if (op === '"') out.push(`${operands[0]} Tw ${operands[1]} Tc T*`) // and the spacing it set stays
    operands = []
  }
  return Buffer.from(out.join('\n'), 'latin1')
}
