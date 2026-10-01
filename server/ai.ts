import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { APP_HOME, writeFileAtomic } from './config.ts'
import { broadcast } from './hub.ts'
import { INSTRUCTIONS, MCP_SERVER_NAME } from './mcp.ts'
import { HttpError, INTERNAL_DIR } from './paths.ts'

/**
 * The chat sidebar. Each message runs the user's own Claude Code CLI in headless mode, which is
 * signed in with their Claude subscription, so no API key is involved. Claude Code gets no
 * built-in tools at all: it can only act through this app's MCP tools.
 */

export const MODELS = ['sonnet', 'haiku', 'opus'] as const
export type Model = (typeof MODELS)[number]
export const EFFORTS = ['low', 'medium', 'high'] as const
export type Effort = (typeof EFFORTS)[number]

export type ChatPart =
  | { kind: 'text'; text: string }
  /** parent: the helper-agent call this step belongs to, when a helper made it. */
  | { kind: 'tool'; id: string; label: string; status: 'running' | 'done' | 'error'; parent?: string }

export type ChatMessage = { id: string; role: 'user' | 'assistant'; parts: ChatPart[]; error?: string; t: number }
export type ChatContext = { file?: string; line?: number; selection?: string; selectionStart?: number; selectionEnd?: number }
export type Usage = { fiveHour?: number; sevenDay?: number; resetsAt?: number; /** Tokens the main conversation currently re-sends every step. */ context?: number }

const CLI_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.claude/local')]

/** Finds the Claude Code CLI even when the server was started from Finder with a bare PATH. */
export function findClaudeCli(): string | null {
  const dirs = [...(process.env.PATH ?? '').split(':'), ...CLI_DIRS]
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = path.join(dir, 'claude')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

const t = (name: string): string => `mcp__${MCP_SERVER_NAME}__${name}`

/**
 * Helper agents. Each starts with an empty context and only returns a short report, so long files,
 * PDF text and page images never enter the main conversation, which every later step re-sends.
 */
export const HELPER_AGENTS = {
  reader: {
    description: 'Reads and searches the project sources and the PDF text, and answers a specific question about them in a few lines. Use it instead of reading long files or many pages yourself.',
    prompt: 'You answer one question about a LaTeX project by reading its files and the compiled PDF text with your tools. Read only what you need (use search and line ranges). Reply with a short, precise answer: quote at most a few lines, and give file:line references so the caller can edit directly. Never paste whole sections.',
    tools: [t('project_info'), t('read_file'), t('search'), t('read_pdf_text')],
    model: 'haiku',
  },
  'layout-checker': {
    description: 'Checks the layout of the compiled PDF (page breaks, figure and table placement, spacing, overfull lines) and reports concrete problems with page numbers and the source lines responsible. Use it for any visual check instead of looking at pages yourself.',
    prompt: 'You check the layout of a compiled LaTeX document and report problems. Start with check_layout (text). Look at images only where it leaves a question open: first an overview of several pages with view_page pages: [..], then a band of one page with from/to if you need detail. Never edit files. Reply with a short list: page, what is wrong, the likely source location (file:line), and a suggested fix. If everything looks fine, say so in one line.',
    tools: [t('check_layout'), t('view_page'), t('read_pdf_text'), t('search'), t('read_file'), t('project_info')],
    model: 'haiku',
  },
  writer: {
    description: 'Carries out a clearly specified piece of writing or editing across the project (for example: rewrite a section along given lines, restructure a chapter, fix all errors of a kind), compiles, fixes errors it caused, and reports what it changed. Give it complete instructions; it cannot see this conversation.',
    prompt: 'You make the requested changes to a LaTeX project with your tools, keeping the author\'s style and changing nothing else. Put all changes to a file in one edit_file call with several edits; pass compile: false on all but the last call. Follow the project notes and writing preferences that project_info shows. Fix compile errors you caused. Your changes wait for the user\'s review, so do not ask for confirmation. Reply with a short summary of what changed where (file:line); do not paste the new text.',
    tools: [t('project_info'), t('read_file'), t('search'), t('edit_file'), t('write_file'), t('compile'), t('check_layout'), t('read_log')],
    model: 'sonnet',
  },
} as const

const SYSTEM_PROMPT = `You are the writing assistant inside LaTeX Writer, a LaTeX editor. The user is writing a document and chats with you in a sidebar next to the editor and the PDF.

${INSTRUCTIONS}

Helper agents (the Agent tool): reader, layout-checker and writer. Each starts fresh, does its part
with the same tools, and returns a short report, so its reading, page images and intermediate steps
do not fill up this conversation.
- Delegate: reading long files or many PDF pages (reader), every visual or layout check
  (layout-checker), and large or multi-file writing jobs (writer).
- Do it yourself: small edits, short reads, and anything needing the context of this conversation.
- Give a helper a complete, self-contained task (it cannot see this conversation) and ask for a
  short report. Independent helpers can run at the same time.
- Always set run_in_background to false, so you receive the report before you answer.
- Use only these three helpers.

Answering:
- Be brief. The sidebar is narrow: short paragraphs, no tables, no headings.
- The sidebar typesets math. Write formulas as inline $...$ and display math as $$...$$ on its own lines (no \\( \\) or \\[ \\]). Write prices without a dollar sign or as \\$5. Put LaTeX source that is meant to be copied into the document, such as \\textbf{x} or an environment, in backticks or a code block, so it shows as text and is not typeset.
- Refer to files by their project path, optionally with a line, like sections/method.tex:42. The sidebar turns these into links that open the file.
- Mention a label or citation key on its own in backticks, like \`eq:E\` or \`knuth1984\` (or \\ref{eq:E}, \\cite{knuth1984}). The sidebar links it to where it is defined. Do not use backticks around ordinary words.
- Do not paste back whole files or long passages the user can already see in the editor.
- Notes you add to the project notes need no comment. If you changed the author's writing preferences, say so in one sentence.
- When you changed something, say in one or two sentences what changed and where. The user sees the exact changes in the review list.
- If a request is ambiguous, ask one short question instead of guessing.
- Answer in the language the user writes in.`

function toolLabel(name: string, input: Record<string, unknown>): string {
  const tool = name.replace(`mcp__${MCP_SERVER_NAME}__`, '')
  const file = typeof input.path === 'string' ? input.path : ''
  switch (tool) {
    case 'project_info': return 'Looked at the project'
    case 'read_file': return `Read ${file}${input.start_line ? ` (lines ${input.start_line}-${input.end_line ?? 'end'})` : ''}`
    case 'search': return `Searched for "${String(input.query ?? '').slice(0, 40)}"`
    case 'edit_file': return `Edited ${file}`
    case 'write_file': return `Wrote ${file}`
    case 'read_notes': return 'Read the notes'
    case 'update_notes': return input.file === 'preferences' ? 'Updated your writing preferences' : 'Updated the project notes (INSTRUCTIONS.md)'
    case 'compile': return 'Compiled'
    case 'read_pdf_text': return 'Read the PDF text'
    case 'view_page': return Array.isArray(input.pages) ? `Looked at pages ${input.pages.join(', ')}` : `Looked at page ${input.page ?? ''}${input.from !== undefined || input.to !== undefined ? ' (part)' : ''}`
    case 'check_layout': return 'Checked the layout'
    case 'read_log': return 'Read the LaTeX log'
    case 'Agent':
    case 'Task': return `${String(input.subagent_type ?? 'Helper').replace(/^./, (c) => c.toUpperCase())}: ${String(input.description ?? '').slice(0, 80)}`
    default: return tool
  }
}

/** One conversation: its messages and the Claude Code session that holds its context. */
type Chat = {
  id: string
  sessionId: string | null
  messages: ChatMessage[]
  /** A turn was started and has not finished: if it is still set when the app starts, the app was closed mid-turn. */
  interrupted?: boolean
  /** How many times in a row an interrupted turn was picked up again. */
  attempts?: number
}
type Saved = { active?: Chat; archive?: Chat[]; sessionId?: string | null; messages?: ChatMessage[] }
export type ChatSummary = { id: string; title: string; t: number; active: boolean }
/** Chats kept per project, the one in use included. The oldest are dropped past this. */
export const MAX_CHATS = 10
const newChat = (): Chat => ({ id: crypto.randomUUID(), sessionId: null, messages: [] })

let serverPort = 0
/** The port this server answers on; Claude Code is pointed back at it for the tools. */
export function setAiPort(port: number): void {
  serverPort = port
}

export type AiHost = {
  root: string
  /** Compact description of the project for the first message of a conversation. */
  overview: () => string
}

export class AiChat {
  private host: AiHost
  private file: string
  private cwd: string
  private active: Chat = newChat()
  private disposed = false
  /** Earlier chats, newest first. */
  private archive: Chat[] = []
  private child: ChildProcess | null = null
  private current: ChatMessage | null = null
  private stopRequested = false
  usage: Usage = {}

  constructor(host: AiHost) {
    this.host = host
    this.file = path.join(host.root, INTERNAL_DIR, 'ai-chat.json')
    // Claude Code keeps conversations per working folder. Use a private, empty one per project
    // so it picks up no project instructions or settings of its own.
    this.cwd = path.join(APP_HOME, 'ai', crypto.createHash('sha1').update(host.root).digest('hex').slice(0, 16))
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Saved
      const valid = (c: unknown): c is Chat => !!c && typeof (c as Chat).id === 'string' && Array.isArray((c as Chat).messages)
      // Older versions kept a single chat.
      this.active = valid(saved.active) ? saved.active
        : { id: crypto.randomUUID(), sessionId: typeof saved.sessionId === 'string' ? saved.sessionId : null, messages: Array.isArray(saved.messages) ? saved.messages : [] }
      this.archive = Array.isArray(saved.archive) ? saved.archive.filter(valid) : []
      this.trim()
      // A turn that was cut off by a restart can never finish.
      for (const c of [this.active, ...this.archive]) for (const m of c.messages) for (const p of m.parts) if (p.kind === 'tool' && p.status === 'running') p.status = 'error'
    } catch {}
  }

  private get sessionId(): string | null {
    return this.active.sessionId
  }

  private set sessionId(id: string | null) {
    this.active.sessionId = id
  }

  get messages(): ChatMessage[] {
    return this.active.messages
  }

  /** Drops the oldest chats so that, with the one in use, at most MAX_CHATS remain. */
  private trim(): void {
    this.archive.length = Math.min(this.archive.length, this.active.messages.length ? MAX_CHATS - 1 : MAX_CHATS)
  }

  get busy(): boolean {
    return this.child !== null
  }

  private persist(): void {
    if (!fs.existsSync(this.host.root)) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileAtomic(this.file, JSON.stringify({ active: this.cut(this.active), archive: this.archive.map((c) => this.cut(c)) } satisfies Saved))
    } catch (err) {
      console.error('Could not save the chat:', (err as Error).message)
    }
  }

  private cut(chat: Chat): Chat {
    return { ...chat, messages: chat.messages.slice(-200) }
  }

  private emit(event: Record<string, unknown>): void {
    broadcast('ai', event, 'host')
  }

  /** Every chat worth keeping, the one in use first, then the newest. */
  list(): ChatSummary[] {
    const summary = (c: Chat, active: boolean): ChatSummary => {
      const first = c.messages.find((m) => m.role === 'user')?.parts.find((p) => p.kind === 'text')
      const title = (first?.kind === 'text' ? first.text : '').replace(/\s+/g, ' ').trim().slice(0, 70) || 'New chat'
      return { id: c.id, title, t: c.messages[c.messages.length - 1]?.t ?? 0, active }
    }
    return [...(this.active.messages.length ? [summary(this.active, true)] : []), ...this.archive.map((c) => summary(c, false))]
  }

  state(): Record<string, unknown> {
    return { messages: this.messages, busy: this.busy, usage: this.usage, chats: this.list(), activeId: this.active.id }
  }

  /** Tells the panel to show whichever chat is now in use. */
  private loaded(): void {
    this.usage = { ...this.usage, context: undefined }
    this.persist()
    this.emit({ kind: 'loaded', ...this.state() })
  }

  /** Puts the chat in use on the shelf, if there is anything in it. */
  private shelve(): void {
    if (this.active.messages.length) this.archive.unshift(this.active)
  }

  /** Starts a fresh chat; the one in use stays in the list. */
  reset(): void {
    this.stop()
    this.shelve()
    this.active = newChat()
    this.trim()
    this.loaded()
  }

  open(id: unknown): void {
    if (this.busy) throw new HttpError(409, 'Stop the assistant before switching chats')
    const i = this.archive.findIndex((c) => c.id === id)
    if (i < 0) return
    const [chat] = this.archive.splice(i, 1)
    this.shelve()
    this.active = chat
    this.trim()
    this.loaded()
  }

  remove(id: unknown): void {
    if (id === this.active.id) {
      this.stop()
      this.active = newChat()
    } else {
      this.archive = this.archive.filter((c) => c.id !== id)
    }
    this.loaded()
  }

  stop(): void {
    const child = this.child
    if (!child) return
    // The user chose to end this turn, so it must not be picked up again later.
    this.active.interrupted = false
    this.stopRequested = true
    child.kill('SIGTERM')
    setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 2000).unref()
  }

  private buildPrompt(text: string, context: ChatContext): string {
    const lines: string[] = []
    if (!this.sessionId) lines.push(this.host.overview())
    if (context.file) lines.push(`The user has ${context.file} open${context.line ? `, cursor at line ${context.line}` : ''}.`)
    if (context.selection?.trim()) {
      const range = context.selectionStart ? ` (lines ${context.selectionStart}-${context.selectionEnd ?? context.selectionStart})` : ''
      lines.push(`Selected text${range}:\n${context.selection.slice(0, 6000)}`)
    }
    return lines.length ? `<context>\n${lines.join('\n')}\n</context>\n\n${text}` : text
  }

  send(textInput: unknown, context: ChatContext, model: Model, effort: Effort): void {
    const text = typeof textInput === 'string' ? textInput.trim() : ''
    if (!text) throw new HttpError(400, 'Write a message first')
    if (text.length > 20_000) throw new HttpError(400, 'That message is too long')
    if (this.busy) throw new HttpError(409, 'The assistant is still working on the previous message')
    const cli = findClaudeCli()
    if (!cli) throw new HttpError(503, 'Claude Code was not found on this Mac. Install it and sign in with your Claude account.')

    const user: ChatMessage = { id: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text }], t: Date.now() }
    const reply: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', parts: [], t: Date.now() }
    this.messages.push(user, reply)
    this.active.interrupted = true
    this.active.attempts = 0
    this.trim()
    this.persist()
    this.current = reply
    this.emit({ kind: 'message', message: user })
    this.emit({ kind: 'message', message: reply })
    this.run(cli, this.buildPrompt(text, context), model, effort, reply, true)
  }

  private run(cli: string, prompt: string, model: Model, effort: Effort, reply: ChatMessage, mayRetry: boolean): void {
    fs.mkdirSync(this.cwd, { recursive: true })
    const mcpConfig = JSON.stringify({
      mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: `http://127.0.0.1:${serverPort}/mcp` } },
    })
    const args = [
      '-p',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', model,
      '--effort', effort,
      // Summarise the conversation before it grows past this, instead of re-sending it all every step.
      '--autocompact', '100k',
      // No built-in tools except the one that starts helper agents; no user plugins, skills, hooks or
      // other MCP servers: only this app's tools.
      '--tools', 'Agent',
      '--agents', JSON.stringify(HELPER_AGENTS),
      '--mcp-config', mcpConfig, '--strict-mcp-config',
      '--allowedTools', `mcp__${MCP_SERVER_NAME}`, 'Agent',
      '--setting-sources', '',
      '--disable-slash-commands',
      '--permission-prompts', 'none',
      '--system-prompt', SYSTEM_PROMPT,
    ]
    const resuming = this.sessionId
    if (resuming) args.push('--resume', resuming)

    // A clean environment: an API key or a parent Claude Code session must not leak in, or the
    // request would be billed to the API or behave like a nested session.
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (/^(ANTHROPIC_|CLAUDE|MCP_)/.test(key)) continue
      env[key] = value
    }
    env.PATH = [...CLI_DIRS, env.PATH ?? '/usr/bin:/bin'].join(':')

    const child = spawn(cli, args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.stopRequested = false
    this.emit({ kind: 'busy', busy: true })
    child.stdin!.end(prompt)

    let buffer = ''
    let stderr = ''
    let gotResult = false
    let producedAnything = false
    const tools = new Map<string, Extract<ChatPart, { kind: 'tool' }>>()

    const appendText = (delta: string): void => {
      const last = reply.parts[reply.parts.length - 1]
      if (last?.kind === 'text') last.text += delta
      else reply.parts.push({ kind: 'text', text: delta })
      producedAnything = true
      this.emit({ kind: 'delta', id: reply.id, text: delta })
    }

    const handle = (ev: any): void => {
      if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string') {
        this.sessionId = ev.session_id
      } else if (ev.type === 'stream_event') {
        // Only the main conversation is streamed into the chat; helpers report through their result.
        if (ev.parent_tool_use_id) return
        const e = ev.event
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') appendText(e.delta.text)
        if (e?.type === 'message_start' && e.message?.usage) {
          const u = e.message.usage
          this.usage = { ...this.usage, context: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) }
          this.emit({ kind: 'usage', usage: this.usage })
        }
      } else if (ev.type === 'assistant') {
        const parent = typeof ev.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : undefined
        for (const block of ev.message?.content ?? []) {
          if (block.type !== 'tool_use' || tools.has(block.id)) continue
          const part: Extract<ChatPart, { kind: 'tool' }> = { kind: 'tool', id: block.id, label: toolLabel(String(block.name), block.input ?? {}), status: 'running' }
          if (parent) part.parent = parent
          tools.set(block.id, part)
          reply.parts.push(part)
          producedAnything = true
          this.emit({ kind: 'tool', id: reply.id, part })
        }
      } else if (ev.type === 'user') {
        const content = ev.message?.content
        for (const block of Array.isArray(content) ? content : []) {
          if (block.type !== 'tool_result') continue
          const part = tools.get(block.tool_use_id)
          if (!part) continue
          part.status = block.is_error ? 'error' : 'done'
          this.emit({ kind: 'tool', id: reply.id, part })
        }
      } else if (ev.type === 'rate_limit_event') {
        const w = ev.rate_limit_info?.unifiedWindows
        this.usage = {
          ...this.usage,
          fiveHour: w?.five_hour?.utilization,
          sevenDay: w?.seven_day?.utilization,
          resetsAt: w?.five_hour?.resetsAt ? w.five_hour.resetsAt * 1000 : undefined,
        }
        this.emit({ kind: 'usage', usage: this.usage })
      } else if (ev.type === 'result') {
        // A helper left running in the background produces a second result later; keep the last.
        gotResult = true
        delete reply.error
        if (ev.is_error) reply.error = typeof ev.result === 'string' && ev.result ? ev.result : 'The assistant stopped with an error.'
        else if (!reply.parts.some((p) => p.kind === 'text') && typeof ev.result === 'string' && ev.result) appendText(ev.result)
      }
    }

    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try {
          handle(JSON.parse(line))
        } catch {}
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8')
    })

    let finished = false
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void => {
      if (finished || this.disposed) return
      finished = true
      if (this.child === child) this.child = null
      // The saved conversation is gone on Claude Code's side (cleared, or a new Mac): start a fresh one.
      if (resuming && mayRetry && !this.stopRequested && !producedAnything && !gotResult && code !== 0 && !signal && /session|conversation|resume/i.test(stderr)) {
        this.sessionId = null
        this.run(cli, `${this.host.overview()}\n\n${prompt}`, model, effort, reply, false)
        return
      }
      for (const part of tools.values()) if (part.status === 'running') part.status = 'error'
      if (spawnError) reply.error = `Claude Code could not be started: ${spawnError.message}`
      else if (signal || this.stopRequested) reply.error = 'Stopped.'
      else if (!gotResult && code !== 0) reply.error = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400) || `Claude Code exited with code ${code}.`
      if (reply.error && /log ?in|not logged|authenticat|\/login/i.test(reply.error)) {
        reply.error = 'Claude Code is not signed in. Open Terminal, run "claude", and sign in with your Claude account.'
      }
      this.current = null
      this.active.interrupted = false
      this.persist()
      this.emit({ kind: 'done', message: reply })
      this.emit({ kind: 'busy', busy: false })
    }
    child.on('error', (err) => finish(null, null, err))
    child.on('close', (code, signal) => finish(code, signal))
  }

  /**
   * Picks up a turn that the app was closed in the middle of (quit, crash, project closed). Called
   * when the panel opens, so nothing runs for a user who is not looking at the assistant.
   */
  resumeInterrupted(model: Model, effort: Effort): void {
    const chat = this.active
    if (!chat.interrupted || this.busy || this.disposed) return
    const cli = findClaudeCli()
    if (!cli) return
    // A turn that keeps dying (for example because it brings the app down) is not retried for ever.
    if ((chat.attempts ?? 0) >= 2) {
      chat.interrupted = false
      this.persist()
      return
    }
    chat.attempts = (chat.attempts ?? 0) + 1
    const last = this.messages[this.messages.length - 1]
    if (last && last.role === 'assistant' && !last.error) last.error = 'Interrupted.'
    const reply: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', parts: [], t: Date.now() }
    this.messages.push(reply)
    this.current = reply
    this.emit({ kind: 'message', message: reply })
    const note = 'The app was closed while you were working on the previous request, so it was cut off. Check the current state of the files, then carry on and finish that request. Do not redo what is already done.'
    this.run(cli, this.sessionId ? note : `${this.host.overview()}\n\n${note}`, model, effort, reply, true)
  }

  dispose(): void {
    this.disposed = true
    const child = this.child
    this.child = null
    child?.kill('SIGKILL')
    if (this.current) {
      // Left marked as interrupted: it is picked up again the next time the assistant is opened.
      if (!this.current.error) this.current.error = 'Interrupted.'
      this.persist()
    }
  }
}
