import { Events, type AiSettings, type Person, type ProjectInfo, type User } from './api.ts'
import { store } from './dom.ts'

/** State shared by every screen. */
export const app = {
  user: null as User | null,
  project: null as ProjectInfo | null,
  people: [] as Person[],
  /** The assistant add-on; null for guests. */
  ai: null as AiSettings | null,
  events: new Events(),
}

export type ThemeMode = 'system' | 'light' | 'dark'

export function themeMode(): ThemeMode {
  const v = store('theme')
  return v === 'light' || v === 'dark' ? v : 'system'
}

export function applyTheme(mode: ThemeMode = themeMode()): void {
  store('theme', mode === 'system' ? null : mode)
  if (mode === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = mode
}

export function fontSize(): number {
  const n = Number(store('fontSize'))
  return n >= 10 && n <= 24 ? n : 14
}

export function applyFontSize(size: number = fontSize()): void {
  store('fontSize', String(size))
  document.documentElement.style.setProperty('--editor-font-size', `${size}px`)
}
