import assert from 'node:assert/strict'
import { test } from 'node:test'
import { INSTRUCTIONS } from '../server/mcp.ts'
import { markdownMathIssues, markdownMathNote } from '../server/mdmath.ts'

test('math left as plain text in Markdown is found', () => {
  const md = [
    'The angle Theta_lenght sets the stroke.', // 1
    'Energy grows as x^2 and 10^3 times faster than y_0.', // 2
    'Here \\alpha and \\frac{a}{b} are typeset wrongly.', // 3
    'Speed v_max and omega^2 matter.', // 4
  ].join('\n')
  assert.deepEqual(markdownMathIssues(md), [
    'line 1: "Theta_lenght"',
    'line 2: "x^2", "y_0", "10^3"',
    'line 3: "\\alpha", "\\frac{a}{b}"',
    'line 4: "omega^2", "v_max"',
  ])
})

test('math in dollar signs, code, links and ordinary words are left alone', () => {
  const md = [
    'The angle $\\Theta_{\\text{length}}$ and $x^2$ inline, a price of \\$5.',
    'Display:',
    '$$',
    'E = mc^2 \\quad \\alpha_1',
    '$$',
    '$$ \\int_0^1 f(x)\\,dx $$',
    'Run `make_all --x^2` and see [the guide](docs/setup_guide.md) or https://example.com/a_b?x^2.',
    '```python',
    'theta_length = x**2  # x^2',
    '```',
    'Plain snake_case words, file_names.md and my_variable stay as they are.',
  ].join('\n')
  assert.deepEqual(markdownMathIssues(md), [])
})

test('an edit is told only about lines it wrote, and only for Markdown files', () => {
  const before = 'Old line with x_1 left over.\n'
  const after = before + 'New line with sigma_xy.\n'
  assert.deepEqual(markdownMathIssues(after, before), ['line 2: "sigma_xy"'])
  assert.match(markdownMathNote('notes/derivation.md', after, before), /Math outside \$\.\.\.\$ in notes\/derivation\.md[\s\S]*line 2: "sigma_xy"$/)
  assert.equal(markdownMathNote('main.tex', after, before), '', 'LaTeX files are not checked')
  assert.equal(markdownMathNote('notes.md', 'All in $\\sigma_{xy}$.'), '')
})

test('every agent gets the Markdown math rules with its instructions', () => {
  assert.match(INSTRUCTIONS, /Writing Markdown files[\s\S]*Theta_length[\s\S]*\\Theta_\{\\text\{length\}\}/)
})
