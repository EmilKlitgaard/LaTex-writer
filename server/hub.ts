import type { WebSocket } from 'ws'
import type { User } from './auth.ts'

/** Close code for a guest whose session ended (kicked, passcode changed, LAN turned off). */
export const CLOSE_LOGGED_OUT = 4003

type Client = { ws: WebSocket; user: User }

// Live "events" connections: one per open browser tab.
const clients = new Set<Client>()
// Every websocket (events and documents) per user, so a session can be cut off completely.
const socketsByUser = new Map<string, Set<WebSocket>>()

export function trackSocket(ws: WebSocket, user: User): void {
  let set = socketsByUser.get(user.id)
  if (!set) socketsByUser.set(user.id, (set = new Set()))
  set.add(ws)
  ws.on('close', () => {
    set.delete(ws)
    if (!set.size) socketsByUser.delete(user.id)
  })
}

export function addEventClient(ws: WebSocket, user: User): void {
  const client = { ws, user }
  clients.add(client)
  ws.on('close', () => {
    clients.delete(client)
    broadcastPresence()
  })
  broadcastPresence()
}

export function presence(): { id: string; name: string; color: string; role: string }[] {
  const seen = new Map<string, { id: string; name: string; color: string; role: string }>()
  for (const c of clients) seen.set(c.user.id, { id: c.user.id, name: c.user.name, color: c.user.color, role: c.user.role })
  return [...seen.values()].sort((a, b) => (a.role === 'host' ? -1 : b.role === 'host' ? 1 : a.name.localeCompare(b.name)))
}

export function broadcast(type: string, payload: Record<string, unknown> = {}, only?: 'host'): void {
  const msg = JSON.stringify({ type, ...payload })
  for (const c of clients) {
    if (only && c.user.role !== only) continue
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(msg)
  }
}

export function broadcastPresence(): void {
  broadcast('presence', { people: presence() })
}

/** Tells a user's tabs why they are being disconnected, then closes all of their sockets. */
export function disconnectUsers(ids: string[], reason: string): void {
  for (const id of ids) {
    for (const c of clients) {
      if (c.user.id === id && c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify({ type: 'logged-out', reason }))
    }
    for (const ws of [...(socketsByUser.get(id) ?? [])]) ws.close(CLOSE_LOGGED_OUT, reason)
  }
}

export function closeAllSockets(): void {
  for (const set of socketsByUser.values()) for (const ws of set) ws.terminate()
}
