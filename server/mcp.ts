import fs from 'node:fs'
import path from 'node:path'
import { HttpError, isTextFile, resolveInside } from './paths.ts'
import { extractText, pageCount, renderPage } from './pdfrender.ts'
import type { Project, TreeNode } from './project.ts'

// A small MCP server (JSON-RPC over HTTP POST) that lets Claude work on the open project:
// read and search the sources, make edits that wait for the user's review, compile, and look
// at the result. It serves both the chat sidebar and Claude sessions outside the app.

export const MCP_SERVER_NAME = 'latexwriter'
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAX_READ_CHARS = 60_000

export const INSTRUCTIONS = `You are working on a LaTeX project that is open in the LaTeX Writer app.

How changes work:
- edit_file and write_file change the document immediately, and the user sees the change live.
- Every change stays "pending" until the user accepts or declines it in the app. The text from before
  your change is kept as a backup, so nothing you do is lost. Do not ask for permission before each
  edit; make the edit and say briefly what you changed.
- If the user declined a change, do not make it again unless asked.

How to work efficiently:
- Start with project_info. Read only the files and line ranges you need.
- After editing, run compile and fix any errors it reports before you finish.
- To check what the PDF says, use read_pdf_text. Use view_page only for questions about layout
  (figures, tables, spacing, page breaks): an image costs far more than text.
- Keep edits minimal and keep the author's style. Do not reformat text you were not asked to change.

Limits of this setup: no shell escape (so no minted), EPS figures do not convert under pdfLaTeX,
and LuaLaTeX is refused while the project is shared on the network.`

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> }

const str = (description: string): Record<string, unknown> => ({ type: 'string', description })
const int = (description: string): Record<string, unknown> => ({ type: 'integer', description })

export const TOOLS: Tool[] = [
  {
    name: 'project_info',
    description: 'Overview of the open project: name, main file, every file with its size, the state of the last compile, and changes waiting for review. Call this first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_file',
    description: 'Read a text file of the project (the live text, including unsaved edits). Give a line range for large files.',
    inputSchema: {
      type: 'object',
      properties: { path: str('Project-relative path, e.g. "main.tex" or "chapters/intro.tex"'), start_line: int('First line to return (1-based)'), end_line: int('Last line to return') },
      required: ['path'],
    },
  },
  {
    name: 'search',
    description: 'Find text across all text files of the project. Returns matching lines as "file:line: text".',
    inputSchema: {
      type: 'object',
      properties: { query: str('Text to find, or a regular expression when regex is true'), regex: { type: 'boolean', description: 'Treat query as a JavaScript regular expression' } },
      required: ['query'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact piece of text in a file. old_text must match the file exactly (including whitespace and line breaks) and must occur exactly once unless replace_all is true. The change waits for the user\'s review.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('Project-relative path'),
        old_text: str('The exact text to replace'),
        new_text: str('The text to put in its place'),
        replace_all: { type: 'boolean', description: 'Replace every occurrence' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'write_file',
    description: 'Create a new text file, or replace the whole content of an existing one. Prefer edit_file for changes to existing files. The change waits for the user\'s review.',
    inputSchema: {
      type: 'object',
      properties: { path: str('Project-relative path'), content: str('The full new content') },
      required: ['path', 'content'],
    },
  },
  {
    name: 'compile',
    description: 'Compile the project with LaTeX and wait for the result: errors and warnings with file and line, and the number of pages.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_pdf_text',
    description: 'The text of the compiled PDF, page by page. Use this to check content and numbering; it is much cheaper than view_page.',
    inputSchema: { type: 'object', properties: { first_page: int('First page (default 1)'), last_page: int('Last page (default: first_page + 4)') } },
  },
  {
    name: 'view_page',
    description: 'An image of one page of the compiled PDF, for layout questions. Give from/to to look at part of the page in more detail.',
    inputSchema: {
      type: 'object',
      properties: {
        page: int('Page number (1-based)'),
        from: { type: 'number', description: 'Top of the band to show, as a fraction of the page height (0 = top). Default 0.' },
        to: { type: 'number', description: 'Bottom of the band, as a fraction of the page height (1 = bottom). Default 1.' },
        detail: { type: 'string', enum: ['normal', 'high'], description: 'high gives a sharper image at a higher cost. Default normal.' },
      },
      required: ['page'],
    },
  },
  {
    name: 'read_log',
    description: 'The end of the raw LaTeX log of the last compile, when the parsed errors are not enough.',
    inputSchema: { type: 'object', properties: { lines: int('How many lines from the end (default 80, max 400)') } },
  },
]

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
type ToolResult = { content: Content[]; isError?: boolean }

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] })

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
  return `${r.status}, ${r.errorCount} error${r.errorCount === 1 ? '' : 's'}, ${r.warningCount} warning${r.warningCount === 1 ? '' : 's'}`
}

export async function callTool(project: Project, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
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
          ? review.files.map((f) => `  ${f.path}: ${f.status === 'added' ? 'new file' : `${f.hunks.length} change${f.hunks.length === 1 ? '' : 's'}`}`).join('\n')
          : '  none'
        return text(
          `Project: ${project.settings.name}\nMain file: ${project.settings.mainFile}\nLast compile: ${describeBuild(project)}\n\nFiles:\n${lines.join('\n')}\n\nChanges waiting for the user's review:\n${pending}`,
        )
      }

      case 'read_file': {
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
        const oldText = String(args.old_text ?? '')
        const newText = String(args.new_text ?? '')
        if (!oldText) throw new ToolError('old_text is required. To create a file use write_file.')
        if (oldText === newText) throw new ToolError('old_text and new_text are the same.')
        const current = project.docs.read(rel)
        const count = current.split(oldText).length - 1
        if (count === 0) throw new ToolError(`old_text was not found in "${rel}". Read the file again: the text must match exactly, including whitespace and line breaks.`)
        if (count > 1 && !args.replace_all) throw new ToolError(`old_text occurs ${count} times in "${rel}". Include more surrounding text to make it unique, or set replace_all.`)
        const next = args.replace_all ? current.split(oldText).join(newText) : current.replace(oldText, () => newText)
        project.applyAssistantEdit(rel, next)
        const line = current.slice(0, current.indexOf(oldText)).split('\n').length
        return text(`Edited ${rel} at line ${line}${count > 1 ? ` (${count} places)` : ''}. The change is pending the user's review.`)
      }

      case 'write_file': {
        const { rel, abs } = resolveInside(project.root, args.path)
        if (typeof args.content !== 'string') throw new ToolError('content is required')
        if (fs.existsSync(abs)) {
          if (!fs.statSync(abs).isFile() || !isTextFile(abs, rel)) throw new ToolError(`"${rel}" exists and is not a text file.`)
        } else if (!fs.existsSync(path.dirname(abs))) {
          fs.mkdirSync(path.dirname(abs), { recursive: true })
        }
        const existed = fs.existsSync(abs)
        project.applyAssistantEdit(rel, args.content)
        return text(`${existed ? 'Replaced the content of' : 'Created'} ${rel}. The change is pending the user's review.`)
      }

      case 'compile': {
        const r = await project.compile(true)
        const pdf = project.compiler.currentPdf()
        let pages = 0
        if (pdf) {
          try {
            pages = await pageCount(pdf.file)
          } catch {}
        }
        const shown = r.entries.filter((e) => e.severity !== 'info').slice(0, 30)
        const list = shown.map((e) => {
          const where = e.file ? `${e.file}${e.line ? `:${e.line}` : ''}: ` : ''
          return `${e.severity.toUpperCase()} ${where}${e.message}${e.detail ? `\n    ${e.detail}` : ''}${e.hint ? `\n    ${e.hint}` : ''}`
        })
        const hidden = r.errorCount + r.warningCount - shown.length
        return text(
          `Compile ${r.status} (${r.engine}, ${(r.durationMs / 1000).toFixed(1)} s). ${r.errorCount} error${r.errorCount === 1 ? '' : 's'}, ${r.warningCount} warning${r.warningCount === 1 ? '' : 's'}${pages ? `, ${pages} page${pages === 1 ? '' : 's'}` : ', no PDF'}.` +
            (list.length ? `\n\n${list.join('\n')}` : '') +
            (hidden > 0 ? `\n[${hidden} more not shown; use read_log]` : ''),
        )
      }

      case 'read_pdf_text': {
        const pdf = project.compiler.currentPdf()
        if (!pdf) throw new ToolError('There is no PDF yet. Run compile first.')
        const first = Math.max(1, Math.floor(Number(args.first_page) || 1))
        const last = Math.floor(Number(args.last_page) || first + 4)
        const out = await extractText(pdf.file, first, last)
        let body = out.text || '(these pages contain no text)'
        if (body.length > MAX_READ_CHARS) body = body.slice(0, MAX_READ_CHARS) + '\n[cut off: ask for fewer pages]'
        return text(`PDF has ${out.pages} page${out.pages === 1 ? '' : 's'}.\n\n${body}`)
      }

      case 'view_page': {
        const pdf = project.compiler.currentPdf()
        if (!pdf) throw new ToolError('There is no PDF yet. Run compile first.')
        const from = args.from === undefined ? 0 : Number(args.from)
        const to = args.to === undefined ? 1 : Number(args.to)
        if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > 1 || from >= to) throw new ToolError('from and to must be fractions with 0 <= from < to <= 1.')
        // A band of the page gets the full pixel budget, so it comes out sharper than the whole page.
        const band = to - from
        const budget = args.detail === 'high' ? 1800 : 1200
        const out = await renderPage(pdf.file, Math.floor(Number(args.page)), { maxEdge: Math.min(2400, budget / Math.max(band, 0.5)), from, to })
        return {
          content: [
            { type: 'text', text: `Page ${Math.floor(Number(args.page))} of ${out.pages}${band < 1 ? ` (from ${from} to ${to} of the page height)` : ''}, ${out.width}x${out.height} px.` },
            { type: 'image', data: out.png.toString('base64'), mimeType: 'image/png' },
          ],
        }
      }

      case 'read_log': {
        const log = project.compiler.rawLog()
        if (!log) throw new ToolError('There is no log yet. Run compile first.')
        const n = Math.max(1, Math.min(400, Math.floor(Number(args.lines) || 80)))
        return text(log.trimEnd().split('\n').slice(-n).join('\n'))
      }

      default:
        throw new ToolError(`Unknown tool "${name}".`)
    }
  } catch (err) {
    if (err instanceof ToolError || err instanceof HttpError) return { content: [{ type: 'text', text: err.message }], isError: true }
    console.error(`Tool ${name} failed:`, err)
    return { content: [{ type: 'text', text: `The tool failed: ${(err as Error).message}` }], isError: true }
  }
}

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

/** Handles one JSON-RPC message. Returns null for notifications, which get no reply. */
export async function handleRpc(msg: RpcMessage, getProject: () => Project | null): Promise<Record<string, unknown> | null> {
  const isNotification = msg.id === undefined || msg.id === null
  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } })
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request')

  switch (msg.method) {
    case 'initialize': {
      const wanted = String(msg.params?.protocolVersion ?? '')
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, title: 'LaTeX Writer', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      })
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      const project = getProject()
      if (!project) {
        return reply({ content: [{ type: 'text', text: 'No project is open in LaTeX Writer. Ask the user to open one in the app first.' }], isError: true })
      }
      return reply(await callTool(project, name, args))
    }
    default:
      if (isNotification) return null
      return fail(-32601, `Method not found: ${msg.method}`)
  }
}
