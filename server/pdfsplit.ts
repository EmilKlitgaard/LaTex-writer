import { decodePDFRawStream, PDFArray, PDFDocument, PDFName, PDFPage, PDFRawStream, PDFStream, type PDFContext } from 'pdf-lib'
import { keepTextBetween } from './pdfcontent.ts'
import { HttpError } from './paths.ts'

// Builds several PDFs out of one: "Save PDF in parts" in the advanced exporter.
//
// The browser works out where the cuts go, because it already has the PDF open and can see where
// the ink is. It sends each part as a list of pages. A page that is not cut is copied whole, so
// its text, links and fonts stay exactly as they were. A page that is cut is sent as bands:
// horizontal strips of the source page, each placed at its own height on a fresh page of the
// same size. That is how a cut in the middle of a page works: the part before keeps the top of
// the page (and its footer), and the part after starts with the rest, moved up to the top.

/** A horizontal strip of a source page, in points from the top of its visible area. */
export type Band = { from: number; to: number; /** Points to move it down; negative moves it up. */ dy: number }
/** One page of a part: a whole source page, or bands of one. */
export type Piece = { page: number; bands?: Band[] }
export type Part = Piece[]

const MAX_PARTS = 50
const MAX_BANDS = 8

/** Checks what the browser sent against the PDF it is about, so a bad request cannot build nonsense. */
export function validateParts(raw: unknown, pageCount: number, sizes: (n: number) => { width: number; height: number }): Part[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PARTS) throw new HttpError(400, `Choose between 1 and ${MAX_PARTS} parts`)
  let pieces = 0
  return raw.map((part, i) => {
    if (!Array.isArray(part) || part.length === 0) throw new HttpError(400, `Part ${i + 1} is empty`)
    return part.map((p): Piece => {
      if (++pieces > pageCount * 4 + 100) throw new HttpError(400, 'Too many pages')
      const piece = p as Record<string, unknown>
      const page = Number(piece.page)
      if (!Number.isInteger(page) || page < 1 || page > pageCount) throw new HttpError(400, `Page ${String(piece.page)} does not exist`)
      if (piece.bands === undefined || piece.bands === null) return { page }
      if (!Array.isArray(piece.bands) || piece.bands.length === 0 || piece.bands.length > MAX_BANDS) throw new HttpError(400, 'Invalid page bands')
      const { height } = sizes(page)
      const bands = piece.bands.map((b): Band => {
        const band = b as Record<string, unknown>
        const from = Number(band.from), to = Number(band.to), dy = Number(band.dy)
        if (![from, to, dy].every(Number.isFinite) || from < 0 || to > height + 0.5 || to - from < 0.5 || Math.abs(dy) > height) {
          throw new HttpError(400, 'Invalid page bands')
        }
        return { from, to: Math.min(to, height), dy }
      })
      return { page, bands }
    })
  })
}

/** Opens a PDF for splitting and says how big each page is (its visible area, the crop box). */
export async function openForSplit(bytes: Uint8Array): Promise<{ doc: PDFDocument; pageCount: number; size: (n: number) => { width: number; height: number } }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  return {
    doc,
    pageCount: doc.getPageCount(),
    size: (n) => {
      const box = doc.getPage(n - 1).getCropBox()
      return { width: box.width, height: box.height }
    },
  }
}

/** Writes every part as its own PDF. */
export async function buildParts(src: PDFDocument, parts: Part[]): Promise<Uint8Array[]> {
  const title = src.getTitle()
  const out: Uint8Array[] = []
  for (const [index, part] of parts.entries()) {
    const doc = await PDFDocument.create({ updateMetadata: false })
    if (title) doc.setTitle(parts.length > 1 ? `${title} (part ${index + 1} of ${parts.length})` : title)
    const author = src.getAuthor()
    if (author) doc.setAuthor(author)
    doc.setCreator(src.getCreator() ?? 'LaTeX Writer')
    doc.setProducer('LaTeX Writer')
    doc.setCreationDate(src.getCreationDate() ?? new Date())
    doc.setModificationDate(new Date())

    // Whole pages are copied in one go per run, which shares their fonts and images.
    const whole = [...new Set(part.filter((p) => !p.bands).map((p) => p.page - 1))]
    const copies = new Map<number, Awaited<ReturnType<typeof doc.copyPages>>[number]>()
    const copied = await doc.copyPages(src, whole)
    whole.forEach((n, i) => copies.set(n, copied[i]))

    for (const piece of part) {
      if (!piece.bands) {
        const copy = copies.get(piece.page - 1)!
        // The same page twice in one part needs a second copy; one page object cannot sit in two places.
        if (doc.getPages().includes(copy)) doc.addPage((await doc.copyPages(src, [piece.page - 1]))[0])
        else doc.addPage(copy)
        continue
      }
      const source = src.getPage(piece.page - 1)
      const media = source.getMediaBox()
      const crop = source.getCropBox()
      const page = doc.addPage([media.width, media.height])
      page.setMediaBox(media.x, media.y, media.width, media.height)
      page.setCropBox(crop.x, crop.y, crop.width, crop.height)
      const topY = crop.y + crop.height
      for (const band of piece.bands) {
        // Points from the top become PDF coordinates, which count up from the bottom.
        const box = { left: crop.x, right: crop.x + crop.width, bottom: topY - band.to, top: topY - band.from }
        const strip = await doc.embedPage(withTextOnlyIn(src, source, box.bottom, box.top), box)
        page.drawPage(strip, { x: box.left, y: box.bottom - band.dy, width: box.right - box.left, height: box.top - box.bottom })
      }
    }
    out.push(await doc.save({ useObjectStreams: true }))
  }
  return out
}

/** The page's raw drawing instructions, all its content streams joined. */
function pageContent(context: PDFContext, page: PDFPage): Uint8Array | null {
  const contents = page.node.Contents()
  const streams = contents instanceof PDFArray
    ? contents.asArray().map((ref) => context.lookup(ref))
    : contents ? [contents] : []
  const parts: Uint8Array[] = []
  for (const stream of streams) {
    if (stream instanceof PDFRawStream) parts.push(decodePDFRawStream(stream).decode())
    else if (stream instanceof PDFStream) parts.push(stream.getContents())
    else return null
  }
  return Buffer.concat(parts.flatMap((p) => [p, Buffer.from('\n')]))
}

/**
 * A stand-in for a page, drawing the same but holding only the text that shows between two
 * heights. A strip is the page seen through a window, and without this the text outside the
 * window would still be in the file, found by search and picked up by copy.
 */
function withTextOnlyIn(src: PDFDocument, page: PDFPage, yMin: number, yMax: number): PDFPage {
  const content = pageContent(src.context, page)
  if (!content) return page
  const node = page.node.clone(src.context)
  node.set(PDFName.of('Contents'), src.context.register(src.context.flateStream(keepTextBetween(content, yMin, yMax))))
  return PDFPage.of(node, src.context.register(node), src)
}

/** "Thesis - Part 1.pdf" style names: cleaned, ending in .pdf, and never two the same. */
export function partFileNames(requested: unknown, count: number, base: string): string[] {
  const list = Array.isArray(requested) ? requested : []
  const used = new Set<string>()
  return Array.from({ length: count }, (_, i) => {
    let name = String(list[i] ?? '')
      .normalize('NFC')
      .replace(/\.pdf$/i, '')
      .replace(/[\/\\:*?"<>|\0]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+/, '')
      .slice(0, 100)
      .trim()
    if (!name) name = `${base} - Part ${i + 1}`
    let unique = name
    for (let n = 2; used.has(unique.toLowerCase()); n++) unique = `${name} (${n})`
    used.add(unique.toLowerCase())
    return `${unique}.pdf`
  })
}
