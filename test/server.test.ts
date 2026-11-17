// End-to-end test of the server: real HTTP, real websockets, real LaTeX compiles.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

// Isolate everything (config, scratch, Downloads) in a throwaway home folder.
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lw-home-')))
process.env.HOME = HOME
delete process.env.LATEXWRITER_HOME
fs.mkdirSync(path.join(HOME, 'Downloads'))
const WORKSPACE = path.join(HOME, 'Workspace')
fs.mkdirSync(WORKSPACE)

const { startServer } = await import('../server/index.ts')
const auth = await import('../server/auth.ts')
const { currentProject } = await import('../server/project.ts')

const LAN_IP = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address
const PORT = 41730 + Math.floor(Math.random() * 200)
const HOST = `http://127.0.0.1:${PORT}`
const LAN = `http://${LAN_IP}:${PORT}`
let server: Awaited<ReturnType<typeof startServer>>
let projectDir = ''

type Res = { status: number; json: any; headers: Headers; text: string }

async function api(base: string, method: string, url: string, body?: unknown, cookie?: string, extra: Record<string, string> = {}): Promise<Res> {
  const headers: Record<string, string> = { Origin: base, ...extra }
  if (method !== 'GET') headers['X-LW'] = '1'
  if (cookie) headers.Cookie = cookie
  let payload: BodyInit | undefined
  if (body instanceof Uint8Array) {
    headers['Content-Type'] = 'application/octet-stream'
    payload = body as unknown as BodyInit
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(base + url, { method, headers, body: payload })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, headers: res.headers, text }
}
const host = (method: string, url: string, body?: unknown): Promise<Res> => api(HOST, method, url, body)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => T | Promise<T>, what: string, timeout = 8000): Promise<NonNullable<T>> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`)
    await sleep(40)
  }
}

async function compileAndWait(): Promise<any> {
  const before = (await host('GET', '/api/project/build')).json.result?.id ?? 0
  await host('POST', '/api/project/compile', {})
  return until(async () => {
    const b = (await host('GET', '/api/project/build')).json
    return !b.compiling && b.result && b.result.id > before ? b.result : null
  }, 'compile to finish', 60_000)
}

type Editor = { doc: Y.Doc; text: Y.Text; provider: WebsocketProvider; close: () => void }
const editors: Editor[] = []

async function openEditor(file: string, base = HOST, cookie?: string): Promise<Editor> {
  const info = await api(base, 'GET', `/api/project/doc?path=${encodeURIComponent(file)}`, undefined, cookie)
  assert.equal(info.status, 200, info.text)
  class WS extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, { origin: base, headers: cookie ? { Cookie: cookie } : {} })
    }
  }
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(base.replace('http', 'ws') + '/ws', 'doc', doc, {
    params: { path: info.json.path, inst: info.json.instance },
    WebSocketPolyfill: WS as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  })
  await until(() => provider.synced, `${file} to sync`)
  const ed = {
    doc, provider, text: doc.getText('content'),
    close: () => {
      provider.destroy()
      doc.destroy()
    },
  }
  editors.push(ed)
  return ed
}

before(async () => {
  server = await startServer({ port: PORT, strictPort: true })
})

after(async () => {
  for (const e of editors) e.close()
  await server.close()
  fs.rmSync(HOME, { recursive: true, force: true })
})

test('the server answers on loopback only', async () => {
  assert.equal((await host('GET', '/api/ping')).json.app, 'latex-writer')
  const me = (await host('GET', '/api/me')).json
  assert.equal(me.user.role, 'host')
  assert.equal(me.project, null)
  if (LAN_IP) await assert.rejects(fetch(`${LAN}/api/ping`, { signal: AbortSignal.timeout(1500) }), 'not reachable from the LAN while sharing is off')
})

test('cross-site and rebinding requests are refused', async () => {
  const noHeader = await fetch(`${HOST}/api/host/project/close`, { method: 'POST' })
  assert.equal(noHeader.status, 403)
  const evilOrigin = await api(HOST, 'POST', '/api/host/project/close', {}, undefined, { Origin: 'http://evil.example' })
  assert.equal(evilOrigin.status, 403)
  const rebinding = await new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/host/home', headers: { Host: 'evil.example' } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(rebinding, 403)
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/events`, { origin: 'http://evil.example' })
  const code = await new Promise<number>((resolve) => {
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    ws.on('open', () => resolve(101))
    ws.on('error', () => {})
  })
  assert.equal(code, 403)
})

test('the folder picker lists folders and workspaces list projects', async () => {
  const b = (await host('GET', `/api/host/browse?path=${encodeURIComponent(HOME)}`)).json
  assert.deepEqual(b.entries.map((e: any) => e.name).filter((n: string) => n !== 'Library'), ['Downloads', 'Workspace'])
  assert.equal(b.parent, path.dirname(HOME))
  const ws = (await host('GET', `/api/host/workspace?path=${encodeURIComponent(WORKSPACE)}`)).json
  assert.deepEqual(ws.projects, [])
  assert.equal(ws.templates.length, 5)
  // A folder that was renamed or deleted must not dead-end the picker: it lands on the nearest one that exists.
  const gone = (await host('GET', `/api/host/browse?path=${encodeURIComponent(path.join(WORKSPACE, 'renamed-away', 'deeper'))}`)).json
  assert.deepEqual([gone.path, gone.missing], [WORKSPACE, path.join(WORKSPACE, 'renamed-away', 'deeper')])
  assert.equal((await host('GET', '/api/host/browse?path=not-absolute')).json.path, HOME)
  assert.equal((await host('POST', '/api/host/mkdir', { parent: path.join(WORKSPACE, 'renamed-away'), name: 'x' })).status, 404)
  assert.equal((await host('POST', '/api/host/mkdir', { parent: WORKSPACE, name: 'Made Here' })).json.path, path.join(WORKSPACE, 'Made Here'))
  fs.rmdirSync(path.join(WORKSPACE, 'Made Here'))
  const home = (await host('GET', '/api/host/home')).json
  assert.equal(home.recentWorkspaces[0].path, WORKSPACE)
})

test('creating a project applies the structure and opens it', async () => {
  const res = await host('POST', '/api/host/project/create', { workspace: WORKSPACE, name: 'Test: Project', template: 'article' })
  assert.equal(res.status, 200, res.text)
  projectDir = path.join(WORKSPACE, 'Test Project')
  assert.ok(fs.existsSync(path.join(projectDir, 'main.tex')))
  assert.ok(fs.existsSync(path.join(projectDir, '.latexwriter/project.json')))
  assert.equal(res.json.project.name, 'Test: Project')
  const tree = (await host('GET', '/api/project/tree')).json.tree
  assert.deepEqual(tree.map((n: any) => n.name), ['INSTRUCTIONS.md', 'main.tex', 'references.bib'])
  const dup = await host('POST', '/api/host/project/create', { workspace: WORKSPACE, name: 'Test Project', template: 'blank' })
  assert.equal(dup.status, 409)
  const ws = (await host('GET', `/api/host/workspace?path=${encodeURIComponent(WORKSPACE)}`)).json
  assert.equal(ws.projects.length, 1)
})

test('the project compiles and the PDF lands next to main.tex', async () => {
  const result = await compileAndWait()
  assert.equal(result.status, 'success', JSON.stringify(result.entries))
  assert.equal(result.errorCount, 0)
  assert.equal(result.engine, 'pdflatex')
  assert.ok(fs.statSync(path.join(projectDir, 'main.pdf')).size > 1000)
  const pdf = await fetch(`${HOST}/api/project/pdf`)
  assert.equal((await pdf.text()).slice(0, 5), '%PDF-')
  // No build litter in the project folder.
  assert.deepEqual(fs.readdirSync(projectDir).sort(), ['.latexwriter', 'INSTRUCTIONS.md', 'main.pdf', 'main.tex', 'references.bib'])
})

test('compiling again without changes keeps the result instead of failing', async () => {
  // Auto-compile can fire when nothing changed (an edit that was undone); latexmk then has nothing to do.
  const again = await currentProject()!.compile()
  assert.equal(again.status, 'success', JSON.stringify(again.entries))
  assert.ok(again.pdfVersion > 0)
  // The Recompile button forces a real run.
  const logBefore = fs.statSync(path.join(currentProject()!.compiler.buildDir, 'main.log')).mtimeMs
  await sleep(20)
  assert.equal((await compileAndWait()).status, 'success')
  assert.ok(fs.statSync(path.join(currentProject()!.compiler.buildDir, 'main.log')).mtimeMs > logBefore)
})

test('two editors see each other live and the file is saved', async () => {
  const a = await openEditor('main.tex')
  const b = await openEditor('main.tex')
  assert.equal(a.text.toString(), fs.readFileSync(path.join(projectDir, 'main.tex'), 'utf8'))
  const at = a.text.toString().indexOf('Start writing here.')
  a.text.insert(at, 'HELLO-FROM-A ')
  await until(() => b.text.toString().includes('HELLO-FROM-A'), 'B to see A')
  b.text.insert(0, '% edited by B\n')
  await until(() => a.text.toString().startsWith('% edited by B'), 'A to see B')
  await until(() => fs.readFileSync(path.join(projectDir, 'main.tex'), 'utf8') === a.text.toString(), 'save to disk')
})

test('compile errors point at the file and line', async () => {
  const [a] = editors
  const lines = a.text.toString().split('\n')
  const lineIndex = lines.findIndex((l) => l.includes('\\section{Conclusion}'))
  const offset = lines.slice(0, lineIndex + 1).join('\n').length
  a.text.insert(offset, '\n\\thiscommanddoesnotexist')
  const pdfBefore = fs.statSync(path.join(projectDir, 'main.pdf')).mtimeMs
  const result = await compileAndWait()
  assert.equal(result.status, 'error')
  const err = result.entries.find((e: any) => e.severity === 'error')
  assert.deepEqual([err.file, err.line], ['main.tex', lineIndex + 2])
  assert.match(err.message, /Undefined control sequence/)
  assert.equal(fs.statSync(path.join(projectDir, 'main.pdf')).mtimeMs, pdfBefore, 'the last good PDF stays in the project')
  a.text.delete(offset, '\n\\thiscommanddoesnotexist'.length)
  assert.equal((await compileAndWait()).status, 'success')
})

test('SyncTeX maps source to PDF and back', async () => {
  const lines = editors[0].text.toString().split('\n')
  const line = lines.findIndex((l) => l.includes('HELLO-FROM-A')) + 1
  const view = (await host('POST', '/api/project/synctex/view', { file: 'main.tex', line, column: 0 })).json.position
  assert.equal(view.page, 1)
  assert.ok(view.h > 0 && view.v > 0)
  const edit = (await host('POST', '/api/project/synctex/edit', { page: 1, x: view.h + 5, y: view.v - 2 })).json.position
  assert.equal(edit.file, 'main.tex')
  assert.ok(Math.abs(edit.line - line) <= 2, `line ${edit.line} vs ${line}`)
})

test('edits made outside the app are merged into open editors', async () => {
  const [a, b] = editors
  const file = path.join(projectDir, 'main.tex')
  await until(() => fs.readFileSync(file, 'utf8') === a.text.toString(), 'disk in sync')
  const changed = fs.readFileSync(file, 'utf8').replace('HELLO-FROM-A', 'CHANGED-OUTSIDE')
  fs.writeFileSync(file, changed)
  await until(() => a.text.toString() === changed && b.text.toString() === changed, 'external edit to arrive')
})

test('a stale local copy is refused instead of merged', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/doc?path=main.tex&inst=old`, { origin: HOST })
  const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)))
  assert.equal(code, 4001)
})

test('history keeps the pre-edit version and can restore it', async () => {
  const snaps = (await host('GET', '/api/project/history?path=main.tex')).json.snapshots
  assert.ok(snaps.length >= 1)
  const oldest = snaps.at(-1)
  assert.equal(oldest.reason, 'before-edit')
  const content = (await host('GET', `/api/project/history/content?path=main.tex&id=${oldest.id}`)).json.content
  assert.ok(!content.includes('CHANGED-OUTSIDE') && content.includes('\\documentclass'))
  const current = editors[0].text.toString()
  assert.equal((await host('POST', '/api/project/history/restore', { path: 'main.tex', id: oldest.id })).status, 200)
  await until(() => editors[1].text.toString() === content, 'restore to reach editors')
  const after = (await host('GET', '/api/project/history?path=main.tex')).json.snapshots
  assert.equal(after[0].reason, 'before-restore')
  assert.equal((await host('GET', `/api/project/history/content?path=main.tex&id=${after[0].id}`)).json.content, current)
})

test('files can be created, moved, deleted and restored', async () => {
  assert.equal((await host('POST', '/api/project/create', { parent: '', name: 'chapters', type: 'dir' })).status, 200)
  assert.equal((await host('POST', '/api/project/create', { parent: 'chapters', name: 'one.tex', type: 'file' })).json.path, 'chapters/one.tex')
  assert.equal((await host('POST', '/api/project/create', { parent: 'chapters', name: 'one.tex', type: 'file' })).status, 409)
  const ed = await openEditor('chapters/one.tex')
  ed.text.insert(0, 'Chapter one text')
  await until(() => fs.readFileSync(path.join(projectDir, 'chapters/one.tex'), 'utf8') === 'Chapter one text', 'save')
  assert.equal((await host('POST', '/api/project/move', { from: 'chapters', to: 'parts' })).status, 200)
  assert.equal(fs.readFileSync(path.join(projectDir, 'parts/one.tex'), 'utf8'), 'Chapter one text')
  assert.ok((await host('GET', '/api/project/history?path=parts/one.tex')).json.snapshots.length >= 1, 'history follows the move')
  assert.equal((await host('POST', '/api/project/move', { from: 'parts', to: 'parts/inside' })).status, 400)
  assert.equal((await host('POST', '/api/project/delete', { path: 'parts' })).status, 200)
  assert.equal(fs.existsSync(path.join(projectDir, 'parts')), false)
  const trash = (await host('GET', '/api/project/trash')).json.items
  assert.deepEqual(trash.map((t: any) => [t.path, t.type]), [['parts', 'dir']])
  assert.equal((await host('POST', '/api/project/trash/restore', { id: trash[0].id })).json.path, 'parts')
  assert.equal(fs.readFileSync(path.join(projectDir, 'parts/one.tex'), 'utf8'), 'Chapter one text')
})

test('moving the main file keeps the project pointing at it', async () => {
  const gone = new Promise<number>((resolve) => editors[0].provider.on('connection-close', (ev: any) => resolve(ev?.code ?? 0)))
  assert.equal((await host('POST', '/api/project/move', { from: 'main.tex', to: 'thesis.tex' })).status, 200)
  assert.equal((await host('GET', '/api/project/tree')).json.project.mainFile, 'thesis.tex')
  assert.equal(await gone, 4002, 'open editors are told the file moved')
  assert.equal((await host('POST', '/api/project/move', { from: 'thesis.tex', to: 'main.tex' })).status, 200)
  assert.equal((await host('POST', '/api/project/settings', { mainFile: 'nope.tex' })).status, 400)
  // Editors of the old path are dead now; open a fresh one for the remaining tests.
  for (const e of editors.splice(0)) e.close()
  const fresh = await openEditor('main.tex')
  assert.equal(fresh.text.toString(), fs.readFileSync(path.join(projectDir, 'main.tex'), 'utf8'))
})

test('paths cannot escape the project', async () => {
  for (const p of ['../../../etc/passwd', '/etc/passwd', '.latexwriter/project.json', 'a/../../x']) {
    const q = encodeURIComponent(p)
    assert.equal((await host('GET', `/api/project/raw?path=${q}`)).status, 400, p)
    assert.equal((await host('GET', `/api/project/doc?path=${q}`)).status, 400, p)
    assert.equal((await host('PUT', `/api/project/upload?path=${q}`, new Uint8Array([1]))).status, 400, p)
    assert.equal((await host('POST', '/api/project/delete', { path: p })).status, 400, p)
    assert.equal((await host('POST', '/api/project/move', { from: 'main.tex', to: p })).status, 400, p)
    assert.equal((await host('POST', '/api/project/create', { parent: p, name: 'x.tex', type: 'file' })).status, 400, p)
  }
  assert.equal((await host('POST', '/api/project/create', { parent: '', name: '../x.tex', type: 'file' })).status, 400)
  fs.symlinkSync('/etc', path.join(projectDir, 'etc-link'))
  assert.equal((await host('GET', '/api/project/raw?path=etc-link/hosts')).status, 400)
  fs.rmSync(path.join(projectDir, 'etc-link'))
  assert.equal(fs.existsSync(path.join(WORKSPACE, 'x.tex')), false)
})

test('uploads are stored, never overwrite, and are served as inert content', async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
  assert.equal((await host('PUT', '/api/project/upload?path=fig.png', png)).json.path, 'fig.png')
  assert.equal((await host('PUT', '/api/project/upload?path=fig.png', png)).json.path, 'fig (2).png')
  assert.equal((await host('PUT', '/api/project/upload?path=evil.html', new TextEncoder().encode('<script>alert(1)</script>'))).status, 200)
  const img = await host('GET', '/api/project/raw?path=fig.png')
  assert.equal(img.headers.get('content-type'), 'image/png')
  assert.match(img.headers.get('content-security-policy')!, /sandbox/)
  const html = await host('GET', '/api/project/raw?path=evil.html')
  assert.equal(html.headers.get('content-type'), 'application/octet-stream')
  assert.match(html.headers.get('content-disposition')!, /attachment/)
  const tree = (await host('GET', '/api/project/tree')).json.tree
  assert.equal(tree.find((n: any) => n.name === 'fig.png').kind, 'image')
})

test('the index lists labels, citation keys and files', async () => {
  const idx = (await host('GET', '/api/project/index')).json
  assert.ok(idx.labels.some((l: any) => l.name === 'sec:method' && l.file === 'main.tex'))
  assert.deepEqual(idx.bibKeys.map((k: any) => k.key), ['knuth1984'])
  assert.ok(idx.files.includes('fig.png'))
})

test('the index says on which line each label and citation key is defined', async () => {
  const idx = (await host('GET', '/api/project/index')).json
  const lineOf = async (file: string): Promise<string[]> => (await host('GET', `/api/project/raw?path=${encodeURIComponent(file)}`)).text.split('\n')
  const label = idx.labels.find((l: any) => l.name === 'sec:method')
  assert.ok((await lineOf(label.file))[label.line - 1].includes('\\label{sec:method}'))
  const key = idx.bibKeys.find((k: any) => k.key === 'knuth1984')
  assert.ok((await lineOf(key.file))[key.line - 1].includes('knuth1984'))
})

test('export copies the PDF to Downloads without overwriting', async () => {
  assert.equal((await compileAndWait()).status, 'success')
  const first = (await host('POST', '/api/host/export', {})).json
  assert.equal(first.name, 'Test Project.pdf')
  const second = (await host('POST', '/api/host/export', {})).json
  assert.equal(second.name, 'Test Project (2).pdf')
  assert.ok(fs.statSync(path.join(HOME, 'Downloads', 'Test Project (2).pdf')).size > 1000)
})

test('the project downloads as a zip without internal files', async () => {
  const res = await fetch(`${HOST}/api/project/zip`)
  const bytes = Buffer.from(await res.arrayBuffer())
  assert.equal(bytes.subarray(0, 2).toString(), 'PK')
  assert.ok(bytes.includes(Buffer.from('main.tex')))
  assert.equal(bytes.includes(Buffer.from('.latexwriter')), false)
})

test('the TeX sandbox: no shell escape, no reading or writing outside the build folder', async () => {
  const secret = path.join(HOME, 'secret.txt')
  fs.writeFileSync(secret, 'TOP-SECRET-CONTENT')
  const [a] = editors
  const original = a.text.toString()
  const attack = `\\documentclass{article}\\begin{document}
\\immediate\\write18{touch ${HOME}/pwned}
\\newread\\r \\openin\\r=${secret} \\typeout{RESULT:\\ifeof\\r NOREAD\\else CANREAD\\fi}
\\newwrite\\f \\immediate\\openout\\f=${HOME}/written.txt \\immediate\\write\\f{x}
\\end{document}`
  a.doc.transact(() => {
    a.text.delete(0, a.text.length)
    a.text.insert(0, attack)
  })
  await compileAndWait()
  const log = (await host('GET', '/api/project/log')).text
  assert.match(log, /runsystem\(touch .*\)\.\.\.disabled/, 'shell escape is disabled')
  assert.match(log, /RESULT:NOREAD/, 'files outside the build folder cannot be read')
  assert.match(log, /I can't write on file/, 'files outside the build folder cannot be written')
  assert.equal(fs.existsSync(path.join(HOME, 'pwned')), false, 'shell escape ran')
  assert.equal(fs.existsSync(path.join(HOME, 'written.txt')), false, 'wrote outside the build folder')
  // A latexmkrc in the project must not be executed either.
  fs.writeFileSync(path.join(projectDir, 'latexmkrc'), `system("touch ${HOME}/rc-ran");\n`)
  fs.writeFileSync(path.join(projectDir, '.latexmkrc'), `system("touch ${HOME}/rc-ran");\n`)
  await compileAndWait()
  assert.equal(fs.existsSync(path.join(HOME, 'rc-ran')), false, 'latexmkrc was executed')
  fs.rmSync(path.join(projectDir, 'latexmkrc'))
  fs.rmSync(path.join(projectDir, '.latexmkrc'))
  a.doc.transact(() => {
    a.text.delete(0, a.text.length)
    a.text.insert(0, original)
  })
  assert.equal((await compileAndWait()).status, 'success')
})

test('sharing: passcode, guest permissions, lockout, kick', { skip: !LAN_IP && 'no LAN address on this machine' }, async () => {
  assert.equal((await host('POST', '/api/host/settings', { lanEnabled: true })).status, 400, 'needs a passcode first')
  assert.equal((await host('POST', '/api/host/settings', { passcode: '123' })).status, 400, 'too short')
  const on = await host('POST', '/api/host/settings', { passcode: '1234', lanEnabled: true })
  assert.equal(on.status, 200, on.text)
  assert.deepEqual(on.json.sharing.urls.includes(LAN), true)

  // Not logged in: nothing but the login is reachable.
  assert.equal((await api(LAN, 'GET', '/api/me')).json.user, null)
  assert.equal((await api(LAN, 'GET', '/api/me')).json.project, null)
  assert.equal((await api(LAN, 'GET', '/api/project/tree')).status, 401)
  assert.equal((await api(LAN, 'GET', '/api/host/home')).status, 403)

  // Five wrong codes lock the address out, even for the right code.
  for (let i = 0; i < 4; i++) assert.equal((await api(LAN, 'POST', '/api/auth/login', { passcode: 'nope', name: 'x' })).status, 401)
  assert.equal((await api(LAN, 'POST', '/api/auth/login', { passcode: 'nope', name: 'x' })).status, 429)
  assert.equal((await api(LAN, 'POST', '/api/auth/login', { passcode: '1234', name: 'x' })).status, 429)
  auth._resetAuthForTests()

  const login = await api(LAN, 'POST', '/api/auth/login', { passcode: '1234', name: 'Anna' })
  assert.equal(login.status, 200, login.text)
  assert.equal(login.json.user.name, 'Anna')
  const setCookie = login.headers.get('set-cookie')!
  assert.match(setCookie, /HttpOnly/)
  const cookie = setCookie.split(';')[0]

  // A guest can work in the open project...
  assert.equal((await api(LAN, 'GET', '/api/project/tree', undefined, cookie)).status, 200)
  assert.equal((await api(LAN, 'POST', '/api/project/create', { parent: '', name: 'guest.tex', type: 'file' }, cookie)).status, 200)
  assert.equal((await api(LAN, 'POST', '/api/project/settings', { autoCompile: false }, cookie)).status, 200)
  assert.equal((await api(LAN, 'POST', '/api/project/compile', {}, cookie)).status, 200)
  const guestEd = await openEditor('guest.tex', LAN, cookie)
  guestEd.text.insert(0, 'from the guest')
  await until(() => fs.readFileSync(path.join(projectDir, 'guest.tex'), 'utf8') === 'from the guest', 'guest edit saved')

  // ...but cannot touch host-only things.
  assert.equal((await api(LAN, 'POST', '/api/project/settings', { mainFile: 'guest.tex' }, cookie)).status, 403)
  assert.equal((await api(LAN, 'POST', '/api/project/settings', { name: 'Hacked' }, cookie)).status, 403)
  for (const [method, url, body] of [
    ['GET', '/api/host/home'], ['GET', `/api/host/browse?path=${encodeURIComponent(HOME)}`],
    ['POST', '/api/host/settings', { passcode: 'abcd' }], ['POST', '/api/host/project/close', {}],
    ['POST', '/api/host/project/open', { path: HOME }], ['POST', '/api/host/project/trash', { path: projectDir }],
    ['POST', '/api/host/export', {}], ['POST', '/api/host/kick', { id: 'host' }],
    ['GET', '/api/host/ai/state'], ['POST', '/api/host/ai/send', { text: 'hi' }], ['POST', '/api/host/review/accept', {}],
    ['POST', '/api/host/review/decline', {}], ['POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
    ['POST', '/api/host/project/create', { workspace: WORKSPACE, name: 'G', template: 'blank' }],
  ] as const) {
    assert.equal((await api(LAN, method, url, body, cookie)).status, 403, url)
  }

  // The host sees the guest and can remove them.
  const events = new WebSocket(`ws://${LAN_IP}:${PORT}/ws/events`, { origin: LAN, headers: { Cookie: cookie } })
  await new Promise((resolve) => events.on('open', resolve))
  const closed = new Promise<number>((resolve) => events.on('close', (c) => resolve(c)))
  const people = (await host('GET', '/api/host/home')).json.sharing.people
  const anna = people.find((p: any) => p.name === 'Anna')
  assert.equal(anna.role, 'guest')
  assert.equal((await host('POST', '/api/host/kick', { id: anna.id })).status, 200)
  assert.equal(await closed, 4003)
  assert.equal((await api(LAN, 'GET', '/api/project/tree', undefined, cookie)).status, 401)
  assert.equal((await api(LAN, 'POST', '/api/auth/login', { passcode: '1234', name: 'Anna' })).status, 429, 'kicked guests stay out for a while')
  auth._resetAuthForTests()

  // Changing the passcode logs everyone out.
  const again = (await api(LAN, 'POST', '/api/auth/login', { passcode: '1234', name: '' })).headers.get('set-cookie')!.split(';')[0]
  assert.equal((await api(LAN, 'GET', '/api/me', undefined, again)).json.user.name, 'Guest 1')
  await host('POST', '/api/host/settings', { passcode: 'new-code' })
  assert.equal((await api(LAN, 'GET', '/api/project/tree', undefined, again)).status, 401)
  assert.equal((await api(LAN, 'POST', '/api/auth/login', { passcode: '1234' })).status, 401)

  // Turning sharing off closes the LAN listener.
  await host('POST', '/api/host/settings', { lanEnabled: false })
  await assert.rejects(fetch(`${LAN}/api/ping`, { signal: AbortSignal.timeout(1500) }))
  assert.equal((await host('GET', '/api/ping')).status, 200)
})

test('LuaLaTeX is refused while sharing is on', { skip: !LAN_IP && 'no LAN address on this machine' }, async () => {
  const [a] = editors
  a.text.insert(0, '% !TEX program = lualatex\n')
  await host('POST', '/api/host/settings', { passcode: '1234', lanEnabled: true })
  const blocked = await compileAndWait()
  assert.equal(blocked.status, 'failed')
  assert.match(blocked.entries[0].message, /LuaLaTeX is disabled/)
  await host('POST', '/api/host/settings', { lanEnabled: false })
  a.text.delete(0, '% !TEX program = lualatex\n'.length)
})

// ---- assistant ---------------------------------------------------------------------------

async function mcp(method: string, params?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${HOST}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
const tool = async (name: string, args: Record<string, unknown> = {}): Promise<any> => (await mcp('tools/call', { name, arguments: args })).json.result
const review = async (): Promise<any> => (await host('GET', '/api/host/ai/state')).json.review

test('the tool endpoint speaks MCP and refuses web pages', async () => {
  const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  assert.equal(init.status, 200)
  assert.equal(init.json.result.serverInfo.name, 'latexwriter')
  assert.equal(init.json.result.protocolVersion, '2025-06-18')
  assert.match(init.json.result.instructions, /pending/)
  const note = await fetch(`${HOST}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
  assert.equal(note.status, 202)
  const names = (await mcp('tools/list')).json.result.tools.map((t: any) => t.name)
  for (const n of ['project_info', 'read_file', 'search', 'edit_file', 'write_file', 'compile', 'check_layout', 'read_pdf_text', 'view_page', 'read_log', 'use_skill', 'list_sources', 'request_access', 'copy_file']) assert.ok(names.includes(n), n)
  assert.equal((await mcp('no/such/method')).json.error.code, -32601)
  // Errors come back in two forms: protocol errors for bad requests, isError results for failed tools.
  assert.equal((await mcp('tools/call', { name: 'rm_rf', arguments: {} })).json.error.code, -32602)
  assert.equal((await mcp('tools/call', { name: 'read_file', arguments: { path: 'nope.tex' } })).json.result.isError, true)
  // A browser always sends Origin on a cross-site POST; that is how a web page is kept out.
  // The writing skills: a tool the model can call, and prompts for MCP clients.
  assert.deepEqual(init.json.result.capabilities, { tools: {}, prompts: {} })
  const skill = (await tool('use_skill', { name: 'humanize', request: 'the introduction' })).content[0].text
  assert.match(skill, /^<skill name="humanize">[\s\S]*<guide>[\s\S]*<\/guide>\n<\/skill>\n\nThe user's request for \/humanize: the introduction$/)
  assert.equal((await tool('use_skill', { name: 'nope' })).isError, true)
  const prompts = (await mcp('prompts/list')).json.result.prompts
  assert.deepEqual(prompts.map((p: any) => p.name), ['blind-audit', 'humanize', 'humanize-audit', 'humanize-draft'])
  assert.equal(prompts[0].arguments[0].name, 'request')
  const got = (await mcp('prompts/get', { name: 'humanize-draft', arguments: { request: 'a related-work paragraph' } })).json.result
  assert.equal(got.messages[0].role, 'user')
  assert.match(got.messages[0].content.text, /^<skill name="humanize-draft">[\s\S]*: a related-work paragraph$/)
  assert.equal((await mcp('prompts/get', { name: 'nope' })).json.error.code, -32602)
  assert.equal((await mcp('tools/list', undefined, { Origin: 'http://evil.example' })).status, 403)
  assert.equal((await mcp('tools/list', undefined, { Origin: HOST })).status, 403)
})

test('agents share memory through INSTRUCTIONS.md in the project and a global preferences file', async () => {
  const info = (await tool('project_info')).content[0].text
  assert.match(info, /Project notes \(INSTRUCTIONS\.md[\s\S]*Open tasks and progress[\s\S]*writing preferences[\s\S]*My writing preferences/)
  assert.ok(fs.existsSync(path.join(projectDir, 'INSTRUCTIONS.md')), 'the notes file lives with the other project files')
  assert.match(JSON.stringify((await host('GET', '/api/project/tree')).json.tree), /INSTRUCTIONS\.md/)

  // Notes are the agents' own memory: written at once, not held for review.
  assert.equal((await tool('update_notes', { file: 'project', text: 'Use British spelling.' })).isError, undefined)
  assert.match((await tool('read_notes')).content[0].text, /- Use British spelling\./)
  assert.match(fs.readFileSync(path.join(projectDir, 'INSTRUCTIONS.md'), 'utf8'), /- Use British spelling\./)
  assert.equal((await host('GET', '/api/host/ai/state')).json.review.changeCount, 0)

  // The author's preferences change only with a stated reason.
  assert.equal((await tool('update_notes', { file: 'preferences', text: 'Short sentences.' })).isError, true)
  assert.equal((await tool('update_notes', { file: 'preferences', text: 'Short sentences.', reason: 'The author asked for it' })).isError, undefined)
  assert.match(fs.readFileSync(path.join(HOME, 'Library/Application Support/LaTeXWriter/PREFERENCES.md'), 'utf8'), /- Short sentences\./)

  // Past the size limit an agent must condense the file instead of adding to it.
  const refused = await tool('update_notes', { file: 'project', text: 'x'.repeat(8100) })
  assert.equal(refused.isError, true)
  assert.match(refused.content[0].text, /replace/)
  assert.equal((await tool('update_notes', { file: 'project', mode: 'replace', text: '# Project notes\n- Condensed.' })).isError, undefined)
  assert.doesNotMatch((await tool('read_notes')).content[0].text, /British/)
})

test('assistant edits are live but pending; each change can be accepted or declined', async () => {
  const a = editors[0]
  const original = a.text.toString()
  assert.match((await tool('project_info')).content[0].text, /Main file: main\.tex[\s\S]*main\.tex {2}\(\d+ lines\)[\s\S]*review:\n {2}none/)
  assert.match((await tool('read_file', { path: 'main.tex', start_line: 1, end_line: 2 })).content[0].text, /^main\.tex, lines 1-2 of \d+:\n\\documentclass/)

  // Two changes in one call; the reply carries the compile result, so no separate compile step.
  const e1 = await tool('edit_file', {
    path: 'main.tex',
    edits: [
      { old_text: 'Start writing here.', new_text: 'AI-EDIT-ONE.' },
      { old_text: '\\section{Conclusion}', new_text: '\\section{Conclusions}\nAn added line.' },
    ],
  })
  assert.match(e1.content[0].text, /^Edited main\.tex \(2 changes, from line \d+\)\. Pending the user's review\.\nCompile succeeded: 0 errors/)
  await until(() => a.text.toString().includes('AI-EDIT-ONE.') && a.text.toString().includes('An added line.'), 'edits to reach the open editor')

  assert.equal((await tool('edit_file', { path: 'main.tex', old_text: 'not in the file', new_text: 'x' })).isError, true)
  // All or nothing: a failing second edit leaves the first one unapplied.
  const before = a.text.toString()
  const partial = await tool('edit_file', { path: 'main.tex', edits: [{ old_text: 'AI-EDIT-ONE.', new_text: 'SHOULD-NOT-APPEAR' }, { old_text: 'not there', new_text: 'x' }] })
  assert.equal(partial.isError, true)
  assert.match(partial.content[0].text, /Edit 2 of 2: old_text was not found[\s\S]*Nothing was changed/)
  assert.equal(a.text.toString(), before)
  assert.match((await tool('edit_file', { path: 'main.tex', old_text: '\\usepackage', new_text: 'x' })).content[0].text, /occurs \d+ times/)
  assert.equal((await tool('read_file', { path: '../../etc/passwd' })).isError, true)
  assert.equal((await tool('write_file', { path: '.latexwriter/project.json', content: '{}' })).isError, true)

  let r = await review()
  assert.equal(r.changeCount, 2)
  assert.equal(r.hasBeforePdf, true)
  const [first, second] = r.files[0].hunks
  assert.deepEqual(first.newLines.some((l: string) => l.includes('AI-EDIT-ONE.')), true)
  assert.deepEqual(second.oldLines, ['\\section{Conclusion}'])
  assert.deepEqual(second.newLines, ['\\section{Conclusions}', 'An added line.'])
  assert.equal((await fetch(`${HOST}/api/host/review/before.pdf`).then((x) => x.text())).slice(0, 5), '%PDF-')
  assert.ok(fs.existsSync(path.join(projectDir, '.latexwriter/review/state.json')), 'the pre-change backup exists while changes are pending')

  // Accept one: it stays in the document and leaves the pending list.
  assert.equal((await host('POST', '/api/host/review/accept', { path: 'main.tex', hunk: first.id })).status, 200)
  r = await review()
  assert.equal(r.changeCount, 1)
  assert.ok(a.text.toString().includes('AI-EDIT-ONE.'))
  assert.equal((await host('POST', '/api/host/review/accept', { path: 'main.tex', hunk: first.id })).status, 409, 'a stale change id is refused')

  // Decline the other: the old text comes back, and with nothing pending the backup is deleted.
  assert.equal((await host('POST', '/api/host/review/decline', { path: 'main.tex', hunk: r.files[0].hunks[0].id })).status, 200)
  await until(() => !a.text.toString().includes('An added line.'), 'declined text to leave the editor')
  assert.ok(a.text.toString().includes('\\section{Conclusion}\n'))
  assert.equal((await review()).changeCount, 0)
  assert.equal(fs.existsSync(path.join(projectDir, '.latexwriter/review')), false, 'backup deleted once everything is decided')

  // A new file: declining removes it, accepting keeps it.
  assert.match((await tool('write_file', { path: 'notes/ideas.tex', content: 'Idea one.\n', compile: false })).content[0].text, /^Created notes\/ideas\.tex\. Pending the user's review\. Not compiled yet\.$/)
  r = await review()
  assert.deepEqual([r.files[0].path, r.files[0].status], ['notes/ideas.tex', 'added'])
  await host('POST', '/api/host/review/decline', { path: 'notes/ideas.tex' })
  assert.equal(fs.existsSync(path.join(projectDir, 'notes/ideas.tex')), false)
  await tool('write_file', { path: 'notes/ideas.tex', content: 'Idea two.\n', compile: false })
  await host('POST', '/api/host/review/accept', {})
  // Replacing an existing file must be asked for, and is refused for long files.
  assert.match((await tool('write_file', { path: 'notes/ideas.tex', content: 'x' })).content[0].text, /already exists[\s\S]*overwrite: true/)
  await tool('write_file', { path: 'notes/long.tex', content: Array.from({ length: 100 }, (_, i) => `Line ${i}`).join('\n'), compile: false })
  const long = await tool('write_file', { path: 'notes/long.tex', content: 'short', overwrite: true, compile: false })
  assert.equal(long.isError, true)
  assert.match(long.content[0].text, /has 100 lines, too long to replace/)
  await host('POST', '/api/host/review/decline', { path: 'notes/long.tex' })
  assert.equal(fs.readFileSync(path.join(projectDir, 'notes/ideas.tex'), 'utf8'), 'Idea two.\n')
  assert.equal((await review()).changeCount, 0)

  // Decline everything at once puts every file back.
  await tool('edit_file', { path: 'main.tex', edits: [{ old_text: 'AI-EDIT-ONE.', new_text: 'AI-EDIT-TWO.' }], compile: false })
  await tool('edit_file', { path: 'notes/ideas.tex', edits: [{ old_text: 'two', new_text: 'three' }], compile: false })
  assert.equal((await review()).changeCount, 2)
  await host('POST', '/api/host/review/decline', {})
  await until(() => a.text.toString().includes('AI-EDIT-ONE.'), 'decline all to reach the editor')
  assert.equal(fs.readFileSync(path.join(projectDir, 'notes/ideas.tex'), 'utf8'), 'Idea two.\n')
  assert.equal((await review()).changeCount, 0)

  // Undoing the change by hand also clears it from the pending list.
  await tool('edit_file', { path: 'main.tex', old_text: 'AI-EDIT-ONE.', new_text: 'Start writing here.', compile: false })
  assert.equal(a.text.toString(), original)
  await host('POST', '/api/host/review/accept', {})
})

test('writing a Markdown file reports math left outside dollar signs, so the agent can fix it', async () => {
  const created = (await tool('write_file', { path: 'derivation.md', content: '# Derivation\n\nThe angle Theta_lenght grows as x^2.\n', compile: false })).content[0].text
  assert.match(created, /Created derivation\.md[\s\S]*Math outside \$\.\.\.\$ in derivation\.md[\s\S]*line 3: "Theta_lenght", "x\^2"/)
  // Fixed: no note, and the line that was already there is not reported again by a later edit.
  const fixed = (await tool('edit_file', { path: 'derivation.md', old_text: 'Theta_lenght grows as x^2', new_text: '$\\Theta_{\\text{length}}$ grows as $x^2$', compile: false })).content[0].text
  assert.doesNotMatch(fixed, /Math outside/)
  const tex = (await tool('edit_file', { path: 'main.tex', old_text: '\\section{Introduction}', new_text: '\\section{Introduction} x_1', compile: false })).content[0].text
  assert.doesNotMatch(tex, /Math outside/, 'only Markdown files are checked')
  for (const path of ['derivation.md', 'main.tex']) assert.equal((await host('POST', '/api/host/review/decline', { path })).status, 200)
})

test('the assistant can compile and read the result as text or as a page image', async () => {
  const c = await tool('compile')
  assert.equal(c.isError, undefined)
  assert.match(c.content[0].text, /^Compile succeeded: 0 errors, \d+ warnings?, 1 page\./)
  assert.match((await tool('read_pdf_text')).content[0].text, /PDF has 1 page\.[\s\S]*--- page 1 ---[\s\S]*Introduction/)
  assert.match((await tool('read_pdf_text', { query: 'introduction' })).content[0].text, /^p\.1: 1 Introduction/m)
  assert.match((await tool('read_pdf_text', { query: 'no such words' })).content[0].text, /does not occur/)
  assert.match((await tool('check_layout')).content[0].text, /^1 page\./)

  const reference = path.join(projectDir, 'Reference.PDF')
  fs.copyFileSync(path.join(projectDir, 'main.pdf'), reference)
  try {
    assert.match((await tool('read_file', { path: 'Reference.PDF' })).content[0].text, /Introduction/)
    assert.match((await tool('read_pdf_text', { path: 'Reference.PDF', query: 'introduction' })).content[0].text, /^p\.1: 1 Introduction/m)
    assert.equal((await tool('view_page', { path: 'Reference.PDF', page: 1 })).content[1].mimeType, 'image/png')
    assert.equal((await tool('read_pdf_text', { path: '../Reference.PDF' })).isError, true)
  } finally {
    fs.unlinkSync(reference)
  }

  const size = (r: any): number[] => (/(\d+)x(\d+) px/.exec(r.content[0].text) ?? []).slice(1).map(Number)
  const page = await tool('view_page', { page: 1 })
  assert.equal(page.content[1].type, 'image')
  assert.equal(page.content[1].mimeType, 'image/png')
  assert.equal(page.content[1].data.slice(0, 5), 'iVBOR')
  assert.ok(Math.max(...size(page)) <= 1000, `full page kept small: ${size(page)}`)
  const high = await tool('view_page', { page: 1, detail: 'high' })
  assert.match(high.content[0].text, /High detail is only given for a band/)
  assert.deepEqual(size(high), size(page), 'no high detail for a whole page')
  const band = await tool('view_page', { page: 1, from: 0, to: 0.3, detail: 'high' })
  assert.match(band.content[0].text, /from 0 to 0\.3/)
  const sheet = await tool('view_page', { pages: [1, 1, 5] })
  assert.match(sheet.content[0].text, /^Overview of pages 1, 1, 5 \(of 1\)/)
  assert.equal(sheet.content[1].type, 'image')
  assert.equal((await tool('view_page', { page: 99 })).isError, true)
  assert.equal((await tool('view_page', {})).isError, true)
  assert.match((await tool('search', { query: 'knuth' })).content[0].text, /references\.bib:\d+:/)
  assert.match((await tool('read_log', { lines: 5 })).content[0].text, /\S/)

  // A broken edit comes back from compile as an error with file and line.
  const broken = await tool('edit_file', { path: 'main.tex', edits: [{ old_text: '\\maketitle', new_text: '\\maketitle\n\\nosuchmacro' }] })
  assert.match(broken.content[0].text, /Compile FAILED: 1 error[\s\S]*ERROR main\.tex:\d+: Undefined control sequence\.\n {4}at: \\nosuchmacro$/)
  const failed = await tool('compile')
  assert.equal(failed.isError, true, 'a failing compile is reported as an error')
  await host('POST', '/api/host/review/decline', {})
  assert.match((await tool('compile')).content[0].text, /^Compile succeeded/)
})

test('the chat runs the Claude Code CLI with only this app\'s tools and no API key', async () => {
  // A stand-in for the real CLI: records how it was called and answers with a canned stream.
  const bin = path.join(HOME, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/bash
printf '%s\\n' "$@" > "$HOME/cli-args.txt"
cat > "$HOME/cli-stdin.txt"
{ cat "$HOME/cli-stdin.txt"; printf '\n<<END>>\n'; } >> "$HOME/cli-stdin-log.txt"
CONTEXT=$(cat "$HOME/cli-context.txt" 2>/dev/null || echo 42000)
if [ "$(cat "$HOME/cli-stdin.txt")" = "/compact" ]; then
  echo '{"type":"system","subtype":"status","status":"compacting"}'
  echo '{"type":"system","subtype":"init","session_id":"11111111-1111-1111-1111-111111111111"}'
  echo '{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"manual","pre_tokens":42510,"post_tokens":1900}}'
  echo '{"type":"result","is_error":false,"result":""}'
  exit 0
fi
env > "$HOME/cli-env.txt"
pwd > "$HOME/cli-cwd.txt"
echo '{"type":"system","subtype":"init","session_id":"11111111-1111-1111-1111-111111111111"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi from "}}}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"the stand-in."}}}'
echo '{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":'$CONTEXT',"cache_creation_input_tokens":500}}}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Hi from the stand-in."},{"type":"tool_use","id":"t1","name":"mcp__latexwriter__edit_file","input":{"path":"main.tex"}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":false}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a1","name":"Agent","input":{"subagent_type":"layout-checker","description":"Check pages 1-3","run_in_background":false}}]}}'
echo '{"type":"stream_event","parent_tool_use_id":"a1","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"HELPER TEXT MUST NOT LEAK"}}}'
echo '{"type":"stream_event","parent_tool_use_id":"a1","event":{"type":"message_start","message":{"usage":{"input_tokens":999999}}}}'
echo '{"type":"assistant","parent_tool_use_id":"a1","message":{"content":[{"type":"tool_use","id":"h1","name":"mcp__latexwriter__view_page","input":{"pages":[1,2,3]}}]}}'
echo '{"type":"user","parent_tool_use_id":"a1","message":{"content":[{"type":"tool_result","tool_use_id":"h1","is_error":false}]}}'
echo '{"type":"assistant","parent_tool_use_id":"a1","message":{"content":[{"type":"text","text":"HELPER TEXT MUST NOT LEAK"}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a1","is_error":false}]}}'
echo '{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":0.5,"resetsAt":1790789400}}}}'
echo '{"type":"result","is_error":false,"result":"Hi from the stand-in."}'
`, { mode: 0o755 })
  process.env.PATH = `${bin}:${process.env.PATH}`
  process.env.ANTHROPIC_API_KEY = 'sk-should-never-reach-the-cli'

  const chat = async (): Promise<any> => (await host('GET', '/api/host/ai/state')).json
  assert.equal((await chat()).ai.available, true)
  assert.equal((await host('POST', '/api/host/ai/send', { text: '  ' })).status, 400)
  assert.equal((await host('POST', '/api/host/ai/send', { text: 'Tighten the abstract', context: { file: 'main.tex', line: 18, selection: 'Write a short summary', selectionStart: 18, selectionEnd: 18 } })).status, 200)
  const done = await until(async () => {
    const s = await chat()
    return !s.chat.busy && s.chat.messages.length === 2 ? s : null
  }, 'the chat turn to finish')

  const [user, reply] = done.chat.messages
  assert.deepEqual([user.role, user.parts[0].text], ['user', 'Tighten the abstract'])
  assert.deepEqual(reply.parts, [
    { kind: 'text', text: 'Hi from the stand-in.' },
    { kind: 'tool', id: 't1', label: 'Edited main.tex', status: 'done' },
    { kind: 'tool', id: 'a1', label: 'Layout-checker: Check pages 1-3', status: 'done' },
    { kind: 'tool', id: 'h1', label: 'Looked at pages 1, 2, 3', status: 'done', parent: 'a1' },
  ])
  assert.equal(done.chat.usage.fiveHour, 0.5)
  assert.equal(done.chat.activity, null, 'nothing is shown as in progress once the turn is over')
  assert.equal(done.chat.usage.context, 42510, 'context size of the main conversation, not the helper')

  const args = fs.readFileSync(path.join(HOME, 'cli-args.txt'), 'utf8').split('\n')
  const flag = (name: string): string => args[args.indexOf(name) + 1]
  assert.ok(args.includes('-p') && args.includes('--strict-mcp-config') && args.includes('--disable-slash-commands'))
  assert.equal(flag('--tools'), 'Agent', 'no built-in tools except starting helpers')
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 3), ['mcp__latexwriter', 'Agent'])
  assert.equal(flag('--model'), 'sonnet')
  assert.equal(flag('--effort'), 'medium')
  assert.equal(flag('--autocompact'), '130k', 'only a safety net: the app compacts between turns')
  const agents = JSON.parse(flag('--agents'))
  assert.deepEqual(Object.keys(agents), ['reader', 'layout-checker', 'writer', 'auditor'])
  assert.ok(!agents.auditor.tools.some((x: string) => /edit_file|write_file|update_notes|copy_file/.test(x)), 'the auditor cannot edit')
  assert.equal(agents.reader.model, 'haiku')
  assert.ok(agents.reader.tools.every((x: string) => /^mcp__latexwriter__(project_info|read_file|search|read_pdf_text|use_skill|list_sources)$/.test(x)), 'the reader cannot edit or ask for access')
  assert.ok(agents.writer.tools.includes('mcp__latexwriter__use_skill'), 'the writer can load a skill it is handed')
  assert.match(fs.readFileSync(path.join(HOME, 'cli-args.txt'), 'utf8'), /Writing skills \(use_skill\)[\s\S]*- humanize-audit: /)
  assert.ok(!agents['layout-checker'].tools.some((x: string) => /edit_file|write_file/.test(x)), 'the layout checker cannot edit')
  assert.match(fs.readFileSync(path.join(HOME, 'cli-args.txt'), 'utf8'), /set run_in_background to false/)
  assert.deepEqual(JSON.parse(flag('--mcp-config')), { mcpServers: { latexwriter: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp?chat=${done.chat.activeId}` } } })
  assert.equal(args.includes('--resume'), false)
  const stdin = fs.readFileSync(path.join(HOME, 'cli-stdin.txt'), 'utf8')
  assert.match(stdin, /<context>\nProject "Test: Project"\. Main file: main\.tex\.[\s\S]*main\.tex open, cursor at line 18\.[\s\S]*Selected text \(lines 18-18\):\nWrite a short summary\n<\/context>\n\nTighten the abstract$/)
  assert.doesNotMatch(fs.readFileSync(path.join(HOME, 'cli-env.txt'), 'utf8'), /ANTHROPIC_API_KEY/, 'the API key must not reach the CLI')
  assert.ok(!fs.readFileSync(path.join(HOME, 'cli-cwd.txt'), 'utf8').includes('Workspace'), 'runs outside the project folder')

  // The next message continues the same conversation and does not repeat the project overview.
  await host('POST', '/api/host/ai/send', { text: 'And the title?' })
  await until(async () => ((await chat()).chat.messages.length === 4 && !(await chat()).chat.busy), 'second turn')
  const args2 = fs.readFileSync(path.join(HOME, 'cli-args.txt'), 'utf8').split('\n')
  assert.equal(args2[args2.indexOf('--resume') + 1], '11111111-1111-1111-1111-111111111111')
  assert.equal(fs.readFileSync(path.join(HOME, 'cli-stdin.txt'), 'utf8'), 'And the title?')

  // A /command reaches the model as the skill's instructions; the chat shows what the user typed.
  assert.ok((await chat()).ai.skills.some((s: any) => s.name === 'humanize' && s.hint && s.description))
  const unknown = await host('POST', '/api/host/ai/send', { text: '/humanise it' })
  assert.equal(unknown.status, 400)
  assert.match(unknown.json.error, /\/humanize-audit/)
  assert.equal((await chat()).chat.messages.length, 4, 'an unknown command adds nothing to the chat')
  await host('POST', '/api/host/ai/send', { text: '/humanize-audit section 2', context: { file: 'main.tex', line: 3 } })
  await until(async () => ((await chat()).chat.messages.length === 6 && !(await chat()).chat.busy), 'skill turn')
  assert.equal((await chat()).chat.messages[4].parts[0].text, '/humanize-audit section 2')
  assert.match(fs.readFileSync(path.join(HOME, 'cli-stdin.txt'), 'utf8'), /^<context>\nThe user has main\.tex open, cursor at line 3\.\n<\/context>\n\n<skill name="humanize-audit">[\s\S]*<guide>[\s\S]*request for \/humanize-audit: section 2$/)

  // /compact runs Claude Code's own /compact on the same session, with slash commands allowed only then.
  assert.equal((await host('POST', '/api/host/ai/send', { text: '/compact now' })).status, 400)
  await host('POST', '/api/host/ai/send', { text: '/compact', context: { file: 'main.tex', line: 3 } })
  await until(async () => ((await chat()).chat.messages.length === 8 && !(await chat()).chat.busy), 'compact turn')
  const compacted = (await chat()).chat
  assert.equal(compacted.messages[6].parts[0].text, '/compact')
  assert.deepEqual(compacted.messages[7].parts, [{ kind: 'text', text: 'Compacted the conversation from 42.5k tokens to 1.9k tokens.' }])
  assert.equal(compacted.usage.context, 1900)
  assert.equal(fs.readFileSync(path.join(HOME, 'cli-stdin.txt'), 'utf8'), '/compact', 'exactly the command: no context block')
  const cargs0 = fs.readFileSync(path.join(HOME, 'cli-args.txt'), 'utf8').split('\n')
  assert.equal(cargs0[cargs0.indexOf('--resume') + 1], '11111111-1111-1111-1111-111111111111')
  assert.equal(cargs0.includes('--disable-slash-commands'), false)
  assert.ok(cargs0.includes('--strict-mcp-config') && cargs0[cargs0.indexOf('--tools') + 1] === 'Agent', 'otherwise the same locked-down run')

  // A large conversation is compacted before the next turn, quietly, never during one.
  fs.writeFileSync(path.join(HOME, 'cli-context.txt'), '150000')
  await host('POST', '/api/host/ai/send', { text: 'A long turn' })
  await until(async () => ((await chat()).chat.messages.length === 10 && !(await chat()).chat.busy), 'long turn')
  assert.equal((await chat()).chat.usage.context, 150510)
  fs.rmSync(path.join(HOME, 'cli-context.txt'))
  fs.writeFileSync(path.join(HOME, 'cli-stdin-log.txt'), '')
  await host('POST', '/api/host/ai/send', { text: 'After the long turn' })
  await until(async () => ((await chat()).chat.messages.length === 12 && !(await chat()).chat.busy), 'turn after compaction')
  const prompts = fs.readFileSync(path.join(HOME, 'cli-stdin-log.txt'), 'utf8').split('\n<<END>>\n').filter(Boolean)
  assert.deepEqual(prompts, ['/compact', 'After the long turn'], 'compacted first, then the message, in one turn')
  const afterCompact = (await chat()).chat
  assert.equal(afterCompact.messages[11].parts[0].text, 'Hi from the stand-in.', 'the reply is the answer, with no compaction note')
  assert.equal(afterCompact.messages[11].error, undefined)
  assert.equal(afterCompact.usage.context, 42510)
  // Below the limit, no compaction.
  fs.writeFileSync(path.join(HOME, 'cli-stdin-log.txt'), '')
  await host('POST', '/api/host/ai/send', { text: 'A short one' })
  await until(async () => ((await chat()).chat.messages.length === 14 && !(await chat()).chat.busy), 'short turn')
  assert.deepEqual(fs.readFileSync(path.join(HOME, 'cli-stdin-log.txt'), 'utf8').split('\n<<END>>\n').filter(Boolean), ['A short one'])

  // The model and effort choices are passed on.
  await host('POST', '/api/host/settings', { aiModel: 'haiku', aiEffort: 'low' })
  await host('POST', '/api/host/settings', { aiModel: 'not-a-model', aiEffort: 'extreme' })
  await host('POST', '/api/host/ai/send', { text: 'Third' })
  await until(async () => ((await chat()).chat.messages.length === 16 && !(await chat()).chat.busy), 'third turn')
  const args3 = fs.readFileSync(path.join(HOME, 'cli-args.txt'), 'utf8').split('\n')
  assert.equal(args3[args3.indexOf('--model') + 1], 'haiku')
  assert.equal(args3[args3.indexOf('--effort') + 1], 'low')

  // New chat forgets the conversation.
  assert.equal((await host('POST', '/api/host/ai/reset', {})).status, 200)
  assert.deepEqual((await chat()).chat.messages, [])
  await host('POST', '/api/host/ai/send', { text: 'Fresh start' })
  await until(async () => ((await chat()).chat.messages.length === 2 && !(await chat()).chat.busy), 'turn after reset')
  assert.equal(fs.readFileSync(path.join(HOME, 'cli-args.txt'), 'utf8').split('\n').includes('--resume'), false)

  // The earlier chat was kept, and can be reopened and continued.
  let chats = (await chat()).chat.chats
  assert.deepEqual(chats.map((c: any) => [c.title, c.active]), [['Fresh start', true], ['Tighten the abstract', false]])
  assert.equal((await host('POST', '/api/host/ai/open', { id: chats[1].id })).status, 200)
  const reopened = (await chat()).chat
  assert.equal(reopened.messages.length, 16)
  assert.deepEqual(reopened.chats.map((c: any) => [c.title, c.active]), [['Tighten the abstract', true], ['Fresh start', false]])
  await host('POST', '/api/host/ai/send', { text: 'Continue' })
  await until(async () => ((await chat()).chat.messages.length === 18 && !(await chat()).chat.busy), 'turn in a reopened chat')
  assert.ok(fs.readFileSync(path.join(HOME, 'cli-args.txt'), 'utf8').split('\n').includes('--resume'), 'the reopened chat resumes its session')

  // At most 10 chats are kept, the oldest go first, and any chat can be deleted.
  for (let i = 1; i <= 11; i++) {
    await host('POST', '/api/host/ai/reset', {})
    await host('POST', '/api/host/ai/send', { text: `Chat ${i}` })
    await until(async () => !(await chat()).chat.busy && (await chat()).chat.messages.length === 2, `chat ${i}`)
  }
  chats = (await chat()).chat.chats
  assert.equal(chats.length, 10)
  assert.deepEqual([chats[0].title, chats[0].active, chats[9].title], ['Chat 11', true, 'Chat 2'])
  await host('POST', '/api/host/ai/delete', { id: chats[5].id })
  assert.equal((await chat()).chat.chats.length, 9)
  await host('POST', '/api/host/ai/delete', { id: chats[0].id })
  const afterDelete = (await chat()).chat
  assert.deepEqual([afterDelete.messages.length, afterDelete.chats.length, afterDelete.chats.some((c: any) => c.active)], [0, 8, false])

  // Turned off, the add-on disappears completely: no chat and no tool endpoint.
  assert.equal((await host('POST', '/api/host/settings', { aiEnabled: false })).json.ai.enabled, false)
  assert.equal((await host('POST', '/api/host/ai/send', { text: 'hello' })).status, 403)
  assert.equal((await mcp('tools/list')).status, 404)
  assert.equal((await chat()).chat, null)
  await host('POST', '/api/host/settings', { aiEnabled: true })
  assert.equal((await mcp('tools/list')).status, 200)
  delete process.env.ANTHROPIC_API_KEY
})

test('other projects are readable only after the user allows it, and attachments only in their chat', async () => {
  // A finished exercise next to the open project, and a second one the user will not share.
  const ex1 = path.join(WORKSPACE, 'Exercise 1')
  const ex3 = path.join(WORKSPACE, 'Exercise 3')
  for (const dir of [ex1, ex3]) {
    fs.mkdirSync(path.join(dir, 'sections'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'main.tex'), '\\documentclass{article}\n\\input{sections/header}\n')
  }
  fs.writeFileSync(path.join(ex1, 'sections/header.tex'), '% Exercise header\n\\section*{Exercise}\n')
  fs.writeFileSync(path.join(ex1, 'sections/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
  fs.mkdirSync(path.join(ex1, '.latexwriter'))
  fs.writeFileSync(path.join(ex1, '.latexwriter/secret.txt'), 'internal')
  const state = async (): Promise<any> => (await host('GET', '/api/host/ai/state')).json.chat

  let sources = (await tool('list_sources')).content[0].text
  assert.match(sources, /Exercise 1 {2}\(needs permission/)
  const blocked = await tool('read_file', { source: 'Exercise 1', path: 'main.tex' })
  assert.equal(blocked.isError, true)
  assert.match(blocked.content[0].text, /request_access/)

  // The question waits for the user's answer in the panel.
  const asking = tool('request_access', { project: 'Exercise 1', reason: 'To copy the structure of exercise 1' })
  const req = await until(async () => (await state()).requests[0], 'the permission question')
  assert.deepEqual([req.project, req.reason], ['Exercise 1', 'To copy the structure of exercise 1'])
  assert.equal((await host('POST', '/api/host/ai/access/answer', { id: req.id, allow: true })).status, 200)
  assert.match((await asking).content[0].text, /^Allowed/)
  assert.equal((await host('POST', '/api/host/ai/access/answer', { id: req.id, allow: true })).status, 404, 'answered once')
  assert.deepEqual((await state()).granted.map((g: any) => g.name), ['Exercise 1'])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(projectDir, '.latexwriter/access.json'), 'utf8')).projects, [ex1], 'kept with this project')

  // Read-only access: list, read, search, but no way out of that folder and no internal files.
  assert.match((await tool('project_info', { source: 'Exercise 1' })).content[0].text, /sections\/header\.tex {2}\(3 lines\)[\s\S]*sections\/logo\.png {2}\(binary\)/)
  assert.doesNotMatch((await tool('project_info', { source: 'Exercise 1' })).content[0].text, /secret/)
  assert.match((await tool('read_file', { source: 'Exercise 1', path: 'sections/header.tex' })).content[0].text, /read-only[\s\S]*% Exercise header/)
  assert.match((await tool('search', { source: 'exercise 1', query: 'section*' })).content[0].text, /^sections\/header\.tex:2:/)
  for (const bad of ['../Test Project/main.tex', '.latexwriter/secret.txt', '/etc/hosts']) {
    assert.equal((await tool('read_file', { source: 'Exercise 1', path: bad })).isError, true, bad)
  }
  assert.equal((await tool('edit_file', { source: 'Exercise 1', path: 'main.tex', edits: [{ old_text: 'article', new_text: 'x' }] })).isError, true, 'edits only ever go to the open project')
  assert.equal(fs.readFileSync(path.join(ex1, 'main.tex'), 'utf8'), '\\documentclass{article}\n\\input{sections/header}\n')

  // Copying keeps the structure, never overwrites, and text files wait for review.
  const copied = (await tool('copy_file', { source: 'Exercise 1' })).content[0].text
  assert.match(copied, /Copied 2 files[\s\S]*sections\/header\.tex[\s\S]*Skipped[\s\S]*main\.tex/)
  assert.ok(fs.existsSync(path.join(projectDir, 'sections/logo.png')))
  assert.ok((await review()).files.some((f: any) => f.path === 'sections/header.tex' && f.status === 'added'))
  assert.match((await tool('copy_file', { source: 'Exercise 1', path: 'sections/header.tex', to: 'parts/head.tex' })).content[0].text, /parts\/head\.tex/)

  // A no is a plain answer, and nothing is granted.
  const asking3 = tool('request_access', { project: 'Exercise 3', reason: 'Compare' })
  const req3 = await until(async () => (await state()).requests[0], 'the second question')
  await host('POST', '/api/host/ai/access/answer', { id: req3.id, allow: false })
  const no = await asking3
  assert.ok(!no.isError && /did not allow/.test(no.content[0].text))
  assert.equal((await tool('read_file', { source: 'Exercise 3', path: 'main.tex' })).isError, true)
  assert.match((await tool('request_access', { project: 'Nope', reason: 'x' })).content[0].text, /no project "Nope"[\s\S]*Exercise 1/)

  // Taking it back closes the door again.
  await host('POST', '/api/host/ai/access/revoke', { path: ex1 })
  assert.equal((await tool('read_file', { source: 'Exercise 1', path: 'main.tex' })).isError, true)

  // Attachments belong to one chat: tools called for another chat (or from outside the app) cannot see them.
  const outside = fs.mkdtempSync(path.join(HOME, 'notes-'))
  fs.writeFileSync(path.join(outside, 'rules.md'), '# Rules\nUse \\section* for exercises.\n')
  const attachment = path.join(HOME, 'Assignment_read.pdf')
  fs.copyFileSync(path.join(projectDir, 'main.pdf'), attachment)
  const attached = (await host('POST', '/api/host/ai/attach', { paths: [outside, attachment, '/definitely/missing', 'relative/path'] })).json.attachments
  assert.deepEqual(attached, [outside, attachment])
  const chatId = (await state()).activeId
  const tool4chat = async (id: string, name: string, args: Record<string, unknown>): Promise<any> => {
    const res = await fetch(`${HOST}/mcp?chat=${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    return (await res.json()).result
  }
  assert.match((await tool4chat(chatId, 'read_file', { source: outside, path: 'rules.md' })).content[0].text, /Use \\section\*/)
  assert.match((await tool4chat(chatId, 'read_file', { source: path.join(outside, 'rules.md') })).content[0].text, /# Rules/, 'a path inside an attached folder works as a source')
  assert.equal((await tool4chat('another-chat', 'read_file', { source: outside, path: 'rules.md' })).isError, true)
  assert.equal((await tool('read_file', { source: outside, path: 'rules.md' })).isError, true)
  assert.match((await tool4chat(chatId, 'read_file', { source: attachment })).content[0].text, /Introduction/)
  assert.match((await tool4chat(chatId, 'read_pdf_text', { source: attachment })).content[0].text, /Introduction/)
  assert.equal((await tool4chat(chatId, 'view_page', { source: attachment, page: 1 })).content[1].mimeType, 'image/png')
  assert.equal((await tool4chat('another-chat', 'read_pdf_text', { source: attachment })).isError, true)
  assert.equal((await tool4chat(chatId, 'read_pdf_text', { source: attachment, path: 'other.pdf' })).isError, true)
  // The assistant is told about the attachment with the next message, once.
  await host('POST', '/api/host/ai/send', { text: 'Structure this like my rules' })
  await until(async () => !(await state()).busy && (await state()).messages.length >= 2, 'the turn with an attachment')
  assert.match(fs.readFileSync(path.join(HOME, 'cli-stdin.txt'), 'utf8'), new RegExp(`attached these for this conversation[^\\n]*${outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  await host('POST', '/api/host/ai/detach', { path: outside })
  await host('POST', '/api/host/ai/detach', { path: attachment })
  assert.deepEqual((await state()).attachments, [])
  await host('POST', '/api/host/ai/reset', {})

  // Leave the project as it was for the tests that follow.
  await host('POST', '/api/host/review/decline', {})
  // A pasted picture goes to Claude Code as an image block in a JSON message; the chat keeps it.
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
  assert.equal((await host('POST', '/api/host/ai/send', { text: '', images: [{ type: 'image/svg+xml', data: png.toString('base64') }] })).status, 400, 'only image types the models read')
  assert.equal((await host('POST', '/api/host/ai/send', { text: 'x', images: Array(5).fill({ type: 'image/png', data: png.toString('base64') }) })).status, 400, 'at most four')
  const chat = async (): Promise<any> => (await host('GET', '/api/host/ai/state')).json
  const before = (await chat()).chat.messages.length
  assert.equal((await host('POST', '/api/host/ai/send', { text: '', images: [{ type: 'image/png', data: png.toString('base64') }] })).status, 200, 'a picture alone is a message')
  const pictured = await until(async () => {
    const s = await chat()
    return !s.chat.busy && s.chat.messages.length === before + 2 ? s : null
  }, 'the turn with a picture')
  const picPart = pictured.chat.messages[before].parts[0]
  assert.deepEqual([picPart.kind, picPart.type], ['image', 'image/png'])
  const args3 = fs.readFileSync(path.join(HOME, 'cli-args.txt'), 'utf8').split('\n')
  assert.equal(args3[args3.indexOf('--input-format') + 1], 'stream-json')
  const sent = JSON.parse(fs.readFileSync(path.join(HOME, 'cli-stdin.txt'), 'utf8'))
  assert.equal(sent.type, 'user')
  assert.deepEqual(sent.message.content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } })
  assert.equal(sent.message.content[1].type, 'text')
  assert.match(sent.message.content[1].text, /See the image\.$/)
  const served = await fetch(`${HOST}/api/host/ai/image/${picPart.id}`, { headers: { Origin: HOST } })
  assert.deepEqual([served.status, served.headers.get('content-type'), Buffer.from(await served.arrayBuffer()).equals(png)], [200, 'image/png', true])
  assert.equal((await host('GET', '/api/host/ai/image/00000000-0000-0000-0000-000000000000')).status, 404)
  // A new chat keeps the picture (the old chat stays in the list); deleting that chat deletes it.
  await host('POST', '/api/host/ai/reset', {})
  assert.equal((await host('GET', `/api/host/ai/image/${picPart.id}`)).status, 200)
  await host('POST', '/api/host/ai/delete', { id: pictured.chat.activeId })
  assert.equal((await host('GET', `/api/host/ai/image/${picPart.id}`)).status, 404)
  fs.rmSync(path.join(projectDir, 'sections'), { recursive: true, force: true })
  fs.rmSync(ex1, { recursive: true })
  fs.rmSync(ex3, { recursive: true })
})

test('Codex can run the chat instead of Claude Code, with only this app\'s tools', async () => {
  // A stand-in for the Codex CLI: its model catalog, and a canned `codex exec --json` stream.
  const bin = path.join(HOME, 'bin')
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/bash
if [ "$1" = debug ]; then echo '{"models":[{"slug":"gpt-test","display_name":"GPT Test","visibility":"list"},{"slug":"gpt-hidden","display_name":"Hidden","visibility":"hide"}]}'; exit 0; fi
printf '%s\\n' "$@" > "$HOME/codex-args.txt"
cat > "$HOME/codex-stdin.txt"
env > "$HOME/codex-env.txt"
echo '{"type":"thread.started","thread_id":"01a1dfd8-0000-7000-8000-000000000001"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Looking."}}'
echo '{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"latexwriter","tool":"read_file","arguments":{"path":"main.tex"},"result":null,"error":null,"status":"in_progress"}}'
echo '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"latexwriter","tool":"read_file","arguments":{"path":"main.tex"},"result":{"content":[]},"error":null,"status":"completed"}}'
echo '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Done from Codex."}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1234,"cached_input_tokens":1000,"output_tokens":5}}'
`, { mode: 0o755 })
  process.env.OPENAI_API_KEY = 'sk-should-never-reach-codex'
  const state = async (): Promise<any> => (await host('GET', '/api/host/ai/state')).json

  // Searching finds both agents; Codex offers the models of its own catalog.
  const found = (await host('POST', '/api/host/ai/detect', {})).json.ai
  assert.deepEqual(found.providers.map((p: any) => [p.id, p.available]), [['claude', true], ['codex', true]])
  assert.equal(found.providers[1].path, path.join(bin, 'codex'))
  assert.match(found.providers[1].mcpCommand, /^codex mcp add latexwriter --url http:\/\/localhost:\d+\/mcp$/)
  assert.equal(found.provider, 'claude')

  // A turn with Claude first, so switching has something to hand over.
  await host('POST', '/api/host/ai/reset', {})
  await host('POST', '/api/host/ai/send', { text: 'Remember: the deadline is Friday' })
  await until(async () => !(await state()).chat.busy && (await state()).chat.messages.length === 2, 'the Claude turn')

  const claudeModel = (await state()).ai.model
  const switched = (await host('POST', '/api/host/settings', { aiProvider: 'codex' })).json.ai
  assert.deepEqual([switched.provider, switched.model, switched.models.map((m: any) => m.id)], ['codex', 'gpt-test', ['gpt-test']])
  assert.equal((await host('POST', '/api/host/settings', { aiModel: 'opus' })).json.ai.model, 'gpt-test', 'a Claude model is not a Codex model')

  await host('POST', '/api/host/ai/send', { text: 'What is in main.tex?' })
  const done = await until(async () => {
    const s = await state()
    return !s.chat.busy && s.chat.messages.length === 4 ? s : null
  }, 'the Codex turn')
  const reply = done.chat.messages[3]
  assert.deepEqual(reply.parts.map((p: any) => (p.kind === 'text' ? p.text : [p.label, p.status])), ['Looking.', ['Read main.tex', 'done'], 'Done from Codex.'])
  assert.equal(reply.error, undefined)
  assert.deepEqual(done.chat.usage.lastReply, { input: 1234, cached: 1000 }, 'Codex reports a whole reply, shown as that')
  assert.equal(done.chat.usage.context, undefined, 'not as the size of the conversation')

  const args = fs.readFileSync(path.join(HOME, 'codex-args.txt'), 'utf8').split('\n')
  assert.equal(args[0], 'exec')
  assert.ok(!args.includes('resume'), 'a new Codex session, not the Claude one')
  for (const f of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'computer_use']) assert.ok(args.includes(f) && args[args.indexOf(f) - 1] === '--disable', f)
  for (const flag of ['--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) assert.ok(args.includes(flag), flag)
  assert.ok(args.includes('sandbox_mode="read-only"') && args.includes('web_search="disabled"'))
  assert.ok(args.includes('mcp_servers.latexwriter.default_tools_approval_mode="approve"'), 'edits wait for review in the app instead')
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-test')
  assert.ok(args.includes(`mcp_servers.latexwriter.url="http://127.0.0.1:${PORT}/mcp?chat=${done.chat.activeId}"`))
  // This app's instructions replace Codex's own, and the sections it does not need are left out: every step re-sends them.
  const file = JSON.parse(args.find((a) => a.startsWith('model_instructions_file='))!.slice('model_instructions_file='.length))
  const instructions = fs.readFileSync(file, 'utf8')
  assert.match(instructions, /^You are the writing assistant inside LaTeX Writer/)
  assert.doesNotMatch(instructions, /Helper agents/, 'the helpers are Claude Code subagents')
  assert.ok(!args.some((a) => a.startsWith('developer_instructions=')))
  for (const c of ['skills.bundled.enabled=false', 'include_permissions_instructions=false', 'include_apps_instructions=false', 'include_collaboration_mode_instructions=false', 'include_environment_context=false']) assert.ok(args.includes(c), c)
  assert.match(fs.readFileSync(path.join(HOME, 'codex-stdin.txt'), 'utf8'), /Earlier in this chat[\s\S]*User: Remember: the deadline is Friday[\s\S]*What is in main\.tex\?$/)
  assert.doesNotMatch(fs.readFileSync(path.join(HOME, 'codex-env.txt'), 'utf8'), /OPENAI_API_KEY|ANTHROPIC_API_KEY/)

  // The next message continues the Codex session.
  await host('POST', '/api/host/ai/send', { text: 'And the title?' })
  await until(async () => !(await state()).chat.busy && (await state()).chat.messages.length === 6, 'the second Codex turn')
  const args2 = fs.readFileSync(path.join(HOME, 'codex-args.txt'), 'utf8').split('\n')
  assert.deepEqual([args2[0], args2[1]], ['exec', 'resume'])
  assert.deepEqual(args2.slice(-3, -1), ['01a1dfd8-0000-7000-8000-000000000001', '-'])
  assert.ok(!args2.includes('-s') && !args2.includes('-C'), 'exec resume takes neither')
  assert.equal(fs.readFileSync(path.join(HOME, 'codex-stdin.txt'), 'utf8'), 'And the title?')

  // A pasted picture goes to Codex as a file, given before the options that follow it.
  const gif = Buffer.from('474946383961010001000000002c00000000010001000002', 'hex')
  await host('POST', '/api/host/ai/send', { text: 'What is this?', images: [{ type: 'image/gif', data: gif.toString('base64') }] })
  await until(async () => !(await state()).chat.busy && (await state()).chat.messages.length === 8, 'the Codex turn with a picture')
  const args3 = fs.readFileSync(path.join(HOME, 'codex-args.txt'), 'utf8').split('\n')
  assert.deepEqual([args3[0], args3[1]], ['exec', 'resume'])
  assert.match(args3[2], /^--image=\/.+\.gif$/)
  assert.ok(fs.readFileSync(args3[2].slice('--image='.length)).equals(gif))
  assert.equal(fs.readFileSync(path.join(HOME, 'codex-stdin.txt'), 'utf8'), 'What is this?')

  // Codex has no headless /compact: the app drops its session instead, without running Codex.
  fs.writeFileSync(path.join(HOME, 'codex-stdin.txt'), 'untouched')
  await host('POST', '/api/host/ai/send', { text: '/compact' })
  await until(async () => !(await state()).chat.busy && (await state()).chat.messages.length === 10, 'the Codex /compact')
  assert.match((await state()).chat.messages[9].parts[0].text, /^Codex has no compact command/)
  assert.equal(fs.readFileSync(path.join(HOME, 'codex-stdin.txt'), 'utf8'), 'untouched', 'Codex was not run')

  // Back to Claude: its model choice was kept, and it gets a new session told what Codex said.
  assert.equal((await host('POST', '/api/host/settings', { aiProvider: 'claude' })).json.ai.model, claudeModel)
  await host('POST', '/api/host/ai/send', { text: 'Thanks' })
  await until(async () => !(await state()).chat.busy && (await state()).chat.messages.length === 12, 'back on Claude')
  const cargs = fs.readFileSync(path.join(HOME, 'cli-args.txt'), 'utf8').split('\n')
  assert.ok(!cargs.includes('--resume'))
  assert.match(fs.readFileSync(path.join(HOME, 'cli-stdin.txt'), 'utf8'), /Assistant: Looking\.[\s\S]*Done from Codex\./)
  assert.doesNotMatch(fs.readFileSync(path.join(HOME, 'cli-stdin.txt'), 'utf8'), /\/compact|no compact command/, 'the handover leaves out the /compact exchange')

  // An agent that is not installed cannot be chosen. (On a Mac with the ChatGPT app, Codex is
  // still found there once the stand-in is gone; then it can be chosen, and the test goes back.)
  fs.rmSync(path.join(bin, 'codex'))
  const after = (await host('POST', '/api/host/ai/detect', {})).json.ai.providers[1]
  assert.equal((await host('POST', '/api/host/settings', { aiProvider: 'codex' })).status, after.available ? 200 : 404)
  await host('POST', '/api/host/settings', { aiProvider: 'claude' })
  assert.equal((await state()).ai.provider, 'claude')
  await host('POST', '/api/host/ai/reset', {})
  delete process.env.OPENAI_API_KEY
})

test('leaving a project while the assistant works in it asks first', async () => {
  // A stand-in that takes its time, so the assistant is still busy.
  const cli = path.join(HOME, 'bin', 'claude')
  const original = fs.readFileSync(cli, 'utf8')
  fs.writeFileSync(cli, '#!/bin/bash\ncat > /dev/null\nsleep 30\n', { mode: 0o755 })
  const state = async (): Promise<any> => (await host('GET', '/api/host/ai/state')).json
  try {
    await host('POST', '/api/host/ai/send', { text: 'Take your time' })
    await until(async () => (await state()).chat.busy, 'the assistant to be busy')
    for (const [url, b] of [
      ['/api/host/project/close', {}],
      ['/api/host/project/create', { workspace: WORKSPACE, name: 'Not now', template: 'blank' }],
      ['/api/host/project/open', { path: WORKSPACE, workspace: WORKSPACE }],
    ] as const) {
      const res = await host('POST', url, b)
      assert.equal(res.status, 409, url)
      assert.equal(res.json.code, 'assistant-busy', url)
      assert.match(res.json.error, /^The assistant is still working in "Test: Project"\. Leaving the project stops it\.$/)
    }
    assert.ok(!fs.existsSync(path.join(WORKSPACE, 'Not now')), 'nothing was created')
    assert.equal(currentProject()?.root, fs.realpathSync(projectDir), 'still in the project')
    // Reopening the project that is already open is not leaving it.
    assert.equal((await host('POST', '/api/host/project/open', { path: projectDir, workspace: WORKSPACE })).status, 200)
  } finally {
    await host('POST', '/api/host/ai/stop', {})
    await until(async () => !(await state()).chat.busy, 'the assistant to stop')
    fs.writeFileSync(cli, original, { mode: 0o755 })
    await host('POST', '/api/host/ai/reset', {})
  }
})

test('a turn cut off by closing the app is picked up again when the assistant is opened', async () => {
  const { AiChat } = await import('../server/ai.ts')
  const root = fs.mkdtempSync(path.join(HOME, 'resume-'))
  fs.mkdirSync(path.join(root, '.latexwriter'))
  const session = '22222222-2222-2222-2222-222222222222'
  const msg = (role: string, text: string) => ({ id: `${role}-${text}`, role, parts: [{ kind: 'text', text }], t: Date.now() })
  const write = (chat: object): void => fs.writeFileSync(path.join(root, '.latexwriter', 'ai-chat.json'), JSON.stringify({ active: chat, archive: [] }))
  write({ id: 'c1', sessionId: session, interrupted: true, messages: [msg('user', 'Rewrite the intro'), msg('assistant', 'Working on it')] })

  const chat = new AiChat({ root, overview: () => 'Project "Resume".' })
  chat.resumeInterrupted({ provider: 'claude', model: 'sonnet', effort: 'low' })
  await until(() => !chat.busy && chat.messages.length === 3, 'the interrupted turn to be picked up')
  assert.equal(chat.messages[1].error, 'Interrupted.')
  assert.match(chat.messages[2].parts.map((p: any) => p.text ?? '').join(''), /stand-in/)
  const args = fs.readFileSync(path.join(HOME, 'cli-args.txt'), 'utf8').split('\n')
  assert.equal(args[args.indexOf('--resume') + 1], session, 'continues the same conversation')
  assert.match(fs.readFileSync(path.join(HOME, 'cli-stdin.txt'), 'utf8'), /cut off/)
  // Once finished it is not started again.
  chat.resumeInterrupted({ provider: 'claude', model: 'sonnet', effort: 'low' })
  assert.equal(chat.busy, false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.latexwriter', 'ai-chat.json'), 'utf8')).active.interrupted, false)

  // A user pressing Stop is not an interruption, and neither is a turn that keeps dying.
  write({ id: 'c2', sessionId: session, interrupted: true, attempts: 2, messages: [msg('user', 'x'), msg('assistant', 'y')] })
  const stuck = new AiChat({ root, overview: () => '' })
  stuck.resumeInterrupted({ provider: 'claude', model: 'sonnet', effort: 'low' })
  assert.equal(stuck.busy, false)
  assert.equal(stuck.messages.length, 2)
  chat.dispose()
  stuck.dispose()
})

test('closing the project flushes edits and snapshots', async () => {
  const [a] = editors
  a.text.insert(0, '% last words\n')
  await sleep(100)
  const project = currentProject()!
  // The open project is remembered, so a server started again with --reopen can open it again.
  const savedConfig = (): any => JSON.parse(fs.readFileSync(path.join(HOME, 'Library/Application Support/LaTeXWriter/config.json'), 'utf8'))
  assert.equal(savedConfig().openProject, fs.realpathSync(projectDir))
  assert.equal((await host('POST', '/api/host/project/close', {})).status, 200)
  assert.equal(savedConfig().openProject, null, 'closing it on purpose forgets it')
  assert.ok(fs.readFileSync(path.join(projectDir, 'main.tex'), 'utf8').startsWith('% last words'))
  assert.equal(currentProject(), null)
  assert.equal(project.history.list('main.tex')[0].reason, 'auto')
  assert.equal((await host('GET', '/api/project/tree')).status, 409)
})

test('an agent stays with its project when another project is opened in the app', async () => {
  assert.equal((await host('POST', '/api/host/project/open', { path: projectDir, workspace: WORKSPACE })).status, 200)
  const call = async (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}, query = ''): Promise<any> => {
    const res = await fetch(`${HOST}/mcp${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    return (await res.json()).result
  }
  // An MCP client gets a session id when it connects, and sends it back with every call.
  const init = await fetch(`${HOST}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) })
  const session = init.headers.get('mcp-session-id')!
  assert.match(session, /^[0-9a-f-]{36}$/)
  const s = { 'Mcp-Session-Id': session }
  assert.match((await call('project_info', {}, s)).content[0].text, /^Project: Test: Project/)

  // The user opens another project: the session's next call does nothing and says why.
  assert.equal((await host('POST', '/api/host/project/create', { workspace: WORKSPACE, name: 'Other One', template: 'blank' })).status, 200)
  const refused = await call('edit_file', { path: 'main.tex', edits: [{ old_text: 'x', new_text: 'y' }] }, s)
  assert.equal(refused.isError, true)
  assert.match(refused.content[0].text, /^Stop: the project open in LaTeX Writer changed from "Test Project" to "Other One"/)
  assert.equal((await call('read_file', { path: 'main.tex' }, s)).isError, true)
  // Only when told to, it moves to the project that is open now.
  assert.match((await call('project_info', { switch: true }, s)).content[0].text, /^Project: Other One/)
  assert.equal((await call('read_file', { path: 'main.tex' }, s)).isError, undefined)
  // A client without a session id keeps the old behaviour: it works on whatever is open.
  assert.match((await call('project_info', {})).content[0].text, /^Project: Other One/)
  // The chat inside the app belongs to one project: a call for a chat of another project is refused.
  const foreign = await call('read_file', { path: 'main.tex' }, {}, '?chat=a-chat-of-another-project')
  assert.equal(foreign.isError, true)
  assert.match(foreign.content[0].text, /^Stop: this conversation belongs to another project/)

  await host('POST', '/api/host/project/close', {})
  fs.rmSync(path.join(WORKSPACE, 'Other One'), { recursive: true })
})

test('renaming the folder of an open project closes it cleanly instead of breaking', async () => {
  assert.equal((await host('POST', '/api/host/project/open', { path: projectDir, workspace: WORKSPACE })).status, 200)
  const ed = await openEditor('main.tex')
  const events = new WebSocket(`ws://127.0.0.1:${PORT}/ws/events`, { origin: HOST })
  const seen: any[] = []
  events.on('message', (data) => seen.push(JSON.parse(String(data))))
  await new Promise((resolve) => events.on('open', resolve))

  const renamed = path.join(WORKSPACE, 'Renamed Project')
  fs.renameSync(projectDir, renamed)
  ed.text.insert(0, '% typed just after the rename\n')
  await until(() => seen.some((e) => e.type === 'project' && e.project === null), 'the project to close itself')
  assert.ok(seen.some((e) => e.type === 'notice' && /renamed, moved or deleted/.test(e.message)))
  assert.equal(currentProject(), null)
  assert.equal((await host('GET', '/api/project/tree')).status, 409)
  await sleep(700)
  assert.equal(fs.existsSync(projectDir), false, 'the old folder must not be recreated by a late save')
  events.close()

  // The app carries on: the workspace lists the project under its new folder and it opens again.
  const ws = (await host('GET', `/api/host/workspace?path=${encodeURIComponent(WORKSPACE)}`)).json
  assert.deepEqual(ws.projects.map((p: any) => p.folder), ['Renamed Project'])
  assert.equal((await host('POST', '/api/host/project/open', { path: renamed, workspace: WORKSPACE })).status, 200)
  assert.equal((await host('GET', '/api/project/tree')).status, 200)
  assert.equal((await host('POST', '/api/host/project/close', {})).status, 200)
  fs.renameSync(renamed, projectDir)
})

test('a project moves to the Trash, not into oblivion', async () => {
  fs.mkdirSync(path.join(HOME, '.Trash'), { recursive: true })
  assert.equal((await host('POST', '/api/host/project/trash', { path: WORKSPACE })).status, 400, 'only real projects')
  assert.equal((await host('POST', '/api/host/project/trash', { path: projectDir })).status, 200)
  assert.equal(fs.existsSync(projectDir), false)
  assert.ok(fs.existsSync(path.join(HOME, '.Trash', 'Test Project', 'main.tex')))
})
