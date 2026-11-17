import AppKit
import WebKit
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var status: NSStatusItem!
    var window: NSWindow!
    var web: WKWebView!
    var backend: Process?
    var localURL: URL?
    var output = Data()
    var previousCount = 0
    func applicationDidFinishLaunching(_ notification: Notification) {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.image = NSImage(systemSymbolName: "point.3.connected.trianglepath.dotted", accessibilityDescription: "Argos Personal")
        let menu = NSMenu()
        menu.addItem(withTitle: "Open Argos Personal", action: #selector(show), keyEquivalent: "o").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Argos Personal", action: #selector(quit), keyEquivalent: "q").target = self
        status.menu = menu
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "argos")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1040, height: 740), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Argos Personal"
        window.minSize = NSSize(width: 760, height: 560)
        window.contentView = web
        window.isReleasedWhenClosed = false
        window.center()
        web.loadHTMLString("<html><body style='font:16px -apple-system;padding:60px;color:#59616d'>Opening your personal connector…</body></html>", baseURL: nil)
        show()
        startBackend()
    }
    func startBackend() {
        guard let root = Bundle.main.resourceURL else { return }
        let process = Process()
        process.executableURL = root.appendingPathComponent("runtime/node")
        process.arguments = [root.appendingPathComponent("app/dist/local/main.js").path]
        process.currentDirectoryURL = root.appendingPathComponent("app")
        var env = ProcessInfo.processInfo.environment
        env["ARGOS_DESKTOP"] = "1"
        process.environment = env
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.output.append(data)
                if let lineEnd = self.output.firstIndex(of: 10) {
                    let line = self.output.prefix(upTo: lineEnd)
                    self.output.removeSubrange(...lineEnd)
                    if let payload = try? JSONSerialization.jsonObject(with: line) as? [String:String], let text = payload["url"], let url = URL(string: text), url.host == "localhost", url.port == 4217 {
                        self.localURL = url
                        self.web.load(URLRequest(url: url))
                    }
                }
            }
        }
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.status.button?.title = " Offline"
                self?.web.loadHTMLString("<html><body style='font:16px -apple-system;padding:60px'><h2>Connector stopped</h2><p>Unlock your keychain and reopen Argos. Close any other running copy first.</p><p>No actions are executed while the connector is stopped.</p></body></html>", baseURL: nil)
            }
        }
        do { try process.run(); backend = process } catch {
            web.loadHTMLString("<html><body style='font:16px -apple-system;padding:60px'>Argos could not start its local runtime. Rebuild the application for this Mac.</body></html>", baseURL: nil)
        }
    }
    @objc func show() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func quit() { NSApp.terminate(nil) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) { backend?.terminate() }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == "localhost", message.frameInfo.securityOrigin.port == 4217,
              let data = message.body as? [String:Any], let kind = data["type"] as? String else { return }
        if kind == "open", let text = data["url"] as? String, let url = URL(string: text), ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        if kind == "notifications" { UNUserNotificationCenter.current().requestAuthorization(options: [.alert,.sound]) { _,_ in } }
        if kind == "count", let count = data["count"] as? Int {
            status.button?.title = count > 0 ? " \(count)" : ""
            if count > previousCount {
                let content = UNMutableNotificationContent()
                content.title = "Argos needs your approval"
                content.body = "Open Argos Personal to review the exact action."
                UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
            }
            previousCount = count
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" || (url.scheme == "http" && url.host == "localhost" && url.port == 4217) { decisionHandler(.allow) }
        else { if ["https","http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; decisionHandler(.cancel) }
    }
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
