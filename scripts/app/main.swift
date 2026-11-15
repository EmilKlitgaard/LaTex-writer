// LaTeX Writer.app: a native window around the same editor the browser shows.
//
// On launch it looks for a LaTeX Writer server that is already running (for example one started
// by "LaTeX Writer Web") and uses it. Otherwise it runs scripts/launch.sh from the source folder,
// which installs and builds what is needed and starts the server, and stops that server again on
// quit. The server gets --exit-with-parent and a stdin pipe from this app, so it also stops if the
// app crashes or is force-quit.
//
// While open it keeps an eye on the server. When it goes away (the app that started it was quit,
// or it crashed), this app starts a new one with --reopen, which opens the same project again; the
// page reconnects by itself. Repeated failures stop that, so a broken setup does not loop.
//
// Nothing of the editor is copied into the app: it runs the source folder, so changes there show
// up without rebuilding. Only changes to this file need scripts/make-app.sh again.
//
// Built by scripts/make-app.sh with swiftc; no Xcode project.

import AppKit
import WebKit
import Darwin

let appName = "LaTeX Writer"
let defaultPort = 4173
let sourceDefaultsKey = "SourceFolder"     // a folder picked by hand, when the built-in one is gone

// ---------- Paths ----------

let appHome = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/LaTeXWriter")

/// A release build carries LaTeX Writer inside the app (Contents/Resources/app). It is run from a
/// copy in Application Support, since the app itself is read-only and its dependencies and build
/// go next to it. The copy is replaced when the app brings another version (.version differs).
func bundledSource() -> URL? {
    let fm = FileManager.default
    guard let inside = Bundle.main.resourceURL?.appendingPathComponent("app"),
          fm.isExecutableFile(atPath: inside.appendingPathComponent("scripts/launch.sh").path) else { return nil }
    let dest = appHome.appendingPathComponent("app")
    func version(_ u: URL) -> String? { try? String(contentsOf: u.appendingPathComponent(".version"), encoding: .utf8) }
    if version(inside) == nil || version(inside) != version(dest) {
        let staging = appHome.appendingPathComponent("app.new")
        do {
            try fm.createDirectory(at: appHome, withIntermediateDirectories: true)
            try? fm.removeItem(at: staging)
            try fm.copyItem(at: inside, to: staging)
            try? fm.removeItem(at: dest)
            try fm.moveItem(at: staging, to: dest)
        } catch {
            return nil
        }
    }
    return dest
}

/// The LaTeX Writer source folder (the one with scripts/launch.sh): the copy a release build brings,
/// else the folder this app was built from (saved into Info.plist), else one picked by hand.
func sourceFolder() -> URL? {
    if let bundled = bundledSource() { return bundled }
    let fm = FileManager.default
    var candidates: [String] = []
    if let picked = UserDefaults.standard.string(forKey: sourceDefaultsKey) { candidates.append(picked) }
    if let built = Bundle.main.object(forInfoDictionaryKey: "LWSourceFolder") as? String { candidates.append(built) }
    for c in candidates where fm.isExecutableFile(atPath: (c as NSString).appendingPathComponent("scripts/launch.sh")) {
        return URL(fileURLWithPath: c)
    }
    return nil
}

let logURL: URL = {
    let dir = appHome.appendingPathComponent("logs")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("app.log")
}()

func logText() -> String { (try? String(contentsOf: logURL, encoding: .utf8)) ?? "" }

func logTail(_ lines: Int = 15) -> String {
    logText().split(separator: "\n", omittingEmptySubsequences: false).suffix(lines).joined(separator: "\n")
}

/// Ports where a server of this app may already answer: the default and the last one it used.
func candidatePorts() -> [Int] {
    var ports = [defaultPort]
    if let data = try? Data(contentsOf: appHome.appendingPathComponent("config.json")),
       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let last = json["lastPort"] as? Int, last != defaultPort {
        ports.append(last)
    }
    return ports
}

// ---------- The server ----------

final class EditorServer {
    private(set) var process: Process?
    private var stdinPipe: Pipe?
    /// Where the editor answers, once known.
    private(set) var url: URL?
    var onUnexpectedExit: ((Int32) -> Void)?
    private var stopping = false
    /// Counts starts, so a wait that belongs to an earlier start ends quietly.
    private(set) var generation = 0

    /// Calls back with true when a LaTeX Writer server answers at url.
    static func ping(_ url: URL, done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: url.appendingPathComponent("api/ping"))
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { data, _, _ in
            let ok = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["app"] as? String == "latex-writer"
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    /// Calls back with the address of a LaTeX Writer server that already answers, or nil.
    func findRunning(_ done: @escaping (URL?) -> Void) {
        var ports = candidatePorts()
        func next() {
            guard !ports.isEmpty else { return done(nil) }
            let port = ports.removeFirst()
            var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/ping")!)
            req.timeoutInterval = 1.5
            URLSession.shared.dataTask(with: req) { data, _, _ in
                DispatchQueue.main.async {
                    if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       json["app"] as? String == "latex-writer" {
                        return done(URL(string: "http://localhost:\(port)/"))
                    }
                    next()
                }
            }.resume()
        }
        next()
    }

    func start(source: URL, reopen: Bool) throws {
        stopping = false
        url = nil
        generation += 1
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let log = try FileHandle(forWritingTo: logURL)

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [source.appendingPathComponent("scripts/launch.sh").path, "--no-open", "--exit-with-parent"] + (reopen ? ["--reopen"] : [])
        p.currentDirectoryURL = source
        var env = ProcessInfo.processInfo.environment
        // Finder gives apps a minimal PATH; launch.sh finds Node and TeX from here.
        env["PATH"] = ["/opt/homebrew/bin", "/usr/local/bin", "/Library/TeX/texbin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
                       env["PATH"] ?? ""].joined(separator: ":")
        env["LATEXWRITER_NO_OPEN"] = "1"
        p.environment = env
        let pipe = Pipe()                      // closes when this app dies -> the server exits
        p.standardInput = pipe
        p.standardOutput = log
        p.standardError = log
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, !self.stopping, self.process === proc else { return }
                self.process = nil
                // Another app's server was there first: that is not a failure, the monitor uses it.
                if logText().contains("already running on") { return }
                self.onUnexpectedExit?(proc.terminationStatus)
            }
        }
        try p.run()
        process = p
        stdinPipe = pipe
    }

    /// Waits until the server prints where it runs. The first start installs and builds, which takes a while.
    func waitUntilReady(timeout: TimeInterval = 600, progress: @escaping (String) -> Void, done: @escaping (URL?) -> Void) {
        let deadline = Date().addingTimeInterval(timeout)
        let gen = generation
        let pattern = try! NSRegularExpression(pattern: "(?:is running on|already running on) (http://[^\\s]+)")
        func attempt() {
            guard gen == generation else { return }
            let text = logText()
            if let m = pattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
               let r = Range(m.range(at: 1), in: text), let found = URL(string: String(text[r]) + "/") {
                url = found
                return done(found)
            }
            guard process?.isRunning == true else { return done(nil) }
            if Date() > deadline { return done(nil) }
            progress(logTail(6))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: attempt)
        }
        attempt()
    }

    func stop() {
        stopping = true
        guard let p = process else { return }
        process = nil
        try? stdinPipe?.fileHandleForWriting.close()
        stdinPipe = nil
        if p.isRunning {
            p.terminate()                                   // SIGTERM: the server saves open files first
            let deadline = Date().addingTimeInterval(5)
            while p.isRunning && Date() < deadline { usleep(20_000) }
            if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        }
    }
}

// ---------- The window ----------

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    let server = EditorServer()
    var baseURL: URL?
    /// Getting a server back after the one in use went away.
    var recovering = false
    var failedPings = 0
    var recoveries: [Date] = []
    var gaveUp = false
    var monitor: Timer?

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        buildWindow()
        server.onUnexpectedExit = { [weak self] status in self?.serverDied(status) }
        connect()
        monitor = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.checkServer() }
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Every two seconds: does the server still answer? Two misses in a row and a new one is started.
    func checkServer() {
        guard let base = baseURL, !recovering, !gaveUp else { return }
        EditorServer.ping(base) { [weak self] ok in
            guard let self, !self.recovering else { return }
            self.failedPings = ok ? 0 : self.failedPings + 1
            if self.failedPings >= 2 { self.recover() }
        }
    }

    /// The server in use is gone: use one another app started meanwhile, or start one.
    func recover() {
        guard !recovering, !gaveUp else { return }
        recoveries = recoveries.filter { $0.timeIntervalSinceNow > -90 } + [Date()]
        if recoveries.count > 3 {
            gaveUp = true
            window.subtitle = ""
            return showMessage("LaTeX Writer keeps stopping",
                               detail: logTail() + "\n\nUse View › Restart Server (⇧⌘R) to try again.")
        }
        recovering = true
        failedPings = 0
        window.subtitle = "Reconnecting…"
        server.findRunning { [weak self] running in
            guard let self else { return }
            if let running { return self.recovered(running) }
            self.startServer(reopen: true)
        }
    }

    /// A server answers again. The page reconnects by itself; it is only loaded again if needed.
    func recovered(_ url: URL) {
        recovering = false
        failedPings = 0
        window.subtitle = ""
        if url != baseURL || !isEditor(webView.url) { open(url) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ note: Notification) {
        monitor?.invalidate()
        server.stop()
    }

    func buildWindow() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()               // keeps layout and settings between launches
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")   // right-click > Inspect Element
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = true
        if #available(macOS 13.3, *) { webView.isInspectable = true }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = appName
        window.minSize = NSSize(width: 520, height: 400)
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("MainWindow")
        window.tabbingMode = .disallowed
        window.makeKeyAndOrderFront(nil)
        showMessage("Starting LaTeX Writer…", detail: "")
    }

    /// Uses a server that already runs, or starts one.
    func connect(reopen: Bool = false) {
        server.findRunning { [weak self] running in
            guard let self else { return }
            if let running { return self.open(running) }
            self.startServer(reopen: reopen)
        }
    }

    func open(_ url: URL) {
        baseURL = url
        webView.load(URLRequest(url: url))
    }

    /// reopen: started again after the server in use went away, so the editor stays on screen.
    func startServer(reopen: Bool) {
        guard let source = sourceFolder() else {
            recovering = false
            return askForFolder()
        }
        do { try server.start(source: source, reopen: reopen) } catch {
            recovering = false
            return showMessage("LaTeX Writer could not start", detail: error.localizedDescription)
        }
        var lastShown = ""
        server.waitUntilReady(progress: { [weak self] tail in
            // The first start installs dependencies and builds the interface: show how it goes.
            guard let self, !self.recovering, tail != lastShown, !tail.isEmpty else { return }
            lastShown = tail
            self.showMessage("Starting LaTeX Writer…", detail: tail)
        }, done: { [weak self] url in
            guard let self else { return }
            if let url {
                if self.recovering { self.recovered(url) } else { self.open(url) }
            } else if self.server.process?.isRunning == true {
                self.recovering = false
                self.showMessage("LaTeX Writer did not start in time", detail: logTail())
            }
            // if it exited, serverDied takes it from there
        })
    }

    func restartServer() {
        gaveUp = false
        recovering = false
        recoveries = []
        window.subtitle = ""
        server.stop()
        showMessage("Restarting LaTeX Writer…", detail: "")
        connect(reopen: true)
    }

    /// The server this app started stopped by itself: start it again (within limits).
    func serverDied(_ status: Int32) {
        recovering = false
        if baseURL == nil {
            // It never got going: show why rather than trying again and again.
            return showMessage("LaTeX Writer stopped (exit code \(status))",
                               detail: logTail() + "\n\nUse View › Restart Server (⇧⌘R) to start it again.")
        }
        recover()
    }

    func askForFolder() {
        let panel = NSOpenPanel()
        panel.message = "Choose the LaTeX Writer source folder (the one that contains scripts/launch.sh)."
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { [weak self] resp in
            guard let self else { return }
            guard resp == .OK, let url = panel.url else {
                return self.showMessage("No source folder", detail: "Use File › Choose Source Folder… to pick it.")
            }
            if FileManager.default.isExecutableFile(atPath: url.appendingPathComponent("scripts/launch.sh").path) {
                UserDefaults.standard.set(url.path, forKey: sourceDefaultsKey)
                self.restartServer()
            } else {
                self.showMessage("That folder has no scripts/launch.sh", detail: url.path)
            }
        }
    }

    /// A plain status page in the editor's colours, for "starting" and error states.
    func showMessage(_ title: String, detail: String) {
        func esc(_ s: String) -> String {
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        }
        let html = """
        <!doctype html><meta charset="utf-8"><style>
        :root { color-scheme: light dark; --bg:#f7f8f7; --text:#1d2420; --muted:#5d6762; --code:#eceeed; }
        @media (prefers-color-scheme: dark) { :root { --bg:#16191a; --text:#e3e7e5; --muted:#9aa4a0; --code:#212628; } }
        body { margin:0; height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
               font: 14px -apple-system, BlinkMacSystemFont, sans-serif; }
        .box { max-width: 760px; padding: 24px; text-align:center; }
        h1 { font-size: 18px; font-weight: 600; }
        pre { text-align:left; white-space:pre-wrap; background:var(--code); color:var(--muted); padding:12px; border-radius:8px; font-size:12px; }
        </style><div class="box"><h1>\(esc(title))</h1>\(detail.isEmpty ? "" : "<pre>\(esc(detail))</pre>")</div>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func isEditor(_ url: URL?) -> Bool {
        guard let url, let base = baseURL else { return false }
        return ["localhost", "127.0.0.1"].contains(url.host ?? "") && url.port == base.port
    }

    // ---------- Navigation, downloads, file pickers ----------

    // Links that leave the editor open in the default browser; downloads are saved to Downloads.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { return decisionHandler(.download) }
        if let url = action.request.url, let scheme = url.scheme, ["http", "https", "mailto"].contains(scheme), !isEditor(url) {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if disposition.lowercased().hasPrefix("attachment") || !response.canShowMIMEType { return decisionHandler(.download) }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let fm = FileManager.default
        let dir = fm.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? fm.homeDirectoryForCurrentUser
        let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
        let ext = (name as NSString).pathExtension
        let stem = (name as NSString).deletingPathExtension
        var dest = dir.appendingPathComponent(name)
        var n = 2
        while fm.fileExists(atPath: dest.path) {
            dest = dir.appendingPathComponent(ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)")
            n += 1
        }
        downloads[ObjectIdentifier(download)] = dest
        completionHandler(dest)
    }

    var downloads: [ObjectIdentifier: URL] = [:]

    func downloadDidFinish(_ download: WKDownload) {
        if let dest = downloads.removeValue(forKey: ObjectIdentifier(download)) {
            NSWorkspace.shared.activateFileViewerSelecting([dest])
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        let alert = NSAlert()
        alert.messageText = "The download failed"
        alert.informativeText = error.localizedDescription
        alert.beginSheetModal(for: window)
    }

    // target=_blank: the editor's PDF and chat links point outside, so they open in the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // <input type="file">: uploading files into a project.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { resp in completionHandler(resp == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { resp in completionHandler(resp == .alertFirstButtonReturn) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { reload(nil) }

    // ---------- Menu ----------

    @objc func reload(_ sender: Any?) {
        if isEditor(webView.url) { webView.reload() } else if let base = baseURL { webView.load(URLRequest(url: base)) }
    }
    @objc func restart(_ sender: Any?) { restartServer() }
    @objc func openInBrowser(_ sender: Any?) {
        if let url = isEditor(webView.url) ? webView.url : baseURL { NSWorkspace.shared.open(url) }
    }
    @objc func chooseFolder(_ sender: Any?) { askForFolder() }
    @objc func revealSource(_ sender: Any?) { if let s = sourceFolder() { NSWorkspace.shared.activateFileViewerSelecting([s]) } }
    @objc func showLog(_ sender: Any?) { NSWorkspace.shared.open(logURL) }
    @objc func zoomIn(_ sender: Any?) { webView.pageZoom = min(webView.pageZoom + 0.1, 3) }
    @objc func zoomOut(_ sender: Any?) { webView.pageZoom = max(webView.pageZoom - 0.1, 0.5) }
    @objc func zoomReset(_ sender: Any?) { webView.pageZoom = 1 }

    func buildMenu() {
        let main = NSMenu()
        func item(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }
        func submenu(_ title: String, _ items: [NSMenuItem]) {
            let m = NSMenu(title: title); items.forEach(m.addItem)
            let top = NSMenuItem(); top.submenu = m; main.addItem(top)
        }
        submenu(appName, [
            item("About \(appName)", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            .separator(),
            item("Hide \(appName)", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
            .separator(),
            item("Quit \(appName)", #selector(NSApplication.terminate(_:)), "q"),
        ])
        // ⌘S, ⌘B and the like are left to the page, so its own shortcuts keep working.
        submenu("File", [
            item("Open in Browser", #selector(openInBrowser(_:)), "o", [.command, .shift]),
            item("Show Source Folder in Finder", #selector(revealSource(_:)), ""),
            item("Choose Source Folder…", #selector(chooseFolder(_:)), ""),
            .separator(),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        // The editor (CodeMirror) handles undo itself; these send the keys on to the page.
        submenu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        submenu("View", [
            item("Reload", #selector(reload(_:)), "r", [.command, .option]),
            item("Restart Server", #selector(restart(_:)), "r", [.command, .shift]),
            item("Server Log", #selector(showLog(_:)), ""),
            .separator(),
            item("Actual Size", #selector(zoomReset(_:)), "0"),
            item("Zoom In", #selector(zoomIn(_:)), "+"),
            item("Zoom Out", #selector(zoomOut(_:)), "-"),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"))
        windowMenu.addItem(item("Zoom", #selector(NSWindow.performZoom(_:)), ""))
        let top = NSMenuItem(); top.submenu = windowMenu; main.addItem(top)
        NSApp.windowsMenu = windowMenu
        NSApp.mainMenu = main
    }
}

// A signal (e.g. `kill`) still stops the server before the app goes.
for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig) { _ in
        if let d = NSApp.delegate as? AppDelegate { d.server.stop() }
        exit(0)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
