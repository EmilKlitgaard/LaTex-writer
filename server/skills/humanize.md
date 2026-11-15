---
name: humanize
description: Rewrite text so it reads as written by a person, fixing the patterns that mark AI text.
hint: "[what to rewrite, or extra instructions]"
guide: humanize-guide
---
Rewrite part of the document so it reads as written by a person, using the guide below.

1. Scope. Use the user's request if it names the text (a section, a file, "the introduction"). If
   it does not, use the selected text. If nothing is selected, use the paragraph or subsection the
   cursor is in. If that is unclear, ask one short question. For more than about 300 lines, hand
   the job to the writer helper. Give it the scope, any instructions from the user, and this line:
   "First call use_skill with name humanize and follow it."
2. Read the scope, plus enough of the text around it to know the genre, the register and the
   author's voice. Check the writing preferences and the project notes from project_info.
3. Diagnose before you write. Go through groups 1–9 of the guide and pick the few patterns that
   most make this passage read as AI. Changes to structure and meaning (groups 1–8) come before
   surface wording (group 9).
4. Rewrite within the scope only. Make all changes to a file in one edit_file call. Keep facts,
   claims, citations, labels, math and LaTeX structure. Keep the length about the same or shorter.
   Do not reorder or restructure beyond the scope. If the text would gain from a larger structural
   change (a different opening, moving a section, a new thread), suggest it instead of making it.
5. Reply in two to four short lines: which patterns you changed and where (file:line), and any
   larger change you suggest. Do not paste the new text; the user sees it in the review list.

If the user's request includes extra instructions (for example "keep it formal" or "only the
dialogue"), they override these steps.
