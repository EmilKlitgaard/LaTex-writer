import './style.css'
import { api, ApiError, setUnauthorizedHandler, type AiSettings, type ProjectInfo, type User } from './api.ts'
import { app, applyFontSize, applyTheme } from './app.ts'
import { clear, h, toast } from './dom.ts'
import { leaveProject } from './dialogs.ts'
import { mountHome, mountLogin, mountWaiting } from './home.ts'
import { mountWorkbench } from './workbench.ts'

const root = document.getElementById('app')!
let unmount: () => void = () => {}

const LOGOUT_MESSAGES: Record<string, string> = {
  kicked: 'The host removed you from the session.',
  'passcode-changed': 'The passcode was changed. Enter the new one to continue.',
  'sharing-off': 'The host stopped sharing.',
  logout: '',
}

function show(mount: () => () => void): void {
  unmount()
  unmount = mount()
}

function showLogin(message: string | null): void {
  app.events.stop()
  app.user = null
  app.project = null
  show(() => mountLogin(root, message, () => void boot()))
}

function route(): void {
  if (!app.user) return showLogin(null)
  if (app.project) {
    show(() => mountWorkbench(root, {
      onBack: () => void leaveProject((force) => api('POST', '/api/host/project/close', { force })).catch((err) => toast((err as Error).message, 'error')),
      onLeave: leave,
    }))
  } else if (app.user.role === 'host') show(() => mountHome(root))
  else show(() => mountWaiting(root, leave))
}

function leave(): void {
  void api('POST', '/api/auth/logout', {}).catch(() => {}).then(() => showLogin(null))
}

async function boot(): Promise<void> {
  let me: { user: User | null; project: ProjectInfo | null; ai: AiSettings | null }
  try {
    me = await api('GET', '/api/me')
  } catch (err) {
    show(() => {
      clear(root)
      root.appendChild(h('div', { class: 'center-screen' }, h('div', { class: 'login-card' },
        h('h1', null, 'LaTeX Writer'),
        h('p', { class: 'error-text' }, (err as Error).message),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => void boot() }, 'Try again'))))
      return () => {}
    })
    return
  }
  app.user = me.user
  app.project = me.project
  app.ai = me.ai
  if (!me.user) return showLogin(null)
  app.events.start()
  route()
}

/** After a dropped connection: find out whether we are still signed in and which project is open. */
async function resync(): Promise<void> {
  if (!app.user) return
  try {
    const me = await api<{ user: User | null; project: ProjectInfo | null }>('GET', '/api/me')
    if (!me.user) return showLogin('Your session has ended. Enter the passcode to continue.')
    const changed = (me.project?.name ?? null) !== (app.project?.name ?? null) || Boolean(me.project) !== Boolean(app.project)
    app.user = me.user
    app.project = me.project
    if (changed) route()
  } catch (err) {
    // Server not reachable: the events channel keeps retrying and calls us again.
    if (!(err instanceof ApiError) || err.status !== 0) console.error(err)
  }
}

app.events.on((e) => {
  if (e.type === 'project') {
    app.project = e.project
    route()
  } else if (e.type === 'presence') {
    app.people = e.people
  } else if (e.type === 'ai' && e.kind === 'settings') {
    app.ai = e.ai
  } else if (e.type === 'notice') {
    toast(e.message, e.kind === 'error' ? 'error' : 'info', 10_000)
  } else if (e.type === 'logged-out') {
    showLogin(LOGOUT_MESSAGES[e.reason] ?? 'Your session has ended.')
  }
})

let resyncTimer: ReturnType<typeof setTimeout> | undefined
app.events.onStatus((connected) => {
  clearTimeout(resyncTimer)
  if (connected) void resync()
  else resyncTimer = setTimeout(() => void resync(), 2500)
})

setUnauthorizedHandler(() => {
  if (app.user?.role === 'guest') showLogin('Your session has ended. Enter the passcode to continue.')
})

applyTheme()
applyFontSize()
void boot()
