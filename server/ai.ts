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

export type ChatPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; label: string; status: 'running' | 'done' | 'error' }

export type ChatMessage = { id: string; role: 'user' | 'assistant'; parts: ChatPart[]; error?: string; t: number }
export type ChatContext = { file?: string; line?: number; selection?: string; selectionStart?: number; selectionEnd?: number }
export type Usage = { fiveHour?: number; sevenDay?: number; resetsAt?: number }

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

const SYSTEM_PROMPT = `You are the writing assistant inside LaTeX Writer, a LaTeX editor. The user is writing a document and chats with you in a sidebar next to the editor and the PDF.

${INSTRUCTIONS}

Answering:
- Be brief. The sidebar is narrow: short paragraphs, no tables, no headings.
- Do not paste back whole files or long passages the user can already see in the editor.
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
    case 'compile': return 'Compiled'
    case 'read_pdf_text': return 'Read the PDF text'
    case 'view_page': return `Looked at page ${input.page ?? ''}`
    case 'read_log': return 'Read the LaTeX log'
    default: return tool
  }
}

type Saved = { sessionId: string | null; messages: ChatMessage[] }

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
  private sessionId: string | null = null
  private child: ChildProcess | null = null
  private current: ChatMessage | null = null
  private stopRequested = false
  messages: ChatMessage[] = []
  usage: Usage = {}

  constructor(host: AiHost) {
    this.host = host
    this.file = path.join(host.root, INTERNAL_DIR, 'ai-chat.json')
    // Claude Code keeps conversations per working folder. Use a private, empty one per project
    // so it picks up no project instructions or settings of its own.
    this.cwd = path.join(APP_HOME, 'ai', crypto.createHash('sha1').update(host.root).digest('hex').slice(0, 16))
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Saved
      this.sessionId = typeof saved.sessionId === 'string' ? saved.sessionId : null
      this.messages = Array.isArray(saved.messages) ? saved.messages : []
      // A turn that was cut off by a restart can never finish.
      for (const m of this.messages) for (const p of m.parts) if (p.kind === 'tool' && p.status === 'running') p.status = 'error'
    } catch {}
  }

  get busy(): boolean {
    return this.child !== null
  }

  private persist(): void {
    if (!fs.existsSync(this.host.root)) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileAtomic(this.file, JSON.stringify({ sessionId: this.sessionId, messages: this.messages.slice(-200) } satisfies Saved))
    } catch (err) {
      console.error('Could not save the chat:', (err as Error).message)
    }
  }

  private emit(event: Record<string, unknown>): void {
    broadcast('ai', event, 'host')
  }

  state(): Record<string, unknown> {
    return { messages: this.messages, busy: this.busy, usage: this.usage }
  }

  reset(): void {
    this.stop()
    this.sessionId = null
    this.messages = []
    this.persist()
    this.emit({ kind: 'reset' })
  }

  stop(): void {
    const child = this.child
    if (!child) return
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

  send(textInput: unknown, context: ChatContext, model: Model): void {
    const text = typeof textInput === 'string' ? textInput.trim() : ''
    if (!text) throw new HttpError(400, 'Write a message first')
    if (text.length > 20_000) throw new HttpError(400, 'That message is too long')
    if (this.busy) throw new HttpError(409, 'The assistant is still working on the previous message')
    const cli = findClaudeCli()
    if (!cli) throw new HttpError(503, 'Claude Code was not found on this Mac. Install it and sign in with your Claude account.')

    const user: ChatMessage = { id: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text }], t: Date.now() }
    const reply: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', parts: [], t: Date.now() }
    this.messages.push(user, reply)
    this.current = reply
    this.emit({ kind: 'message', message: user })
    this.emit({ kind: 'message', message: reply })
    this.run(cli, this.buildPrompt(text, context), model, reply, true)
  }

  private run(cli: string, prompt: string, model: Model, reply: ChatMessage, mayRetry: boolean): void {
    fs.mkdirSync(this.cwd, { recursive: true })
    const mcpConfig = JSON.stringify({
      mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: `http://127.0.0.1:${serverPort}/mcp` } },
    })
    const args = [
      '-p',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', model,
      // No built-in tools, no user plugins, skills, hooks or other MCP servers: only this app's tools.
      '--tools', '',
      '--mcp-config', mcpConfig, '--strict-mcp-config',
      '--allowedTools', `mcp__${MCP_SERVER_NAME}`,
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
        const e = ev.event
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') appendText(e.delta.text)
      } else if (ev.type === 'assistant') {
        for (const block of ev.message?.content ?? []) {
          if (block.type !== 'tool_use' || tools.has(block.id)) continue
          const part: Extract<ChatPart, { kind: 'tool' }> = { kind: 'tool', id: block.id, label: toolLabel(String(block.name), block.input ?? {}), status: 'running' }
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
          fiveHour: w?.five_hour?.utilization,
          sevenDay: w?.seven_day?.utilization,
          resetsAt: w?.five_hour?.resetsAt ? w.five_hour.resetsAt * 1000 : undefined,
        }
        this.emit({ kind: 'usage', usage: this.usage })
      } else if (ev.type === 'result') {
        gotResult = true
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
      if (finished) return
      finished = true
      if (this.child === child) this.child = null
      // The saved conversation is gone on Claude Code's side (cleared, or a new Mac): start a fresh one.
      if (resuming && mayRetry && !this.stopRequested && !producedAnything && !gotResult && code !== 0 && !signal && /session|conversation|resume/i.test(stderr)) {
        this.sessionId = null
        this.run(cli, `${this.host.overview()}\n\n${prompt}`, model, reply, false)
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
      this.persist()
      this.emit({ kind: 'done', message: reply })
      this.emit({ kind: 'busy', busy: false })
    }
    child.on('error', (err) => finish(null, null, err))
    child.on('close', (code, signal) => finish(code, signal))
  }

  dispose(): void {
    const child = this.child
    this.child = null
    child?.kill('SIGKILL')
    if (this.current) {
      this.current.error = 'Stopped.'
      this.persist()
    }
  }
}
