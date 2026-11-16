import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HttpError } from '../server/paths.ts'
import { HELPER_AGENTS, systemPrompt } from '../server/ai.ts'
import { expandCommand, findSkill, skillMenu, SKILLS, skillText } from '../server/skills.ts'

test('the humanize skills are loaded from their Markdown files and share one guide', () => {
  assert.deepEqual(SKILLS.map((s) => s.name), ['blind-audit', 'humanize', 'humanize-audit', 'humanize-draft'])
  for (const s of SKILLS.filter((s) => s.name.startsWith('humanize'))) {
    assert.ok(s.description && s.hint && s.body, s.name)
    assert.equal(s.guide, 'humanize-guide')
    const text = skillText(s)
    assert.match(text, /<guide>[\s\S]*StoryScope[\s\S]*Ground rules for every humanize skill[\s\S]*<\/guide>/)
    assert.doesNotMatch(text, /^---/m, 'front matter is not passed on')
  }
  assert.equal(findSkill('humanize-guide'), undefined, 'the guide is not a skill of its own')
})

test('a /command becomes the skill text with the request; other messages are left alone', () => {
  const out = expandCommand('/humanize-audit  section 2, keep it formal')!
  assert.match(out, /^<skill name="humanize-audit">\n/)
  assert.match(out, /Change nothing/)
  assert.match(out, /The user's request for \/humanize-audit: section 2, keep it formal$/)
  assert.match(expandCommand('/humanize')!, /request for \/humanize: \(none given/)
  assert.match(expandCommand('/humanize\nthe dialogue in ch3')!, /request for \/humanize: the dialogue in ch3$/)
  for (const plain of ['Tighten the abstract', '/usr/local/bin is on the PATH', '/Users/me/thesis', ' /humanize', 'please /humanize this']) assert.equal(expandCommand(plain), null, plain)
  assert.throws(() => expandCommand('/humanise this'), (err: unknown) => err instanceof HttpError && err.status === 400 && /\/blind-audit, \/compact, \/humanize, \/humanize-audit, \/humanize-draft/.test(err.message))
})

test('/blind-audit briefs the auditor helper blind, and works without a request', () => {
  const s = findSkill('blind-audit')!
  assert.ok(s.description && s.hint && !s.guide)
  const out = expandCommand('/blind-audit')!
  assert.match(out, /^<skill name="blind-audit">\n/)
  assert.match(out, /subagent_type auditor/)
  assert.match(out, /request is blank, take the topic this conversation dealt with\s+most recently/)
  assert.match(out, /Change nothing/)
  assert.match(expandCommand('/blind-audit fig:results')!, /request for \/blind-audit: fig:results$/)
  // The auditor only reads: it never edits, and the main agent is told it exists.
  const auditor = HELPER_AGENTS.auditor
  assert.ok(auditor.tools.length && auditor.tools.every((t) => !/edit_file|write_file|update_notes|copy_file/.test(t)))
  assert.match(systemPrompt('claude'), /reader, layout-checker, writer and auditor/)
})

test('/compact is offered in the menu as a command, not a skill', () => {
  const menu = skillMenu()
  assert.deepEqual(menu.find((m) => m.name === 'compact'), { name: 'compact', description: menu.find((m) => m.name === 'compact')!.description, hint: '', command: true })
  assert.ok(menu.filter((m) => !m.command).every((m) => findSkill(m.name)))
  assert.equal(findSkill('compact'), undefined)
})
