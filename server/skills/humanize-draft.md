---
name: humanize-draft
description: Write new text with the human patterns built in from the start, instead of fixing them afterwards.
hint: "<what to write, and where>"
guide: humanize-guide
---
Write new text for the document following the guide below from the first draft. The paper found
that structure and meaning are what give AI text away, and that editing afterwards hardly changes
them. Make those choices before writing, not afterwards.

1. What and where. The user's request says what to write. Put it where they say; otherwise at the
   cursor; otherwise ask one short question. Read the text around that place, and the writing
   preferences and project notes, to match the genre, register, voice and notation.
2. Material. Use only facts, results, names and sources from the document, its .bib files and the
   user's request. Where something you need is missing, write a `% TODO: ...` comment in its place.
   Do not invent it.
3. Decide the structure first, and think it through without writing it out:
   - Where does the text start: with the result, the problem, the moment of trouble, or somewhere
     else? Not by default at the beginning of events.
   - What does the reader work out without being told? No closing lesson or significance line,
     beyond what the genre requires.
   - Which concrete names, sources, numbers or details carry it, instead of general statements?
   - What stays open, complicated or two-sided?
   - Where does the intensity rise, and where does it stop? Stop when the point is made, with no
     wind-down paragraph.
4. Write it in one edit_file call (write_file for a new file). Keep the length to what was asked
   for. Then check the draft once against groups 1–9 of the guide, and fix what slipped through in
   the same edit if you have not made it yet.
5. Reply in one or two lines: what you wrote, where (file:line), and any `% TODO` gaps the author
   needs to fill.
