---
name: humanize-guide
description: Shared ground truth for the humanize skills, from StoryScope (Russell et al., COLM 2026).
---
# Writing like a person: what separates human from AI text

Source: Russell, Rajendhran, Pham, Iyyer and Wieting, "StoryScope: Investigating idiosyncrasies in
AI fiction" (COLM 2026, arXiv:2604.03136). They compared 10,272 human stories with versions of the
same story written by Claude, GPT, Gemini, DeepSeek and Kimi (about 5,000 words each), on 304
narrative features. The figures below are "human vs AI" from that paper.

## The main finding, and what it means for editing

- Choices about structure and meaning give AI away, not only word choice. Narrative features alone
  separate human from AI text at 93.2% F1. After the AI-typical wording was edited out, detection
  barely moved (95.5 → 93.9). Replacing words is not enough: the choices below matter more.
- AI text from every model lands in the same narrow region; human text is more spread out and more
  unusual. Human writing is less predictable in what it chooses to do. Every AI text tends to make
  the same safe choices.
- All of these are tendencies, not rules. Humans also state themes (52% of the time) and write
  stories without subplots (57%). Move the text toward the human figures; do not remove every
  instance or swap in a new tic used just as uniformly.

## The patterns

Each group: what AI does, the human figure, what to do in fiction or narrative, and what to do in
non-fiction (papers, theses, reports). The non-fiction lines adapt the findings to that genre: the
paper studied fiction only.

### 1. Over-explaining the meaning (the strongest signal)
AI states its themes and morals outright (explicitness 3.9 vs 3.3 of 5). The narrator comments on
the theme in 77% of AI stories (human 52%). Dialogue turns into philosophical debate (59% vs 34%).
References stay vague (72% vs 50%). AI spells out the meaning instead of trusting the reader.
- Fiction: cut the closing paragraph that states the lesson; end on something that happens or is
  said. Let dialogue move the plot, show character or carry conflict, not debate ideas.
- Non-fiction: cut sentences that only repeat a paragraph's point or announce its importance
  ("This highlights the crucial role of ...", "Ultimately, ...", "In essence, ..."). Do not end
  every paragraph or section with a takeaway. Let the evidence carry the claim. Keep a summary only
  where the genre requires one (abstract, conclusion, chapter overview).

### 2. Performing emotion and the senses
AI shows emotion through the body in 81% of stories (human 38%). AI names an emotion plainly in
only 8% (human 29%). Other AI habits: smells (82% vs 57%), settings and weather that mirror a
character's mood (4.1 vs 3.6), dense sensory detail, and narration of every inner state.
- Fiction: name some feelings plainly ("He was afraid."). Cut tight chests, held breaths, cold
  sweat and the reflexive smell of something. Let weather and rooms be what they are, not a mood
  board. Leave some characters' inner lives closed.
- Non-fiction: the equivalent is decorative imagery ("a rich tapestry", "navigating the
  landscape", "sheds light on") and atmosphere that adds nothing. Say the literal thing. A plain
  stance ("this surprised us", "we think this is wrong") is fine where the register allows one.

### 3. Tidy, single-track structure
AI runs a single unbroken chain of cause and effect (4.2 vs 3.9) and leaves out subplots (79% have
none; human 57%). Its protagonist solves the problem by choice (69% vs 46%). It ends in inner
understanding or acceptance (47% vs 27%). It introduces characters by describing their appearance
(52% vs 30%), opens with an establishing shot of the place, and builds investment for a long time
before anything is at stake.
- Fiction: allow a second thread that pulls against the main one, outcomes that happen to people
  rather than being chosen, endings that leave something open, and characters who arrive talking or
  acting. Get to the trouble sooner.
- Non-fiction: do not open a section with scene-setting ("In today's rapidly evolving world ...").
  Allow an aside that matters, a result that does not fit, and open questions that stay open. Not
  every limitation needs a reassuring answer, and the conclusion does not have to tie everything up.

### 4. Vague about the outside world (human strength)
Humans name specific works, people, places and things almost twice as often (47% vs 24%). They mix
explicit and implicit references (37% vs 16%). AI sticks to vague allusions.
- Both: prefer the specific name, version, date, number or source to "various studies", "a famous
  novel" or "recent advances". In LaTeX, \cite the specific source rather than "studies show".
- Never invent a reference, quote, name, figure or fact to make the text more specific. Use only
  what the document, its .bib files or the author provide. Where something is missing, leave a
  `% TODO:` comment or ask.

### 5. Ignoring the reader (human strength)
Humans break the fourth wall more often (67% vs 39%) and address the reader directly more often
(28% vs 7%). AI writes as if no one were reading.
- Fiction: an occasional aside to the reader is fine if the voice already supports it.
- Non-fiction: talk to the reader where the register allows ("you", "note that", "we"). Formal
  writing can do this through "we" and real signposting. Never force it, and never in every
  paragraph.

### 6. Strictly chronological order (human strength)
Humans jump in time more, use more flashbacks and flash-forwards, and use time jumps to hold back
a revelation. Their revelations also make the reader re-read what came before more often
(3.3 vs 3.0). AI tells events from first to last.
- Fiction: consider opening late, cutting back to earlier events, or holding back a fact that
  changes the meaning of earlier scenes.
- Non-fiction: lead with the result, the puzzle or the problem, then go back to how you got
  there, instead of narrating the process step by step ("First we ..., then ..."). Do not reorder
  where the genre fixes the order (a methods section, a proof).

### 7. Narrow range (human strength)
Humans use more locations and more dialogue relative to narration. More of their subplots run
parallel to the theme (42% vs 21%). Their protagonists are more often morally mixed (59% vs 38%).
- Fiction: more scenes in dialogue, more than one place, a protagonist whose choices are not
  clearly right.
- Non-fiction: present real trade-offs and say where the favoured approach is worse. Vary
  paragraph length and shape; not every paragraph should be claim, support, wrap-up.

### 8. Claude's own fingerprint (this assistant is Claude)
Claude's stories had the flattest escalation of any source and the most uniform voice. They
honoured conventions rather than challenging them (62% vs 39–56% for the other sources). They
favoured a quiet epilogue and avoided a sudden ending. Counter this, in proportion:
- Let stakes and intensity rise and change, and let the voice shift with the material.
- Drop the reflective last paragraph that winds down ("Looking ahead, ...", "In the end, ...").
  Stop when the point is made.
- Where the evidence supports it, make the stronger claim instead of the safe one.

Other models, for text the author pastes in: GPT relies on gossip and on looking back over the
years. Gemini prefers bleak settings and the tidiest endings. DeepSeek puts all the background up
front.

### 9. Surface tells: check them, but do not stop there
Known AI wording: too many em-dashes (in LaTeX source `---`), words like "delve" and "tapestry",
clichés, padding that restates the obvious, and overwritten prose. Newer models already avoid some
of these, and fixing them alone barely changes how AI-like a text reads (see the main finding).

## Ground rules for every humanize skill
- The author's meaning, facts, claims and voice stay. Change how it is told, not what is said. Never
  add facts, citations, quotes or data.
- Follow the author's writing preferences and the project notes. Where they conflict with this
  guide, they win.
- Respect the genre. A thesis abstract must state its contribution, a proof must be linear, and a
  methods section is chronological. That is convention, not AI over-explanation.
- Edit prose only. Keep every LaTeX command, environment, \label, \ref, \cite, math and comment
  intact, unless the change is the point (for example `---` used as a crutch).
- Prefer a few changes to structure and meaning over many word swaps. Keep the length about the
  same or shorter; humanizing should not add padding.
- Fixing these patterns makes writing better. It does not make text undetectable: the paper's
  word-level classifiers still separate human and AI text at over 99%. Never promise the author
  otherwise.
