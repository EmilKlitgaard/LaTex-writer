import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Everything that must not sync through iCloud lives here.
export const APP_HOME =
  process.env.LATEXWRITER_HOME ?? path.join(os.homedir(), 'Library/Application Support/LaTeXWriter')
export const SCRATCH_DIR = path.join(APP_HOME, 'scratch')
export const LOG_DIR = path.join(APP_HOME, 'logs')
export const WEB_BUILD_DIR = path.join(APP_HOME, 'build/web')
const CONFIG_FILE = path.join(APP_HOME, 'config.json')

export const DEFAULT_PORT = 4173

export type RecentWorkspace = { path: string; lastProject?: string; lastOpened: number }

export type Config = {
  recentWorkspaces: RecentWorkspace[]
  lan: { enabled: boolean; passcodeHash: string | null }
  hostName: string
  lastPort: number
  /** The assistant add-on: off means no sidebar, no chat and no tool endpoint. */
  ai: { enabled: boolean; model: string }
}

const defaults = (): Config => ({
  recentWorkspaces: [],
  lan: { enabled: false, passcodeHash: null },
  hostName: os.userInfo().username || 'Host',
  lastPort: DEFAULT_PORT,
  ai: { enabled: true, model: 'sonnet' },
})

let config: Config = defaults()

export function loadConfig(): Config {
  fs.mkdirSync(APP_HOME, { recursive: true })
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    const d = defaults()
    config = {
      ...d,
      ...raw,
      lan: { ...d.lan, ...(raw.lan ?? {}) },
      ai: { ...d.ai, ...(raw.ai ?? {}) },
      recentWorkspaces: Array.isArray(raw.recentWorkspaces) ? raw.recentWorkspaces : [],
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Could not read config.json, starting with defaults:', (err as Error).message)
    }
    config = defaults()
  }
  return config
}

export function getConfig(): Config {
  return config
}

export function saveConfig(): void {
  writeFileAtomic(CONFIG_FILE, JSON.stringify(config, null, 2))
}

export function updateConfig(mutate: (c: Config) => void): Config {
  mutate(config)
  saveConfig()
  return config
}

export function writeFileAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

export function touchRecentWorkspace(wsPath: string, lastProject?: string): void {
  updateConfig((c) => {
    const existing = c.recentWorkspaces.find((w) => w.path === wsPath)
    c.recentWorkspaces = c.recentWorkspaces.filter((w) => w.path !== wsPath)
    c.recentWorkspaces.unshift({
      path: wsPath,
      lastProject: lastProject ?? existing?.lastProject,
      lastOpened: Date.now(),
    })
    c.recentWorkspaces = c.recentWorkspaces.slice(0, 12)
  })
}
