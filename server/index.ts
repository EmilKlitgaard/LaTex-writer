import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Duplex, Readable } from 'node:stream'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import { ZipArchive } from 'archiver'
import { WebSocketServer } from 'ws'
import {
  checkHostAndOrigin, identify, kick, login, logout, onSessionsRevoked, remoteIp, revokeAllSessions,
  SESSION_COOKIE, sessionCookie, setPasscode, parseCookies, type User,
} from './auth.ts'
import { DEFAULT_PORT, getConfig, loadConfig, touchRecentWorkspace, updateConfig, WEB_BUILD_DIR } from './config.ts'
import { EFFORTS, setAiPort, type ChatContext, type Effort, type RunSettings } from './ai.ts'
import { detectProviders, provider, PROVIDERS, resolveModel, type ProviderId } from './providers.ts'
import { skillMenu } from './skills.ts'
import { CLOSE_STALE } from './docs.ts'
import { handleRpc, newSession } from './mcp.ts'
import { addEventClient, broadcast, broadcastPresence, closeAllSockets, disconnectUsers, presence, trackSocket } from './hub.ts'
import { installLogging } from './logging.ts'
import { extensionOf, HttpError, isHiddenName, resolveInside, sanitizeFolderName } from './paths.ts'
import { closeProject, currentProject, openProject, rememberOpen, requireProject } from './project.ts'
import { revoke } from './access.ts'
import { browse, chooseFolderInFinder, chooseForAttachment, createProject, listWorkspace, makeFolder, trashProject } from './workspace.ts'
import { openUrl, reveal } from './platform.ts'

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null
  }
}

export type ServerHandle = { port: number; close: () => Promise<void>; lanAddresses: () => string[] }

const RAW_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', pdf: 'application/pdf',
}

function lanIPv4Addresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address)
  }
  return out
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

async function isOurServer(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) })
    const body = (await res.json()) as { app?: string }
    return body.app === 'latex-writer'
  } catch {
    return false
  }
}

const body = (req: FastifyRequest): Record<string, unknown> => (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {})
const query = (req: FastifyRequest): Record<string, string> => req.query as Record<string, string>

function requireHost(req: FastifyRequest): void {
  if (req.user?.role !== 'host') throw new HttpError(403, 'Only the host can do that')
}
function requireUser(req: FastifyRequest): User {
  if (!req.user) throw new HttpError(401, 'Please enter the passcode')
  return req.user
}

export async function startServer(opts: { port?: number; strictPort?: boolean } = {}): Promise<ServerHandle> {
  loadConfig()
  let handler: http.RequestListener = () => {}
  const lanServers = new Map<string, http.Server>()
  let port = opts.port ?? DEFAULT_PORT

  const app = Fastify({
    bodyLimit: 1024 * 1024,
    // One handler serves the loopback listener and, while sharing is on, a listener per LAN address.
    serverFactory: (h) => {
      handler = h
      return http.createServer(h)
    },
  })

  app.decorateRequest('user', null)
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload))

  app.setErrorHandler((err: Error & { status?: number; statusCode?: number }, _req, reply) => {
    const status = err instanceof HttpError ? err.status : (err.statusCode ?? 500)
    if (status >= 500) console.error(err)
    reply.status(status).send({
      error: status >= 500 && !(err instanceof HttpError) ? 'Something went wrong on the server' : err.message,
      ...(err instanceof HttpError && err.code ? { code: err.code } : {}),
    })
  })

  // One log line when a device on the network opens the page, so "cannot connect" can be told apart
  // from "connected but something went wrong".
  const seenDevices = new Map<string, number>()
  app.addHook('onRequest', async (req, reply) => {
    checkHostAndOrigin(req.raw, false)
    req.user = identify(req.raw)
    if (req.url === '/' && req.user?.role !== 'host') {
      const ip = remoteIp(req.raw)
      if (Date.now() - (seenDevices.get(ip) ?? 0) > 60_000) console.log(`Page opened from ${ip}`)
      seenDevices.set(ip, Date.now())
    }
    const isApi = req.url.startsWith('/api/')
    if (isApi && req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-lw'] !== '1') {
      // A custom header cannot be sent cross-site without a CORS preflight, which we never grant.
      throw new HttpError(403, 'Missing request header')
    }
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    if (isApi) reply.header('Cache-Control', 'no-store')
    else {
      reply.header(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; ` +
          `font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' ws://${req.headers.host}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      )
    }
  })

  // ---- public -----------------------------------------------------------------

  app.get('/api/ping', async () => ({ app: 'latex-writer' }))

  /** The agent, model and effort the next turn runs with. */
  const runSettings = (): RunSettings => {
    const cfg = getConfig()
    const p = provider(cfg.ai.provider)
    return { provider: p.id, model: resolveModel(p, cfg.ai.model), effort: EFFORTS.includes(cfg.ai.effort as Effort) ? (cfg.ai.effort as Effort) : 'medium' }
  }
  const aiState = (): Record<string, unknown> => {
    const cfg = getConfig()
    const run = runSettings()
    const p = provider(run.provider)
    const url = `http://localhost:${getConfig().lastPort}/mcp`
    return {
      enabled: cfg.ai.enabled,
      provider: p.id,
      providerName: p.name,
      plan: p.plan,
      // Every agent this app can run, found or not, for the choice in Settings.
      providers: detectProviders().map((x) => ({ id: x.id, name: x.name, plan: x.plan, available: x.path !== null, path: x.path, mcpCommand: x.mcpCommand(url) })),
      // Where any MCP client can reach this app's tools (on this Mac, while the app runs).
      mcpUrl: url,
      model: run.model,
      effort: run.effort,
      available: p.path !== null,
      models: p.models,
      efforts: EFFORTS,
      skills: skillMenu(),
    }
  }
  const requireAi = (req: FastifyRequest): void => {
    requireHost(req)
    if (!getConfig().ai.enabled) throw new HttpError(403, 'The assistant is turned off in Settings')
  }

  app.get('/api/me', async (req) => {
    const project = currentProject()
    return {
      user: req.user,
      ai: req.user?.role === 'host' ? aiState() : null,
      sharing: getConfig().lan.enabled,
      project: req.user && project ? project.info() : null,
    }
  })

  app.post('/api/auth/login', async (req, reply) => {
    if (req.user?.role === 'host') return { user: req.user }
    const b = body(req)
    const session = login(remoteIp(req.raw), b.passcode, b.name)
    reply.header('Set-Cookie', sessionCookie(session.id))
    return { user: { id: session.id, name: session.name, color: session.color, role: 'guest' } }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (sid) logout(sid)
    reply.header('Set-Cookie', sessionCookie(null))
    return { ok: true }
  })

  // ---- host only --------------------------------------------------------------

  const sharingState = (): Record<string, unknown> => {
    const cfg = getConfig()
    return {
      enabled: cfg.lan.enabled,
      hasPasscode: Boolean(cfg.lan.passcodeHash),
      urls: cfg.lan.enabled ? [...lanServers.keys()].map((ip) => `http://${ip}:${port}`) : [],
      people: presence(),
    }
  }

  app.get('/api/host/home', async (req) => {
    requireHost(req)
    const cfg = getConfig()
    return {
      hostName: cfg.hostName,
      recentWorkspaces: cfg.recentWorkspaces.map((w) => ({ ...w, name: path.basename(w.path), exists: fs.existsSync(w.path) })),
      sharing: sharingState(),
    }
  })

  app.get('/api/host/browse', async (req) => {
    requireHost(req)
    return browse(query(req).path)
  })

  app.post('/api/host/choose-folder', async (req) => {
    requireHost(req)
    return { path: await chooseFolderInFinder(body(req).start) }
  })

  app.post('/api/host/mkdir', async (req) => {
    requireHost(req)
    return { path: makeFolder(body(req).parent, body(req).name) }
  })

  app.get('/api/host/workspace', async (req) => {
    requireHost(req)
    const ws = listWorkspace(query(req).path)
    touchRecentWorkspace(ws.path as string)
    return ws
  })

  app.post('/api/host/workspace/forget', async (req) => {
    requireHost(req)
    const p = body(req).path
    updateConfig((c) => {
      c.recentWorkspaces = c.recentWorkspaces.filter((w) => w.path !== p)
    })
    return { ok: true }
  })

  /**
   * Leaving the open project stops an assistant that is working in it (only one project is open
   * at a time, and its tools act on that one). Unless the request says force, it is refused with a
   * code the page turns into a question, whichever window or button it came from.
   */
  const guardLeave = (req: FastifyRequest, target?: string): void => {
    const project = currentProject()
    if (!project?.ai.busy || body(req).force === true) return
    if (target) {
      try {
        if (fs.realpathSync(target) === project.root) return
      } catch {}
    }
    throw new HttpError(409, `The assistant is still working in "${project.settings.name}". Leaving the project stops it.`, 'assistant-busy')
  }

  app.post('/api/host/project/create', async (req) => {
    requireHost(req)
    guardLeave(req)
    const b = body(req)
    const dir = createProject(b.workspace, b.name, b.template)
    const project = await openProject(dir)
    touchRecentWorkspace(String(b.workspace), dir)
    return { project: project.info() }
  })

  app.post('/api/host/project/open', async (req) => {
    requireHost(req)
    const b = body(req)
    if (typeof b.path !== 'string' || !path.isAbsolute(b.path) || !fs.existsSync(b.path) || !fs.statSync(b.path).isDirectory()) {
      throw new HttpError(404, 'That project folder does not exist any more')
    }
    guardLeave(req, b.path)
    const project = await openProject(b.path)
    if (typeof b.workspace === 'string') touchRecentWorkspace(b.workspace, project.root)
    return { project: project.info() }
  })

  app.post('/api/host/project/close', async (req) => {
    requireHost(req)
    guardLeave(req)
    await closeProject()
    rememberOpen(null)
    return { ok: true }
  })

  app.post('/api/host/project/trash', async (req) => {
    requireHost(req)
    const target = String(body(req).path ?? '')
    const current = currentProject()
    if (current && fs.existsSync(target) && current.root === fs.realpathSync(target)) {
      if (current.ai.busy && body(req).force !== true) throw new HttpError(409, `The assistant is still working in "${current.settings.name}". Moving it to the Trash stops it.`, 'assistant-busy')
      await closeProject()
      rememberOpen(null)
    }
    await trashProject(target)
    return { ok: true }
  })

  app.post('/api/host/settings', async (req) => {
    requireHost(req)
    const b = body(req)
    if (typeof b.hostName === 'string') {
      const name = b.hostName.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40)
      if (name) updateConfig((c) => void (c.hostName = name))
    }
    if (typeof b.passcode === 'string' && b.passcode) setPasscode(b.passcode)
    if (typeof b.aiEnabled === 'boolean') {
      updateConfig((c) => void (c.ai.enabled = b.aiEnabled as boolean))
      if (!b.aiEnabled) currentProject()?.ai.stop()
      broadcast('ai', { kind: 'settings', ai: aiState() }, 'host')
    }
    if (typeof b.aiProvider === 'string' && PROVIDERS.includes(b.aiProvider as ProviderId) && b.aiProvider !== getConfig().ai.provider) {
      if (currentProject()?.ai.busy) throw new HttpError(409, 'Stop the assistant before switching to another one')
      const next = provider(b.aiProvider)
      if (!next.path) throw new HttpError(404, `${next.name} was not found on this Mac`)
      updateConfig((c) => {
        // Each agent keeps its own model choice.
        c.ai.models[c.ai.provider] = c.ai.model
        c.ai.provider = next.id
        c.ai.model = resolveModel(next, c.ai.models[next.id])
      })
      broadcast('ai', { kind: 'settings', ai: aiState() }, 'host')
    }
    if (typeof b.aiModel === 'string' && provider(getConfig().ai.provider).models.some((m) => m.id === b.aiModel)) {
      updateConfig((c) => void (c.ai.model = b.aiModel as string))
      broadcast('ai', { kind: 'settings', ai: aiState() }, 'host')
    }
    if (typeof b.aiEffort === 'string' && EFFORTS.includes(b.aiEffort as Effort)) {
      updateConfig((c) => void (c.ai.effort = b.aiEffort as string))
      broadcast('ai', { kind: 'settings', ai: aiState() }, 'host')
    }
    if (typeof b.lanEnabled === 'boolean') {
      if (b.lanEnabled && !getConfig().lan.passcodeHash) throw new HttpError(400, 'Set a passcode before turning sharing on')
      updateConfig((c) => void (c.lan.enabled = b.lanEnabled as boolean))
      if (!b.lanEnabled) revokeAllSessions('sharing-off')
    }
    await syncLanListeners()
    broadcast('sharing', { sharing: sharingState() }, 'host')
    return { hostName: getConfig().hostName, sharing: sharingState(), ai: aiState() }
  })

  // ---- assistant (host only) ----------------------------------------------------

  app.get('/api/host/ai/state', async (req) => {
    requireHost(req)
    const project = currentProject()
    const ai = aiState()
    // Opening the assistant picks up a turn that was cut off when the app was closed.
    if (project && getConfig().ai.enabled) project.ai.resumeInterrupted(runSettings())
    return { ai: aiState(), chat: project && getConfig().ai.enabled ? project.ai.state() : null, review: project ? project.review.summary() : null }
  })

  // Pasted pictures travel in the message, so it may be larger than other requests.
  app.post('/api/host/ai/send', { bodyLimit: 32 * 1024 * 1024 }, async (req) => {
    requireAi(req)
    const b = body(req)
    const c = (b.context && typeof b.context === 'object' ? b.context : {}) as Record<string, unknown>
    const context: ChatContext = {
      file: typeof c.file === 'string' ? c.file.slice(0, 300) : undefined,
      line: Number.isFinite(Number(c.line)) ? Number(c.line) : undefined,
      selection: typeof c.selection === 'string' ? c.selection : undefined,
      selectionStart: Number.isFinite(Number(c.selectionStart)) ? Number(c.selectionStart) : undefined,
      selectionEnd: Number.isFinite(Number(c.selectionEnd)) ? Number(c.selectionEnd) : undefined,
    }
    requireProject().ai.send(b.text, context, runSettings(), b.images)
    return { ok: true }
  })

  // A picture pasted into one of this project's chats.
  app.get('/api/host/ai/image/:id', async (req, reply) => {
    requireHost(req)
    const found = requireProject().ai.imageFile((req.params as { id?: string }).id)
    if (!found) throw new HttpError(404, 'That image is gone')
    reply.header('Content-Type', found.type)
    reply.header('Cache-Control', 'private, max-age=31536000, immutable')
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'")
    return reply.send(fs.createReadStream(found.file))
  })

  // Looks for the agents installed on this Mac again (after installing one, for example).
  app.post('/api/host/ai/detect', async (req) => {
    requireHost(req)
    detectProviders(true)
    const ai = aiState()
    broadcast('ai', { kind: 'settings', ai }, 'host')
    return { ai }
  })

  app.post('/api/host/ai/stop', async (req) => {
    requireHost(req)
    currentProject()?.ai.stop()
    return { ok: true }
  })

  app.post('/api/host/ai/reset', async (req) => {
    requireAi(req)
    const ai = requireProject().ai
    if (ai.busy && body(req).force !== true) {
      throw new HttpError(409, 'The assistant is still working in this chat. Starting a new chat stops it.', 'assistant-busy')
    }
    ai.reset()
    return { ok: true }
  })

  app.post('/api/host/ai/open', async (req) => {
    requireAi(req)
    requireProject().ai.open(body(req).id)
    return { ok: true }
  })

  app.post('/api/host/ai/delete', async (req) => {
    requireAi(req)
    requireProject().ai.remove(body(req).id)
    return { ok: true }
  })

  // Files and folders the assistant may read in the chat in use, chosen in a Finder dialog.
  app.post('/api/host/ai/attach', async (req) => {
    requireAi(req)
    const b = body(req)
    const project = requireProject()
    const paths = Array.isArray(b.paths) ? b.paths : await chooseForAttachment(b.kind, path.dirname(project.root))
    return { attachments: paths.length ? project.ai.attach(paths) : project.ai.state().attachments }
  })

  app.post('/api/host/ai/detach', async (req) => {
    requireAi(req)
    requireProject().ai.detach(body(req).path)
    return { ok: true }
  })

  // The user's answer to the assistant asking to read another project.
  app.post('/api/host/ai/access/answer', async (req) => {
    requireAi(req)
    const b = body(req)
    if (!requireProject().ai.access.answer(b.id, b.allow === true)) throw new HttpError(404, 'That question was already answered or has expired')
    return { ok: true }
  })

  app.post('/api/host/ai/access/revoke', async (req) => {
    requireAi(req)
    const project = requireProject()
    revoke(project.root, body(req).path)
    project.ai.emitAccess()
    return { ok: true }
  })

  app.get('/api/host/review/before.pdf', async (req, reply) => {
    requireHost(req)
    const file = requireProject().review.beforePdfPath()
    if (!file) throw new HttpError(404, 'No earlier PDF was kept')
    reply.header('Content-Type', 'application/pdf')
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'")
    return reply.send(fs.createReadStream(file))
  })

  app.post('/api/host/review/accept', async (req) => {
    requireHost(req)
    const b = body(req)
    const project = requireProject()
    project.review.accept(typeof b.path === 'string' ? b.path : undefined, typeof b.hunk === 'string' ? b.hunk : undefined)
    return { review: project.review.summary() }
  })

  app.post('/api/host/review/decline', async (req) => {
    requireHost(req)
    const b = body(req)
    const project = requireProject()
    project.review.decline(typeof b.path === 'string' ? b.path : undefined, typeof b.hunk === 'string' ? b.hunk : undefined)
    return { review: project.review.summary() }
  })

  // The tool endpoint Claude connects to (MCP over HTTP). Loopback only; a web page cannot reach it
  // because browsers attach an Origin header, which is refused here.
  app.post('/mcp', async (req, reply) => {
    requireHost(req)
    if (req.headers.origin) throw new HttpError(403, 'Not available to web pages')
    if (!getConfig().ai.enabled) throw new HttpError(404, 'The assistant is turned off in LaTeX Writer settings')
    const payload = req.body
    const messages = Array.isArray(payload) ? payload : [payload]
    const replies: Record<string, unknown>[] = []
    const chat = typeof query(req).chat === 'string' ? query(req).chat : undefined
    // A new MCP session gets an id; the client sends it back with every call, so its calls can be
    // kept to the project it started on.
    let session = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined
    if (messages.some((m) => (m as Record<string, unknown> | null)?.method === 'initialize')) {
      session = newSession()
      reply.header('Mcp-Session-Id', session)
    }
    for (const msg of messages) {
      const out = await handleRpc((msg ?? {}) as Record<string, unknown>, currentProject, { chat, session })
      if (out) replies.push(out)
    }
    if (!replies.length) return reply.status(202).send()
    return Array.isArray(payload) ? replies : replies[0]
  })
  app.get('/mcp', async (_req, reply) => reply.status(405).header('Allow', 'POST').send())
  app.delete('/mcp', async (_req, reply) => reply.status(405).header('Allow', 'POST').send())

  app.post('/api/host/kick', async (req) => {
    requireHost(req)
    kick(String(body(req).id ?? ''))
    return { ok: true }
  })

  app.post('/api/host/export', async (req) => {
    requireHost(req)
    const project = requireProject()
    const pdf = project.compiler.currentPdf()
    if (!pdf) throw new HttpError(409, 'There is no PDF yet. Compile the project first.')
    const downloads = path.join(os.homedir(), 'Downloads')
    const base = sanitizeFolderName(project.settings.name)
    // COPYFILE_EXCL makes the copy itself refuse to overwrite, so nothing is ever replaced.
    for (let i = 1; i < 500; i++) {
      const name = i === 1 ? `${base}.pdf` : `${base} (${i}).pdf`
      const target = path.join(downloads, name)
      try {
        fs.copyFileSync(pdf.file, target, fs.constants.COPYFILE_EXCL)
        return { file: target, name }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EEXIST') continue
        if (code === 'EPERM' || code === 'EACCES') {
          throw new HttpError(500, 'macOS blocked access to the Downloads folder. Allow it in System Settings → Privacy & Security → Files and Folders, then try again.')
        }
        throw new HttpError(500, `Could not write to the Downloads folder: ${(err as Error).message}`)
      }
    }
    throw new HttpError(500, 'Too many exported copies in the Downloads folder')
  })

  app.post('/api/host/reveal', async (req) => {
    requireHost(req)
    const target = String(body(req).path ?? '')
    if (!path.isAbsolute(target) || !fs.existsSync(target)) throw new HttpError(404, 'Not found')
    reveal(target)
    return { ok: true }
  })

  // ---- project: host and guests -----------------------------------------------

  app.get('/api/project/tree', async (req) => {
    requireUser(req)
    const project = requireProject()
    return { tree: project.tree(), project: project.info() }
  })

  app.get('/api/project/doc', async (req) => {
    requireUser(req)
    const entry = requireProject().docs.open(query(req).path)
    return { path: entry.rel, instance: entry.instance }
  })

  app.get('/api/project/raw', async (req, reply) => {
    requireUser(req)
    const project = requireProject()
    const { rel, abs } = resolveInside(project.root, query(req).path)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(404, 'File not found')
    const type = RAW_TYPES[extensionOf(rel)]
    const download = query(req).download === '1' || !type
    // Project files are untrusted content (guests can upload): never let them run as a page of this app.
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
    reply.header('Content-Type', type ?? 'application/octet-stream')
    if (download) reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(rel))}`)
    return reply.send(fs.createReadStream(abs))
  })

  app.post('/api/project/create', async (req) => {
    requireUser(req)
    const b = body(req)
    return { path: requireProject().create(String(b.parent ?? ''), String(b.name ?? ''), b.type === 'dir' ? 'dir' : 'file') }
  })

  app.post('/api/project/move', async (req) => {
    requireUser(req)
    const b = body(req)
    return { path: requireProject().move(String(b.from ?? ''), String(b.to ?? '')) }
  })

  app.post('/api/project/delete', async (req) => {
    requireUser(req)
    requireProject().remove(String(body(req).path ?? ''))
    return { ok: true }
  })

  app.put('/api/project/upload', async (req) => {
    requireUser(req)
    if (req.headers['content-type'] !== 'application/octet-stream') throw new HttpError(415, 'Unsupported upload type')
    return { path: await requireProject().upload(query(req).path, req.body as Readable) }
  })

  app.post('/api/project/cloud-download', async (req) => {
    requireUser(req)
    await requireProject().downloadFromCloud(String(body(req).path ?? ''))
    return { ok: true }
  })

  app.get('/api/project/zip', async (req, reply) => {
    requireUser(req)
    const project = requireProject()
    project.docs.flushAll()
    const archive = new ZipArchive({ zlib: { level: 6 } })
    archive.on('error', (err: Error) => console.error('Zip failed:', err.message))
    const add = (relDir: string): void => {
      for (const ent of fs.readdirSync(path.join(project.root, relDir), { withFileTypes: true })) {
        if (isHiddenName(ent.name)) continue
        const rel = relDir ? `${relDir}/${ent.name}` : ent.name
        if (ent.isDirectory()) add(rel)
        else if (ent.isFile()) archive.file(path.join(project.root, rel), { name: rel })
      }
    }
    add('')
    void archive.finalize()
    reply.header('Content-Type', 'application/zip')
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(sanitizeFolderName(project.settings.name))}.zip`)
    return reply.send(archive)
  })

  app.get('/api/project/pdf', async (req, reply) => {
    requireUser(req)
    const project = requireProject()
    const pdf = project.compiler.currentPdf()
    if (!pdf) throw new HttpError(404, 'No PDF yet')
    reply.header('Content-Type', 'application/pdf')
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'")
    if (query(req).download === '1') {
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(sanitizeFolderName(project.settings.name))}.pdf`)
    }
    return reply.send(fs.createReadStream(pdf.file))
  })

  app.get('/api/project/build', async (req) => {
    requireUser(req)
    const c = requireProject().compiler
    return { compiling: c.compiling, result: c.lastResult, pdfVersion: c.currentPdf()?.version ?? 0 }
  })

  app.get('/api/project/log', async (req, reply) => {
    requireUser(req)
    reply.header('Content-Type', 'text/plain; charset=utf-8')
    return requireProject().compiler.rawLog() || 'No log yet.'
  })

  app.post('/api/project/compile', async (req) => {
    requireUser(req)
    // The Recompile button reruns LaTeX even if no source changed.
    void requireProject().compile(true)
    return { ok: true }
  })

  app.post('/api/project/settings', async (req) => {
    const user = requireUser(req)
    const b = body(req)
    const project = requireProject()
    const patch: { name?: string; mainFile?: string; autoCompile?: boolean } = {}
    if (typeof b.autoCompile === 'boolean') patch.autoCompile = b.autoCompile
    if (b.name !== undefined || b.mainFile !== undefined) {
      if (user.role !== 'host') throw new HttpError(403, 'Only the host can change project settings')
      if (typeof b.name === 'string') patch.name = b.name
      if (typeof b.mainFile === 'string') patch.mainFile = b.mainFile
    }
    project.updateSettings(patch)
    return { project: project.info() }
  })

  app.get('/api/project/index', async (req) => {
    requireUser(req)
    return requireProject().index()
  })

  app.get('/api/project/history', async (req) => {
    requireUser(req)
    const project = requireProject()
    const { rel } = resolveInside(project.root, query(req).path)
    return { path: rel, snapshots: project.history.list(rel) }
  })

  app.get('/api/project/history/content', async (req) => {
    requireUser(req)
    const project = requireProject()
    const { rel } = resolveInside(project.root, query(req).path)
    return { content: project.history.read(rel, String(query(req).id ?? '')) }
  })

  app.post('/api/project/history/restore', async (req) => {
    requireUser(req)
    const b = body(req)
    requireProject().restoreSnapshot(String(b.path ?? ''), String(b.id ?? ''))
    return { ok: true }
  })

  app.get('/api/project/trash', async (req) => {
    requireUser(req)
    const project = requireProject()
    const existing = new Set(project.index().files)
    return {
      items: project.listTrash(),
      // Files that have history but no longer exist (deleted outside the app, for example).
      orphans: project.history.paths().filter((p) => !existing.has(p)),
    }
  })

  app.post('/api/project/trash/restore', async (req) => {
    requireUser(req)
    return { path: requireProject().restoreFromTrash(String(body(req).id ?? '')) }
  })

  app.post('/api/project/synctex/view', async (req) => {
    requireUser(req)
    const b = body(req)
    const project = requireProject()
    const { rel } = resolveInside(project.root, b.file)
    return { position: await project.compiler.synctexView(rel, Math.max(1, Number(b.line) || 1), Math.max(0, Number(b.column) || 0)) }
  })

  app.post('/api/project/synctex/edit', async (req) => {
    requireUser(req)
    const b = body(req)
    const page = Number(b.page), x = Number(b.x), y = Number(b.y)
    if (!Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) throw new HttpError(400, 'Invalid position')
    return { position: await requireProject().compiler.synctexEdit(Math.max(1, Math.round(page)), x, y) }
  })

  // ---- static front end ---------------------------------------------------------

  if (fs.existsSync(path.join(WEB_BUILD_DIR, 'index.html'))) {
    await app.register(fastifyStatic, { root: WEB_BUILD_DIR, cacheControl: false })
    app.addHook('onSend', async (req, reply) => {
      if (req.url.startsWith('/assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      else if (!req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-cache')
    })
  } else {
    app.get('/', async (_req, reply) => {
      reply.type('text/plain').send('The front end has not been built yet. Run "npm run build".')
    })
  }

  // ---- websockets ---------------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })

  const onUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    const reject = (status: number, text: string): void => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
    }
    let user: User | null
    let url: URL
    try {
      checkHostAndOrigin(req, true)
      user = identify(req)
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return reject(403, 'Forbidden')
    }
    if (!user) return reject(401, 'Unauthorized')
    const who = user

    if (url.pathname === '/ws/events') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        trackSocket(ws, who)
        addEventClient(ws, who)
        ws.on('error', () => ws.close())
      })
      return
    }

    if (url.pathname === '/ws/doc') {
      const project = currentProject()
      let entry
      try {
        if (!project) throw new HttpError(409, 'No project')
        entry = project.docs.open(url.searchParams.get('path') ?? '')
      } catch {
        return reject(404, 'Not Found')
      }
      const found = entry
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('error', () => ws.close())
        if (url.searchParams.get('inst') !== found.instance) {
          // The browser holds a copy from an older load of this file; merging it would duplicate text.
          ws.close(CLOSE_STALE, 'stale document')
          return
        }
        trackSocket(ws, who)
        project!.docs.connect(ws, found)
      })
      return
    }

    reject(404, 'Not Found')
  }

  onSessionsRevoked((ids, reason) => {
    disconnectUsers(ids, reason)
    broadcastPresence()
  })

  // ---- listeners ------------------------------------------------------------------

  async function syncLanListeners(): Promise<void> {
    const cfg = getConfig()
    const wanted = cfg.lan.enabled && cfg.lan.passcodeHash ? lanIPv4Addresses() : []
    for (const [ip, server] of lanServers) {
      if (!wanted.includes(ip)) {
        lanServers.delete(ip)
        server.close()
        server.closeAllConnections()
      }
    }
    for (const ip of wanted) {
      if (lanServers.has(ip)) continue
      const server = http.createServer(handler)
      server.on('upgrade', onUpgrade)
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, ip, () => resolve())
        })
        server.on('error', (err) => console.error(`LAN listener ${ip}:`, err.message))
        lanServers.set(ip, server)
        console.log(`Sharing on http://${ip}:${port}`)
      } catch (err) {
        console.error(`Could not share on ${ip}:${port}: ${(err as Error).message}`)
      }
    }
  }

  await app.ready()
  if (!opts.strictPort) {
    for (let i = 0; i < 30 && !(await portFree(port)); i++) port++
  }
  app.server.on('upgrade', onUpgrade)
  await app.listen({ port, host: '127.0.0.1' })
  setAiPort(port)
  updateConfig((c) => void (c.lastPort = port))
  await syncLanListeners()
  // The Mac's address changes when it switches networks; follow it while sharing is on.
  const lanTimer = setInterval(() => {
    const before = [...lanServers.keys()].join(',')
    void syncLanListeners().then(() => {
      if ([...lanServers.keys()].join(',') !== before) broadcast('sharing', { sharing: sharingState() }, 'host')
    })
  }, 10_000)
  lanTimer.unref()

  return {
    port,
    lanAddresses: () => [...lanServers.keys()],
    close: async () => {
      clearInterval(lanTimer)
      await closeProject(false)
      closeAllSockets()
      for (const server of lanServers.values()) {
        server.close()
        server.closeAllConnections()
      }
      lanServers.clear()
      app.server.closeAllConnections()
      await app.close()
    },
  }
}

async function main(): Promise<void> {
  installLogging()
  const noOpen = process.argv.includes('--no-open') || process.env.LATEXWRITER_NO_OPEN === '1'
  const cfgPort = DEFAULT_PORT
  const alreadyRunning = (): void => {
    console.log(`LaTeX Writer is already running on http://localhost:${cfgPort}`)
    if (!noOpen) openUrl(`http://localhost:${cfgPort}`)
    // Nothing should keep this process alive, but make sure of it.
    setTimeout(() => process.exit(0), 1000).unref()
  }
  if (!(await portFree(cfgPort)) && (await isOurServer(cfgPort))) return alreadyRunning()
  // Claim the usual port first. When two apps start a server at the same moment (both saw the
  // old one go), one gets it and the other finds it here instead of moving to the next port.
  let server: ServerHandle
  try {
    server = await startServer({ port: cfgPort, strictPort: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
    for (let i = 0; i < 20 && !(await isOurServer(cfgPort)); i++) await new Promise((r) => setTimeout(r, 100))
    if (await isOurServer(cfgPort)) return alreadyRunning()
    server = await startServer()
  }
  // Started again by an app after the server it used went away: open the project that was open.
  const reopen = getConfig().openProject
  if (process.argv.includes('--reopen') && reopen && fs.existsSync(reopen)) {
    try {
      await openProject(reopen)
      console.log(`Reopened ${reopen}`)
    } catch (err) {
      console.error(`Could not reopen ${reopen}: ${(err as Error).message}`)
    }
  }
  const url = `http://localhost:${server.port}`
  console.log(`\nLaTeX Writer is running on ${url}`)
  console.log('Keep this window open while you work. Press Ctrl+C or close the window to stop.\n')
  if (!noOpen) openUrl(url)

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    console.log(`\nStopping (${signal}): saving open files...`)
    const force = setTimeout(() => process.exit(0), 5000)
    force.unref()
    server.close().catch((err) => console.error(err)).finally(() => process.exit(0))
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => stop(sig))
  // Started by the Mac app with a pipe on stdin: when the app goes away (even force-quit or a
  // crash) the pipe closes, and the server stops instead of running on unseen.
  if (process.argv.includes('--exit-with-parent')) {
    process.stdin.on('end', () => stop('the app quit'))
    process.stdin.on('close', () => stop('the app quit'))
    process.stdin.resume()
  }
  process.on('uncaughtException', (err) => {
    console.error('Unexpected error:', err)
    try {
      currentProject()?.docs.flushAll()
    } catch {}
  })
  process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err))
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
