import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

process.env.LATEXWRITER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-activity-'))
const { describeActivity } = await import('../server/ai.ts')

const stream = (event: unknown, parent?: string): unknown => ({ type: 'stream_event', event, ...(parent ? { parent_tool_use_id: parent } : {}) })
const toolUse = (id: string, name: string, input: unknown, parent?: string): unknown => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] }, ...(parent ? { parent_tool_use_id: parent } : {}) })

test('the activity line follows what the assistant is doing, step by step', () => {
  const helpers = new Map<string, string>()
  const say = (ev: unknown): string | undefined => describeActivity(ev, helpers)
  assert.equal(say({ type: 'system', subtype: 'init' }), 'Thinking…')
  assert.equal(say(stream({ type: 'message_start', message: {} })), 'Thinking…')
  assert.equal(say(stream({ type: 'content_block_start', content_block: { type: 'thinking' } })), 'Thinking…')
  assert.equal(say(stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } })), undefined, 'a delta changes nothing')
  assert.equal(say(stream({ type: 'content_block_start', content_block: { type: 'text' } })), 'Writing…')
  assert.equal(say(stream({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'mcp__latexwriter__edit_file' } })), 'Writing the changes…')
  assert.equal(say(toolUse('t1', 'mcp__latexwriter__edit_file', { path: 'main.tex' })), 'Editing main.tex and compiling…')
  assert.equal(say(toolUse('t2', 'mcp__latexwriter__edit_file', { path: 'a.tex', compile: false })), 'Editing a.tex…')
  assert.equal(say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }), 'Thinking…')
  assert.equal(say(toolUse('t3', 'mcp__latexwriter__use_skill', { name: 'humanize' })), 'Loading the /humanize skill…')

  // A helper's own steps are shown as that helper's.
  assert.equal(say(toolUse('a1', 'Agent', { subagent_type: 'layout-checker', description: 'Check pages 1-3' })), 'Layout-checker is working: Check pages 1-3…')
  assert.equal(say(stream({ type: 'message_start', message: {} }, 'a1')), 'Layout-checker is thinking…')
  assert.equal(say(toolUse('h1', 'mcp__latexwriter__view_page', { pages: [1, 2, 3] }, 'a1')), 'Layout-checker: looking at pages 1, 2, 3…')
  assert.equal(say(stream({ type: 'content_block_start', content_block: { type: 'text' } }, 'a1')), 'Layout-checker is writing its report…')
  assert.equal(say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a1' }] } }), 'Thinking…')

  // Waits that would otherwise look like a hang.
  assert.equal(say({ type: 'system', subtype: 'status', status: 'compacting' }), 'Summarising the conversation to keep it small…')
  assert.match(say({ type: 'system', subtype: 'api_retry', attempt: 2 }) ?? '', /busy, trying again \(attempt 2\)/)
  assert.equal(say({ type: 'rate_limit_event' }), undefined)
  assert.equal(say({ type: 'result', is_error: false }), undefined)
})
