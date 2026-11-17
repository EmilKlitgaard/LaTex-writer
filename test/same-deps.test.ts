import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const script = path.join(import.meta.dirname, '..', 'scripts', 'same-deps.mjs')
const lock = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package-lock.json'), 'utf8'))

/** Runs the check on a changed copy of this repository's lock file against the real one. */
function sameDeps(change: (copy: any) => void): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-deps-'))
  const installed = path.join(dir, 'installed.json')
  const next = path.join(dir, 'next.json')
  fs.writeFileSync(installed, JSON.stringify(lock, null, 2))
  const copy = structuredClone(lock)
  change(copy)
  fs.writeFileSync(next, JSON.stringify(copy, null, 2))
  return spawnSync(process.execPath, [script, next, installed]).status === 0
}

test('an update that only raises the app version reinstalls nothing; a dependency change does', () => {
  assert.equal(sameDeps((c) => {
    c.version = '99.0.0'
    c.packages[''].version = '99.0.0'
  }), true)
  assert.equal(sameDeps((c) => {
    c.packages['node_modules/ws'].version = '0.0.1'
  }), false)
  assert.equal(sameDeps((c) => {
    c.packages[''].dependencies.left = '1.0.0'
  }), false)
  assert.equal(spawnSync(process.execPath, [script, 'package-lock.json', 'no-such-file.json']).status, 1, 'no installed copy: install')
})
