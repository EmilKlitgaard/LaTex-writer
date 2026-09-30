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

## 8. Assistant add-on (added after v1)

Requested after the first version; not part of the original plan above.

- A collapsible right sidebar with a chat, toggled by an Assistant button; the whole feature is switched on or off in Settings.
- The chat runs the Claude Code CLI on the host's Mac in headless mode, so it uses the host's Claude subscription and needs no API key. Host only.
- The assistant works through an MCP server built into the app (`/mcp`, loopback only): project overview, read, search, edit, write, compile, PDF text, PDF page image, raw log. The same endpoint can be registered in the Claude app or Claude Code.
- Edits apply to the live document immediately. The pre-change text is kept as a backup until every change in that file is accepted or declined, then deleted. Changes can be decided one by one or all at once.
- The PDF from before the pending changes is kept alongside, for a Before / After switch in the preview.
- To keep usage low the assistant gets the PDF as extracted text, and page images only on request.
- Edits the user makes by hand in a file with pending changes show up in the same review list, since "pending" is the difference between the backup and the current text.
