import fs from 'node:fs'
import path from 'node:path'
import { APP_HOME, writeFileAtomic } from './config.ts'
import type { Project } from './project.ts'

// Two small Markdown files that give the assistant a memory.
//
// - INSTRUCTIONS.md lives in each project, next to the other files. Agents read it at the start of
//   every session and add what the next one needs to know: decisions, conventions, open tasks.
// - PREFERENCES.md is the author's personal writing preferences, shared by every project. It only
//   changes when the author asks for it or states a lasting preference.
//
// Both are plain text the author can read and edit like any other file. They stay short: past the
// size limit an agent has to rewrite the file in condensed form instead of adding to it.

export const PROJECT_NOTES_FILE = 'INSTRUCTIONS.md'
export const PREFERENCES_PATH = path.join(APP_HOME, 'PREFERENCES.md')
export const NOTES_LIMITS = { project: 8000, preferences: 4000 } as const
export type NotesKind = keyof typeof NOTES_LIMITS

export const PROJECT_NOTES_STARTER = `# Project notes

Shared memory for the AI assistants working on this project. They read it at the start of every
session and add what the next one needs to know. You can edit it too.

## Instructions from the author
(Standing instructions for this project: audience, tone, structure, conventions.)

## Decisions and conventions

## Open tasks and progress
`

export const PREFERENCES_STARTER = `# My writing preferences

How I like my text written, in every project. Agents follow this and only change it when I ask,
or when I state a lasting preference.
`

/** The author's global preferences; the file is created on first use. */
export function readPreferences(): string {
  try {
    return fs.readFileSync(PREFERENCES_PATH, 'utf8')
  } catch {}
  try {
    fs.mkdirSync(APP_HOME, { recursive: true })
    writeFileAtomic(PREFERENCES_PATH, PREFERENCES_STARTER)
  } catch {}
  return PREFERENCES_STARTER
}

/** The project's notes (the live text); projects made before this existed get the file on first use. */
export function readProjectNotes(project: Project): string {
  if (!fs.existsSync(path.join(project.root, PROJECT_NOTES_FILE))) project.writeNotes(PROJECT_NOTES_STARTER)
  return project.docs.read(PROJECT_NOTES_FILE)
}

export const NOTES_HEADERS = {
  project: `Project notes (${PROJECT_NOTES_FILE}, shared memory of the agents on this project; add to it with update_notes):`,
  preferences: 'The author\'s writing preferences (apply to every project; follow them; do not change them unless the author asks, or states a lasting preference):',
} as const

/** The two files as shown to an agent, with a hint when one is close to its size limit. */
export function describeNotes(project: Project): string {
  const section = (kind: NotesKind, body: string): string => {
    const limit = NOTES_LIMITS[kind]
    const hint = body.length > limit ? `\n[over the size limit of ${limit} characters: rewrite it shorter with update_notes mode "replace"]`
      : body.length > limit * 0.8 ? `\n[nearly full (${body.length}/${limit} characters): condense it the next time you update it]` : ''
    return `${NOTES_HEADERS[kind]}\n${body.trim() || '(empty)'}${hint}`
  }
  return `${section('project', readProjectNotes(project))}\n\n${section('preferences', readPreferences())}`
}

export type NotesResult = { ok: true; message: string } | { ok: false; error: string }

/** Adds to or rewrites one of the two files. Refuses to grow a file past its limit. */
export function updateNotes(project: Project, args: Record<string, unknown>): NotesResult {
  const kind = args.file
  if (kind !== 'project' && kind !== 'preferences') return { ok: false, error: 'file must be "project" or "preferences".' }
  const mode = args.mode === 'replace' ? 'replace' : 'append'
  const text = typeof args.text === 'string' ? args.text.replace(/\r\n/g, '\n').trim() : ''
  if (!text) return { ok: false, error: 'text is required.' }
  if (kind === 'preferences' && !(typeof args.reason === 'string' && args.reason.trim())) {
    return { ok: false, error: 'The author\'s preferences only change when the author asked for it or stated a lasting preference. Say which in reason, or put a note about this project in the project notes instead.' }
  }
  const current = kind === 'project' ? readProjectNotes(project) : readPreferences()
  const next = (mode === 'replace' ? text : `${current.trimEnd()}\n${text.startsWith('-') || text.startsWith('#') ? '' : '- '}${text}`) + '\n'
  const limit = NOTES_LIMITS[kind]
  if (next.length > limit) {
    return {
      ok: false,
      error: mode === 'replace'
        ? `That is ${next.length} characters; the limit is ${limit}. Make it shorter.`
        : `The file would grow to ${next.length} characters; the limit is ${limit}. Condense it: call update_notes with mode "replace" and a shorter version of the whole file (read_notes shows the current text) that keeps everything still useful and drops what is done or outdated.`,
    }
  }
  if (kind === 'project') project.writeNotes(next)
  else writeFileAtomic(PREFERENCES_PATH, next)
  return { ok: true, message: `${mode === 'replace' ? 'Rewrote' : 'Added to'} the ${kind === 'project' ? `project notes (${PROJECT_NOTES_FILE})` : 'writing preferences'} (${next.length}/${limit} characters).` }
}
