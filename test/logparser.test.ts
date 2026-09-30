import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBibLog, parseTexLog, toProjectPath } from '../server/logparser.ts'

const LOG = String.raw`This is pdfTeX, Version 3.141592653-2.6-1.40.26 (TeX Live 2024)
(./main.tex
LaTeX2e <2023-11-01> patch level 1
(/usr/local/texlive/2024/texmf-dist/tex/latex/base/article.cls
Document Class: article 2023/05/17 v1.4n Standard LaTeX document class
(/usr/local/texlive/2024/texmf-dist/tex/latex/base/size10.clo))
(./main.aux (./chapters/one.aux))

LaTeX Warning: Reference ` + '`' + String.raw`nope' on page 1 undefined on input line 6.

[1{/usr/local/texlive/2024/texmf-var/fonts/map/pdftex/updmap/pdftex.map}]
\openout2 = ` + '`' + String.raw`chapters/one.aux'.

 (./chapters/one.tex
./chapters/one.tex:2: Undefined control sequence.
l.2 Some text $x^2$ and a bad \badmacro
                                        here.
The control sequence at the end of the top line
of your error message was never \def'ed.

Overfull \hbox (12.0pt too wide) in paragraph at lines 5--6
[]\OT1/cmr/m/n/10 A very long line (with a stray paren

Package hyperref Warning: Token not allowed in a PDF string (Unicode):
(hyperref)                removing ` + '`' + String.raw`math shift' on input line 9.

) [2]
./main.tex:8: Undefined control sequence.
l.8 \undefinedcommand
                     
./main.tex:9: LaTeX Error: File ` + '`' + String.raw`fancypkg.sty' not found.

LaTeX Warning: There were undefined references.

 )
`

test('errors carry file, line and the offending text', () => {
  const entries = parseTexLog(LOG)
  const errors = entries.filter((e) => e.severity === 'error')
  assert.deepEqual(errors.map((e) => [e.file, e.line]), [['chapters/one.tex', 2], ['main.tex', 8], ['main.tex', 9]])
  assert.equal(errors[0].message, 'Undefined control sequence.')
  assert.match(errors[0].detail!, /\\badmacro/)
})

test('a missing package gets an install hint', () => {
  const missing = parseTexLog(LOG).find((e) => /fancypkg/.test(e.message))!
  assert.match(missing.hint!, /sudo tlmgr install fancypkg/)
})

test('warnings are attributed to the file that was open', () => {
  const entries = parseTexLog(LOG)
  const ref = entries.find((e) => /Reference/.test(e.message))!
  assert.deepEqual([ref.severity, ref.file, ref.line], ['warning', 'main.tex', 6])
  const hyper = entries.find((e) => /hyperref/.test(e.message))!
  assert.deepEqual([hyper.file, hyper.line], ['chapters/one.tex', 9])
  assert.match(hyper.message, /removing .math shift./)
  assert.equal(entries.some((e) => /There were undefined references/.test(e.message)), false)
})

test('box warnings are informational and do not corrupt the file stack', () => {
  const entries = parseTexLog(LOG)
  const box = entries.find((e) => /Overfull/.test(e.message))!
  assert.deepEqual([box.severity, box.file, box.line], ['info', 'chapters/one.tex', 5])
})

test('fatal-error follow-up lines are dropped', () => {
  const log = './main.tex:3: LaTeX Error: File `x.tex\' not found.\nl.3 \\input{x}\n./main.tex:3: Emergency stop.\n./main.tex:3:  ==> Fatal error occurred, no output PDF file produced!\n'
  assert.equal(parseTexLog(log).length, 1)
})

test('errors without file-line-error format are located through the file stack', () => {
  const log = '(./main.tex (./sub/part.tex\n! Missing $ inserted.\n<inserted text> \n                $\nl.14 a_b\n\n))\n'
  const [e] = parseTexLog(log)
  assert.deepEqual([e.severity, e.file, e.line, e.message], ['error', 'sub/part.tex', 14, 'Missing $ inserted.'])
})

test('paths in the build folder map back to the project, TeX tree paths do not', () => {
  assert.equal(toProjectPath('/build/x/./main.tex', '/build/x'), 'main.tex')
  assert.equal(toProjectPath('./a/b.tex'), 'a/b.tex')
  assert.equal(toProjectPath('/usr/local/texlive/2024/texmf-dist/tex/latex/base/article.cls', '/build/x'), null)
})

test('BibTeX log: missing entries and syntax errors', () => {
  const blg = `This is BibTeX, Version 0.99d
Database file #1: refs.bib
Warning--I didn't find a database entry for "smith2020"
I was expecting a \`,' or a \`}'---line 7 of file refs.bib
 :   title = {Broken
(Error may have been on previous line)
Warning--empty year in knuth84
`
  const entries = parseBibLog(blg)
  assert.deepEqual(entries.map((e) => e.severity), ['warning', 'error', 'warning'])
  assert.match(entries[0].message, /smith2020/)
  assert.deepEqual([entries[1].file, entries[1].line], ['refs.bib', 7])
})

test('Biber log lines are recognised', () => {
  const blg = "[120] Utils.pm:411> WARN - I didn't find a database entry for 'x' (section 0)\n[121] Biber.pm:140> ERROR - Cannot find 'refs.bib'!\n"
  assert.deepEqual(parseBibLog(blg).map((e) => e.severity), ['warning', 'error'])
})
