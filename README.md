<p align="center">
  <img src="web/public/favicon.svg" width="128" height="128" alt="LaTeX Writer icon">
</p>

<h1 align="center">LaTeX Writer</h1>

<p align="center">
  A local, Overleaf-style LaTeX editor with live PDF preview, collaboration on your network and an optional AI assistant.
  <br>
  <a href="https://github.com/EmilKlitgaard/LaTex-writer/releases/latest"><strong>Download for Mac or Windows</strong></a>
</p>

A locally hosted, Overleaf-style LaTeX editor. It runs on your Mac, uses your MacTeX installation, and opens in its own window or your browser. People on the same network can join with a passcode and edit with you live. It also runs on Windows ([see below](#windows)).

The full design is in [SPEC.md](SPEC.md).

## Install (without the source code)

Download it from the [latest release](https://github.com/EmilKlitgaard/LaTex-writer/releases/latest). The quickest way is one line in Terminal. It checks the download against the release's checksums, installs both apps (into /Applications, or ~/Applications without admin rights), and needs no "Open Anyway" step:

```bash
curl -fsSL https://github.com/EmilKlitgaard/LaTex-writer/releases/latest/download/install.sh | bash
```

Or download the `.dmg`, drag both apps to Applications, and open LaTeX Writer. The apps are not notarized (that needs a paid Apple Developer account), so macOS blocks the first start: open System Settings › Privacy & Security, click **Open Anyway** next to LaTeX Writer, and confirm. This is needed once per app.

You need macOS 12 or later, [Node.js](https://nodejs.org) 24 or newer and [MacTeX](https://tug.org/mactex). The first start downloads what LaTeX Writer needs, which takes a minute or two.

### Windows

The same release has **LaTeX-Writer-<version>-Windows.zip**. Unzip it and double-click **Start LaTeX Writer.bat**. The editor opens in your browser (there is no app on Windows), and closing the black window stops it. You need [Node.js](https://nodejs.org) 24 or newer and [MiKTeX](https://miktex.org) or TeX Live. From a clone of this repository, run `scripts\windows\Start LaTeX Writer.bat`.

Windows support started from [Lukas4314's port](https://github.com/Lukas4314/LaTex-writer). It is the same code: everything that differs between macOS and Windows sits in `server/platform.ts` (folder and file dialogs, the Recycle Bin, opening a browser, TeX and agent paths, stopping a compile). The interface's words for the computer are in `OS` in `web/src/app.ts`. The Mac is where it is built and tested; Windows is untested by the maintainer, so fixes are welcome. To bring in someone's Windows changes, compare their fork with the commit it started from and port the difference into `server/platform.ts`:

```bash
git remote add lukas https://github.com/Lukas4314/LaTex-writer.git
```

```bash
git fetch lukas && git diff $(git merge-base main lukas/main) lukas/main
```

The assistant needs Claude Code or Codex installed as a real `.exe` (their own Windows installers): an npm-installed `.cmd` wrapper is not found. Not on Windows: the Mac apps, iCloud downloads, and the macOS folder-permission hints.

## Start it (from this folder)

Three ways, all running the same server, so projects, settings and chats are shared:

- **`LaTeX Writer.app`** (in `~/Applications`): its own Mac window, no browser. It starts the server, or uses one that already runs. While it starts, it shows a spinner and what it is doing (installing what it needs, preparing the editor); the log only appears if starting fails. Quitting it stops the server it started, and the server also stops if the app crashes. File › Open in Browser (⇧⌘O) shows the same editor in your browser.
- **`LaTeX Writer Web.app`** (in `~/Applications`): the editor in your browser, with no Terminal window. Quit it from the Dock to stop. Click the Dock icon to bring the editor back.
- **`Start LaTeX Writer.command`** (in this folder): double-click. A Terminal window opens and the editor opens in your browser. Close the Terminal window or press Ctrl+C to stop.

While either app is open it keeps a server running. If the server it uses goes away, for example because you quit the other app or it crashed, it starts a new one within a few seconds. That server opens the same project again, and the editor reconnects by itself; anything typed while it was disconnected may be lost, as the banner says. A server that keeps stopping is given up after a few tries, with its log shown. The Terminal way (`Start LaTeX Writer.command`) does not do this.

Build or rebuild both apps by double-clicking **`Build apps.command`** (or `./scripts/make-app.sh`, optionally with a target folder). Do it again after moving this folder or changing `scripts/app/main.swift`. Changes to the editor itself need no rebuild. The native app needs the Xcode Command Line Tools (`xcode-select --install`); without them only LaTeX Writer Web is built.

These apps run this folder. The apps in a release are built with `--release` instead and carry their own copy of LaTeX Writer (see Releasing below).

The first start installs dependencies and builds the interface, which takes a little while. Later starts are quick.

The address is `http://localhost:4173` (the next free port is used if another program has that one).

The compile status in the top bar (the error count, or the time of a clean compile) shows and hides the Problems list under the PDF. In the Editor layout it switches to Split first and opens the list, since the list lives in the PDF pane.

**Share** in the top bar (inside a project) saves the PDF to Downloads (on a guest's device: downloads it), downloads the project as a .zip, opens **Share on your network…**, and **Connect an AI app…** (see the assistant below). The theme is a three-way switch in Settings: **Auto** follows the Mac's light or dark appearance, or choose **Light** or **Dark**.

## Requirements

- macOS with [MacTeX](https://tug.org/mactex) (for `latexmk`, `pdflatex`, `xelatex`, `synctex`)
- Node.js 24 or newer

## How it is organised

```
server/            the local server (TypeScript, run directly by Node)
  index.ts         HTTP routes, websockets, LAN listeners, startup
  project.ts       the open project: files, trash, watcher, auto-compile, snapshots
  docs.ts          live documents (Yjs) and saving to disk
  compile.ts       latexmk runs in a build folder, SyncTeX
  logparser.ts     turns the LaTeX log into errors and warnings with file and line
  history.ts       version snapshots and retention
  auth.ts          host/guest, passcode, sessions, lockout
  workspace.ts     folder picker, project list, templates, move to Trash
web/               the browser interface (TypeScript, bundled by Vite)
test/              unit tests and an end-to-end test of the server
scripts/launch.sh  used by all three ways of starting
scripts/make-app.sh  builds LaTeX Writer.app and LaTeX Writer Web.app
scripts/app/         the native app (main.swift: a WebKit window around the server)
```

Nothing heavy lives in this (iCloud) folder. Dependencies, the built interface, settings, logs and LaTeX build files are in `~/Library/Application Support/LaTeXWriter/`. `node_modules` here is only a link to that place.

A project is an ordinary folder: your `.tex` files, `main.pdf` next to the main file, and a hidden `.latexwriter/` folder with the project settings, version history and deleted files.

## Development

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run build
```

Start the server without opening a browser:

```bash
node server/index.ts --no-open
```

Other flags: `--reopen` opens the project that was open last (the apps use it when they start a server again), and `--exit-with-parent` stops the server when its stdin closes (the native app passes a pipe). `LATEXWRITER_HOME` and `LATEXWRITER_PORT` move the data folder and the port, for trying things without touching your own setup:

```bash
LATEXWRITER_HOME=/tmp/lw-try LATEXWRITER_PORT=4400 node server/index.ts --no-open
```

To add a dependency, install it in `~/Library/Application Support/LaTeXWriter/deps` and copy `package.json` and `package-lock.json` back here. Do not run `npm install` in this folder: it would replace the link with a real `node_modules` that iCloud then tries to sync.

## The assistant (optional add-on)

A chat in a right-hand sidebar, opened with the **Assistant** button. It can read and search the sources, edit them, compile, and check the PDF. Turn it off in Settings and nothing of it remains: no button, no chat, no tool endpoint.

- **Claude Code or Codex, no API key.** Each message runs a coding agent already installed and signed in on this Mac: Claude Code (`claude -p`, your Claude subscription) or Codex (`codex exec`, your ChatGPT plan). Choose it in Settings › Assistant › **Runs on**. The list shows what was found on this Mac, and **Search again** looks again after you install one. Codex is found on the PATH, inside the ChatGPT or Codex app, or inside the ChatGPT extension for VS Code. The model menu under the message box lists the chosen agent's models (Codex's come from its own catalog), and each agent remembers its own model. Switching mid-chat keeps the chat: the other agent starts a new session and is told the conversation so far. With Claude Code the sidebar also shows how much of the 5-hour limit is used.
- **Only this app's tools, whichever agent.** Claude Code runs with no built-in tools except starting helpers. Codex runs with its shell, web search, apps, plugins and your own Codex config and rules switched off, and in a read-only sandbox in an empty folder, so it too can only act through this app's tools. This app's tools need no approval in Codex, since every edit already waits for your review here.
- **One project at a time.** The assistant works in the project that is open. Leaving that project while it works (going back to the projects, or opening or creating another, from any window) asks first. Leaving stops it, but what it changed stays in the list for your review, and it picks the request up again the next time you open the assistant in that project. A tool call that still arrives for the old project is refused, and a Claude or Codex session outside the app stays with the project it started on. If you open another project, its next call stops and says so; it only moves to the new project when you tell it to.
- **Changes wait for you.** An edit by the assistant goes into the document at once, and the text from before is kept as a backup in `.latexwriter/review/`. Each change is listed with Accept and Decline; the editor tints the changed lines, and the PDF pane gets a Before / After switch. Accepting keeps the change, declining puts the old text back, and when nothing is pending the backup is deleted. The tray above the message box says how many files and changes are waiting, with Decline all and Accept all; click it to slide the list up over the whole chat, and again to slide it back. The number on the Assistant button is the same count of files.
- **Kept cheap.** Every step of a conversation re-sends all of it, so the tools are built to need few steps and small answers:
  - `edit_file` takes several edits in one call and compiles afterwards, returning errors with the offending source line.
  - `check_layout` reports page fill, caption positions and overfull lines as text; `view_page` shows up to 8 pages in one small overview image, and high detail only for part of a page.
  - `read_pdf_text` can search instead of returning whole pages; `write_file` refuses to rewrite long files.
  - Claude Code runs with no built-in tools except starting helpers, no skills, plugins or other MCP servers, a chosen effort level, and automatic compaction at 100k tokens. The sidebar shows the conversation size and suggests a new chat when it grows large.
  - Codex runs with this app's instructions in place of its own (which are written for a coding agent with a shell), and without its skills list and its permission, collaboration and environment notes. That halves what each step sends: a reply that reads one file went from about 62k to 31k tokens. Codex only reports what a whole reply read (every step added up, most of it from cache), so the sidebar shows exactly that: "Last reply read 31k tokens (19k from cache)".
- **Helper agents.** The main assistant can hand work to three helpers that start with an empty context and return a short report, so their reading and page images never enter the main conversation: `reader` (Haiku, read-only), `layout-checker` (Haiku, read-only, the only one meant to look at pages), and `writer` (Sonnet, edits). Their steps appear indented under the helper in the chat.
- **Writing skills.** Type `/` in the chat for task recipes the assistant follows. They are Markdown files in `server/skills/`; add a file there to add a command.
  - `/humanize [what]` rewrites text so it reads as written by a person.
  - `/humanize-audit [what]` reports where text reads as AI-written, with quotes, line numbers and the fixes that matter most, without changing anything.
  - `/humanize-draft <what, where>` writes new text with those choices made from the start.

  With no target they work on the selection, else the section at the cursor. All three rest on one guide (`server/skills/humanize-guide.md`) built from StoryScope (Russell et al., COLM 2026). That paper found that AI text gives itself away mostly through structure and meaning, not wording: it over-explains its themes, conveys emotion through the body, tells one tidy linear thread, and stays vague about the outside world. The guide adapts those findings to non-fiction too. The assistant also loads a skill by itself (`use_skill`) when you ask for the same thing in your own words, and MCP clients see the skills as prompts.
- **Other projects, with your permission.** On its own the assistant only sees the open project. When a task needs another project in the same folder ("set up exercise 2 like exercise 1"), it asks first: a card in the sidebar says which project and why, with **Allow for this project** and **Don't allow**. Access is read-only. The assistant can list, read and search that project and copy files from it with `copy_file`. Copies never overwrite, copied text files wait for review, and images are copied as they are. The permission belongs to the open project (`.latexwriter/access.json`) and shows as a chip under the message box; click its × to take it back.
- **Attach files and folders.** The **+** in the message box opens a Finder dialog to add files or folders from anywhere on the Mac. The assistant may read them, read-only, in that chat only (each chip has a × to remove it). Helper agents can read what the main assistant may read, but only the main assistant can ask for access.
- **Paste pictures.** Paste a screenshot or an image (⌘V) into the message box, or drop image files on it, and it goes with your message: up to 4 per message, shown as thumbnails you can remove before sending. Both Claude Code and Codex see them. Large pictures are scaled down to at most 2000 px before sending, and click a sent picture to see it full size. When the clipboard holds text as well (copying from Word or Pages), the text is pasted.
- **Usable from any AI app that speaks MCP.** The tools are an MCP server at `http://localhost:4173/mcp` (streamable HTTP, no sign-in, only on this Mac, only while LaTeX Writer runs). **Share › Connect an AI app…** shows everything needed to connect one: the one-line commands for the agents found on this Mac, the address, a config for apps that take a URL (Cursor, VS Code, Windsurf, …), one for apps that can only start a local command (through `npx mcp-remote`), and a prompt to paste into any agent that can set itself up. The server is on while the AI assistant is on (Settings › Assistant); the dialog says when it is off and can turn it on. For example:

```bash
claude mcp add --transport http latexwriter http://localhost:4173/mcp
```

```bash
codex mcp add latexwriter --url http://localhost:4173/mcp
```

Code: `server/mcp.ts` (the tools), `server/access.ts` (other projects and attachments), `server/skills.ts` and `server/skills/` (the writing skills), `server/review.ts` (pending changes), `server/ai.ts` (runs the agent), `server/providers.ts` (finds Claude Code and Codex, and their models), `server/pdfrender.ts` (PDF to text and images), `web/src/aipanel.ts` (the sidebar).

## Releasing

A release puts the apps on GitHub for people who do not want the source code:

```bash
scripts/release.sh --dry-run
```

```bash
scripts/release.sh
```

The dry run builds everything and checks it: both apps in the DMG and the zip, valid signatures, and matching checksums. The second command does the same from a clean, pushed `main`, then tags `v<version>` (the version from `package.json`; raise it in `package.json` and `package-lock.json` first) and publishes the release with the DMG, the zip, the Windows zip, `install.sh` and `SHA256SUMS.txt`. The release apps carry a copy of LaTeX Writer (the files git tracks, without tests) inside them. On the first start, and after an update, that copy goes to `~/Library/Application Support/LaTeXWriter/app`, where `launch.sh` installs the dependencies and builds the interface, as it does for this folder.

## Security notes

- The server listens on `127.0.0.1` only. With "Show on LAN" on, it also listens on the Mac's network address, and guests must enter the passcode.
- Whoever connects from this Mac itself is the host. Guests can edit, manage files, compile and restore versions in the project that is open, and nothing else.
- The assistant reads outside the open project only what you allow: another project after you answer its request (read-only, until you remove it), and files you attach to a chat (read-only, that chat only). It writes only to the open project.
- LAN traffic is plain HTTP. The passcode keeps casual visitors out; it is not strong security.
- The assistant and its tool endpoint are host-only and answer on `127.0.0.1` only; requests from web pages are refused. Guests cannot use them.
- LaTeX runs without shell escape, ignores `latexmkrc` files, and may only read and write inside its build folder. LuaLaTeX is refused while sharing is on, because Lua code in a document can read and write any file.
