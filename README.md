# LaTeX Writer

A locally hosted, Overleaf-style LaTeX editor. It runs on your Mac, uses your MacTeX installation, and shows up in your browser. People on the same network can join with a passcode and edit with you live.

The full design is in [SPEC.md](SPEC.md).

## Start it

Two ways, same result:

- **`Start LaTeX Writer.command`** (in this folder): double-click. A Terminal window opens, the editor opens in your browser. Close the Terminal window or press Ctrl+C to stop.
- **`LaTeX Writer.app`** (in `~/Applications`): a Dock app with no Terminal window. Quit it from the Dock to stop. Click the Dock icon to bring the editor back. Rebuild it with `./scripts/make-app.sh` if you move this folder.

The first start installs dependencies and builds the interface, which takes a little while. Later starts are quick.

The address is `http://localhost:4173` (the next free port is used if that one is taken).

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
scripts/launch.sh  used by both launchers
scripts/make-app.sh  builds the Dock app
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

To add a dependency, install it in `~/Library/Application Support/LaTeXWriter/deps` and copy `package.json` and `package-lock.json` back here. Do not run `npm install` in this folder: it would replace the link with a real `node_modules` that iCloud then tries to sync.

## The assistant (optional add-on)

A chat in a right-hand sidebar, opened with the **Assistant** button. It can read and search the sources, edit them, compile, and check the PDF. Turn it off in Settings and nothing of it remains: no button, no chat, no tool endpoint.

- **No API key.** Each message runs the Claude Code CLI already installed on this Mac (`claude -p`), which is signed in with your Claude subscription. Usage counts against that plan; the sidebar shows how much of the 5-hour limit is used.
- **Changes wait for you.** An edit by the assistant goes into the document at once, and the text from before is kept as a backup in `.latexwriter/review/`. Each change is listed with Accept and Decline; the editor tints the changed lines, and the PDF pane gets a Before / After switch. Accepting keeps the change, declining puts the old text back, and when nothing is pending the backup is deleted.
- **Kept cheap.** Every step of a conversation re-sends all of it, so the tools are built to need few steps and small answers:
  - `edit_file` takes several edits in one call and compiles afterwards, returning errors with the offending source line.
  - `check_layout` reports page fill, caption positions and overfull lines as text; `view_page` shows up to 8 pages in one small overview image, and high detail only for part of a page.
  - `read_pdf_text` can search instead of returning whole pages; `write_file` refuses to rewrite long files.
  - Claude Code runs with no built-in tools except starting helpers, no skills, plugins or other MCP servers, a chosen effort level, and automatic compaction at 100k tokens. The sidebar shows the conversation size and suggests a new chat when it grows large.
- **Helper agents.** The main assistant can hand work to three helpers that start with an empty context and return a short report, so their reading and page images never enter the main conversation: `reader` (Haiku, read-only), `layout-checker` (Haiku, read-only, the only one meant to look at pages), and `writer` (Sonnet, edits). Their steps appear indented under the helper in the chat.
- **Also usable from the Claude app or a Claude Code session.** The tools are an MCP server at `http://localhost:4173/mcp`. Register it once (the command is also in Settings):

```bash
claude mcp add --transport http latexwriter http://localhost:4173/mcp
```

Code: `server/mcp.ts` (the tools), `server/review.ts` (pending changes), `server/ai.ts` (runs the CLI), `server/pdfrender.ts` (PDF to text and images), `web/src/aipanel.ts` (the sidebar).

## Security notes

- The server listens on `127.0.0.1` only. With "Show on LAN" on, it also listens on the Mac's network address, and guests must enter the passcode.
- Whoever connects from this Mac itself is the host. Guests can edit, manage files, compile and restore versions in the project that is open, and nothing else.
- LAN traffic is plain HTTP. The passcode keeps casual visitors out; it is not strong security.
- The assistant and its tool endpoint are host-only and answer on `127.0.0.1` only; requests from web pages are refused. Guests cannot use them.
- LaTeX runs without shell escape, ignores `latexmkrc` files, and may only read and write inside its build folder. LuaLaTeX is refused while sharing is on, because Lua code in a document can read and write any file.
