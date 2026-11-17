import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { findSibling, findSource, grant, listFiles, MAX_FILES_LISTED, resolveInSource, siblings, sources, type Source } from './access.ts'
import type { BuildResult } from './compile.ts'
import { describeNotes, NOTES_LIMITS, readPreferences, readProjectNotes, updateNotes, NOTES_HEADERS } from './notes.ts'
import { HttpError, INTERNAL_DIR, isTextFile, resolveInside, validateEntryName } from './paths.ts'
import { extractText, pageCount, pageGeometry, renderPage, renderSheet, searchText } from './pdfrender.ts'
import type { Project, TreeNode } from './project.ts'
import { markdownMathNote } from './mdmath.ts'
import { findSkill, skillCatalog, SKILLS, skillText } from './skills.ts'

// A small MCP server (JSON-RPC over HTTP POST) that lets Claude work on the open project:
// read and search the sources, make edits that wait for the user's review, compile, and look
// at the result. It serves both the chat sidebar and Claude sessions outside the app.
//
// Designed to keep the number of steps and the size of every answer small: each step re-sends
// the whole conversation, so a tool that saves a step, or an image, saves a lot.

export const MCP_SERVER_NAME = 'latexwriter'
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAX_READ_CHARS = 60_000
/** Existing files longer than this cannot be replaced wholesale: rewriting them costs far more than editing. */
const MAX_OVERWRITE_LINES = 80
const MAX_ISSUES_LISTED = 15
const MAX_COPY_FILES = 200
const MAX_COPY_BYTES = 20 * 1024 * 1024

/** The app's read-only rules for writing Markdown files, shared by every agent (server/markdown-rules.md). */
const MARKDOWN_RULES = fs.readFileSync(path.join(import.meta.dirname, 'markdown-rules.md'), 'utf8').trim()

export const INSTRUCTIONS = `You are working on a LaTeX project that is open in the LaTeX Writer app.

How changes work:
- edit_file and write_file change the document immediately, and the user sees the change live.
- Every change stays "pending" until the user accepts or declines it in the app. The text from before
  your change is kept as a backup, so nothing you do is lost. Do not ask for permission before each
  edit; make the edit and say briefly what you changed.
- If the user declined a change, do not make it again unless asked.

How to work efficiently (every step re-sends the whole conversation, so fewer, smaller steps matter):
- Start with project_info. Read only the files and line ranges you need; use search to find things.
- Put all changes to one file into a single edit_file call with several edits.
- edit_file and write_file compile afterwards and report the result, so you rarely need compile on
  its own. Pass compile: false on all but the last of several edit calls in a row.
- Check layout with check_layout first (text, cheap). Look at pages only when that is not enough:
  view_page with pages: [..] shows several pages in one small image; a single page or a band of it
  (from/to) shows detail. Never look at the same page twice without a change in between.
- To check what the PDF says, use read_pdf_text, with query to find specific text.
- Keep edits minimal and keep the author's style. Do not reformat text you were not asked to change.

Memory (two Markdown files; project_info and read_notes show both):
- Project notes (INSTRUCTIONS.md, in the project folder): memory shared by the agents and sessions that
  work on this project. Follow them. With update_notes (file "project") add what a later session needs:
  the author's standing instructions for this document, decisions, conventions, structure, open tasks,
  pitfalls. Do not note what the files already show. Keep it short and current: remove what is done
  or no longer true.
- Writing preferences (global, all projects): how the author likes to be written for. Follow them.
  Do NOT change them unless the author asks you to, or states a lasting preference that clearly
  applies to all their writing, not just this document. Then use update_notes (file "preferences")
  with a reason. Anything specific to this document belongs in the project notes.
- Both files have a size limit. When an update is refused for size, rewrite the whole file shorter
  with mode "replace" (read_notes first), keeping everything still useful.

Other projects and attached files (read-only):
- The user can attach files and folders to a conversation; you are told their paths. Read them by
  passing the path as source to project_info, read_file and search.
- For PDFs in the project, pass their project-relative path to read_pdf_text or view_page.
  For a directly attached PDF, pass its attachment path as source and omit path.
  For a PDF in an attached folder or allowed project, pass source and a path relative to it.
  Use view_page for scans and diagrams.
- Other projects in the same folder can be read only with the user's permission. list_sources shows
  them. Ask with request_access only when the task needs one (for example "set this up like my
  exercise 1"), once per project; the answer lasts until the user takes it back.
- You can never change those files. copy_file copies files from them into this project (text files
  wait for review like your edits); then adapt the copies with edit_file.

${MARKDOWN_RULES}

If a tool says the project open in the app has changed, stop: do nothing more and tell the user.

Limits of this setup: no shell escape (so no minted), EPS figures do not convert under pdfLaTeX,
and LuaLaTeX is refused while the project is shared on the network.`

type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, boolean> }

const str = (description: string): Record<string, unknown> => ({ type: 'string', description })
const int = (description: string): Record<string, unknown> => ({ type: 'integer', description })
const bool = (description: string): Record<string, unknown> => ({ type: 'boolean', description })
const readOnly = { readOnlyHint: true }

const pdfFileProperties = {
  path: str('PDF path relative to the project or source. Omit for a directly attached PDF or to use the compiled PDF when no source is given.'),
  source: str('Attachment path or allowed project folder name. See list_sources.'),
}

export const TOOLS: Tool[] = [
  {
    name: 'project_info',
    description: 'Overview of the open project: name, main file, every file with its size, the state of the last compile, and changes waiting for review. Call this first. With source: the files of another project or attachment.',
    inputSchema: {
      type: 'object',
      properties: {
        source: str('Read from another project (its folder name) or an attached file or folder (its path) instead of this project. See list_sources.'),
        switch: bool('Only after the user agreed: continue on the project that is open in the app now, after a tool said it changed'),
      },
    },
    annotations: readOnly,
  },
  {
    name: 'read_file',
    description: 'Read a text file (including live project edits) or extract the first three pages of a PDF. Use read_pdf_text for other PDF pages and view_page for scans.',
    inputSchema: {
      type: 'object',
      properties: { path: str('Project-relative path, e.g. "main.tex" or "chapters/intro.tex" (relative to the source when source is given)'), start_line: int('First line to return (1-based)'), end_line: int('Last line to return'), source: str('Read from another project (its folder name) or an attached file or folder (its path) instead of this project. See list_sources.') },
      required: ['path'],
    },
    annotations: readOnly,
  },
  {
    name: 'search',
    description: 'Find text across all text files of the project. Returns matching lines as "file:line: text".',
    inputSchema: {
      type: 'object',
      properties: { query: str('Text to find, or a regular expression when regex is true'), regex: bool('Treat query as a JavaScript regular expression'), source: str('Read from another project (its folder name) or an attached file or folder (its path) instead of this project. See list_sources.') },
      required: ['query'],
    },
    annotations: readOnly,
  },
  {
    name: 'edit_file',
    description: 'Make one or more exact text replacements in a file, in one call. Each old_text must match the file exactly (whitespace and line breaks included) and occur once, unless replace_all is set. The edits are applied in order and all-or-nothing. Then compiles (unless compile is false) and reports the result. The changes wait for the user\'s review.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('Project-relative path'),
        edits: {
          type: 'array',
          minItems: 1,
          description: 'The replacements, applied in order',
          items: {
            type: 'object',
            properties: { old_text: str('The exact text to replace'), new_text: str('The text to put in its place'), replace_all: bool('Replace every occurrence') },
            required: ['old_text', 'new_text'],
          },
        },
        compile: bool('Compile afterwards and report errors (default true). Use false when more edits follow right away.'),
      },
      required: ['path', 'edits'],
    },
  },
  {
    name: 'write_file',
    description: `Create a new text file. Replacing an existing file needs overwrite: true and is only allowed for files up to ${MAX_OVERWRITE_LINES} lines; change longer files with edit_file. Then compiles (unless compile is false). The change waits for the user's review.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: str('Project-relative path'),
        content: str('The full content'),
        overwrite: bool('Replace an existing (short) file'),
        compile: bool('Compile afterwards and report errors (default true)'),
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_notes',
    description: 'The current text of the project notes (INSTRUCTIONS.md) and the author\'s writing preferences. Use it before rewriting either file.',
    inputSchema: { type: 'object', properties: {} },
    annotations: readOnly,
  },
  {
    name: 'update_notes',
    description: `Remember something across sessions. file "project": the project notes (INSTRUCTIONS.md), for decisions, conventions, open tasks and anything the next agent needs. file "preferences": the author's global writing preferences; only when the author asked, or stated a lasting preference for all their writing; reason is then required. mode "append" (default) adds a line; "replace" rewrites the whole file, which is how to condense it. Limits: ${NOTES_LIMITS.project} characters for project notes, ${NOTES_LIMITS.preferences} for preferences. Takes effect at once and does not wait for review.`,
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', enum: ['project', 'preferences'] },
        text: str('The line to add, or, with mode "replace", the complete new Markdown text of the file'),
        mode: { type: 'string', enum: ['append', 'replace'] },
        reason: str('For file "preferences": what the author said that justifies the change'),
      },
      required: ['file', 'text'],
    },
  },
  {
    name: 'compile',
    description: 'Compile the project and report errors and warnings with file, line and the offending source line, and the number of pages. Edits already compile by themselves; use this after changes made by someone else, or to recheck.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_layout',
    description: 'A text report on the layout of the compiled PDF, far cheaper than images: how full each page is, pages that end early (large empty space), where figure and table captions landed, and overfull or underfull lines mapped to their page and source line.',
    inputSchema: { type: 'object', properties: { first_page: int('First page (default 1)'), last_page: int('Last page (default: last page, at most 60 pages)') } },
    annotations: readOnly,
  },
  {
    name: 'read_pdf_text',
    description: 'The text of a project PDF, attached PDF, or the compiled PDF by default. With query: only the lines containing it, with page numbers, across the whole PDF. Without: the full text of a page range.',
    inputSchema: { type: 'object', properties: { ...pdfFileProperties, query: str('Text to find in the PDF'), first_page: int('First page (default 1)'), last_page: int('Last page (default: first_page + 2)') } },
    annotations: readOnly,
  },
  {
    name: 'view_page',
    description: 'Images of a project PDF, attached PDF, or the compiled PDF by default. Use for scans and visual questions. pages: [..] (up to 8) gives one small overview image of several pages, about the cost of one page. page with from/to shows part of one page in more detail.',
    inputSchema: {
      type: 'object',
      properties: {
        ...pdfFileProperties,
        page: int('One page to show (1-based)'),
        pages: { type: 'array', items: { type: 'integer' }, maxItems: 8, description: 'Several pages side by side in one overview image' },
        from: { type: 'number', description: 'Top of the band to show, as a fraction of the page height (0 = top). Default 0.' },
        to: { type: 'number', description: 'Bottom of the band, as a fraction of the page height (1 = bottom). Default 1.' },
        detail: { type: 'string', enum: ['normal', 'high'], description: 'high is only allowed for a band of at most half the page' },
      },
    },
    annotations: readOnly,
  },
  {
    name: 'use_skill',
    description: `Load a writing skill: step-by-step instructions for a kind of writing task, with the guidance it rests on. Load one when the user asks for that kind of work in their own words, then follow it. Skills:\n${skillCatalog()}`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: SKILLS.map((s) => s.name) },
        request: str('What the user asked for, in their words: scope and any extra instructions'),
      },
      required: ['name'],
    },
    annotations: readOnly,
  },
  {
    name: 'list_sources',
    description: 'What you can read besides this project: the files and folders attached to this conversation, and the other projects in the same folder, each marked as readable or as needing the user\'s permission (request_access).',
    inputSchema: { type: 'object', properties: {} },
    annotations: readOnly,
  },
  {
    name: 'request_access',
    description: 'Ask the user for permission to read another project in the same folder (read-only). The user answers in the app; this waits for the answer. Once allowed, this project keeps the access until the user removes it. Ask only when the task needs that project.',
    inputSchema: {
      type: 'object',
      properties: { project: str('The other project\'s folder name, as list_sources shows it'), reason: str('One short sentence for the user: what you want to read it for') },
      required: ['project', 'reason'],
    },
  },
  {
    name: 'copy_file',
    description: `Copy a file or a whole folder from another project or attachment into this project, keeping the file structure. Existing files are never overwritten (they are skipped and listed). Copied text files wait for the user's review like your edits; images and other binary files are copied as they are. At most ${MAX_COPY_FILES} files. Does not compile unless compile is true.`,
    inputSchema: {
      type: 'object',
      properties: {
        source: str('The other project (folder name) or the attached file or folder (path)'),
        path: str('File or folder to copy, relative to the source. Empty: everything in the source.'),
        to: str('Where to put it in this project (default: the same relative path)'),
        compile: bool('Compile afterwards (default false)'),
      },
      required: ['source'],
    },
  },
  {
    name: 'read_log',
    description: 'The end of the raw LaTeX log of the last compile, when the reported errors are not enough.',
    inputSchema: { type: 'object', properties: { lines: int('How many lines from the end (default 80, max 400)') } },
    annotations: readOnly,
  },
]

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export type ToolResult = { content: Content[]; isError?: boolean }

const text = (t: string, isError = false): ToolResult => (isError ? { content: [{ type: 'text', text: t }], isError } : { content: [{ type: 'text', text: t }] })
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

class ToolError extends Error {}

function flatten(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    if (n.type === 'dir') flatten(n.children ?? [], out)
    else out.push(n)
  }
  return out
}

function requireText(project: Project, input: unknown): { rel: string; abs: string } {
  const { rel, abs } = resolveInside(project.root, input)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new ToolError(`"${rel}" does not exist. Use project_info to list the files.`)
  if (!isTextFile(abs, rel)) throw new ToolError(`"${rel}" is not a text file.`)
  return { rel, abs }
}

function describeBuild(project: Project): string {
  const r = project.compiler.lastResult
  if (project.compiler.compiling) return 'compiling now'
  if (!r) return 'not compiled yet in this session'
  return `${r.status}, ${plural(r.errorCount, 'error')}, ${plural(r.warningCount, 'warning')}`
}

async function pdfPages(project: Project): Promise<number> {
  const pdf = project.compiler.currentPdf()
  if (!pdf) return 0
  try {
    return await pageCount(pdf.file)
  } catch {
    return 0
  }
}

/** A compact compile report: the verdict first, then the problems with their source line. */
async function compileReport(project: Project, r: BuildResult): Promise<string> {
  const pages = await pdfPages(project)
  const head = `Compile ${r.status === 'success' ? 'succeeded' : r.status === 'error' ? 'FAILED' : r.status.toUpperCase()}: ${plural(r.errorCount, 'error')}, ${plural(r.warningCount, 'warning')}, ${pages ? plural(pages, 'page') : 'no PDF'}.`
  const issues = r.entries.filter((e) => e.severity !== 'info')
  const shown = issues.slice(0, MAX_ISSUES_LISTED).map((e) => {
    const where = e.file ? `${e.file}${e.line ? `:${e.line}` : ''}: ` : ''
    let line = `${e.severity === 'error' ? 'ERROR' : 'warning'} ${where}${e.message}`
    if (e.detail) line += `\n    at: ${e.detail}`
    if (e.hint) line += `\n    ${e.hint}`
    return line
  })
  const hidden = issues.length - shown.length
  return [head, ...shown, hidden > 0 ? `[${hidden} more; use read_log]` : ''].filter(Boolean).join('\n')
}

/** The result of a change: its summary, how the build went, then `note` (things to fix in what was written). */
async function afterChange(project: Project, args: Record<string, unknown>, summary: string, note = ''): Promise<ToolResult> {
  if (args.compile === false) return text(`${summary} Not compiled yet.${note}`)
  const r = await project.compile(true)
  return text(`${summary}\n${await compileReport(project, r)}${note}`)
}

type Edit = { old_text: string; new_text: string; replace_all?: boolean }

function readEdits(args: Record<string, unknown>): Edit[] {
  // A single old_text/new_text at the top level is still accepted, for older clients.
  const raw = Array.isArray(args.edits) ? args.edits : args.old_text !== undefined ? [{ old_text: args.old_text, new_text: args.new_text, replace_all: args.replace_all }] : []
  if (!raw.length) throw new ToolError('Give at least one edit: edits: [{ old_text, new_text }]. To create a file use write_file.')
  return raw.map((e, i) => {
    const edit = (e ?? {}) as Record<string, unknown>
    if (typeof edit.old_text !== 'string' || !edit.old_text) throw new ToolError(`Edit ${i + 1}: old_text is required.`)
    if (typeof edit.new_text !== 'string') throw new ToolError(`Edit ${i + 1}: new_text is required.`)
    if (edit.old_text === edit.new_text) throw new ToolError(`Edit ${i + 1}: old_text and new_text are the same.`)
    return { old_text: edit.old_text, new_text: edit.new_text, replace_all: edit.replace_all === true }
  })
}

async function layoutReport(project: Project, file: string, first: number, last: number): Promise<string> {
  const { pages, total } = await pageGeometry(file, first, last)
  const out: string[] = [`${plural(total, 'page')}${pages.length < total ? ` (showing ${pages[0]?.page}-${pages.at(-1)?.page})` : ''}.`]

  const early = pages.filter((p, i) => p.page < total && p.lines > 0 && p.textEndsAt < 0.75 && !(i === 0 && p.page === 1))
  const empty = pages.filter((p) => p.lines === 0)
  if (early.length) out.push(`Pages that end early (text stops well above the bottom, often a float pushed to the next page): ${early.map((p) => `p.${p.page} at ${Math.round(p.textEndsAt * 100)}%`).join(', ')}.`)
  if (empty.length) out.push(`Pages without text (full-page figure or empty): ${empty.map((p) => `p.${p.page}`).join(', ')}.`)
  const captions = pages.flatMap((p) => p.captions.map((c) => `${c.label} on p.${p.page} at ${Math.round(c.at * 100)}%`))
  if (captions.length) out.push(`Captions: ${captions.join('; ')}.`)

  // Overfull and underfull lines from the log, mapped to the page they ended up on.
  const boxes = (project.compiler.lastResult?.entries ?? []).filter((e) => /^(Overfull|Underfull)/.test(e.message))
  const mapped: string[] = []
  for (const e of boxes.slice(0, 20)) {
    let page: number | null = null
    if (e.file && e.line) page = (await project.compiler.synctexView(e.file, e.line, 0))?.page ?? null
    mapped.push(`${e.message.replace(/ in paragraph| detected/g, '')}${e.file ? ` (${e.file}${e.line ? `:${e.line}` : ''})` : ''}${page ? ` on p.${page}` : ''}`)
  }
  if (mapped.length) out.push(`Overfull/underfull lines (${boxes.length}):\n  ${mapped.join('\n  ')}${boxes.length > mapped.length ? `\n  [${boxes.length - mapped.length} more]` : ''}`)
  const floats = (project.compiler.lastResult?.entries ?? []).filter((e) => /float/i.test(e.message) && e.severity === 'warning')
  if (floats.length) out.push(`Float warnings: ${floats.slice(0, 5).map((e) => `${e.message}${e.file ? ` (${e.file}:${e.line ?? '?'})` : ''}`).join('; ')}.`)
  if (out.length === 1) out.push('No layout problems found in the text: pages are full, no overfull lines, no float warnings.')
  return out.join('\n')
}

/** The source a tool call names, among what this chat may read. */
function sourceFor(project: Project, chat: string | undefined, name: unknown): { source: Source; prefix: string } {
  const found = findSource(sources(project.root, project.ai.attachmentsOf(chat)), name)
  if (found) return found
  const sibling = findSibling(project.root, name)
  if (sibling) throw new ToolError(`You cannot read the project "${sibling.name}" yet. Ask the user with request_access first.`)
  throw new ToolError(`"${String(name)}" is not something you can read. Use list_sources to see what is available.`)
}

function pdfFile(project: Project, args: Record<string, unknown>, chat?: string): string {
  if (args.source !== undefined && args.source !== '') {
    const { source, prefix } = sourceFor(project, chat, args.source)
    const { rel, abs } = resolveInSource(source, args.path, prefix)
    return requirePdf(rel, abs)
  }
  if (args.path !== undefined) {
    const { rel, abs } = resolveInside(project.root, args.path)
    return requirePdf(rel, abs)
  }
  const pdf = project.compiler.currentPdf()
  if (!pdf) throw new ToolError('There is no PDF yet. Compile first or specify a PDF path or attachment source.')
  return pdf.file
}

const isPdf = (rel: string): boolean => path.extname(rel).toLowerCase() === '.pdf'

function requirePdf(rel: string, abs: string): string {
  if (!isPdf(rel) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new ToolError(`"${rel}" does not name a readable PDF file.`)
  }
  return abs
}

async function readPdfPages(file: string, first: number, last: number): Promise<string> {
  const out = await extractText(file, first, last)
  if (first > out.pages || last < first) throw new ToolError(`Invalid page range. PDF has ${plural(out.pages, 'page')}.`)
  let body = out.text || '(these pages contain no extractable text; use view_page to inspect them)'
  if (body.length > MAX_READ_CHARS) body = body.slice(0, MAX_READ_CHARS) + '\n[cut off: ask for fewer pages]'
  return `PDF has ${plural(out.pages, 'page')}.\n\n${body}`
}

const sourceLabel = (s: Source): string => (s.kind === 'project' ? `project "${s.name}"` : s.kind === 'folder' ? `attached folder ${s.root}` : `attached file ${path.join(s.root, s.only!)}`)

function readSourceText(source: Source, rel: string, abs: string): string {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new ToolError(`"${rel}" does not exist in the ${sourceLabel(source)}. Use project_info with source to list its files.`)
  if (!isTextFile(abs, rel)) throw new ToolError(`"${rel}" is not a text file.`)
  return fs.readFileSync(abs, 'utf8')
}

function lineCount(abs: string): number {
  try {
    return fs.readFileSync(abs, 'utf8').split('\n').length
  } catch {
    return 0
  }
}

function sourceInfo(project: Project, chat: string | undefined, name: unknown): string {
  const { source, prefix } = sourceFor(project, chat, name)
  const files = listFiles(source, prefix)
  const shown = files.slice(0, MAX_FILES_LISTED).map((f) => `  ${f.rel}  (${f.text ? `${lineCount(f.abs)} lines` : 'binary'})`)
  const head = [`Read-only ${sourceLabel(source)}${prefix ? `, under ${prefix}` : ''}.`]
  if (source.kind === 'project') {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(source.root, INTERNAL_DIR, 'project.json'), 'utf8')) as { name?: string; mainFile?: string }
      head.push(`Name: ${settings.name ?? source.name}. Main file: ${settings.mainFile ?? 'main.tex'}.`)
    } catch {}
  }
  return `${head.join('\n')}\n\nFiles:\n${shown.join('\n') || '  (none)'}${files.length > shown.length ? `\n  [${files.length - shown.length} more]` : ''}`
}

function copyFiles(project: Project, chat: string | undefined, args: Record<string, unknown>): string {
  const { source, prefix } = sourceFor(project, chat, args.source)
  const from = resolveInSource(source, typeof args.path === 'string' ? args.path : '', prefix)
  const fromStat = fs.existsSync(from.abs) ? fs.statSync(from.abs) : null
  if (!fromStat) throw new ToolError(`"${from.rel || '(root)'}" does not exist in the ${sourceLabel(source)}.`)
  const isDir = fromStat.isDirectory() && source.kind !== 'file'
  const files = isDir ? listFiles(source, from.rel) : [{ rel: from.rel, abs: from.abs, text: isTextFile(from.abs, from.rel) }]
  if (!files.length) throw new ToolError('There are no files to copy there.')
  if (files.length > MAX_COPY_FILES) throw new ToolError(`That is ${files.length} files; at most ${MAX_COPY_FILES} can be copied at once. Copy sub-folders one by one.`)
  const to = typeof args.to === 'string' ? args.to.trim() : ''
  const base = isDir ? to || from.rel : ''
  const copied: string[] = []
  const skipped: string[] = []
  for (const f of files) {
    const destRel = isDir ? path.posix.join(base, path.posix.relative(from.rel, f.rel)) : to || (source.kind === 'file' ? source.only! : f.rel)
    const dest = resolveInside(project.root, destRel)
    if (fs.existsSync(dest.abs)) {
      skipped.push(dest.rel)
      continue
    }
    if (fs.statSync(f.abs).size > MAX_COPY_BYTES) {
      skipped.push(`${dest.rel} (too large)`)
      continue
    }
    if (f.text) project.applyAssistantEdit(dest.rel, fs.readFileSync(f.abs, 'utf8'))
    else {
      validateEntryName(path.basename(dest.rel))
      fs.mkdirSync(path.dirname(dest.abs), { recursive: true })
      fs.copyFileSync(f.abs, dest.abs, fs.constants.COPYFILE_EXCL)
    }
    copied.push(dest.rel)
  }
  const out = [`Copied ${plural(copied.length, 'file')} from the ${sourceLabel(source)}${copied.length ? `: ${copied.slice(0, 40).join(', ')}${copied.length > 40 ? ', …' : ''}` : ''}. Text files are pending the user's review.`]
  if (skipped.length) out.push(`Skipped, because they already exist in this project (change them with edit_file): ${skipped.slice(0, 40).join(', ')}${skipped.length > 40 ? ', …' : ''}.`)
  return out.join('\n')
}

export async function callTool(project: Project, name: string, args: Record<string, unknown>, chat?: string): Promise<ToolResult> {
  try {
    if (args.source !== undefined && args.source !== '' && ['project_info', 'read_file', 'search'].includes(name)) return text(await callOnSource(project, name, args, chat))
    switch (name) {
      case 'list_sources': {
        const attached = project.ai.attachmentsOf(chat)
        const others = siblings(project.root)
        const lines = ['Attached to this conversation (read-only):', ...(attached.length ? attached.map((a) => `  ${a}${fs.existsSync(a) ? (fs.statSync(a).isDirectory() ? '  (folder)' : '  (file)') : '  (missing)'}`) : ['  none'])]
        lines.push('', 'Other projects in the same folder:', ...(others.length ? others.map((o) => `  ${o.name}  (${o.granted ? 'readable' : 'needs permission: request_access'})`) : ['  none']))
        return text(lines.join('\n'))
      }

      case 'request_access': {
        const sibling = findSibling(project.root, args.project)
        if (!sibling) {
          const names = siblings(project.root).map((s) => s.name)
          throw new ToolError(`There is no project "${String(args.project ?? '')}" in this folder.${names.length ? ` Projects: ${names.join(', ')}.` : ' There are no other projects here.'}`)
        }
        if (sibling.granted) return text(`You can already read "${sibling.name}". Pass source: "${sibling.name}".`)
        const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'No reason given.'
        const ok = await project.ai.access.ask(sibling, reason)
        if (!ok) return text(`The user did not allow reading "${sibling.name}". Do not ask again unless the user asks you to; carry on without it or ask what they want.`)
        grant(project.root, sibling.path)
        project.ai.emitAccess()
        return text(`Allowed. You can now read "${sibling.name}" (read-only): pass source: "${sibling.name}" to project_info, read_file and search, and use copy_file to copy from it.`)
      }

      case 'copy_file': {
        const summary = copyFiles(project, chat, args)
        if (args.compile === true) return await afterChange(project, {}, summary)
        return text(summary)
      }

      case 'project_info': {
        const files = flatten(project.tree()).filter((f) => !f.cloud)
        const lines = files.map((f) => {
          if (f.kind !== 'text') return `  ${f.path}  (${f.kind})`
          let count = 0
          try {
            count = project.docs.read(f.path).split('\n').length
          } catch {}
          return `  ${f.path}  (${count} lines)`
        })
        const review = project.review.summary()
        const pending = review.files.length
          ? review.files.map((f) => `  ${f.path}: ${f.status === 'added' ? 'new file' : plural(f.hunks.length, 'change')}`).join('\n')
          : '  none'
        return text(
          `Project: ${project.settings.name}\nMain file: ${project.settings.mainFile}\nLast compile: ${describeBuild(project)}\n\nFiles:\n${lines.join('\n')}\n\nChanges waiting for the user's review:\n${pending}\n\n${describeNotes(project)}`,
        )
      }

      case 'read_notes':
        return text(`${NOTES_HEADERS.project}\n${readProjectNotes(project).trim()}\n\n${NOTES_HEADERS.preferences}\n${readPreferences().trim()}`)

      case 'update_notes': {
        const r = updateNotes(project, args)
        if (!r.ok) throw new ToolError(r.error)
        return text(r.message)
      }

      case 'read_file': {
        const { rel: requested, abs } = resolveInside(project.root, args.path)
        if (isPdf(requested)) return text(await readPdfPages(requirePdf(requested, abs), 1, 3))
        const { rel } = requireText(project, args.path)
        const all = project.docs.read(rel).split('\n')
        const start = Math.max(1, Math.floor(Number(args.start_line) || 1))
        const end = Math.min(all.length, Math.floor(Number(args.end_line) || all.length))
        if (start > all.length) throw new ToolError(`"${rel}" has only ${all.length} lines.`)
        let body = all.slice(start - 1, end).join('\n')
        let note = ''
        if (body.length > MAX_READ_CHARS) {
          body = body.slice(0, MAX_READ_CHARS)
          note = '\n[cut off: ask for a smaller line range to see the rest]'
        }
        return text(`${rel}, lines ${start}-${end} of ${all.length}:\n${body}${note}`)
      }

      case 'search': {
        const query = String(args.query ?? '')
        if (!query) throw new ToolError('query is required')
        let re: RegExp
        try {
          re = args.regex ? new RegExp(query, 'i') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        } catch (err) {
          throw new ToolError(`Invalid regular expression: ${(err as Error).message}`)
        }
        const hits: string[] = []
        let total = 0
        for (const f of flatten(project.tree())) {
          if (f.kind !== 'text' || f.cloud) continue
          let content: string
          try {
            content = project.docs.read(f.path)
          } catch {
            continue
          }
          content.split('\n').forEach((line, i) => {
            if (!re.test(line)) return
            total++
            if (hits.length < 60) hits.push(`${f.path}:${i + 1}: ${line.trim().slice(0, 200)}`)
          })
        }
        if (!total) return text(`No matches for "${query}".`)
        return text(hits.join('\n') + (total > hits.length ? `\n[${total - hits.length} more matches not shown]` : ''))
      }

      case 'edit_file': {
        const { rel } = requireText(project, args.path)
        const edits = readEdits(args)
        const original = project.docs.read(rel)
        let next = original
        let firstLine = 0
        // Apply to a copy first: either every edit fits, or nothing changes.
        edits.forEach((e, i) => {
          const count = next.split(e.old_text).length - 1
          const label = edits.length > 1 ? `Edit ${i + 1} of ${edits.length}: ` : ''
          if (count === 0) throw new ToolError(`${label}old_text was not found in "${rel}"${i > 0 ? ' (after the earlier edits in this call)' : ''}. Nothing was changed. Read the file again: the text must match exactly, including whitespace and line breaks.`)
          if (count > 1 && !e.replace_all) throw new ToolError(`${label}old_text occurs ${count} times in "${rel}". Nothing was changed. Include more surrounding text to make it unique, or set replace_all.`)
          const line = next.slice(0, next.indexOf(e.old_text)).split('\n').length
          firstLine = firstLine ? Math.min(firstLine, line) : line
          next = e.replace_all ? next.split(e.old_text).join(e.new_text) : next.replace(e.old_text, () => e.new_text)
        })
        project.applyAssistantEdit(rel, next)
        return await afterChange(project, args, `Edited ${rel} (${plural(edits.length, 'change')}, from line ${firstLine}). Pending the user's review.`, markdownMathNote(rel, next, original))
      }

      case 'write_file': {
        const { rel, abs } = resolveInside(project.root, args.path)
        if (typeof args.content !== 'string') throw new ToolError('content is required')
        const existed = fs.existsSync(abs)
        if (existed) {
          if (!fs.statSync(abs).isFile() || !isTextFile(abs, rel)) throw new ToolError(`"${rel}" exists and is not a text file.`)
          if (args.overwrite !== true) throw new ToolError(`"${rel}" already exists. Change it with edit_file, or pass overwrite: true to replace a short file.`)
          const lines = project.docs.read(rel).split('\n').length
          if (lines > MAX_OVERWRITE_LINES) throw new ToolError(`"${rel}" has ${lines} lines, too long to replace wholesale (limit ${MAX_OVERWRITE_LINES}). Use edit_file with several edits in one call.`)
        } else if (!fs.existsSync(path.dirname(abs))) {
          fs.mkdirSync(path.dirname(abs), { recursive: true })
        }
        const before = existed ? project.docs.read(rel) : ''
        project.applyAssistantEdit(rel, args.content)
        return await afterChange(project, args, `${existed ? 'Replaced' : 'Created'} ${rel}. Pending the user's review.`, markdownMathNote(rel, args.content, before))
      }

      case 'compile': {
        const r = await project.compile(true)
        // A document that does not compile is reported as an error, so the model treats it as one.
        return text(await compileReport(project, r), r.status !== 'success')
      }

      case 'check_layout': {
        const pdf = project.compiler.currentPdf()
        if (!pdf) throw new ToolError('There is no PDF yet. Compile first.')
        return text(await layoutReport(project, pdf.file, Number(args.first_page) || 1, Number(args.last_page) || Infinity))
      }

      case 'read_pdf_text': {
        const file = pdfFile(project, args, chat)
        if (typeof args.query === 'string' && args.query.trim()) {
          const found = await searchText(file, args.query.trim())
          if (!found.total) return text(`"${args.query}" does not occur in the PDF text (${plural(found.pages, 'page')}).`)
          return text(found.hits.join('\n') + (found.total > found.hits.length ? `\n[${found.total - found.hits.length} more]` : ''))
        }
        const first = Math.max(1, Math.floor(Number(args.first_page) || 1))
        const last = Math.floor(Number(args.last_page) || first + 2)
        return text(await readPdfPages(file, first, last))
      }

      case 'view_page': {
        const file = pdfFile(project, args, chat)
        if (Array.isArray(args.pages) && args.pages.length) {
          const list = args.pages.map(Number).filter(Number.isFinite).slice(0, 8)
          const out = await renderSheet(file, list)
          return {
            content: [
              { type: 'text', text: `Overview of pages ${list.join(', ')} (of ${out.pages}), ${out.width}x${out.height} px. Ask for one page with from/to to see details.` },
              { type: 'image', data: out.png.toString('base64'), mimeType: 'image/png' },
            ],
          }
        }
        if (args.page === undefined) throw new ToolError('Give page (one page) or pages (an overview of several).')
        const from = args.from === undefined ? 0 : Number(args.from)
        const to = args.to === undefined ? 1 : Number(args.to)
        if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > 1 || from >= to) throw new ToolError('from and to must be fractions with 0 <= from < to <= 1.')
        const band = to - from
        const high = args.detail === 'high' && band <= 0.5
        // A band gets more pixels per page height, so it comes out sharper for about the same cost.
        const edge = Math.min(high ? 2400 : 1600, (high ? 1400 : 1000) / Math.max(band, 0.3))
        const page = Math.floor(Number(args.page))
        const out = await renderPage(file, page, { maxEdge: edge, from, to })
        const note = args.detail === 'high' && !high ? ' High detail is only given for a band of at most half the page; use from/to.' : ''
        return {
          content: [
            { type: 'text', text: `Page ${page} of ${out.pages}${band < 1 ? ` (from ${from} to ${to} of the page height)` : ''}, ${out.width}x${out.height} px.${note}` },
            { type: 'image', data: out.png.toString('base64'), mimeType: 'image/png' },
          ],
        }
      }

      case 'use_skill': {
        const skill = findSkill(args.name)
        if (!skill) throw new ToolError(`There is no skill "${String(args.name)}". Skills: ${SKILLS.map((s) => s.name).join(', ')}.`)
        return text(skillText(skill, typeof args.request === 'string' ? args.request : ''))
      }

      case 'read_log': {
        const log = project.compiler.rawLog()
        if (!log) throw new ToolError('There is no log yet. Compile first.')
        const n = Math.max(1, Math.min(400, Math.floor(Number(args.lines) || 80)))
        return text(log.trimEnd().split('\n').slice(-n).join('\n'))
      }

      default:
        throw new ToolError(`Unknown tool "${name}".`)
    }
  } catch (err) {
    if (err instanceof ToolError || err instanceof HttpError) return text(err.message, true)
    console.error(`Tool ${name} failed:`, err)
    return text(`The tool failed: ${(err as Error).message}`, true)
  }
}

/** project_info, read_file and search on another project or an attachment. */
async function callOnSource(project: Project, name: string, args: Record<string, unknown>, chat?: string): Promise<string> {
  if (name === 'project_info') return sourceInfo(project, chat, args.source)
  const { source, prefix } = sourceFor(project, chat, args.source)
  if (name === 'read_file') {
    const { rel, abs } = resolveInSource(source, args.path, prefix)
    if (!rel) throw new ToolError('path is required')
    if (isPdf(rel)) return readPdfPages(requirePdf(rel, abs), 1, 3)
    const all = readSourceText(source, rel, abs).split('\n')
    const start = Math.max(1, Math.floor(Number(args.start_line) || 1))
    const end = Math.min(all.length, Math.floor(Number(args.end_line) || all.length))
    if (start > all.length) throw new ToolError(`"${rel}" has only ${all.length} lines.`)
    let body = all.slice(start - 1, end).join('\n')
    let note = ''
    if (body.length > MAX_READ_CHARS) {
      body = body.slice(0, MAX_READ_CHARS)
      note = '\n[cut off: ask for a smaller line range to see the rest]'
    }
    return `${rel} in the ${sourceLabel(source)} (read-only), lines ${start}-${end} of ${all.length}:\n${body}${note}`
  }
  const query = String(args.query ?? '')
  if (!query) throw new ToolError('query is required')
  let re: RegExp
  try {
    re = args.regex ? new RegExp(query, 'i') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  } catch (err) {
    throw new ToolError(`Invalid regular expression: ${(err as Error).message}`)
  }
  const hits: string[] = []
  let total = 0
  for (const f of listFiles(source, prefix)) {
    if (!f.text) continue
    let content: string
    try {
      content = fs.readFileSync(f.abs, 'utf8')
    } catch {
      continue
    }
    content.split('\n').forEach((line, i) => {
      if (!re.test(line)) return
      total++
      if (hits.length < 60) hits.push(`${f.rel}:${i + 1}: ${line.trim().slice(0, 200)}`)
    })
  }
  if (!total) return `No matches for "${query}" in the ${sourceLabel(source)}.`
  return hits.join('\n') + (total > hits.length ? `\n[${total - hits.length} more matches not shown]` : '')
}

/**
 * Which project each MCP session works on. A session is pinned to the project open at its first
 * tool call, so when the user opens another project in the app, its next call is refused instead
 * of quietly changing a different document. The chat inside the app is checked by its chat id.
 */
const sessions = new Map<string, string | null>()
const MAX_SESSIONS = 500

export function newSession(): string {
  const id = crypto.randomUUID()
  sessions.set(id, null)
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!)
  return id
}

export type RpcContext = { chat?: string; session?: string }

/** An error result when this call must not touch the project that is open now, else null. */
function projectGuard(project: Project, name: string, args: Record<string, unknown>, ctx: RpcContext): ToolResult | null {
  if (ctx.chat) {
    if (project.ai.owns(ctx.chat)) return null
    return text(`Stop: this conversation belongs to another project, and the user has now opened "${project.settings.name}" in LaTeX Writer. Nothing was done. Do not continue; tell the user the task was interrupted because the project was switched.`, true)
  }
  if (!ctx.session) return null
  const pinned = sessions.get(ctx.session)
  // A session the server does not know (it restarted) starts over on the open project.
  if (pinned === undefined || pinned === null || (name === 'project_info' && args.switch === true)) {
    sessions.set(ctx.session, project.root)
    return null
  }
  if (pinned === project.root) return null
  return text(`Stop: the project open in LaTeX Writer changed from "${path.basename(pinned)}" to "${project.settings.name}" since you started. Nothing was done. Tell the user. Only if they want you to work on "${project.settings.name}" now, call project_info with switch: true, then carry on there.`, true)
}

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

/** Handles one JSON-RPC message. Returns null for notifications, which get no reply. */
export async function handleRpc(msg: RpcMessage, getProject: () => Project | null, ctx: RpcContext = {}): Promise<Record<string, unknown> | null> {
  const isNotification = msg.id === undefined || msg.id === null
  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } })
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request')

  switch (msg.method) {
    case 'initialize': {
      const wanted = String(msg.params?.protocolVersion ?? '')
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: MCP_SERVER_NAME, title: 'LaTeX Writer', version: '1.1.0' },
        instructions: INSTRUCTIONS,
      })
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    // The skills as prompts, so a Claude session outside the app can run them as /commands too.
    case 'prompts/list':
      return reply({
        prompts: SKILLS.map((s) => ({ name: s.name, description: s.description, arguments: [{ name: 'request', description: s.hint, required: false }] })),
      })
    case 'prompts/get': {
      const skill = findSkill(msg.params?.name)
      if (!skill) return fail(-32602, `Unknown prompt: ${String(msg.params?.name)}`)
      const request = (msg.params?.arguments as Record<string, unknown> | undefined)?.request
      return reply({ description: skill.description, messages: [{ role: 'user', content: { type: 'text', text: skillText(skill, typeof request === 'string' ? request : '') } }] })
    }
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`)
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      const project = getProject()
      if (!project) {
        return reply(text('No project is open in LaTeX Writer. Ask the user to open one in the app first.', true))
      }
      const refused = projectGuard(project, name, args, ctx)
      if (refused) return reply(refused)
      return reply(await callTool(project, name, args, ctx.chat))
    }
    default:
      if (isNotification) return null
      return fail(-32601, `Method not found: ${msg.method}`)
  }
}
