Writing Markdown files (.md: notes, READMEs, drafts). The app previews them with KaTeX math:
- All math goes inside dollar signs, however small: a symbol, a variable with a subscript, a unit
  with a power. Never leave math as plain text: `Theta_length`, `x^2`, `\alpha` or `v_max` in the
  text are wrong; write $\Theta_{\text{length}}$, $x^2$, $\alpha$, $v_{\max}$.
- Inline math as `$...$` with no space just inside the dollars. Display math as `$$` on its own
  line, the formula, then `$$` on its own line. Several aligned lines go in one display block with
  `\begin{aligned} ... \end{aligned}`. Do not use `\(...\)`, `\[...\]` or bare `\begin{equation}`.
- Subscripts and superscripts of more than one character need braces: `x_{10}`, `e^{-t/\tau}`.
  A word in a subscript is text, not italic letters: `\Theta_{\text{length}}`, `T_{\mathrm{room}}`.
- Units upright with a thin space: `$9.81\,\mathrm{m/s^2}$`. KaTeX has no packages, so no `\SI`,
  `\qty`, `\si` or macros from the document's preamble.
- A literal dollar sign is `\$`. Code, file names, commands and LaTeX meant to be copied go in
  backticks or a fenced code block, never in dollar signs.
