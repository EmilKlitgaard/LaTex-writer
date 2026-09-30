import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { getConfig, updateConfig } from './config.ts'
import { HttpError } from './paths.ts'

export const SESSION_COOKIE = 'lw_session'
export const MIN_PASSCODE_LENGTH = 4
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 5 * 60 * 1000

export type User = { id: string; name: string; color: string; role: 'host' | 'guest' }
type Session = { id: string; name: string; color: string; ip: string; createdAt: number }

const COLORS = ['#d9480f', '#1971c2', '#2f9e44', '#9c36b5', '#e8590c', '#0c8599', '#c2255c', '#5f3dc4', '#66a80f', '#f08c00']
export const HOST_COLOR = '#0b7285'

const sessions = new Map<string, Session>()
const attempts = new Map<string, { count: number; lockedUntil: number }>()
let guestCounter = 0
let colorCounter = 0

// ---- passcode ---------------------------------------------------------------

export function hashPasscode(passcode: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(passcode, salt, 32)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPasscode(passcode: string, stored: string | null): boolean {
  if (!stored) return false
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = crypto.scryptSync(passcode, Buffer.from(saltHex, 'hex'), expected.length)
  return crypto.timingSafeEqual(actual, expected)
}

export function validatePasscode(passcode: unknown): string {
  if (typeof passcode !== 'string' || passcode.length < MIN_PASSCODE_LENGTH || passcode.length > 128) {
    throw new HttpError(400, `The passcode must be at least ${MIN_PASSCODE_LENGTH} characters`)
  }
  return passcode
}

// ---- who is asking ----------------------------------------------------------

export function remoteIp(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
}

function isLoopback(addr: string | undefined): boolean {
  const a = (addr ?? '').replace(/^::ffff:/, '')
  return a === '127.0.0.1' || a === '::1'
}

/** The host is whoever connects over the loopback interface. Never trust anything the client sends. */
export function isHostRequest(req: IncomingMessage): boolean {
  return isLoopback(req.socket.remoteAddress) && isLoopback(req.socket.localAddress)
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function identify(req: IncomingMessage): User | null {
  if (isHostRequest(req)) {
    return { id: 'host', name: getConfig().hostName || 'Host', color: HOST_COLOR, role: 'host' }
  }
  if (!getConfig().lan.enabled) return null
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  const session = sid ? sessions.get(sid) : undefined
  if (!session) return null
  return { id: session.id, name: session.name, color: session.color, role: 'guest' }
}

/**
 * Blocks DNS rebinding and cross-site requests: the Host header must name this machine
 * by address, and a browser-supplied Origin must match it.
 */
export function checkHostAndOrigin(req: IncomingMessage, requireOrigin: boolean): void {
  const hostHeader = req.headers.host ?? ''
  const hostname = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  // Loopback requests carry host privileges without a login, so a rebinding site must not reach them.
  // LAN requests are authenticated by a cookie bound to the name the guest typed, so any name is fine.
  if (isHostRequest(req) && !['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    throw new HttpError(403, 'Unexpected Host header')
  }
  const origin = req.headers.origin
  if (origin) {
    if (origin !== `http://${hostHeader}`) throw new HttpError(403, 'Cross-site request blocked')
  } else if (requireOrigin) {
    throw new HttpError(403, 'Origin header required')
  }
}

// ---- guest login ------------------------------------------------------------

export function lockoutRemaining(ip: string): number {
  const a = attempts.get(ip)
  if (!a) return 0
  const left = a.lockedUntil - Date.now()
  if (left <= 0 && a.lockedUntil) attempts.delete(ip)
  return Math.max(0, left)
}

export function login(ip: string, passcode: unknown, name: unknown): Session {
  const cfg = getConfig()
  if (!cfg.lan.enabled || !cfg.lan.passcodeHash) throw new HttpError(403, 'Sharing is turned off')
  const left = lockoutRemaining(ip)
  if (left > 0) throw new HttpError(429, `Too many wrong attempts. Try again in ${Math.ceil(left / 60000)} min.`)
  if (typeof passcode !== 'string' || !verifyPasscode(passcode, cfg.lan.passcodeHash)) {
    const a = attempts.get(ip) ?? { count: 0, lockedUntil: 0 }
    a.count++
    if (a.count >= MAX_ATTEMPTS) {
      a.lockedUntil = Date.now() + LOCKOUT_MS
      a.count = 0
      attempts.set(ip, a)
      throw new HttpError(429, 'Too many wrong attempts. Try again in 5 min.')
    }
    attempts.set(ip, a)
    throw new HttpError(401, 'Wrong passcode')
  }
  attempts.delete(ip)
  const cleanName = typeof name === 'string' ? name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) : ''
  const session: Session = {
    id: crypto.randomBytes(24).toString('hex'),
    name: cleanName || `Guest ${++guestCounter}`,
    color: COLORS[colorCounter++ % COLORS.length],
    ip,
    createdAt: Date.now(),
  }
  sessions.set(session.id, session)
  return session
}

export function sessionCookie(id: string | null): string {
  const base = `${SESSION_COOKIE}=${id ?? ''}; Path=/; HttpOnly; SameSite=Lax`
  return id ? base : `${base}; Max-Age=0`
}

const revokeListeners = new Set<(ids: string[], reason: string) => void>()
export function onSessionsRevoked(fn: (ids: string[], reason: string) => void): void {
  revokeListeners.add(fn)
}

export function logout(id: string): void {
  if (sessions.delete(id)) for (const fn of revokeListeners) fn([id], 'logout')
}

/** Removes a guest and keeps them out for the lockout period. */
export function kick(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  attempts.set(s.ip, { count: 0, lockedUntil: Date.now() + LOCKOUT_MS })
  for (const fn of revokeListeners) fn([id], 'kicked')
}

export function revokeAllSessions(reason: string): void {
  const ids = [...sessions.keys()]
  sessions.clear()
  if (ids.length) for (const fn of revokeListeners) fn(ids, reason)
}

export function setPasscode(passcode: string): void {
  updateConfig((c) => {
    c.lan.passcodeHash = hashPasscode(validatePasscode(passcode))
  })
  revokeAllSessions('passcode-changed')
}

export function _resetAuthForTests(): void {
  sessions.clear()
  attempts.clear()
}
