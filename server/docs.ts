import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { simpleDiffString } from 'lib0/diff'
import type { WebSocket } from 'ws'
import { HttpError, isTextFile, resolveInside } from './paths.ts'

const MSG_SYNC = 0
const MSG_AWARENESS = 1
const MSG_QUERY_AWARENESS = 3
const SAVE_DELAY_MS = 500

/** Close code telling a client its local copy belongs to an older load of the file. */
export const CLOSE_STALE = 4001
export const CLOSE_GONE = 4002

const ORIGIN_DISK = Symbol('disk')

export type DocEntry = {
  rel: string
  abs: string
  /** Changes every time the file is loaded from disk, so clients never merge two unrelated histories. */
  instance: string
  doc: Y.Doc
  text: Y.Text
  awareness: awarenessProtocol.Awareness
  conns: Map<WebSocket, Set<number>>
  /** Content as last read from or written to disk (LF line endings). */
  lastSaved: string
  crlf: boolean
  saveTimer: NodeJS.Timeout | null
  editedThisSession: boolean
}

export type DocEvents = {
  /** Called before the first edit of a file in this session, with the pre-edit content. */
  onFirstEdit: (rel: string, previous: string) => void
  /** Called after every change to a file's content, whoever made it. */
  onChange: (rel: string) => void
}

function readTextFile(abs: string): { text: string; crlf: boolean } {
  const buf = fs.readFileSync(abs)
  const raw = buf.toString('utf8')
  if (!Buffer.from(raw, 'utf8').equals(buf)) {
    throw new HttpError(415, 'This file is not UTF-8 text and cannot be edited here')
  }
  const crlf = raw.includes('\r\n')
  return { text: crlf ? raw.replace(/\r\n/g, '\n') : raw, crlf }
}

export class DocManager {
  private entries = new Map<string, DocEntry>()
  private root: string
  private events: DocEvents

  constructor(root: string, events: DocEvents) {
    this.root = root
    this.events = events
  }

  has(rel: string): boolean {
    return this.entries.has(rel)
  }

  /** Current content of a text file: the live document if it is open, otherwise the file on disk. */
  read(rel: string): string {
    const entry = this.entries.get(rel)
    if (entry) return entry.text.toString()
    return readTextFile(path.join(this.root, rel)).text
  }

  open(relInput: string): DocEntry {
    const { rel, abs } = resolveInside(this.root, relInput)
    const existing = this.entries.get(rel)
    if (existing) return existing
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(404, 'File not found')
    if (!isTextFile(abs, rel)) throw new HttpError(415, 'Not a text file')
    const { text: content, crlf } = readTextFile(abs)

    const doc = new Y.Doc()
    const text = doc.getText('content')
    doc.transact(() => text.insert(0, content), ORIGIN_DISK)
    const awareness = new awarenessProtocol.Awareness(doc)
    awareness.setLocalState(null)

    const entry: DocEntry = {
      rel, abs, doc, text, awareness, crlf,
      instance: crypto.randomBytes(8).toString('hex'),
      conns: new Map(),
      lastSaved: content,
      saveTimer: null,
      editedThisSession: false,
    }

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      syncProtocol.writeUpdate(enc, update)
      const msg = encoding.toUint8Array(enc)
      for (const ws of entry.conns.keys()) send(ws, msg)
      if (origin !== ORIGIN_DISK) {
        if (!entry.editedThisSession) {
          // Nothing has been saved since load, so lastSaved is still the pre-edit content.
          entry.editedThisSession = true
          this.events.onFirstEdit(entry.rel, entry.lastSaved)
        }
        this.scheduleSave(entry)
      }
      this.events.onChange(entry.rel)
    })

    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = added.concat(updated, removed)
      const controlled = origin ? entry.conns.get(origin as WebSocket) : undefined
      if (controlled) {
        for (const id of added) controlled.add(id)
        for (const id of removed) controlled.delete(id)
      }
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_AWARENESS)
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed))
      const msg = encoding.toUint8Array(enc)
      for (const ws of entry.conns.keys()) send(ws, msg)
    })

    this.entries.set(rel, entry)
    return entry
  }

  /** Attaches a websocket to a document and speaks the y-websocket protocol with it. */
  connect(ws: WebSocket, entry: DocEntry): void {
    entry.conns.set(ws, new Set())
    ws.binaryType = 'arraybuffer'

    ws.on('message', (data: ArrayBuffer | Buffer) => {
      try {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data)
        const dec = decoding.createDecoder(bytes)
        const enc = encoding.createEncoder()
        const type = decoding.readVarUint(dec)
        if (type === MSG_SYNC) {
          encoding.writeVarUint(enc, MSG_SYNC)
          syncProtocol.readSyncMessage(dec, enc, entry.doc, ws)
          if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc))
        } else if (type === MSG_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(entry.awareness, decoding.readVarUint8Array(dec), ws)
        } else if (type === MSG_QUERY_AWARENESS) {
          sendAwareness(ws, entry, [...entry.awareness.getStates().keys()])
        }
      } catch (err) {
        console.error('Bad collaboration message:', (err as Error).message)
      }
    })

    ws.on('close', () => {
      const controlled = entry.conns.get(ws)
      entry.conns.delete(ws)
      if (controlled?.size) awarenessProtocol.removeAwarenessStates(entry.awareness, [...controlled], null)
    })

    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeSyncStep1(enc, entry.doc)
    send(ws, encoding.toUint8Array(enc))
    const states = [...entry.awareness.getStates().keys()]
    if (states.length) sendAwareness(ws, entry, states)
  }

  private scheduleSave(entry: DocEntry): void {
    if (entry.saveTimer) clearTimeout(entry.saveTimer)
    entry.saveTimer = setTimeout(() => this.save(entry), SAVE_DELAY_MS)
  }

  private save(entry: DocEntry): void {
    if (entry.saveTimer) clearTimeout(entry.saveTimer)
    entry.saveTimer = null
    if (this.entries.get(entry.rel) !== entry) return
    const content = entry.text.toString()
    if (content === entry.lastSaved) return
    // The project folder was renamed or removed: writing now would recreate it as a ghost copy.
    if (!fs.existsSync(this.root)) return
    try {
      fs.mkdirSync(path.dirname(entry.abs), { recursive: true })
      fs.writeFileSync(entry.abs, entry.crlf ? content.replace(/\n/g, '\r\n') : content)
      entry.lastSaved = content
    } catch (err) {
      console.error(`Could not save ${entry.rel}:`, (err as Error).message)
    }
  }

  /** Writes every pending edit to disk. Called before compiling, snapshotting and on shutdown. */
  flushAll(): void {
    for (const entry of this.entries.values()) this.save(entry)
  }

  flush(rel: string): void {
    const entry = this.entries.get(rel)
    if (entry) this.save(entry)
  }

  /** Replaces the content of a file through the live document so every editor updates. */
  setContent(relInput: string, content: string): void {
    const entry = this.open(relInput)
    const normalized = content.replace(/\r\n/g, '\n')
    const current = entry.text.toString()
    if (current === normalized) return
    const d = simpleDiffString(current, normalized)
    entry.doc.transact(() => {
      if (d.remove) entry.text.delete(d.index, d.remove)
      if (d.insert) entry.text.insert(d.index, d.insert)
    }, 'restore')
    this.save(entry)
  }

  /**
   * The file changed on disk behind our back (another editor, iCloud). Merge that change
   * into the live document. Returns true if the document changed.
   */
  syncFromDisk(rel: string): boolean {
    const entry = this.entries.get(rel)
    if (!entry) return false
    let disk: string
    try {
      disk = readTextFile(entry.abs).text
    } catch {
      return false
    }
    if (disk === entry.lastSaved) return false
    const current = entry.text.toString()
    if (disk === current) {
      entry.lastSaved = disk
      return false
    }
    // The change made on disk, relative to what we last wrote.
    const ext = simpleDiffString(entry.lastSaved, disk)
    let op = simpleDiffString(current, disk)
    if (current !== entry.lastSaved) {
      // Unsaved edits are pending. Keep them if they do not overlap the external change.
      const local = simpleDiffString(entry.lastSaved, current)
      if (local.index + local.remove <= ext.index) {
        op = { index: ext.index + local.insert.length - local.remove, remove: ext.remove, insert: ext.insert }
      } else if (ext.index + ext.remove <= local.index) {
        op = ext
      }
    }
    if (!entry.editedThisSession) {
      entry.editedThisSession = true
      this.events.onFirstEdit(entry.rel, current)
    }
    entry.doc.transact(() => {
      if (op.remove) entry.text.delete(op.index, op.remove)
      if (op.insert) entry.text.insert(op.index, op.insert)
    }, ORIGIN_DISK)
    entry.lastSaved = disk
    if (entry.text.toString() !== disk) this.scheduleSave(entry)
    return true
  }

  /** Forgets a document (after delete or move). Clients are told to reopen. */
  drop(rel: string, save: boolean): void {
    const entry = this.entries.get(rel)
    if (!entry) return
    if (save) this.save(entry)
    if (entry.saveTimer) clearTimeout(entry.saveTimer)
    entry.saveTimer = null
    this.entries.delete(rel)
    for (const ws of [...entry.conns.keys()]) ws.close(CLOSE_GONE, 'file moved or deleted')
    entry.conns.clear()
    entry.doc.destroy()
  }

  /** Drops a path and everything below it. */
  dropTree(rel: string, save: boolean): void {
    for (const key of [...this.entries.keys()]) {
      if (key === rel || key.startsWith(rel + '/')) this.drop(key, save)
    }
  }

  openPaths(): string[] {
    return [...this.entries.keys()]
  }

  close(): void {
    this.flushAll()
    for (const key of [...this.entries.keys()]) this.drop(key, false)
  }
}

function send(ws: WebSocket, msg: Uint8Array): void {
  if (ws.readyState === ws.OPEN) ws.send(msg, (err) => err && ws.close())
}

function sendAwareness(ws: WebSocket, entry: DocEntry, ids: number[]): void {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_AWARENESS)
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(entry.awareness, ids))
  send(ws, encoding.toUint8Array(enc))
}
