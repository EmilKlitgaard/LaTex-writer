// Where the advanced exporter cuts the PDF, and what each part then contains.
//
// No DOM in here: the dialog measures the pages (where the ink is) and this file does the rest,
// so the rules can be tested on their own. All lengths are PDF points measured from the top of
// the page.
//
// A page is seen as "runs": horizontal stripes with ink in them, separated by blank stripes.
// For text that is roughly one run per line. A cut always sits in a blank stripe, so it never
// slices through a line, a formula or a figure. A running header and the page number are
// recognised because they sit at the same place on most pages; they are kept on both halves of
// a page that is cut, and the moved half is placed where the body text normally starts.

export type Run = { top: number; bottom: number }
export type PageInk = { width: number; height: number; runs: Run[] }
/** Running header and footer zones, found from several pages. */
export type Furniture = { headerBottom: number | null; footerTop: number | null; bodyTop: number | null }
export type Cut = { page: number; y: number }
export type Band = { from: number; to: number; dy: number }
export type Piece = { page: number; bands?: Band[] }

/**
 * Turns one row-per-pixel ink mask into runs. Gaps narrower than minGap points are bridged, so
 * the faint space inside a glyph or between a fraction's lines does not count as a place to cut.
 */
export function inkRuns(rows: ArrayLike<number>, pxPerPoint: number, minGap = 0.6): Run[] {
  const runs: Run[] = []
  let start = -1
  for (let i = 0; i <= rows.length; i++) {
    const ink = i < rows.length && rows[i] > 0
    if (ink && start < 0) start = i
    if (!ink && start >= 0) {
      const top = start / pxPerPoint, bottom = i / pxPerPoint
      const last = runs[runs.length - 1]
      if (last && top - last.bottom < minGap) last.bottom = bottom
      else runs.push({ top, bottom })
      start = -1
    }
  }
  return runs
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** Runs that sit close together (a header and the rule under it) as blocks. */
function blocks(runs: Run[], maxGap = 6): Run[] {
  const out: Run[] = []
  for (const r of runs) {
    const last = out[out.length - 1]
    if (last && r.top - last.bottom < maxGap) last.bottom = Math.max(last.bottom, r.bottom)
    else out.push({ ...r })
  }
  return out
}

/**
 * Finds a running header and footer: a short block (text, perhaps with a rule) in the top or
 * bottom 13% of the page, set well apart from the body, at the same height on at least half of
 * the pages (and on two or more). A title page without a page number does not get in the way.
 */
export function findFurniture(pages: PageInk[]): Furniture {
  const zone = (pick: (p: PageInk) => Run | null, edge: (r: Run) => number): number | null => {
    const found = pages.map(pick).filter((r): r is Run => !!r)
    if (found.length < 2 || found.length < pages.length / 2) return null
    const at = median(found.map(edge))!
    const agree = found.filter((r) => Math.abs(edge(r) - at) < 4)
    if (agree.length < 2 || agree.length < pages.length / 2) return null
    return at
  }
  const footerBlock = (p: PageInk): Run | null => {
    const b = blocks(p.runs)
    if (b.length < 2) return null
    const last = b[b.length - 1], prev = b[b.length - 2]
    const ok = last.top > p.height * 0.87 && last.bottom - last.top < p.height * 0.05 && last.top - prev.bottom > Math.max(10, (last.bottom - last.top) * 1.2)
    return ok ? last : null
  }
  const headerBlock = (p: PageInk): Run | null => {
    const b = blocks(p.runs)
    if (b.length < 2) return null
    const first = b[0], next = b[1]
    const ok = first.bottom < p.height * 0.13 && first.bottom - first.top < p.height * 0.05 && next.top - first.bottom > Math.max(10, (first.bottom - first.top) * 1.2)
    return ok ? first : null
  }
  const footerTop = zone(footerBlock, (r) => r.top)
  const headerBottom = zone(headerBlock, (r) => r.bottom)
  // Where body text starts on an ordinary page: the most common first line below the header.
  // Pages that start low (a title page, a chapter opening) are left out.
  const tops = pages.flatMap((p) => {
    const body = bodyRuns(p, { headerBottom, footerTop, bodyTop: null })
    return body.length && body[0].top < p.height * 0.3 ? [body[0].top] : []
  })
  return { headerBottom, footerTop, bodyTop: median(tops) }
}

const isHeader = (r: Run, f: Furniture): boolean => f.headerBottom !== null && r.bottom <= f.headerBottom + 3
const isFooter = (r: Run, f: Furniture): boolean => f.footerTop !== null && r.top >= f.footerTop - 3

/** The runs that belong to the page's content: everything except its running header and footer. */
export function bodyRuns(page: PageInk, f: Furniture): Run[] {
  const body = page.runs.filter((r) => !isHeader(r, f) && !isFooter(r, f))
  // A page with nothing but furniture-like ink (a lone heading high up) keeps it as its body.
  return body.length ? body : page.runs
}

/** The blank stripe nearest to y, as the height of its middle; null when the page has no body. */
export function snapCut(page: PageInk, f: Furniture, y: number): number | null {
  const body = bodyRuns(page, f)
  if (!body.length) return null
  const gaps: number[] = []
  for (let i = 1; i < body.length; i++) gaps.push((body[i - 1].bottom + body[i].top) / 2)
  // The start and end of the page count as places to cut too: between pages.
  const candidates = [0, ...gaps, page.height]
  let best = candidates[0]
  for (const c of candidates) if (Math.abs(c - y) < Math.abs(best - y)) best = c
  return best
}

/** The cut just above whatever starts at or below y (a heading, say). */
export function cutBefore(page: PageInk, f: Furniture, y: number): number {
  const body = bodyRuns(page, f)
  const i = body.findIndex((r) => r.bottom > y + 0.5)
  if (i <= 0) return i === 0 ? 0 : page.height
  return (body[i - 1].bottom + body[i].top) / 2
}

/**
 * A cut written the one way it can be: at the start of a page when nothing of the page's body
 * stays above it, or at the start of the next page when nothing stays below. Returns null for
 * the very start or end of the document, where a cut would leave an empty part.
 */
export function normalizeCut(cut: Cut, pages: PageInk[], f: Furniture): Cut | null {
  const page = pages[cut.page - 1]
  if (!page) return null
  const body = bodyRuns(page, f)
  const above = body.filter((r) => (r.top + r.bottom) / 2 < cut.y).length
  let out: Cut
  if (above === 0) out = { page: cut.page, y: 0 }
  else if (above === body.length) out = { page: cut.page + 1, y: 0 }
  else out = { page: cut.page, y: cut.y }
  if (out.y === 0 && (out.page <= 1 || out.page > pages.length)) return null
  return out
}

/** Sorted, normalised cuts without duplicates; cuts that would leave an empty part are dropped. */
export function cleanCuts(cuts: Cut[], pages: PageInk[], f: Furniture): Cut[] {
  const out: Cut[] = []
  for (const c of cuts.map((c) => normalizeCut(c, pages, f)).filter((c): c is Cut => !!c).sort((a, b) => a.page - b.page || a.y - b.y)) {
    const last = out[out.length - 1]
    if (last && last.page === c.page && Math.abs(last.y - c.y) < 0.5) continue
    out.push(c)
  }
  return out
}

/**
 * What every part contains. A page without cuts is copied whole. A page cut in the middle
 * becomes a page per piece: the first keeps the top of the page as it was; each later one keeps
 * the header and footer where they were and moves its share of the body up to where the body
 * normally starts.
 */
export function planParts(cuts: Cut[], pages: PageInk[], f: Furniture): Piece[][] {
  const clean = cleanCuts(cuts, pages, f)
  const parts: Piece[][] = [[]]
  const newPart = (): void => {
    if (parts[parts.length - 1].length) parts.push([])
  }
  pages.forEach((page, idx) => {
    const n = idx + 1
    const here = clean.filter((c) => c.page === n)
    if (here.some((c) => c.y === 0)) newPart()
    const mids = here.filter((c) => c.y > 0).map((c) => c.y)
    if (!mids.length) {
      parts[parts.length - 1].push({ page: n })
      return
    }
    const body = bodyRuns(page, f)
    const header = page.runs.filter((r) => !body.includes(r) && isHeader(r, f))
    const footer = page.runs.filter((r) => !body.includes(r) && isFooter(r, f))
    const lastBody = body[body.length - 1]
    const bodyEnd = footer.length ? (lastBody.bottom + footer[0].top) / 2 : page.height
    const footerBand = footer.length ? [{ from: bodyEnd, to: page.height, dy: 0 }] : []
    const headerBand = header.length ? [{ from: 0, to: (header[header.length - 1].bottom + body[0].top) / 2, dy: 0 }] : []
    const target = f.bodyTop ?? body[0].top

    // Top piece: the page as it was down to the first cut, and its footer.
    parts[parts.length - 1].push({ page: n, bands: [{ from: 0, to: mids[0], dy: 0 }, ...footerBand] })
    mids.forEach((y, i) => {
      const end = i + 1 < mids.length ? mids[i + 1] : bodyEnd
      const first = body.find((r) => r.top >= y)
      if (!first) return
      // Start a hair above the ink, so no blank stripe is drawn over the header.
      const from = Math.max(y, first.top - 2)
      // Moving down is never needed: content that already sits high stays where it is.
      const dy = Math.min(0, target - first.top)
      newPart()
      parts[parts.length - 1].push({ page: n, bands: [...headerBand, { from, to: end, dy }, ...footerBand] })
    })
  })
  return parts.filter((p) => p.length)
}

/** "pages 3–7" for a part, counting a page split between two parts in both. */
export function pageRange(part: Piece[]): string {
  const first = part[0].page, last = part[part.length - 1].page
  return first === last ? `page ${first}` : `pages ${first}–${last}`
}
