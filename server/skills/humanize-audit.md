---
name: humanize-audit
description: Report where text reads as AI-written, with evidence and the fixes that matter most, without changing anything.
hint: "[what to check: a section, a file, or the whole document]"
guide: humanize-guide
---
Audit part of the document for the patterns in the guide below, and report. Change nothing: do not
call edit_file, write_file or update_notes in this task.

1. Scope. Use the user's request if it names the text. If it does not, use the selected text. If
   nothing is selected, use the section the cursor is in. "The whole document" means every chapter
   file. For more than about 300 lines, hand the reading to the reader helper. Give it the scope
   and this line: "First call use_skill with name humanize-audit and follow it; report only."
2. Read the scope and work out its genre (fiction, essay, academic, report), because what counts as
   a problem depends on the genre (see the ground rules).
3. Check each group of the guide (1–9). For each, decide whether there is a clear sign, a weak sign
   or no sign, compared with the human figures in the guide, not with zero. These checks catch the
   most common cases:
   - Does a paragraph, section or the ending state the lesson or the significance outright? (1)
   - Is emotion or tone carried by bodies, smells, weather or decorative imagery, rather than
     named plainly? (2)
   - Does it run in one straight line from setup to tidy resolution, with no side thread and no
     open question? (3, 6)
   - Are references vague where a specific name or citation is available? (4)
   - Does it end on a quiet wind-down or epilogue, with an even, flat intensity? (8)
4. Report in the chat, short enough for a narrow sidebar, with no tables and no headings:
   - One line: overall impression, and the genre you judged it as.
   - The clear signs, most important first. For each: the pattern, a short quote (at most one
     line) with file:line, and the concrete fix.
   - The weak signs, in one line each.
   - What already reads as human and should be kept, in one line.
   - The three changes that would matter most. Structural changes come before word swaps.
   - Finally: "Run /humanize to apply these, or name the ones you want."
5. Be honest about limits. The paper measured long stories of about 5,000 words; in a short passage
   these signals are weak. This is a writing review, not an AI detector. Never state or estimate
   whether the text was written by AI.
