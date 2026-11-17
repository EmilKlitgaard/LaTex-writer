import fs from 'node:fs'
import path from 'node:path'
import { HttpError } from './paths.ts'

/**
 * Writing skills: task instructions in Markdown files under server/skills/, offered to the
 * assistant three ways from the same text. The user types /name in the chat, the assistant loads
 * one itself with the use_skill tool (also helpers and outside Claude sessions), and MCP clients
 * see them as prompts.
 *
 * A file has a small front matter block (name, description, hint, guide). A file without a hint is
 * a guide: shared ground truth that skills name with `guide:` and that is appended to their text.
 */

export type Skill = { name: string; description: string; hint: string; body: string; guide?: string }

const DIR = path.join(import.meta.dirname, 'skills')

function parse(file: string): Skill {
  const raw = fs.readFileSync(file, 'utf8')
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
  const meta: Record<string, string> = {}
  for (const line of (m?.[1] ?? '').split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1')
  }
  return {
    name: meta.name || path.basename(file, '.md'),
    description: meta.description ?? '',
    hint: meta.hint ?? '',
    body: raw.slice(m?.[0].length ?? 0).trim(),
    guide: meta.guide || undefined,
  }
}

const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => parse(path.join(DIR, f))).sort((a, b) => a.name.localeCompare(b.name))
const guides = new Map(all.filter((s) => !s.hint).map((s) => [s.name, s.body]))

/**
 * The app's global rules for writing in the chat (server/chat-rules.md): tone, and the formatting the
 * sidebar renders (math, references, callouts, choices). Shipped with the app and read-only: no tool
 * changes it. It goes into the system prompt of every agent the chat runs.
 */
export const CHAT_RULES = fs.readFileSync(path.join(import.meta.dirname, 'chat-rules.md'), 'utf8').trim()

/** The skills the user and the assistant can use, in a stable order. */
export const SKILLS: Skill[] = all.filter((s) => s.hint)

for (const s of SKILLS) if (s.guide && !guides.has(s.guide)) throw new Error(`Skill ${s.name} names a missing guide: ${s.guide}`)

export const findSkill = (name: unknown): Skill | undefined => SKILLS.find((s) => s.name === name)

/**
 * Chat commands that are not skills: the app carries them out itself instead of sending text to the
 * model (see Assistant.send).
 */
export const COMMANDS: { name: string; description: string; hint: string }[] = [
  { name: 'compact', description: 'Summarise the conversation so far, so the next replies are faster and use less of your limit.', hint: '' },
]

const commandList = (): string => [...SKILLS, ...COMMANDS].map((s) => `/${s.name}`).sort().join(', ')

/** The full text of a skill for the model: its task, the user's request, and the guide it rests on. */
export function skillText(skill: Skill, request = ''): string {
  const guide = skill.guide ? `\n\n<guide>\n${guides.get(skill.guide)}\n</guide>` : ''
  const req = request.trim() ? request.trim() : '(none given: work out the scope as the task says)'
  return `<skill name="${skill.name}">\n${skill.body}${guide}\n</skill>\n\nThe user's request for /${skill.name}: ${req}`
}

/**
 * A chat message that starts with /name becomes that skill's text. Returns null for ordinary
 * messages; an unknown /command is refused, so a typo does not reach the model as plain text.
 */
export function expandCommand(text: string): string | null {
  const m = /^\/([a-z][a-z0-9-]*)(?=\s|$)\s*([\s\S]*)$/.exec(text)
  if (!m) return null
  const skill = findSkill(m[1])
  if (!skill) throw new HttpError(400, `There is no command /${m[1]}. Commands: ${commandList()}.`)
  return skillText(skill, m[2])
}

/** One line per skill, for the system prompt and the tool description. */
export const skillCatalog = (): string => SKILLS.map((s) => `- ${s.name}: ${s.description}`).join('\n')

/** What the chat composer needs to offer the commands: the skills, then the app's own commands. */
export const skillMenu = (): { name: string; description: string; hint: string; command?: boolean }[] => [
  ...SKILLS.map(({ name, description, hint }) => ({ name, description, hint })),
  ...COMMANDS.map((c) => ({ ...c, command: true })),
]
