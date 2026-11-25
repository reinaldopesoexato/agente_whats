import AppKit
import Foundation

@MainActor
final class WhatsMenu: NSObject, NSApplicationDelegate {
    let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    let details = NSMenuItem(title: "Consultando servidor…", action: nil, keyEquivalent: "")
    let queue = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let batch = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let baseURL: URL
    var timer: Timer?

    init(port: UInt16) {
        baseURL = URL(string: "http://127.0.0.1:\(port)/")!
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem.button?.title = "WhatsIA"
        statusItem.button?.image = NSImage(systemSymbolName: "bubble.left.and.bubble.right", accessibilityDescription: nil)
        statusItem.button?.imagePosition = .imageLeading
        for item in [details, queue, batch] { menu.addItem(item) }
        menu.addItem(.separator())
        let open = NSMenuItem(title: "Abrir painel", action: #selector(openPanel), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        menu.addItem(NSMenuItem(title: "Sair", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem.menu = menu
        refresh()
        timer = Timer.scheduledTimer(timeInterval: 15, target: self, selector: #selector(refresh), userInfo: nil, repeats: true)
    }

    @objc func openPanel() { NSWorkspace.shared.open(baseURL) }

    func request(_ path: String) async throws -> Any {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.timeoutInterval = 8
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    @objc func refresh() {
        Task {
            do {
                let diagnosis = try await request("api/integration/doctor") as? [String: Any]
                let accounts = diagnosis?["accounts"] as? [[String: Any]] ?? []
                let connected = accounts.filter { $0["status"] as? String == "Conectado" }.count
                details.title = "\(connected)/\(accounts.count) contas conectadas"
                let analysis = diagnosis?["queue"] as? [String: Any]
                queue.title = "\(analysis?["pending"] as? Int ?? 0) mensagens na fila de análise"
                let job = try await request("api/history/bulk") as? [String: Any]
                let state = job?["status"] as? String ?? ""
                if ["listing", "processing"].contains(state) {
                    batch.title = "Histórico \(job?["completed"] as? Int ?? 0)/\(job?["total"] as? Int ?? 0)"
                } else {
                    batch.title = "Sem lote em andamento"
                }
            } catch {
                details.title = "Servidor indisponível"
                queue.title = ""
                batch.title = ""
            }
        }
    }
}

MainActor.assumeIsolated {
    let port = CommandLine.arguments.dropFirst().first.flatMap(UInt16.init) ?? 3030
    let app = NSApplication.shared
    let delegate = WhatsMenu(port: port)
    app.setActivationPolicy(.accessory)
    app.delegate = delegate
    app.run()
}
