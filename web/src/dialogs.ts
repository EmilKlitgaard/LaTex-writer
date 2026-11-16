import { api, ApiError, q, type AiSettings, type Person, type Sharing, type Snapshot, type TreeNode } from './api.ts'
import { app, applyFontSize, applyTheme, fontSize, themeMode, type ThemeMode } from './app.ts'
import { clear, confirmDialog, copyBox, copyButton, h, icon, iconButton, openModal, timeAgo, toast } from './dom.ts'
import { OS } from './app.ts'

// ---- sharing (host) ------------------------------------------------------------------

export function openShareDialog(): void {
  const off: (() => void)[] = []
  const m = openModal({ title: 'Share on your network', onClose: () => off.forEach((fn) => fn()) })
  const content = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'))
  m.body.appendChild(content)
  m.footer.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Done'))
  let sharing: Sharing | null = null
  let editingPasscode = false

  const save = async (patch: Record<string, unknown>): Promise<boolean> => {
    try {
      const res = await api<{ sharing: Sharing }>('POST', '/api/host/settings', patch)
      sharing = res.sharing
      render()
      return true
    } catch (err) {
      toast((err as Error).message, 'error')
      render()
      return false
    }
  }

  const render = (): void => {
    if (!sharing) return
    const s = sharing
    clear(content)

    const passInput = h('input', { class: 'input', type: 'text', placeholder: 'At least 4 characters, e.g. 1234', autocomplete: 'off', spellcheck: false, maxlength: 128 })
    const setPass = async (): Promise<void> => {
      const v = passInput.value
      if (v.length < 4) return toast('The passcode must be at least 4 characters', 'error')
      editingPasscode = false
      if (await save({ passcode: v })) toast(s.hasPasscode ? 'Passcode changed. Everyone was signed out.' : 'Passcode set', 'success')
    }
    const passcodeRow = s.hasPasscode && !editingPasscode
      ? h('div', { class: 'row' },
          h('span', { class: 'grow' }, icon('check'), ' A passcode is set'),
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => { editingPasscode = true; render() } }, 'Change'))
      : h('form', { class: 'row', onsubmit: (e: Event) => { e.preventDefault(); void setPass() } },
          passInput,
          h('button', { class: 'btn btn-primary', type: 'submit' }, s.hasPasscode ? 'Change' : 'Set passcode'))

    const toggle = h('input', {
      type: 'checkbox', class: 'switch', checked: s.enabled, disabled: !s.hasPasscode, id: 'lan-toggle',
      onchange: () => void save({ lanEnabled: toggle.checked }),
    })

    content.append(
      h('div', { class: 'section' },
        h('label', { class: 'row switch-row', for: 'lan-toggle' },
          h('span', { class: 'grow' }, h('strong', null, 'Show on LAN'), h('span', { class: 'muted block' }, s.hasPasscode ? 'People on the same network can join with the passcode.' : 'Set a passcode first.')),
          toggle),
      ),
      h('div', { class: 'section' }, h('h3', null, 'Passcode'), passcodeRow),
    )

    if (s.enabled) {
      const urls = s.urls.length
        ? s.urls.map((url) => copyBox(url, { what: 'the address', class: 'large' }))
        : [h('p', { class: 'muted' }, 'This Mac is not connected to a network right now.')]
      content.append(h('div', { class: 'section' },
        h('h3', null, 'Address to share'),
        ...urls,
        h('p', { class: 'muted small' }, 'Guests see only the project you have open, and follow you when you switch. The connection is plain HTTP on your local network: the passcode keeps casual visitors out, but it is not strong security.'),
      ))
    }

    const guests = s.people.filter((p) => p.role === 'guest')
    content.append(h('div', { class: 'section' },
      h('h3', null, `Connected (${s.people.length})`),
      s.people.length ? h('ul', { class: 'people' }, s.people.map((p) => personRow(p))) : h('p', { class: 'muted' }, 'Nobody is connected.'),
      !guests.length && s.enabled ? h('p', { class: 'muted small' }, 'No guests yet.') : null,
    ))
    if (editingPasscode || !s.hasPasscode) passInput.focus()
  }

  const personRow = (p: Person): HTMLElement =>
    h('li', { class: 'row' },
      h('span', { class: 'avatar', style: { background: p.color } }, initials(p.name)),
      h('span', { class: 'grow' }, p.name, p.role === 'host' ? h('span', { class: 'muted' }, ' (you)') : null),
      p.role === 'guest'
        ? h('button', { class: 'btn btn-small btn-danger-ghost', type: 'button', onclick: async () => {
            try {
              await api('POST', '/api/host/kick', { id: p.id })
              toast(`${p.name} was removed and cannot rejoin for 5 minutes`, 'info')
            } catch (err) {
              toast((err as Error).message, 'error')
            }
          } }, 'Remove')
        : null)

  off.push(app.events.on((e) => {
    if (e.type === 'sharing') sharing = e.sharing
    else if (e.type === 'presence' && sharing) sharing = { ...sharing, people: e.people }
    else return
    if (!editingPasscode && document.activeElement?.tagName !== 'INPUT') render()
  }))

  api<{ sharing: Sharing }>('GET', '/api/host/home').then((res) => {
    sharing = res.sharing
    render()
  }).catch((err) => {
    clear(content)
    content.appendChild(h('p', { class: 'error-text' }, (err as Error).message))
  })
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/**
 * Runs a call that leaves the open project (back to the projects, opening or creating another,
 * moving it to the Trash). If the assistant is working in it, says what leaving does and asks
 * first; on yes the call is repeated with force. Returns null if the user stayed.
 */
export async function leaveProject<T>(call: (force: boolean) => Promise<T>): Promise<T | null> {
  try {
    return await call(false)
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'assistant-busy') throw err
    const ok = await confirmDialog({
      title: 'Stop the assistant?',
      message: `${err.message} What it has changed so far stays in the list for your review, and it picks the request up again the next time you open the assistant in this project.`,
      confirmLabel: 'Leave and stop it',
      danger: true,
    })
    return ok ? call(true) : null
  }
}

// ---- connecting other AI apps ------------------------------------------------------------

/**
 * How to use this app's tools from outside it: the commands for the agents found on this Mac, the
 * plain MCP address and config for any other MCP app, and a prompt any AI can follow to connect.
 */
export function openConnectDialog(): void {
  const ai = app.ai
  const m = openModal({ title: 'Connect an AI app', wide: true })
  m.footer.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Done'))
  if (!ai) return void m.body.append(h('p', { class: 'muted' }, 'Only the host can connect AI apps.'))
  const url = ai.mcpUrl
  const copyRow = (text: string, what: string, block = false): HTMLElement => copyBox(text, { what, block })
  const withUrl = JSON.stringify({ mcpServers: { latexwriter: { url } } }, null, 2)
  const withCommand = JSON.stringify({ mcpServers: { latexwriter: { command: 'npx', args: ['-y', 'mcp-remote', url] } } }, null, 2)
  const prompt = `Connect to LaTeX Writer, a LaTeX editor running on ${OS.computer}, through its MCP server (Model Context Protocol). Add an MCP server named "latexwriter" that uses the streamable HTTP transport at ${url}. It needs no authentication and only answers on this Mac while LaTeX Writer is running. If you can only start local commands, run it through mcp-remote instead: command "npx" with the arguments "-y", "mcp-remote", "${url}". Then call its project_info tool to check that it works, and follow the instructions the server sends: it works on the project that is open in the app, and your edits wait for my review there.`
  const found = ai.providers.filter((p) => p.available)
  // Whether the MCP server answers: it is switched with the AI assistant in Settings.
  const status = h('div', { class: 'mcp-status' })
  const snippets = h('div', { class: 'connect-snippets' })
  const renderStatus = (on: boolean): void => {
    clear(status)
    status.classList.toggle('off', !on)
    snippets.classList.toggle('off', !on)
    if (on) {
      status.append(h('span', { class: 'mcp-dot', 'aria-hidden': 'true' }), h('span', { class: 'grow' }, h('strong', null, 'MCP server: on'), ` at ${url}`))
      return
    }
    const turnOn = h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: async () => {
      turnOn.disabled = true
      try {
        const res = await api<{ ai: AiSettings }>('POST', '/api/host/settings', { aiEnabled: true })
        app.ai = res.ai
        renderStatus(res.ai.enabled)
      } catch (err) {
        turnOn.disabled = false
        toast((err as Error).message, 'error')
      }
    } }, 'Turn on')
    status.append(h('span', { class: 'mcp-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'grow' }, h('strong', null, 'MCP server: off. '), 'It is switched on and off with the AI assistant, in Settings › Assistant. While it is off, no AI app can connect.'),
      turnOn)
  }
  renderStatus(ai.enabled)
  const parts: (HTMLElement | null)[] = [
    h('p', null, 'LaTeX Writer\'s tools (read, search, edit, compile, check the PDF) are an MCP server. Any AI app that supports MCP can use them on the project that is open here. Edits wait for your review, as with the built-in assistant.'),
    status,
    found.length ? h('div', { class: 'section' },
      h('h3', null, `Found on ${OS.computer}`),
      h('p', { class: 'muted small' }, 'Run once in Terminal while LaTeX Writer is running:'),
      ...found.map((p) => h('div', null, h('div', { class: 'small connect-label' }, p.name), copyRow(p.mcpCommand, 'the command')))) : null,
    h('div', { class: 'section' },
      h('h3', null, 'Any other MCP app'),
      h('div', { class: 'small connect-label' }, 'Server address (streamable HTTP, no sign-in)'),
      copyRow(url, 'the address'),
      h('div', { class: 'small connect-label' }, 'Config for apps that take a URL (Cursor, VS Code, Windsurf, …)'),
      copyRow(withUrl, 'the config', true),
      h('div', { class: 'small connect-label' }, 'Config for apps that can only start a local command (needs Node.js)'),
      copyRow(withCommand, 'the config', true)),
    h('div', { class: 'section' },
      h('h3', null, 'Or let the AI do it'),
      h('p', { class: 'muted small' }, 'Paste this into an AI agent that can change its own settings:'),
      copyRow(prompt, 'the prompt', true)),
  ]
  snippets.append(...parts.slice(2).filter((x): x is HTMLElement => x !== null))
  m.body.append(parts[0]!, status, snippets,
    h('p', { class: 'muted small' }, `The address only works on ${OS.computer} and only while LaTeX Writer is running. Web pages cannot use it.`))
}

// ---- settings --------------------------------------------------------------------------

export function openSettingsDialog(opts: { texFiles: string[]; onLeave: () => void }): void {
  const m = openModal({ title: 'Settings' })
  const isHost = app.user?.role === 'host'

  // Theme: a three-way switch. Auto follows the Mac's appearance and changes with it.
  const THEMES: { mode: ThemeMode; label: string; icon: string; title: string }[] = [
    { mode: 'system', label: 'Auto', icon: 'contrast', title: `Follow the appearance of ${OS.computer}` },
    { mode: 'light', label: 'Light', icon: 'sun', title: 'Always light' },
    { mode: 'dark', label: 'Dark', icon: 'moon', title: 'Always dark' },
  ]
  const theme = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Theme' })
  const renderTheme = (): void => {
    clear(theme)
    const current = themeMode()
    for (const t of THEMES) {
      const on = t.mode === current
      theme.append(h('button', {
        class: `segment ${on ? 'active' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1', title: t.title,
        onclick: () => {
          applyTheme(t.mode)
          renderTheme()
          ;(theme.querySelector('.segment.active') as HTMLElement | null)?.focus()
        },
      }, icon(t.icon, 14), t.label))
    }
  }
  // Arrow keys move between the three, like any radio group.
  theme.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const i = THEMES.findIndex((t) => t.mode === themeMode())
    applyTheme(THEMES[(i + (e.key === 'ArrowRight' ? 1 : THEMES.length - 1)) % THEMES.length].mode)
    renderTheme()
    ;(theme.querySelector('.segment.active') as HTMLElement | null)?.focus()
  })
  renderTheme()
  const size = h('select', { class: 'input', onchange: () => applyFontSize(Number(size.value)) },
    ...[11, 12, 13, 14, 15, 16, 18, 20].map((n) => h('option', { value: String(n), selected: fontSize() === n }, `${n} px`)))

  m.body.append(h('div', { class: 'section' },
    h('h3', null, 'Appearance'),
    h('div', { class: 'field' }, h('span', null, 'Theme'), theme),
    h('label', { class: 'field' }, h('span', null, 'Editor text size'), size),
  ))

  if (isHost) {
    const name = h('input', { class: 'input', type: 'text', value: app.user?.name ?? '', maxlength: 40 })
    m.body.append(h('div', { class: 'section' },
      h('h3', null, 'You'),
      h('label', { class: 'field' }, h('span', null, 'Your name (shown next to your cursor)'), name),
    ))
    const saveName = async (): Promise<void> => {
      const v = name.value.trim()
      if (!v || v === app.user?.name) return
      try {
        await api('POST', '/api/host/settings', { hostName: v })
        if (app.user) app.user.name = v
      } catch (err) {
        toast((err as Error).message, 'error')
      }
    }
    name.addEventListener('change', () => void saveName())
  }

  if (isHost && app.ai) {
    const ai = app.ai
    const toggle = h('input', { type: 'checkbox', class: 'switch', checked: ai.enabled, id: 'ai-toggle', onchange: async () => {
      try {
        await api('POST', '/api/host/settings', { aiEnabled: toggle.checked })
      } catch (err) {
        toggle.checked = !toggle.checked
        toast((err as Error).message, 'error')
      }
    } })
    // Which agent runs the chat: every one this app knows, those not found on this Mac greyed out.
    const choice = h('select', { class: 'input', 'aria-label': 'Assistant' })
    const note = h('span', { class: 'muted block' })
    const commands = h('div', { class: 'ai-mcp-commands' })
    const render = (a: AiSettings): void => {
      clear(choice)
      for (const p of a.providers) choice.append(h('option', { value: p.id, disabled: !p.available, selected: p.id === a.provider }, p.available ? p.name : `${p.name} (not found)`))
      choice.value = a.provider
      note.textContent = a.available
        ? `A chat in the right sidebar that can edit, compile and check the document. It runs ${a.providerName} on ${OS.computer} and uses ${a.plan}, not an API key. It can only use this app's tools. Turning it off also turns off the MCP server that other AI apps connect to.`
        : `${a.providerName} was not found on ${OS.computer}. Install it and sign in, then choose Search again.`
      clear(commands)
      commands.append(h('p', { class: 'muted small' },
        'Other AI apps can use the same tools: ',
        h('button', { class: 'link', type: 'button', onclick: () => openConnectDialog() }, 'Connect an AI app…'),
        ' (also under Share).'))
    }
    choice.addEventListener('change', async () => {
      try {
        const res = await api<{ ai: AiSettings }>('POST', '/api/host/settings', { aiProvider: choice.value })
        app.ai = res.ai
        render(res.ai)
      } catch (err) {
        toast((err as Error).message, 'error')
        if (app.ai) render(app.ai)
      }
    })
    const search = h('button', { class: 'btn btn-small', type: 'button', title: `Look again for Claude Code and Codex on ${OS.computer}`, onclick: async () => {
      search.disabled = true
      try {
        const res = await api<{ ai: AiSettings }>('POST', '/api/host/ai/detect', {})
        app.ai = res.ai
        render(res.ai)
        const found = res.ai.providers.filter((p) => p.available).map((p) => p.name)
        toast(found.length ? `Found: ${found.join(', ')}` : `No assistant found on ${OS.computer}`, 'info')
      } catch (err) {
        toast((err as Error).message, 'error')
      } finally {
        search.disabled = false
      }
    } }, icon('refresh'), ' Search again')
    render(ai)
    m.body.append(h('div', { class: 'section' },
      h('h3', null, 'Assistant'),
      h('label', { class: 'row switch-row', for: 'ai-toggle' },
        h('span', { class: 'grow' }, h('strong', null, 'AI assistant'), note),
        toggle),
      h('div', { class: 'field' }, h('span', null, 'Runs on'), h('div', { class: 'row' }, h('span', { class: 'grow' }, choice), search)),
      h('p', { class: 'muted small' }, 'Switching keeps the chat: the other assistant is told the conversation so far. Models and effort are chosen under the message box.'),
      commands,
    ))
  }

  if (app.project && isHost) {
    const pname = h('input', { class: 'input', type: 'text', value: app.project.name, maxlength: 100 })
    const files = opts.texFiles.includes(app.project.mainFile) ? opts.texFiles : [app.project.mainFile, ...opts.texFiles]
    const main = h('select', { class: 'input' }, ...files.map((f) => h('option', { value: f, selected: f === app.project!.mainFile }, f)))
    const patch = async (body: Record<string, unknown>): Promise<void> => {
      try {
        await api('POST', '/api/project/settings', body)
      } catch (err) {
        toast((err as Error).message, 'error')
      }
    }
    pname.addEventListener('change', () => pname.value.trim() && void patch({ name: pname.value.trim() }))
    main.addEventListener('change', () => void patch({ mainFile: main.value }))
    m.body.append(h('div', { class: 'section' },
      h('h3', null, 'Project'),
      h('label', { class: 'field' }, h('span', null, 'Name'), pname),
      h('label', { class: 'field' }, h('span', null, 'Main file (the one that is compiled)'), main),
      h('p', { class: 'muted small' }, 'The compiler is chosen automatically: pdfLaTeX by default, XeLaTeX when the document uses fontspec. To force one, put "% !TEX program = xelatex" on the first line of the main file.'),
    ))
  }

  if (!isHost) {
    m.body.append(h('div', { class: 'section' },
      h('h3', null, 'You'),
      h('p', null, `Joined as ${app.user?.name ?? 'guest'}.`),
      h('button', { class: 'btn', type: 'button', onclick: () => { m.close(); opts.onLeave() } }, icon('logout'), ' Leave'),
    ))
  }

  m.body.append(h('div', { class: 'section' },
    h('h3', null, 'Shortcuts'),
    h('dl', { class: 'shortcuts' },
      ...[['⌘ S or ⌘ Enter', 'Recompile (files are saved as you type)'], ['⌘ J', 'Show the cursor position in the PDF'], ['Double-click in PDF', 'Jump to that place in the source'], ['⌘ F', 'Find and replace'], ['⌘ /', 'Comment or uncomment lines'], ['⌘ B / ⌘ I', 'Bold / emphasis']]
        .flatMap(([k, v]) => [h('dt', null, h('kbd', null, k)), h('dd', null, v)])),
  ))
  m.footer.appendChild(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => m.close() }, 'Done'))
}

// ---- history ---------------------------------------------------------------------------

const REASONS: Record<string, string> = {
  auto: 'Automatic',
  'before-edit': 'Before editing started',
  'before-restore': 'Before a restore',
  external: 'Changed outside the app',
  deleted: 'Before deletion',
}

type TrashItem = { id: string; path: string; type: 'dir' | 'file'; t: number }

export function openHistoryDialog(opts: { current: string | null; textFiles: string[] }): void {
  const m = openModal({ title: 'History', wide: true })
  const fileSelect = h('select', { class: 'input' })
  const list = h('div', { class: 'history-list' })
  const preview = h('pre', { class: 'history-preview' }, 'Select a version to preview it.')
  const restoreBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Restore this version')
  const trashList = h('div', { class: 'trash-list' })
  let selected: { path: string; id: string } | null = null

  const loadSnapshots = async (): Promise<void> => {
    clear(list)
    selected = null
    restoreBtn.disabled = true
    preview.textContent = 'Select a version to preview it.'
    const path = fileSelect.value
    if (!path) {
      list.appendChild(h('p', { class: 'muted pad' }, 'No files with history yet.'))
      return
    }
    try {
      const res = await api<{ snapshots: Snapshot[] }>('GET', `/api/project/history?${q({ path })}`)
      if (!res.snapshots.length) {
        list.appendChild(h('p', { class: 'muted pad' }, 'No earlier versions of this file yet. A version is saved every 2 minutes while you edit.'))
        return
      }
      for (const s of res.snapshots) {
        const row = h('button', { class: 'history-row', type: 'button', onclick: async () => {
          list.querySelectorAll('.history-row.active').forEach((el) => el.classList.remove('active'))
          row.classList.add('active')
          try {
            const c = await api<{ content: string }>('GET', `/api/project/history/content?${q({ path, id: s.id })}`)
            preview.textContent = c.content || '(empty file)'
            preview.scrollTop = 0
            selected = { path, id: s.id }
            restoreBtn.disabled = false
          } catch (err) {
            toast((err as Error).message, 'error')
          }
        } },
          h('span', { class: 'history-time' }, new Date(s.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
          h('span', { class: 'muted small' }, `${REASONS[s.reason] ?? s.reason} · ${timeAgo(s.t)}`),
        )
        list.appendChild(row)
      }
    } catch (err) {
      list.appendChild(h('p', { class: 'error-text pad' }, (err as Error).message))
    }
  }

  const loadTrash = async (): Promise<void> => {
    clear(trashList)
    try {
      const res = await api<{ items: TrashItem[]; orphans: string[] }>('GET', '/api/project/trash')
      const known = new Set([...fileSelect.options].map((o) => o.value))
      for (const p of res.orphans) {
        if (!known.has(p)) fileSelect.appendChild(h('option', { value: p }, `${p} (deleted)`))
      }
      if (!res.items.length) {
        trashList.appendChild(h('p', { class: 'muted' }, 'Nothing has been deleted in the last 30 days.'))
        return
      }
      for (const item of res.items) {
        trashList.appendChild(h('div', { class: 'row trash-row' },
          icon(item.type === 'dir' ? 'folder' : 'file'),
          h('span', { class: 'grow' }, item.path, h('span', { class: 'muted small' }, ` · deleted ${timeAgo(item.t)}`)),
          h('button', { class: 'btn btn-small', type: 'button', onclick: async () => {
            try {
              const r = await api<{ path: string }>('POST', '/api/project/trash/restore', { id: item.id })
              toast(`Restored ${r.path}`, 'success')
              void loadTrash()
            } catch (err) {
              toast((err as Error).message, 'error')
            }
          } }, 'Restore'),
        ))
      }
    } catch (err) {
      trashList.appendChild(h('p', { class: 'error-text' }, (err as Error).message))
    }
  }

  for (const f of opts.textFiles) fileSelect.appendChild(h('option', { value: f, selected: f === opts.current }, f))
  fileSelect.addEventListener('change', () => void loadSnapshots())

  restoreBtn.addEventListener('click', async () => {
    if (!selected) return
    const ok = await confirmDialog({
      title: 'Restore version',
      message: `Replace the current content of "${selected.path}" with this version? The current content is saved as a version first, so you can undo this.`,
      confirmLabel: 'Restore',
    })
    if (!ok) return
    try {
      await api('POST', '/api/project/history/restore', selected)
      toast('Version restored', 'success')
      m.close()
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  })

  m.body.append(
    h('div', { class: 'history' },
      h('div', { class: 'history-side' }, h('label', { class: 'field' }, h('span', null, 'File'), fileSelect), list),
      h('div', { class: 'history-main' }, preview),
    ),
    h('div', { class: 'section' }, h('h3', null, 'Deleted files'), trashList),
  )
  m.footer.append(h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Close'), restoreBtn)
  void loadTrash().then(() => loadSnapshots())
}

// ---- raw log ---------------------------------------------------------------------------

export async function openRawLog(): Promise<void> {
  const m = openModal({ title: 'LaTeX log', wide: true })
  const pre = h('pre', { class: 'history-preview raw-log' }, 'Loading…')
  // The copy button sits in the log's top-right corner and stays there while the log scrolls.
  m.body.appendChild(h('div', { class: 'copy-box block log-box' }, pre, copyButton(() => pre.textContent ?? '', { what: 'the log' })))
  m.footer.append(h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Close'))
  try {
    const res = await fetch('/api/project/log', { credentials: 'same-origin' })
    pre.textContent = await res.text()
  } catch {
    pre.textContent = 'The log could not be loaded.'
  }
}

export function texFilesOf(nodes: TreeNode[]): string[] {
  const out: string[] = []
  const walk = (list: TreeNode[]): void => {
    for (const n of list) {
      if (n.type === 'dir') walk(n.children ?? [])
      else if (n.path.toLowerCase().endsWith('.tex')) out.push(n.path)
    }
  }
  walk(nodes)
  return out
}

export function textFilesOf(nodes: TreeNode[]): string[] {
  const out: string[] = []
  const walk = (list: TreeNode[]): void => {
    for (const n of list) {
      if (n.type === 'dir') walk(n.children ?? [])
      else if (n.kind === 'text' && !n.cloud) out.push(n.path)
    }
  }
  walk(nodes)
  return out
}
