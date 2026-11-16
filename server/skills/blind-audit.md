---
name: blind-audit
description: Have a fresh helper that knows nothing of this chat check something (a figure, a passage, a claim, a result) on its own, then compare its verdict with ours.
hint: "[what to check: a figure, a passage to fact-check, a claim; blank = what we just discussed]"
---
Get an independent second opinion. A helper that has not seen this conversation checks the
material on its own, so it cannot simply agree with what was said here. Change nothing in this
task: do not call edit_file, write_file or update_notes.

1. Target. Use the user's request if it names something (a figure, a table, a passage, a claim, a
   calculation, a section). If the request is blank, take the topic this conversation dealt with
   most recently: the figure, text or result that was just made, changed or discussed. If the
   chat is empty, use the selected text, and if nothing is selected, the section the cursor is in.
   Say in one line what you are having audited. Always run a new audit, even if the same material
   was audited earlier in this chat: an earlier report is not a check of the files as they are
   now, and repeating it is not what the user asked for.
2. Pin it down. Find where the material is: file:line ranges, the figure or table label, the PDF
   page (read_pdf_text, or search for the label). For a figure, also find the data or code it is
   drawn from when that is in the project, and the text that describes it.
3. Brief the helper blind. Start the auditor helper (the Agent tool, subagent_type auditor, with
   run_in_background false). The brief holds only:
   - where the material is (files, lines, labels, pages) and what kind of thing it is;
   - the neutral question that fits it, for example:
     - a figure or graph: "Describe what this figure shows. Check the axes, units, labels, legend,
       scale and caption, whether it matches its data or code, and whether the text that cites it
       describes it correctly.";
     - a passage to fact-check: "List each factual claim in this passage. For each, say whether it
       is supported, contradicted or not checkable here, with the evidence (a cited source in the
       bibliography, another part of the document, or well-established knowledge).";
     - a calculation, derivation or result: "Redo this from its inputs and say whether it holds.";
     - anything else: "Check this for errors and say what is wrong, with evidence.";
   - "Report problems first, most serious first, each with file:line or page and the evidence.
     Say how sure you are. If nothing is wrong, say so in one line."
   Leave out everything else: what the user or you think of it, the answer you expect, earlier
   findings, why it is being checked, and who wrote it. Do not hint at a suspected problem. Only
   that keeps the audit blind.
4. Compare. Set the helper's report beside what this conversation concluded. Do not dismiss a
   finding because it disagrees with us: check it against the files yourself first.
5. Report in the chat, short enough for a narrow sidebar, with no tables and no headings:
   - One line: what was audited, and the overall verdict (holds up, has problems, or could not be
     checked).
   - The problems the auditor found, most serious first, each with file:line or page and the fix,
     marked "new" where this conversation had missed it.
   - Where the auditor disagrees with what was said here, say who is right after your check.
   - Claims that could not be checked here (they need a source outside the project), and which
     source would settle them.
   - One sentence offering to fix the problems. Make the changes only when the user asks.

If the Agent tool is not available (another agent runs the assistant), do the audit yourself in a
fresh pass: read the material again from the files, answer the neutral question from step 3
without leaning on what was said in this chat, and say in the report that it was not done by a
separate helper.
