import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { test } from 'node:test'
import { History, thin, type Snapshot } from '../server/history.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lw-hist-'))
const snap = (t: number): Snapshot => ({ id: String(t), t, hash: String(t), size: 1, reason: 'auto' })

test('thin keeps everything from the last hour', () => {
  const now = 100 * DAY
  const snaps = Array.from({ length: 25 }, (_, i) => snap(now - 58 * MIN + i * 2 * MIN))
  assert.equal(thin(snaps, now).length, 25)
})

test('thin keeps the newest per hour for a day, then the newest per day', () => {
  const now = 100 * DAY + 30 * MIN
  const snaps: Snapshot[] = []
  // Every 2 minutes for 5 days.
  for (let t = now - 5 * DAY; t <= now; t += 2 * MIN) snaps.push(snap(t))
  const kept = thin(snaps, now)
  const lastHour = kept.filter((s) => now - s.t < HOUR)
  const lastDay = kept.filter((s) => now - s.t >= HOUR && now - s.t < DAY)
  const older = kept.filter((s) => now - s.t >= DAY)
  assert.equal(lastHour.length, 30)
  assert.ok(lastDay.length >= 23 && lastDay.length <= 24, `hourly: ${lastDay.length}`)
  assert.ok(older.length >= 4 && older.length <= 5, `daily: ${older.length}`)
  // Order is preserved and the newest snapshot always survives.
  assert.deepEqual(kept.map((s) => s.t), [...kept.map((s) => s.t)].sort((a, b) => a - b))
  assert.equal(kept.at(-1)!.t, snaps.at(-1)!.t)
})

test('snapshots are deduplicated and can be read back', () => {
  const h = new History(tmp())
  assert.equal(h.snapshot('main.tex', 'one', 'auto', 1000), true)
  assert.equal(h.snapshot('main.tex', 'one', 'auto', 2000), false)
  assert.equal(h.snapshot('main.tex', 'two æøå', 'auto', 3000), true)
  const list = h.list('main.tex')
  assert.equal(list.length, 2)
  assert.equal(h.read('main.tex', list[0].id), 'two æøå')
  assert.equal(h.read('main.tex', list[1].id), 'one')
  assert.throws(() => h.read('main.tex', 'nope'))
})

test('history survives a reload and follows renames', () => {
  const root = tmp()
  const h = new History(root)
  h.snapshot('chapters/a.tex', 'A', 'auto', 1000)
  h.snapshot('main.tex', 'M', 'auto', 1000)
  h.rename('chapters', 'parts')
  const again = new History(root)
  assert.equal(again.list('chapters/a.tex').length, 0)
  assert.equal(again.read('parts/a.tex', again.list('parts/a.tex')[0].id), 'A')
  assert.equal(again.list('main.tex').length, 1)
})

test('prune enforces the size cap, oldest first, and keeps the newest of each file', () => {
  const root = tmp()
  const h = new History(root, 20_000)
  const now = Date.now()
  // Incompressible content, about 3 KB per snapshot once gzipped.
  for (let i = 0; i < 20; i++) h.snapshot('a.tex', crypto.randomBytes(3000).toString('base64'), 'auto', now - (20 - i) * 1000)
  h.snapshot('b.tex', 'small', 'auto', now - 50_000)
  assert.ok(h.totalBytes() > 20_000)
  h.prune(now)
  assert.ok(h.totalBytes() <= 20_000, `still ${h.totalBytes()} bytes`)
  const left = h.list('a.tex')
  assert.ok(left.length >= 1 && left.length < 20)
  assert.equal(left[0].t, now - 1000, 'newest snapshot kept')
  assert.equal(h.list('b.tex').length, 1, 'the only snapshot of a file is never dropped')
  // No orphaned blobs remain.
  const blobs = fs.readdirSync(path.join(root, '.latexwriter/history/blobs')).length
  assert.equal(blobs, left.length + 1)
})
