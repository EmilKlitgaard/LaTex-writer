import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HttpError } from '../server/paths.ts'
import { expandCommand, findSkill, SKILLS, skillText } from '../server/skills.ts'

test('the humanize skills are loaded from their Markdown files and share one guide', () => {
  assert.deepEqual(SKILLS.map((s) => s.name), ['humanize', 'humanize-audit', 'humanize-draft'])
  for (const s of SKILLS) {
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
  assert.throws(() => expandCommand('/humanise this'), (err: unknown) => err instanceof HttpError && err.status === 400 && /\/humanize, \/humanize-audit, \/humanize-draft/.test(err.message))
})
