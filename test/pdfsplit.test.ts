import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { keepTextBetween } from '../server/pdfcontent.ts'
import { buildParts, openForSplit, partFileNames, validateParts } from '../server/pdfsplit.ts'
import { cleanCuts, cutBefore, findFurniture, inkRuns, normalizeCut, planParts, snapCut, type PageInk } from '../web/src/splitplan.ts'

// A page like LaTeX makes them: a running header, lines of body text 12pt apart, a page number.
function page(lines: number, opts: { header?: boolean; footer?: boolean; firstTop?: number } = {}): PageInk {
  const runs = []
  if (opts.header ?? true) runs.push({ top: 40, bottom: 48 })
  const start = opts.firstTop ?? 90
  for (let i = 0; i < lines; i++) runs.push({ top: start + i * 12, bottom: start + i * 12 + 9 })
  if (opts.footer ?? true) runs.push({ top: 790, bottom: 797 })
  return { width: 595, height: 842, runs }
}

test('ink rows become runs, with hairline gaps bridged', () => {
  const rows = [0, 1, 1, 0, 1, 1, 0, 0, 0, 0, 1, 0]
  // At 2 px per point a one-pixel gap is half a point: bridged. The four-pixel gap is not.
  assert.deepEqual(inkRuns(rows, 2), [{ top: 0.5, bottom: 3 }, { top: 5, bottom: 5.5 }])
})

test('running header and page number are recognised from several pages', () => {
  const pages = [page(10, { header: false, footer: false, firstTop: 300 }), page(55), page(55), page(20)]
  const f = findFurniture(pages)
  assert.ok(f.headerBottom !== null && Math.abs(f.headerBottom - 48) < 0.01)
  assert.ok(f.footerTop !== null && Math.abs(f.footerTop - 790) < 0.01)
  assert.equal(f.bodyTop, 90)
})

test('a header with a rule under it counts as one header', () => {
  const ruled = (): PageInk => {
    const p = page(40)
    p.runs.splice(1, 0, { top: 51, bottom: 51.5 })
    return p
  }
  const pages = [ruled(), ruled(), ruled()]
  const f = findFurniture(pages)
  assert.equal(f.headerBottom, 51.5)
  assert.equal(f.bodyTop, 90)
  const parts = planParts([{ page: 2, y: cutBefore(pages[1], f, 210) }], pages, f)
  const [header, body] = parts[1][0].bands!
  assert.equal(header.to, (51.5 + 90) / 2) // header and rule stay on the moved page
  assert.equal(body.dy, 90 - 210)
})

test('a single page has no furniture to compare, and that is fine', () => {
  const f = findFurniture([page(20)])
  assert.equal(f.footerTop, null)
  assert.equal(f.headerBottom, null)
})

test('cuts snap into the space between lines, never through one', () => {
  const pages = [page(30), page(30), page(30)]
  const f = findFurniture(pages)
  const y = snapCut(pages[1], f, 95)!
  // Lines run 90–99 and 102–111: the cut goes into the gap between them, or above the first.
  assert.ok(y === 0 || (y >= 99 && y <= 102), `got ${y}`)
  assert.equal(snapCut(pages[1], f, 100.4), 100.5)
  assert.equal(cutBefore(pages[1], f, 102), 100.5)
})

test('a cut above all body text is a page break; below all of it, the next page', () => {
  const pages = [page(30), page(30), page(30)]
  const f = findFurniture(pages)
  assert.deepEqual(normalizeCut({ page: 2, y: 60 }, pages, f), { page: 2, y: 0 })
  assert.deepEqual(normalizeCut({ page: 2, y: 600 }, pages, f), { page: 3, y: 0 })
  // The very start and the very end of the document would leave an empty part.
  assert.equal(normalizeCut({ page: 1, y: 10 }, pages, f), null)
  assert.equal(normalizeCut({ page: 3, y: 700 }, pages, f), null)
  assert.equal(cleanCuts([{ page: 2, y: 0 }, { page: 1, y: 830 }], pages, f).length, 1)
})

test('a page break split copies whole pages', () => {
  const pages = [page(30), page(30), page(30), page(30)]
  const f = findFurniture(pages)
  assert.deepEqual(planParts([{ page: 3, y: 0 }], pages, f), [[{ page: 1 }, { page: 2 }], [{ page: 3 }, { page: 4 }]])
})

test('a mid-page split keeps header and footer and moves the rest to the top', () => {
  const pages = [page(30), page(40), page(30)]
  const f = findFurniture(pages)
  // Between line 10 (top 198) and line 11 (top 210) of page 2.
  const cut = cutBefore(pages[1], f, 210)
  const parts = planParts([{ page: 2, y: cut }], pages, f)
  assert.equal(parts.length, 2)
  assert.deepEqual(parts[0][0], { page: 1 })
  const top = parts[0][1]
  assert.equal(top.page, 2)
  assert.deepEqual(top.bands?.[0], { from: 0, to: cut, dy: 0 })
  assert.equal(top.bands?.[1].dy, 0) // the page number stays put
  assert.ok(top.bands![1].from > 560 && top.bands![1].from < 790)

  const rest = parts[1][0]
  assert.equal(rest.page, 2)
  const [header, body, footer] = rest.bands!
  assert.equal(header.from, 0)
  assert.equal(header.dy, 0)
  assert.equal(body.from, 208.5) // from the cut, in the blank space just above the first moved line
  assert.equal(body.dy, 90 - 210) // its first line lands where body text starts on every page
  assert.equal(footer.dy, 0)
  assert.deepEqual(parts[1][1], { page: 3 })
})

test('two cuts on one page make a middle part of just that stretch', () => {
  const pages = [page(30), page(40), page(30)]
  const f = findFurniture(pages)
  const a = cutBefore(pages[1], f, 210), b = cutBefore(pages[1], f, 330)
  const parts = planParts([{ page: 2, y: b }, { page: 2, y: a }], pages, f)
  assert.equal(parts.length, 3)
  assert.equal(parts[1].length, 1)
  const middle = parts[1][0].bands!.find((x) => x.dy !== 0)!
  assert.equal(middle.from, 208.5)
  assert.equal(middle.to, b)
})

test('file names are cleaned, end in .pdf and never repeat', () => {
  assert.deepEqual(partFileNames(['Front: matter', '', 'front  matter.pdf'], 3, 'Thesis'), ['Front matter.pdf', 'Thesis - Part 2.pdf', 'front matter (2).pdf'])
})

test('the server checks the parts it is sent', () => {
  const size = () => ({ width: 595, height: 842 })
  assert.throws(() => validateParts([[{ page: 9 }]], 3, size), /does not exist/)
  assert.throws(() => validateParts([[{ page: 1, bands: [{ from: 10, to: 5, dy: 0 }] }]], 3, size), /Invalid/)
  assert.throws(() => validateParts([], 3, size), /Choose/)
  assert.deepEqual(validateParts([[{ page: 1 }], [{ page: 2, bands: [{ from: 0, to: 842.3, dy: -3 }] }]], 3, size), [[{ page: 1 }], [{ page: 2, bands: [{ from: 0, to: 842, dy: -3 }] }]])
})

test('parts are written as real PDFs with the right pages, sizes and text', async () => {
  const src = await PDFDocument.create()
  const font = await src.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 3; i++) {
    const p = src.addPage([595, 842])
    p.drawText(`Page ${i} top`, { x: 72, y: 760, size: 12, font })
    p.drawText(`Page ${i} bottom`, { x: 72, y: 300, size: 12, font })
  }
  src.setTitle('My thesis')
  const opened = await openForSplit(await src.save())
  assert.equal(opened.pageCount, 3)
  const parts = validateParts([
    [{ page: 1 }, { page: 2, bands: [{ from: 0, to: 400, dy: 0 }] }],
    [{ page: 2, bands: [{ from: 400, to: 842, dy: -300 }] }, { page: 3 }],
  ], opened.pageCount, opened.size)
  const files = await buildParts(opened.doc, parts)
  assert.equal(files.length, 2)
  const [a, b] = await Promise.all(files.map((f) => PDFDocument.load(f)))
  assert.equal(a.getPageCount(), 2)
  assert.equal(b.getPageCount(), 2)
  assert.equal(a.getTitle(), 'My thesis (part 1 of 2)')
  for (const p of [...a.getPages(), ...b.getPages()]) assert.deepEqual(p.getSize(), { width: 595, height: 842 })
})

test('text outside a strip is taken out of the page, everything else stays', () => {
  const content = [
    'q 1 0 0 1 72 0 cm',
    'BT /F1 10 Tf 12 TL 0 700 Td (Top line) Tj T* [(Second) -250 (line)] TJ',
    '0 -400 Td (Low \\(escaped\\) line) Tj',
    "(Next via quote) '",
    '1 2 (Next via dquote) "',
    'ET',
    '0 0 1 rg 0 500 100 1 re f',
    'BI /W 1 /H 1 /BPC 8 /CS /G ID \x01EI EI',
    'Q',
  ].join('\n')
  const kept = Buffer.from(keepTextBetween(Buffer.from(content, 'latin1'), 650, 800)).toString('latin1')
  assert.match(kept, /\(Top line\) Tj/)
  assert.match(kept, /\[\(Second\) -250 \(line\)\] TJ/)
  assert.doesNotMatch(kept, /Low|Next via/)
  assert.match(kept, /1 Tw 2 Tc T\*/) // the spacing a dropped " set still applies
  assert.match(kept, /0 500 100 1 re\s+f/) // drawing is untouched
  assert.match(kept, /BI \/W 1 .*EI EI/s) // so is an inline image, binary and all
  const low = Buffer.from(keepTextBetween(Buffer.from(content, 'latin1'), 250, 320)).toString('latin1')
  assert.doesNotMatch(low, /Top line|Second/)
  assert.match(low, /Low \\\(escaped\\\) line/)
})
