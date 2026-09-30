import { api, q, type Person, type Sharing, type Snapshot, type TreeNode } from './api.ts'
import { app, applyFontSize, applyTheme, fontSize, themeMode, type ThemeMode } from './app.ts'
import { clear, confirmDialog, copyText, h, icon, iconButton, openModal, timeAgo, toast } from './dom.ts'

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
        ? s.urls.map((url) => h('div', { class: 'row url-row' },
            h('code', { class: 'grow url' }, url),
            h('button', { class: 'btn btn-small', type: 'button', onclick: async () => toast((await copyText(url)) ? 'Address copied' : 'Could not copy. Select the address and copy it.', 'info') }, icon('copy'), ' Copy')))
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

// ---- settings --------------------------------------------------------------------------

export function openSettingsDialog(opts: { texFiles: string[]; onLeave: () => void }): void {
  const m = openModal({ title: 'Settings' })
  const isHost = app.user?.role === 'host'

  const theme = h('select', { class: 'input', onchange: () => applyTheme(theme.value as ThemeMode) },
    ...(['system', 'light', 'dark'] as const).map((v) => h('option', { value: v, selected: themeMode() === v }, v === 'system' ? 'Match system' : v === 'light' ? 'Light' : 'Dark')))
  const size = h('select', { class: 'input', onchange: () => applyFontSize(Number(size.value)) },
    ...[11, 12, 13, 14, 15, 16, 18, 20].map((n) => h('option', { value: String(n), selected: fontSize() === n }, `${n} px`)))

  m.body.append(h('div', { class: 'section' },
    h('h3', null, 'Appearance'),
    h('label', { class: 'field' }, h('span', null, 'Theme'), theme),
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
    const command = `claude mcp add --transport http latexwriter http://localhost:${location.port || '4173'}/mcp`
    m.body.append(h('div', { class: 'section' },
      h('h3', null, 'Assistant'),
      h('label', { class: 'row switch-row', for: 'ai-toggle' },
        h('span', { class: 'grow' }, h('strong', null, 'AI assistant'),
          h('span', { class: 'muted block' }, ai.available
            ? 'A chat in the right sidebar that can edit, compile and check the document. It runs through Claude Code on this Mac and uses your Claude subscription, not an API key.'
            : 'Needs Claude Code on this Mac, signed in with your Claude account. It was not found.')),
        toggle),
      h('p', { class: 'muted small' }, 'To use the same tools from the Claude app or a Claude Code session, run this once in Terminal while LaTeX Writer is running:'),
      h('div', { class: 'row url-row' },
        h('code', { class: 'grow url small' }, command),
        h('button', { class: 'btn btn-small', type: 'button', onclick: async () => toast((await copyText(command)) ? 'Command copied' : 'Could not copy. Select the text and copy it.', 'info') }, icon('copy'), ' Copy')),
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
  m.body.appendChild(pre)
  m.footer.append(
    iconButton('copy', 'Copy the log', async () => toast((await copyText(pre.textContent ?? '')) ? 'Log copied' : 'Could not copy', 'info')),
    h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Close'),
  )
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
