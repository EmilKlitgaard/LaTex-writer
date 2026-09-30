export type TemplateId = 'blank' | 'article' | 'report' | 'beamer' | 'letter'

export const TEMPLATES: { id: TemplateId; name: string; description: string }[] = [
  { id: 'article', name: 'Article', description: 'Title, abstract, sections and a bibliography' },
  { id: 'report', name: 'Report', description: 'Chapters in separate files, table of contents' },
  { id: 'beamer', name: 'Presentation', description: 'Beamer slides' },
  { id: 'letter', name: 'Letter', description: 'A formal letter' },
  { id: 'blank', name: 'Blank', description: 'An empty document' },
]

const ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}', '#': '\\#', $: '\\$', '%': '\\%', '&': '\\&', _: '\\_', '{': '\\{', '}': '\\}',
  '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
}
const esc = (s: string): string => s.replace(/[\\#$%&_{}~^]/g, (c) => ESCAPES[c])

/** Returns the files of a new project: path to content. */
export function renderTemplate(id: TemplateId, title: string, author: string): Record<string, string> {
  const t = esc(title)
  const a = esc(author)
  switch (id) {
    case 'blank':
      return {
        'main.tex': `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}

\\begin{document}

\\end{document}
`,
      }
    case 'article':
      return {
        'main.tex': `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{hyperref}

\\title{${t}}
\\author{${a}}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
Write a short summary of the article here.
\\end{abstract}

\\section{Introduction}\\label{sec:introduction}

Start writing here. Reference other parts with Section~\\ref{sec:method},
and cite sources like this~\\cite{knuth1984}.

\\section{Method}\\label{sec:method}

An equation:
\\begin{equation}\\label{eq:euler}
  e^{i\\pi} + 1 = 0
\\end{equation}

\\section{Conclusion}

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
        'references.bib': `@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984}
}
`,
      }
    case 'report':
      return {
        'main.tex': `\\documentclass[11pt,a4paper]{report}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{hyperref}

\\title{${t}}
\\author{${a}}
\\date{\\today}

\\begin{document}

\\maketitle
\\tableofcontents

\\input{chapters/introduction}
\\input{chapters/background}

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
        'chapters/introduction.tex': `\\chapter{Introduction}\\label{ch:introduction}

Start writing here. Chapter~\\ref{ch:background} gives the background.
`,
        'chapters/background.tex': `\\chapter{Background}\\label{ch:background}

\\section{Previous work}

Cite sources like this~\\cite{knuth1984}.
`,
        'references.bib': `@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984}
}
`,
      }
    case 'beamer':
      return {
        'main.tex': `\\documentclass[aspectratio=169]{beamer}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{graphicx}

\\usetheme{Madrid}

\\title{${t}}
\\author{${a}}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

\\begin{frame}{Outline}
  \\tableofcontents
\\end{frame}

\\section{Introduction}

\\begin{frame}{First slide}
  \\begin{itemize}
    \\item A first point
    \\item A second point
  \\end{itemize}
\\end{frame}

\\section{Results}

\\begin{frame}{An equation}
  \\[
    \\int_0^1 x^2 \\, dx = \\frac{1}{3}
  \\]
\\end{frame}

\\end{document}
`,
      }
    case 'letter':
      return {
        'main.tex': `\\documentclass[11pt,a4paper]{letter}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[margin=2.5cm]{geometry}

\\signature{${a}}
\\address{Your street 1 \\\\ 1234 City}
\\date{\\today}

\\begin{document}

\\begin{letter}{Recipient name \\\\ Their street 2 \\\\ 5678 City}

\\opening{Dear Sir or Madam,}

Write the letter here.

\\closing{Yours sincerely,}

\\end{letter}

\\end{document}
`,
      }
  }
}
