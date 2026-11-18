# LaTeX Writer — Specification v1

A locally hosted, Overleaf-style LaTeX editor. Double-click to start, Safari is the interface, other people on the LAN can join with a passcode.

## 1. Verified environment

| Item | Status |
|---|---|
| MacTeX 2024 (full: fontspec, biblatex, beamer, minted, tikz, babel present) | OK |
| `latexmk` 4.83, `pdflatex`, `xelatex`, `lualatex`, `bibtex`, `biber`, `synctex` | OK |
| Node v24 (nvm), npm | OK |
| Port 4173 | free |
| `~/Downloads` (Overførsler) | exists |
| LAN IP (en0) | 192.168.1.18 (detected at runtime, not hard-coded) |

## 2. Decisions (all settled with the user)

**Stack & launch**
- Node.js server (Fastify + WebSocket), TypeScript. Front end: CodeMirror 6, PDF.js, Yjs, bundled with Vite; fully offline, no CDN.
- Launcher: `Start LaTeX Writer.command` (first run does `npm install`, then starts the server and opens Safari). Later wrapped into a `.app` with a Dock icon.
- Port 4173, falls back to the next free port and opens that one.
- iCloud rule: source lives here; `node_modules`, config, compile scratch live in `~/Library/Application Support/LaTeXWriter/`.

**Workspaces & projects**
- Start screen: pick a workspace folder (parent folder) or reopen a recent one. Folder picker is an in-app server-side directory browser (host only).
- Workspace shows a project list; "New project" creates `<workspace>/<Name>/` containing `main.tex`, `main.pdf` and a hidden `.latexwriter/` folder. Templates: blank, article, report, beamer, letter.
- Opening a folder that already contains a `main.tex` directly is also supported.

**Editing**
- Full real-time co-editing (Yjs), with live cursors, names and colors.
- Autosave to disk; file watcher merges external edits (VS Code, iCloud) live and snapshots them.
- iCloud placeholder files: detected, message "not downloaded from iCloud" with a "Download now" retry.

**Compile**
- pdfLaTeX by default; `% !TEX program = xelatex|lualatex` overrides it; auto-switch to XeLaTeX if `fontspec` is loaded. No dropdown.
- Auto-compile on by default, 1.5 s after typing stops, toolbar toggle. Manual Recompile button and ⌘/Ctrl+Enter.
- A new compile request cancels the running one and restarts with the latest.
- Shell escape always off.
- Errors/warnings panel under the PDF, filter "only errors"; click jumps to the line in the editor; error markers in the gutter.
- Missing package: error plus a copyable `sudo tlmgr install <pkg>` hint. No auto-install.

**LAN sharing**
- Settings toggle "Show on LAN". Off: server bound to `127.0.0.1`. On: `0.0.0.0`, Settings shows `http://<LAN-IP>:<port>`.
- Passcode: plain, numbers or text, minimum 4 characters (`1234` is fine), stored hashed.
- Guests see only the project the host has open, and follow if the host switches. No project open shows a "waiting for host" screen.
- Guests type a display name (remembered in the browser, blank gives "Guest N"); colors auto-assigned.
- Guests may: edit, create/rename/move/delete files (delete goes to `.latexwriter/trash`), upload, compile, view/restore history, download the PDF.
- Guests may not: change project settings or delete the project, change LAN/passcode, use the folder picker, switch projects.
- Rate limit: 5 wrong passcodes from one IP locks that IP for 5 minutes. Session cookie after success. Changing the passcode or turning LAN off logs out all guests.
- Host is identified by connecting from `127.0.0.1`. Opening the LAN IP in your own browser counts as a guest.
- Share panel lists connected people with a kick button.

**UI**
- Top bar: project name, Recompile, auto-compile toggle, Download PDF, Export PDF, Share, Settings.
- Left: collapsible file tree (right-click new/rename/delete/move, drag-drop upload).
- Middle: editor. Right: PDF (zoom, fit-width, page nav) with collapsible log panel below.
- Draggable dividers. Light/dark follows the system with manual override. English UI. Safari's built-in spell check.

**Export**
- "Export PDF" copies `main.pdf` to `~/Downloads/<ProjectName>.pdf` (adds `(2)`, `(3)` if the name exists). Guests get a normal browser download.
- "Advanced exporter…" (⇧⌘E) splits the PDF into parts at chosen points (default: before the abstract; quick picks from the PDF's bookmarks or headings). Whole pages are copied; a page cut mid-way becomes two pages drawn through windows, with the moved half placed at the usual top of the text and the running header/footer kept. Text outside a window is removed from the content stream. Files: `<ProjectName> - Part N.pdf` in Downloads (the same `(2)` for the whole set if any name is taken), or one .zip (always for guests).

**History**
- Snapshot every 2 min while editing (only if changed), stored as compressed diffs in `.latexwriter/history`.
- Retention: everything for the last hour, then hourly for a day, then daily. Hard cap 50 MB per project, oldest dropped first.
- Per-file history view and restore; restoring snapshots the current state first, so it can be undone. No diff view in v1.

## 3. Gaps filled (my decisions)

**Architecture**
- One Node process. HTTP for static files and REST, one WebSocket endpoint for Yjs sync and presence (`y-websocket` protocol), one for compile events.
- Server holds one Yjs doc per open text file. Debounced write to disk (~500 ms). Binary files bypass Yjs and are plain REST.
- Host-vs-guest is decided per request from the socket's remote address, never from a client-sent flag.

**Compile pipeline**
- Command: `latexmk -pdf|-xelatex|-lualatex -interaction=nonstopmode -file-line-error -synctex=1 -no-shell-escape -halt-on-error=off -outdir=<scratch>`, run with the project folder as cwd. `TEXINPUTS` and `BIBINPUTS` include the project folder so `\input`, images and `.bib` files resolve while aux files stay out of iCloud.
- 60 s timeout, then the process is killed and "compile timed out" is reported.
- On success, `main.pdf` is copied from scratch into the project folder. On failure, the last good PDF stays and errors are shown.
- Log parsing: `-file-line-error` output gives `file:line: message`. The parser also handles overfull/underfull boxes, undefined references, missing files, and BibTeX/Biber errors. The result is a list of `{severity, file, line, message}`; clicking opens the file and line.
- Bibliography is handled by latexmk (bibtex or biber, auto-detected).
- SyncTeX: the `synctex` CLI translates in both directions. Double-click a PDF spot to jump to the source; a "go to PDF" button or shortcut jumps from the cursor to the PDF.
- Compiled PDF is streamed to PDF.js. Scroll position and zoom are preserved across recompiles.

**Editor**
- LaTeX syntax highlighting, line numbers, bracket matching and auto-closing, `\begin{x}` auto-`\end{x}`, find/replace, command autocomplete, `\ref`/`\cite`/`\includegraphics`/`\input` autocomplete from project labels, `.bib` keys and files, comment toggle (⌘/), soft wrap, font size setting, keyboard shortcut for bold/italic (`\textbf`, `\emph`).
- Binary files: images show in a preview pane; other PDFs open in the viewer.
- Outline panel (sections from `\section` etc.) in the left sidebar, click to jump.

**Files & projects**
- Main file defaults to `main.tex`; host can change it in project settings. Magic comment `% !TEX root = ...` is respected.
- Zip download of the whole project. Delete project (host only) moves the folder to the macOS Trash. It is never permanently deleted.
- Upload limit 50 MB per file. Project names are sanitized for folder names.
- Recent workspaces stored with the last-opened project per workspace.

**Security**
- All paths resolved against the project root; `..`, absolute paths and symlinks leaving the root are rejected.
- Guests cannot reach any endpoint outside the currently open project.
- Passcode hashed with scrypt; the cookie is `HttpOnly`, `SameSite=Lax`, random session id.
- Origin/Host header checked on the WebSocket and state-changing requests to block cross-site requests from other pages.
- Guest sessions cannot use secure-context browser APIs (LAN HTTP is not a secure context), so nothing in the UI depends on clipboard-write, crypto.subtle or service workers. The copy hint uses a fallback.
- Traffic on the LAN is plain HTTP. The passcode is a convenience barrier, not strong security. Documented in Settings.

**Server**
- Config file (`config.json` in Application Support): recent workspaces, LAN toggle, passcode hash, theme, last port. Written atomically.
- Graceful shutdown on Ctrl+C or closing Terminal: flushes open docs to disk before exit.
- Clean handling if the workspace folder disappears or is renamed (error screen, back to start).
- Logging to `~/Library/Application Support/LaTeXWriter/logs/`, rotated.

## 4. Explicitly out of scope for v1

Visual (rich-text) editor, comments/track changes, git integration, diff view, minted/shell-escape (host-only toggle can be added later), Danish UI, per-guest permissions, HTTPS, automatic package install, Chrome-specific features (Safari is the target; the app avoids browser-specific APIs).

## 5. Build plan

1. Server skeleton, launcher, workspace/project management, config.
2. Editor with file tree and disk sync (single user).
3. Compile pipeline, log parser, PDF viewer, SyncTeX.
4. Yjs collaboration and LAN mode (passcode, presence, guest permissions, kick).
5. History, export, zip, outline, autocomplete, polish.
6. Tests: unit tests for path safety, log parser, retention; end-to-end test with two browser sessions; then wrap into `.app`.

## 6. Known risks

- iCloud can evict or delay files under a workspace in iCloud Drive; mitigated by placeholder detection, but workspaces outside iCloud are more reliable.
- SyncTeX accuracy depends on the document (some packages break it).
- Safari differs slightly from Chrome in PDF.js worker loading and WebSocket reconnects. Both are handled in testing.

## 7. Where the build differs from this spec

Decided while building; each is a change to something written above.

- **History storage.** Snapshots are whole files, compressed and stored once per distinct content, instead of diffs. Thinning old versions would break a chain of diffs; whole snapshots can be dropped freely. The 2-minute interval, retention and 50 MB cap are as specified.
- **Compile folder.** The project is copied (only changed files) into a build folder in Application Support and compiled there, instead of compiling in the project with `-outdir`. BibTeX and `\include` break with an outside output folder under the read/write restrictions below.
- **Sandboxing LaTeX.** Beyond "shell escape off": `latexmkrc` files in the project are ignored, and TeX may only read and write inside the build folder (`openin_any=p`, `openout_any=p`). Without this a guest could run code or read files on the host through the document.
- **LuaLaTeX while sharing.** Refused while "Show on LAN" is on. Lua code in a document can read and write any file, and that cannot be restricted without breaking LuaLaTeX itself. It works when sharing is off.
- **EPS figures with pdfLaTeX.** These need the restricted shell escape that "always off" also disables, so they do not convert automatically. Use PDF, PNG or JPG figures.
- **`% !TEX root`.** Not implemented. The main file is the one set in the project settings (or "Set as main file" in the file tree).
- **Recompile button.** Forces a full LaTeX run even if nothing changed; auto-compile skips the run when nothing changed.
- **Moving a project to the Trash.** Tries a direct move and falls back to asking Finder, because macOS restricts direct access to the Trash folder.
- **iCloud placeholders.** Detected in the old `.name.icloud` form. Newer macOS versions download such files on first read without the app noticing, which also works.
- **Theme.** Stored per browser, not in `config.json`, so each person (host and guests) has their own.
- **Narrow screens.** Below 820 px the editor and PDF are shown one at a time with a Source/PDF switch.
- **Top bar.** The PDF and .zip downloads and network sharing are one **Share** menu. Settings has a three-way theme switch: Auto (follows the Mac), Light, Dark.
- **Compile status.** The status in the top bar toggles the Problems list. In the Editor layout (or the Source view on a narrow screen) it first brings the PDF pane into view, without changing the saved layout, and opens the list. A compile cancelled by a newer one is not shown: the last real result stays, so the error count does not blink and a list the user closed is not reopened.
- **Apps.** Two Mac apps instead of one Dock launcher, both built by `scripts/make-app.sh` (or `Build apps.command`) and both running the same server from the source folder. `LaTeX Writer.app` is a native WebKit window (Swift, `scripts/app/main.swift`, built with `swiftc`, no Xcode project), modelled on the Coding Notes app. It handles downloads, file pickers and outside links natively, and passes `--exit-with-parent` so its server stops if the app dies. While the server starts it shows a spinner and the phase in plain words, read from `launch.sh`'s output (installing, preparing the editor, starting); the log is shown only when starting fails or times out. `LaTeX Writer Web.app` is the AppleScript launcher that opens the browser. Each uses a server that is already running rather than starting a second one.
- **Release builds.** `scripts/make-app.sh --release` puts a copy of the app's files (what git tracks, minus tests and the app sources) with a `.version` stamp into `Contents/Resources/app` of both apps. On start they copy it to `~/Library/Application Support/LaTeXWriter/app` when the stamps differ, and run `launch.sh` from there; it rebuilds the interface when the stamp differs from the last build. `scripts/release.sh` builds them, makes a DMG (both apps, an Applications link, a read-me), a zip (both apps at its top), `install.sh` (a curl-to-bash installer that checks the zip against `SHA256SUMS.txt` and installs without sudo or quarantine, modelled on AudioSync's) and the checksums. It checks all of them, then tags and publishes a GitHub release. Ad-hoc signed, not notarized.
- **Connecting other AI apps.** Share › Connect an AI app… (host, inside a project) shows the MCP address, the commands for the agents found, JSON configs for URL-based and command-only clients (`npx mcp-remote`), and a prompt an agent can follow to connect itself. A status line says whether the server is on (it follows the assistant switch; off means `/mcp` answers 404) and turns it on from there. Copyable text everywhere (these snippets, the network address, the LaTeX log, the Problems list's install command, code blocks in the chat) has its copy button inside the text, which shows "Copied" for a moment. Share appears only inside a project.
- **Keeping a server running.** While either app is open it checks the server every few seconds. When the server goes away (the other app quit, or a crash) it starts a new one with `--reopen`, which opens the project that was open (stored as `openProject` in `config.json`, cleared when the user closes the project). The page reconnects by itself. The server first claims port 4173 strictly, so two apps starting one at the same moment end up with one server. A server that keeps dying is given up after a few tries.

## 7a. Windows (added after v1)

Ported from Lukas4314's fork (one commit on top of `9170913`). The code is the same on both systems. `server/platform.ts` holds every difference:
- the app's home folder: `%LOCALAPPDATA%\LaTeXWriter` on Windows;
- TeX folders: MiKTeX, and TeX Live by year;
- PATH handling with `path.delimiter`, folding Windows' `Path` spelling;
- `.exe` names for the agents;
- stopping a compile with `taskkill /T` (no process groups on Windows);
- opening a browser with `rundll32 url.dll`;
- showing a file with `explorer /select`;
- the folder and file dialogs and the Recycle Bin, through PowerShell with Windows Forms. Paths go to PowerShell in environment variables, never inside the script.

The interface takes its words from `OS` in `web/src/app.ts`, using the user agent. `scripts/windows/Start LaTeX Writer.bat` is the counterpart of `launch.sh`. `release.sh` adds `LaTeX-Writer-<version>-Windows.zip` (the tracked files without tests and the Mac app sources, with the start script at the top) to every release. There is no app on Windows, and it is untested by the maintainer.

## 8. Assistant add-on (added after v1)

Requested after the first version; not part of the original plan above.

- A collapsible right sidebar with a chat, toggled by an Assistant button; the whole feature is switched on or off in Settings.
- The chat runs the Claude Code CLI on the host's Mac in headless mode, so it uses the host's Claude subscription and needs no API key. Host only.
- The assistant works through an MCP server built into the app (`/mcp`, loopback only): project overview, read, search, edit, write, compile, PDF text, PDF page image, raw log. The same endpoint can be registered in the Claude app or Claude Code.
- Edits apply to the live document immediately. The pre-change text is kept as a backup until every change in that file is accepted or declined, then deleted. Changes can be decided one by one or all at once.
- The PDF from before the pending changes is kept alongside, for a Before / After switch in the preview.
- The changes tray: a full-width row with the number of files and changes and the lines added and removed, then Decline all and Accept all side by side. Opened, it slides up to fill the chat area (the chat folds away above it, so the message box stays put) and slides back down when closed, without animation under reduced motion. The badge on the Assistant button counts files, as the tray does; its tooltip gives both counts.
- To keep usage low the assistant gets the PDF as extracted text, and page images only on request.
- Edits the user makes by hand in a file with pending changes show up in the same review list, since "pending" is the difference between the backup and the current text.
- Efficiency pass (after measuring a real session: 3 messages became 100 requests re-reading up to 215k tokens each, with 31 page images and 19 whole-file rewrites): batch edits with automatic compile, text layout report, multi-page overview images, capped image size, PDF text search, no rewrites of long files, effort setting, compaction at 100k, conversation size shown in the sidebar. Compaction later moved between turns (`COMPACT_BEFORE` in `server/ai.ts`): when the last measured context is 60k or more, `send` first runs `/compact` on the session and then the turn, in one reply with one clock and no compaction note. Measured first in a real 21-turn session under `--autocompact 100k`: Claude Code compacts at the window minus about 33k (67-70k), 3 of 4 compactions struck mid-turn and stalled the reply about 2 minutes each (edits afterwards still worked, but the agent re-read files), and one turn grew the context by at most 18k. So turns start below 60k, as cheap per step as before, and `--autocompact 130k` (fires near 97k) stays as a safety net 37k above, twice the largest growth seen. A first version used 100k and 200k, which would have let each step re-send up to about 170k.
- Helper agents (Claude Code subagents) `reader`, `layout-checker`, `writer` and `auditor` (read-only, used by `/blind-audit`), run in the foreground so the main assistant gets their report in the same turn. Failed compiles are returned as tool errors.
- Reading beyond the open project (`server/access.ts`), always read-only. Other projects in the same parent folder need the user's permission. `request_access` blocks until the user answers a card in the sidebar (5 minutes, or Stop, counts as no), and the grant is stored per project in `.latexwriter/access.json` until revoked. Files and folders attached with the composer's + (macOS choose-file/folder dialog) belong to one chat. The chat id is passed in the MCP URL (`/mcp?chat=<id>`), so other chats and outside clients never see them. `project_info`, `read_file` and `search` take a `source`; `list_sources` and `copy_file` complete the set. `copy_file` never overwrites, routes text through review and caps a copy at 200 files.
- Pasted pictures (`ImageInput` in `server/ai.ts`). The panel sends up to 4 per message as base64 PNG, JPEG, GIF or WebP, at most 5 MB each. It redraws other types and anything larger than 2000 px or 4.5 MB first. `/api/host/ai/send` allows a 32 MB body. The server keeps each picture in the agent's folder (`<APP_HOME>/ai/<hash>/images/<id>.<ext>`), not in the project. A message part `{kind:'image', id, type}` points to it, and `GET /api/host/ai/image/:id` serves it (host only, sandboxed). Claude Code gets them as image blocks in a `--input-format stream-json` message on stdin; plain-text turns are unchanged. Codex gets `--image=<file>` before its other options. Pictures of deleted chats are removed when the chat list changes. A new session's hand-over notes that a message had pictures.
- Two agents (`server/providers.ts`, `server/ai.ts`): Claude Code and Codex, chosen in Settings. Detection looks in the usual install places every time (cheap), and reads Codex's model catalog (`codex debug models`) once per CLI found until "Search again". Codex runs as `codex exec --json` (`exec resume <thread>` to continue). Options: `--ignore-user-config`, `--ignore-rules`, `sandbox_mode="read-only"` (resume takes neither `-s` nor `-C`), `web_search="disabled"`; shell, unified exec, apps, plugins, multi-agent, browser and computer use, image generation, hooks and memories disabled. The app's MCP server goes in with `default_tools_approval_mode="approve"` (otherwise Codex's own approval step refuses every edit in headless mode) and a 600 s tool timeout. The system prompt (without the Claude-only helper agents) replaces Codex's own base instructions through `model_instructions_file`, written to the chat's private folder, and `skills.bundled.enabled`, `include_permissions_instructions`, `include_apps_instructions`, `include_collaboration_mode_instructions` and `include_environment_context` are off: measured with real turns, a one-file reply went from 62k to 31k input tokens, with the same answers and edits. Codex reports usage per reply (all steps summed, with the cached part), so the sidebar shows "Last reply read …" instead of a conversation size, and no long-conversation warning. Verified against codex-cli 0.167: `apply_patch` is still offered but refused by the read-only sandbox, and its code-mode host cannot reach the file system. A chat's session belongs to one agent: switching starts a new session that gets the recent conversation as text.
- Project boundaries. The in-app chat's id is in the MCP URL, and a call for a chat the open project does not own is refused. Outside clients get an `Mcp-Session-Id` on initialize, and a session is pinned to the project of its first call. After the user opens another project, its calls are refused until it calls `project_info` with `switch: true`, which the instructions allow only when the user agrees. Leaving a project while its assistant works is refused with code `assistant-busy`, unless the request says `force`; the page turns that into a question. Leaving stops the turn, which resumes when the assistant is next opened in that project.
- Writing skills (`server/skills/*.md`, loaded by `server/skills.ts`): `/humanize`, `/humanize-audit` (report only, no edits) and `/humanize-draft`. They share one guide grounded in StoryScope (Russell et al., COLM 2026, arXiv:2604.03136). Typing `/name` in the chat is expanded on the server, so the chat shows what the user typed and the model gets the skill's instructions. An unknown `/command` is refused. The same text is available to the model and its helpers as the `use_skill` tool, and to outside MCP clients as prompts. Claude Code's own slash commands and skills stay off. `/blind-audit` briefs the `auditor` helper with only where the material is and a neutral question (no opinions from the chat), then compares. `/compact` is not a skill but an app command (`COMMANDS` in `server/skills.ts`, handled by `Assistant.compact`): on Claude Code it resumes the session with the prompt exactly `/compact` and, for that run only, without `--disable-slash-commands` (verified with Claude Code 2.1.267: the run emits `compact_boundary` with pre and post token counts; with the flag it answers "/compact isn't available"). `codex exec` has no compact command, so for Codex the session is dropped and the next message gets the handover, which leaves out the /compact exchange.
