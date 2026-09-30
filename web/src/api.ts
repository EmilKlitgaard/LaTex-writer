export type User = { id: string; name: string; color: string; role: 'host' | 'guest' }
export type ProjectInfo = { name: string; mainFile: string; autoCompile: boolean; outputPdf: string }
export type Person = { id: string; name: string; color: string; role: 'host' | 'guest' }
export type Sharing = { enabled: boolean; hasPasscode: boolean; urls: string[]; people: Person[] }
export type TreeNode = {
  name: string
  path: string
  type: 'dir' | 'file'
  kind?: 'text' | 'image' | 'pdf' | 'binary'
  cloud?: boolean
  children?: TreeNode[]
}
export type LogEntry = { severity: 'error' | 'warning' | 'info'; file: string | null; line: number | null; message: string; detail?: string; hint?: string }
export type BuildResult = {
  id: number
  status: 'success' | 'error' | 'timeout' | 'cancelled' | 'failed'
  engine: string
  durationMs: number
  pdfVersion: number
  entries: LogEntry[]
  errorCount: number
  warningCount: number
  finishedAt: number
}
export type ProjectIndex = { labels: { name: string; file: string }[]; bibKeys: { key: string; title?: string; author?: string }[]; files: string[] }
export type Snapshot = { id: string; t: number; size: number; reason: string }

export type Hunk = { id: string; oldStart: number; oldLines: string[]; newStart: number; newLines: string[] }
export type ReviewFile = { path: string; status: 'modified' | 'added'; hunks: Hunk[] }
export type ReviewSummary = { files: ReviewFile[]; changeCount: number; hasBeforePdf: boolean }
export type ChatPart = { kind: 'text'; text: string } | { kind: 'tool'; id: string; label: string; status: 'running' | 'done' | 'error'; parent?: string }
export type ChatMessage = { id: string; role: 'user' | 'assistant'; parts: ChatPart[]; error?: string; t: number }
export type ChatContext = { file?: string; line?: number; selection?: string; selectionStart?: number; selectionEnd?: number }
export type AiSettings = { enabled: boolean; available: boolean; model: string; models: string[]; effort: string; efforts: string[] }
export type AiUsage = { fiveHour?: number; sevenDay?: number; resetsAt?: number; context?: number }

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  let payload: BodyInit | undefined
  if (method !== 'GET') headers['X-LW'] = '1'
  if (body instanceof Blob) {
    headers['Content-Type'] = 'application/octet-stream'
    payload = body
  } else if (method !== 'GET') {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body ?? {})
  }
  let res: Response
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'The server cannot be reached. Is LaTeX Writer still running?')
  }
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) onUnauthorized?.()
    throw new ApiError(res.status, json?.error ?? `Request failed (${res.status})`)
  }
  return json as T
}

export const q = (params: Record<string, string>): string => new URLSearchParams(params).toString()

export type ServerEvent = { type: string; [key: string]: any }

/** The events channel: one websocket per tab, reconnecting on its own. */
export class Events {
  private ws: WebSocket | null = null
  private handlers = new Set<(e: ServerEvent) => void>()
  private statusHandlers = new Set<(connected: boolean) => void>()
  private retry = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  connected = false

  start(): void {
    if (this.ws && !this.stopped) return
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.ws?.close()
    this.ws = null
  }

  on(fn: (e: ServerEvent) => void): () => void {
    this.handlers.add(fn)
    return () => this.handlers.delete(fn)
  }

  onStatus(fn: (connected: boolean) => void): () => void {
    this.statusHandlers.add(fn)
    return () => this.statusHandlers.delete(fn)
  }

  private setConnected(v: boolean): void {
    if (this.connected === v) return
    this.connected = v
    for (const fn of this.statusHandlers) fn(v)
  }

  private open(): void {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/events`)
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.setConnected(true)
    }
    ws.onmessage = (ev) => {
      let msg: ServerEvent
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      for (const fn of this.handlers) fn(msg)
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.setConnected(false)
      if (this.stopped) return
      if (ev.code === 4003) {
        // Session ended; the 'logged-out' message has already been delivered.
        return
      }
      const delay = Math.min(5000, 300 * 2 ** this.retry++)
      this.timer = setTimeout(() => this.open(), delay)
    }
  }
}
