import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exeName, IS_WINDOWS } from './platform.ts'

/**
 * The assistants the chat can run: command-line agents already installed and signed in on this
 * Mac. Each runs headless with only this app's tools. Found by looking in the usual places, since
 * an app started from Finder does not get the shell's PATH.
 */

export const PROVIDERS = ['claude', 'codex'] as const
export type ProviderId = (typeof PROVIDERS)[number]
export type ModelOption = { id: string; label: string }
export type ProviderInfo = {
  id: ProviderId
  name: string
  /** Who pays: shown in Settings. */
  plan: string
  path: string | null
  models: ModelOption[]
  defaultModel: string
  /** How to register this app's tools in a session of that agent outside the app. */
  mcpCommand: (url: string) => string
}

export const BIN_DIRS = IS_WINDOWS
  ? [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local')]
  : ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.claude/local')]

const isExecutable = (p: string): boolean => {
  try {
    // Windows has no execute bit; a file is enough there.
    if (!IS_WINDOWS) fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * A program on the PATH. On Windows only a real .exe counts: an npm-installed .cmd wrapper cannot
 * be started without a shell, so install the agents with their own installers there.
 */
function onPath(name: string): string | null {
  for (const dir of [...(process.env.PATH ?? '').split(path.delimiter), ...BIN_DIRS]) {
    if (dir && isExecutable(path.join(dir, exeName(name)))) return path.join(dir, exeName(name))
  }
  return null
}

/** Newest first, by the version number in the folder name. */
const newestFirst = (a: string, b: string): number => b.localeCompare(a, undefined, { numeric: true })

/** Finds the Claude Code CLI even when the server was started from Finder with a bare PATH. */
export function findClaudeCli(): string | null {
  return onPath('claude')
}

/**
 * Finds the Codex CLI: on the PATH (npm or Homebrew install), inside the ChatGPT or Codex app, or
 * inside the ChatGPT extension for VS Code, which all ship it.
 */
export function findCodexCli(): string | null {
  const found = onPath('codex')
  if (found) return found
  const home = os.homedir()
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    path.join(home, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'),
  ]
  for (const dir of [path.join(home, '.vscode/extensions'), path.join(home, '.cursor/extensions')]) {
    try {
      for (const ext of fs.readdirSync(dir).filter((n) => n.startsWith('openai.chatgpt-')).sort(newestFirst)) {
        for (const arch of ['macos-aarch64', 'macos-x86_64']) candidates.push(path.join(dir, ext, 'bin', arch, 'codex'))
      }
    } catch {}
  }
  return candidates.find(isExecutable) ?? null
}

const CLAUDE_MODELS: ModelOption[] = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku (lightest)' },
  { id: 'opus', label: 'Opus (heaviest)' },
]

/** The models this Codex offers, from its own catalog. */
function codexModels(cli: string): ModelOption[] {
  try {
    const out = execFileSync(cli, ['debug', 'models'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 })
    const data = JSON.parse(out) as unknown
    const list = (Array.isArray(data) ? data : (data as { models?: unknown[] }).models ?? []) as Record<string, unknown>[]
    return list
      .filter((m) => typeof m.slug === 'string' && m.visibility !== 'hide')
      .map((m) => ({ id: m.slug as string, label: typeof m.display_name === 'string' ? m.display_name : (m.slug as string) }))
  } catch {
    return []
  }
}

/** The model set in the user's own Codex config, used as the default when it is offered. */
function codexConfiguredModel(): string | null {
  try {
    const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
    const m = /^model\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'))
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** Codex's model catalog, per CLI found: reading it runs the CLI, so it is kept until a search. */
const modelCache = new Map<string, ModelOption[]>()

/**
 * Every assistant this app knows, with whether and where it is installed. Where they are is looked
 * up every time (a few file checks), so one installed while the app runs is found; refresh also
 * reads Codex's model catalog again.
 */
export function detectProviders(refresh = false): ProviderInfo[] {
  if (refresh) modelCache.clear()
  const codex = findCodexCli()
  if (codex && !modelCache.has(codex)) modelCache.set(codex, codexModels(codex))
  const codexList = codex ? modelCache.get(codex)! : []
  const configured = codexConfiguredModel()
  return [
    {
      id: 'claude',
      name: 'Claude Code',
      plan: 'your Claude subscription',
      path: findClaudeCli(),
      models: CLAUDE_MODELS,
      defaultModel: 'sonnet',
      mcpCommand: (url) => `claude mcp add --transport http latexwriter ${url}`,
    },
    {
      id: 'codex',
      name: 'Codex (ChatGPT)',
      plan: 'your ChatGPT plan',
      path: codex,
      models: codexList,
      defaultModel: (configured && codexList.some((m) => m.id === configured) ? configured : codexList[0]?.id) ?? '',
      mcpCommand: (url) => `codex mcp add latexwriter --url ${url}`,
    },
  ]
}

export function provider(id: unknown): ProviderInfo {
  const list = detectProviders()
  return list.find((p) => p.id === id) ?? list[0]
}

/** The model to use: the one chosen if this provider offers it, else its default. */
export function resolveModel(p: ProviderInfo, model: unknown): string {
  return typeof model === 'string' && p.models.some((m) => m.id === model) ? model : p.defaultModel
}
