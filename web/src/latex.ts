import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { EditorSelection } from '@codemirror/state'
import type { EditorView, KeyBinding } from '@codemirror/view'
import type { ProjectIndex } from './api.ts'

// ---- outline -----------------------------------------------------------------------

export type OutlineItem = { level: number; title: string; line: number }

const SECTION_LEVELS: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 }

/** Reads the argument in braces starting at `open` (the index of "{"), honouring nesting. */
function braceArgument(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length && i < open + 400; i++) {
    const ch = text[i]
    if (ch === '\\') i++
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return text.slice(open + 1, i)
  }
  return text.slice(open + 1, open + 80)
}

export function parseOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = []
  const lines = text.split('\n')
  const re = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/g
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const comment = line.search(/(^|[^\\])%/)
    const code = comment >= 0 ? line.slice(0, comment + (line[comment] === '%' ? 0 : 1)) : line
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(code))) {
      const rest = lines.slice(i, i + 3).join(' ')
      const title = braceArgument(rest, m.index + m[0].length - 1)
        .replace(/\\label\{[^}]*\}/g, '')
        .replace(/\\[a-zA-Z]+\*?\s*/g, '')
        .replace(/[{}~]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      items.push({ level: SECTION_LEVELS[m[1]], title: title || '(untitled)', line: i + 1 })
    }
  }
  const min = Math.min(...items.map((i) => i.level))
  return items.map((i) => ({ ...i, level: i.level - min }))
}

// ---- completion --------------------------------------------------------------------

const cmd = (label: string, detail?: string): Completion => ({ label, type: 'keyword', detail })
const snip = (template: string, label: string, detail?: string): Completion => snippetCompletion(template, { label, type: 'function', detail })

const COMMANDS: Completion[] = [
  snip('\\begin{${env}}\n\t${}\n\\end{${env}}', '\\begin', 'environment'),
  snip('\\section{${title}}', '\\section'), snip('\\subsection{${title}}', '\\subsection'),
  snip('\\subsubsection{${title}}', '\\subsubsection'), snip('\\chapter{${title}}', '\\chapter'),
  snip('\\paragraph{${title}}', '\\paragraph'), snip('\\part{${title}}', '\\part'),
  snip('\\textbf{${text}}', '\\textbf', 'bold'), snip('\\textit{${text}}', '\\textit', 'italic'),
  snip('\\emph{${text}}', '\\emph', 'emphasis'), snip('\\underline{${text}}', '\\underline'),
  snip('\\texttt{${text}}', '\\texttt', 'monospace'), snip('\\textsc{${text}}', '\\textsc', 'small caps'),
  snip('\\textrm{${text}}', '\\textrm'), snip('\\textsf{${text}}', '\\textsf'), snip('\\text{${text}}', '\\text'),
  snip('\\label{${name}}', '\\label'), snip('\\ref{${label}}', '\\ref'), snip('\\eqref{${label}}', '\\eqref'),
  snip('\\pageref{${label}}', '\\pageref'), snip('\\autoref{${label}}', '\\autoref'), snip('\\cref{${label}}', '\\cref'),
  snip('\\cite{${key}}', '\\cite'), snip('\\citep{${key}}', '\\citep'), snip('\\citet{${key}}', '\\citet'),
  snip('\\parencite{${key}}', '\\parencite'), snip('\\textcite{${key}}', '\\textcite'), snip('\\footcite{${key}}', '\\footcite'),
  snip('\\footnote{${text}}', '\\footnote'), snip('\\caption{${text}}', '\\caption'),
  snip('\\includegraphics[width=${0.8}\\textwidth]{${file}}', '\\includegraphics'),
  snip('\\input{${file}}', '\\input'), snip('\\include{${file}}', '\\include'),
  snip('\\usepackage{${package}}', '\\usepackage'), snip('\\documentclass{${class}}', '\\documentclass'),
  snip('\\title{${title}}', '\\title'), snip('\\author{${name}}', '\\author'), snip('\\date{${date}}', '\\date'),
  snip('\\frac{${num}}{${den}}', '\\frac'), snip('\\sqrt{${x}}', '\\sqrt'), snip('\\sum_{${i=1}}^{${n}}', '\\sum'),
  snip('\\int_{${a}}^{${b}}', '\\int'), snip('\\prod_{${i=1}}^{${n}}', '\\prod'), snip('\\lim_{${x \\to 0}}', '\\lim'),
  snip('\\mathbf{${x}}', '\\mathbf'), snip('\\mathrm{${x}}', '\\mathrm'), snip('\\mathbb{${R}}', '\\mathbb'),
  snip('\\mathcal{${L}}', '\\mathcal'), snip('\\hat{${x}}', '\\hat'), snip('\\bar{${x}}', '\\bar'),
  snip('\\vec{${x}}', '\\vec'), snip('\\overline{${x}}', '\\overline'), snip('\\left( ${} \\right)', '\\left('),
  snip('\\left[ ${} \\right]', '\\left['), snip('\\href{${url}}{${text}}', '\\href'), snip('\\url{${url}}', '\\url'),
  snip('\\newcommand{\\${name}}[${1}]{${definition}}', '\\newcommand'), snip('\\renewcommand{\\${name}}{${definition}}', '\\renewcommand'),
  snip('\\bibliography{${file}}', '\\bibliography'), snip('\\bibliographystyle{${plain}}', '\\bibliographystyle'),
  snip('\\addbibresource{${file}.bib}', '\\addbibresource'), snip('\\vspace{${1em}}', '\\vspace'), snip('\\hspace{${1em}}', '\\hspace'),
  snip('\\multicolumn{${2}}{${c}}{${text}}', '\\multicolumn'), snip('\\textcolor{${red}}{${text}}', '\\textcolor'),
  snip('\\setlength{\\${parindent}}{${0pt}}', '\\setlength'),
  ...['item', 'maketitle', 'tableofcontents', 'listoffigures', 'listoftables', 'newpage', 'clearpage', 'pagebreak', 'noindent',
    'centering', 'raggedright', 'raggedleft', 'hline', 'toprule', 'midrule', 'bottomrule', 'today', 'LaTeX', 'TeX', 'ldots', 'cdots',
    'vdots', 'ddots', 'quad', 'qquad', 'hfill', 'vfill', 'par', 'bigskip', 'medskip', 'smallskip', 'linebreak', 'newline',
    'textwidth', 'linewidth', 'columnwidth', 'textheight', 'printbibliography', 'appendix', 'frametitle', 'titlepage', 'pause',
    'small', 'footnotesize', 'scriptsize', 'tiny', 'large', 'Large', 'LARGE', 'huge', 'Huge', 'normalsize', 'bfseries', 'itshape',
    'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu',
    'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda',
    'Xi', 'Pi', 'Sigma', 'Phi', 'Psi', 'Omega', 'infty', 'partial', 'nabla', 'times', 'cdot', 'pm', 'mp', 'leq', 'geq', 'neq',
    'approx', 'equiv', 'sim', 'propto', 'in', 'notin', 'subset', 'subseteq', 'supset', 'cup', 'cap', 'emptyset', 'forall', 'exists',
    'rightarrow', 'leftarrow', 'Rightarrow', 'Leftarrow', 'leftrightarrow', 'Leftrightarrow', 'mapsto', 'to', 'sin', 'cos', 'tan',
    'log', 'ln', 'exp', 'min', 'max', 'det', 'dots', 'ell', 'hbar', 'neg', 'land', 'lor', 'oplus', 'otimes', 'circ', 'langle',
    'rangle', 'lfloor', 'rfloor', 'lceil', 'rceil', 'mid', 'parallel', 'perp', 'angle', 'triangle', 'star', 'dagger',
  ].map((n) => cmd('\\' + n)),
]

const ENVIRONMENTS = [
  'document', 'abstract', 'itemize', 'enumerate', 'description', 'figure', 'table', 'tabular', 'equation', 'equation*', 'align',
  'align*', 'gather', 'gather*', 'multline', 'cases', 'matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'array', 'center', 'flushleft',
  'flushright', 'quote', 'quotation', 'verbatim', 'lstlisting', 'minipage', 'frame', 'columns', 'column', 'block', 'theorem',
  'lemma', 'proof', 'definition', 'corollary', 'example', 'remark', 'tikzpicture', 'subfigure', 'thebibliography', 'titlepage',
  'letter', 'appendix', 'split', 'aligned', 'tabularx', 'longtable', 'figure*', 'table*',
]

const PACKAGES = [
  'amsmath', 'amssymb', 'amsthm', 'mathtools', 'graphicx', 'hyperref', 'geometry', 'inputenc', 'fontenc', 'babel', 'xcolor',
  'booktabs', 'tabularx', 'longtable', 'multirow', 'array', 'caption', 'subcaption', 'float', 'enumitem', 'listings', 'tikz',
  'pgfplots', 'siunitx', 'biblatex', 'natbib', 'cleveref', 'csquotes', 'microtype', 'setspace', 'fancyhdr', 'titlesec', 'url',
  'lmodern', 'parskip', 'todonotes', 'algorithm2e', 'algorithmicx', 'fontspec', 'unicode-math', 'appendix', 'wrapfig', 'pdfpages',
]

const REF_COMMANDS = /\\(?:ref|eqref|pageref|autoref|cref|Cref|nameref|vref)\{([^}]*)$/
const CITE_COMMANDS = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?(?:\[[^\]]*\]){0,2}\{([^}]*)$/
const GRAPHICS = /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)$/
const INPUT = /\\(input|include|subfile|bibliography|addbibresource)\{([^}]*)$/
const BEGIN_END = /\\(?:begin|end)\{([^}]*)$/
const USEPACKAGE = /\\usepackage(?:\[[^\]]*\])?\{([^}]*)$/
const IMAGE_EXT = /\.(png|jpe?g|pdf|eps|gif|svg)$/i

export type IndexSource = { get: () => ProjectIndex; localLabels: () => string[] }

/** Completion for commands, environments, labels, citation keys and file names. */
export function latexCompletions(source: IndexSource) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = line.text.slice(0, ctx.pos - line.from)
    // For comma-separated arguments (\cite{a,b}), complete only the part after the last comma.
    const lastPart = (arg: string): number => {
      const tail = arg.slice(arg.lastIndexOf(',') + 1)
      return ctx.pos - tail.trimStart().length
    }
    let m: RegExpExecArray | null

    if ((m = REF_COMMANDS.exec(before))) {
      const index = source.get()
      const seen = new Set<string>()
      const options: Completion[] = []
      for (const name of source.localLabels()) if (!seen.has(name)) { seen.add(name); options.push({ label: name, type: 'variable' }) }
      for (const l of index.labels) if (!seen.has(l.name)) { seen.add(l.name); options.push({ label: l.name, type: 'variable', detail: l.file }) }
      return { from: ctx.pos - m[1].length, options, validFor: /^[^}]*$/ }
    }
    if ((m = CITE_COMMANDS.exec(before))) {
      const options = source.get().bibKeys.map((k) => ({ label: k.key, type: 'constant', detail: [k.author?.split(/ and |,/)[0], k.title].filter(Boolean).join(': ').slice(0, 70) }))
      return { from: lastPart(m[1]), options, validFor: /^[^},]*$/ }
    }
    if ((m = GRAPHICS.exec(before))) {
      const options = source.get().files.filter((f) => IMAGE_EXT.test(f)).map((f) => ({ label: f, type: 'text' }))
      return { from: ctx.pos - m[1].length, options, validFor: /^[^}]*$/ }
    }
    if ((m = INPUT.exec(before))) {
      const bib = m[1] === 'bibliography' || m[1] === 'addbibresource'
      const options = source.get().files
        .filter((f) => (bib ? f.endsWith('.bib') : f.endsWith('.tex')))
        .map((f) => ({ label: m![1] === 'addbibresource' || m![1] === 'subfile' ? f : f.replace(/\.(tex|bib)$/, ''), type: 'text' }))
      return { from: bib ? lastPart(m[2]) : ctx.pos - m[2].length, options, validFor: /^[^},]*$/ }
    }
    if ((m = USEPACKAGE.exec(before))) {
      return { from: lastPart(m[1]), options: PACKAGES.map((p) => ({ label: p, type: 'namespace' })), validFor: /^[^},]*$/ }
    }
    if ((m = BEGIN_END.exec(before))) {
      return { from: ctx.pos - m[1].length, options: ENVIRONMENTS.map((e) => ({ label: e, type: 'type' })), validFor: /^[^}]*$/ }
    }
    const word = ctx.matchBefore(/\\[a-zA-Z]*/)
    if (word && (word.text.length > 1 || ctx.explicit)) {
      return { from: word.from, options: COMMANDS, validFor: /^\\[a-zA-Z]*$/ }
    }
    return null
  }
}

// ---- editing helpers ------------------------------------------------------------------

/** Enter after \begin{env} inserts the matching \end{env} when it is missing. */
function closeEnvironment(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  const before = line.text.slice(0, sel.head - line.from)
  const after = line.text.slice(sel.head - line.from)
  const m = /\\begin\{([^}]+)\}(?:\[[^\]]*\]|\{[^}]*\})*\s*$/.exec(before)
  if (!m || after.trim()) return false
  const env = m[1]
  const escaped = env.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const text = state.doc.toString()
  const begins = (text.match(new RegExp(`\\\\begin\\{${escaped}\\}`, 'g')) ?? []).length
  const ends = (text.match(new RegExp(`\\\\end\\{${escaped}\\}`, 'g')) ?? []).length
  if (begins <= ends) return false
  const indent = /^\s*/.exec(line.text)![0]
  const inner = env === 'document' ? '' : '  '
  const item = /^(itemize|enumerate|description)$/.test(env) ? '\\item ' : ''
  const insert = `\n${indent}${inner}${item}\n${indent}\\end{${env}}`
  view.dispatch({
    changes: { from: sel.head, insert },
    selection: { anchor: sel.head + 1 + indent.length + inner.length + item.length },
    userEvent: 'input',
    scrollIntoView: true,
  })
  return true
}

function wrapSelection(command: string) {
  return (view: EditorView): boolean => {
    const changes = view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to)
      const insert = `\\${command}{${text}}`
      const start = range.from + command.length + 2
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(start, start + text.length),
      }
    })
    view.dispatch(view.state.update(changes, { userEvent: 'input', scrollIntoView: true }))
    return true
  }
}

export const latexKeymap: KeyBinding[] = [
  { key: 'Enter', run: closeEnvironment },
  { key: 'Mod-b', run: wrapSelection('textbf') },
  { key: 'Mod-i', run: wrapSelection('emph') },
]
