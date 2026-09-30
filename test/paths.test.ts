import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HttpError, normalizeRel, resolveInside, sanitizeFolderName, validateEntryName } from '../server/paths.ts'

const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lw-paths-')))

test('normalizeRel accepts ordinary relative paths', () => {
  assert.equal(normalizeRel('main.tex'), 'main.tex')
  assert.equal(normalizeRel('./chapters//one.tex'), 'chapters/one.tex')
  assert.equal(normalizeRel('a\\b.tex'), 'a/b.tex')
})

test('normalizeRel rejects anything that could leave the project', () => {
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'a/..', 'C:\\x', 'a\0b', '.latexwriter/project.json', 'x/.latexwriter']) {
    assert.throws(() => normalizeRel(bad), HttpError, bad)
  }
  assert.throws(() => normalizeRel(undefined))
  assert.throws(() => normalizeRel(42))
})

test('resolveInside blocks symlinks that point outside the root', () => {
  const root = tmp()
  const outside = tmp()
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  fs.symlinkSync(outside, path.join(root, 'link'))
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'file-link'))
  assert.throws(() => resolveInside(root, 'link/secret.txt'))
  assert.throws(() => resolveInside(root, 'link/new-file.txt'))
  assert.throws(() => resolveInside(root, 'file-link'))
  assert.equal(resolveInside(root, 'new/deep/file.tex').abs, path.join(root, 'new/deep/file.tex'))
  assert.throws(() => resolveInside(root, ''))
  assert.equal(resolveInside(root, '', true).abs, root)
})

test('sanitizeFolderName strips path characters', () => {
  assert.equal(sanitizeFolderName('  My: Thesis / 2026 '), 'My Thesis 2026')
  assert.equal(sanitizeFolderName('../../etc'), 'etc')
  assert.equal(sanitizeFolderName('Bachelor æøå'), 'Bachelor æøå')
  assert.throws(() => sanitizeFolderName('///'))
  assert.throws(() => sanitizeFolderName('..'))
})

test('validateEntryName rejects separators and reserved names', () => {
  assert.equal(validateEntryName(' fig.png '), 'fig.png')
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', '.latexwriter', '.DS_Store']) assert.throws(() => validateEntryName(bad), HttpError, bad)
})
