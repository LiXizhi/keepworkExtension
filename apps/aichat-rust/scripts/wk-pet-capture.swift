import Cocoa
import WebKit

// Isolated packaged-origin fixture: no account, network, recordings, or real
// microphone. Mock devices belong only to the pet's nonpersistent WebView.
// Compile with:
// xcrun swiftc -parse-as-library -module-cache-path /tmp/wk-pet-module-cache \
//   scripts/wk-pet-capture.swift -o /tmp/wk-pet-capture -framework Cocoa -framework WebKit
// Exit 77 means a locked/non-console GUI session prevented visible capture.
@MainActor
final class Harness: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKURLSchemeHandler {
    var mainWindow: NSWindow!
    var petWindow: NSWindow!
    var pet: WKWebView!
    var loaded = false
    var sessionLocked = false
    var onConsole = false

    func emit(_ kind: String, _ values: [String: Any] = [:]) {
        var record = values
        record["event"] = kind
        record["mainVisible"] = mainWindow?.isVisible ?? false
        record["petVisible"] = petWindow?.isVisible ?? false
        record["petOccluded"] = !(petWindow?.occlusionState.contains(.visible) ?? false)
        if let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) { print(text); fflush(stdout) }
    }

    func fail(_ reason: String) { emit("FAIL", ["reason": reason]); exit(1) }

    func setBool(_ object: NSObject, _ name: String, _ value: Bool) {
        let selector = NSSelectorFromString(name)
        guard object.responds(to: selector) else { fail("Missing WebKit test selector: \(name)"); return }
        typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
        unsafeBitCast(object.method(for: selector), to: Setter.self)(object, selector, value)
    }

    func configuration(mock: Bool) -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(self, forURLScheme: "tauri")
        if mock {
            config.mediaTypesRequiringUserActionForPlayback = []
            setBool(config.preferences, "_setMockCaptureDevicesEnabled:", true)
            setBool(config.preferences, "_setMockCaptureDevicesPromptEnabled:", false)
            setBool(config.preferences, "_setGetUserMediaRequiresFocus:", true)
            setBool(config.preferences, "_setMediaDevicesEnabled:", true)
        }
        // No secure-scheme registration and no focus/security relaxation.
        return config
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
        let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
        sessionLocked = (session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
        onConsole = (session["kCGSessionOnConsoleKey"] as? NSNumber)?.boolValue ?? false
        mainWindow = NSWindow(contentRect: NSRect(x: 150, y: 150, width: 620, height: 420), styleMask: [.titled], backing: .buffered, defer: false)
        mainWindow.title = "Isolated hidden main"
        mainWindow.isReleasedWhenClosed = false
        let main = WKWebView(frame: mainWindow.contentView!.bounds, configuration: configuration(mock: false))
        mainWindow.contentView = main
        main.load(URLRequest(url: URL(string: "tauri://localhost/index.html")!))
        // This test never shows, focuses, or activates mainWindow.
        petWindow = NSWindow(contentRect: NSRect(x: 180, y: 180, width: 460, height: 280), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        petWindow.title = "Isolated pet capture"
        petWindow.isReleasedWhenClosed = false
        pet = WKWebView(frame: petWindow.contentView!.bounds, configuration: configuration(mock: true))
        pet.navigationDelegate = self
        petWindow.contentView = pet
        pet.load(URLRequest(url: URL(string: "tauri://localhost/pet.html")!))
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { self.fail("Native pet fixture exceeded 15 second deadline") }
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard task.request.url?.host == "localhost" else { task.didFailWithError(NSError(domain: "PetFixture", code: 1)); return }
        let html = task.request.url?.path == "/pet.html" ? """
        <!doctype html><meta charset="utf-8"><title>Pet capture fixture</title>
        <style>body{font:18px system-ui;background:#eef4ef;padding:24px}</style>
        <p>Generated test microphone. No account, cloud request, or recording.</p>
        <script>
        window.metrics={secure:isSecureContext,media:!!navigator.mediaDevices,url:location.href,origin:location.origin,phase:'idle',samples:0,nonzero:0,pcmSampleRate:16000};
        window.read=()=>JSON.stringify({...metrics,visibility:document.visibilityState});
        window.start=()=>{
            metrics.phase='pending';metrics.requestVisibility=document.visibilityState;
            navigator.mediaDevices.getUserMedia({audio:{channelCount:1}}).then(async stream=>{
                window.stream=stream;metrics.phase='resolved';metrics.resolvedVisibility=document.visibilityState;
                window.context=new AudioContext();await context.resume();
                window.source=context.createMediaStreamSource(stream);window.processor=context.createScriptProcessor(4096,1,1);window.silent=context.createGain();silent.gain.value=0;
                processor.onaudioprocess=e=>{const input=e.inputBuffer.getChannelData(0),ratio=context.sampleRate/16000;
                    for(let i=0;i<Math.floor(input.length/ratio);i++){
                        const start=Math.floor(i*ratio),end=Math.min(input.length,Math.max(start+1,Math.floor((i+1)*ratio)));let sum=0;
                        for(let p=start;p<end;p++)sum+=input[p];const value=Math.max(-1,Math.min(1,sum/(end-start)));
                        const sample=Math.trunc(value*(value<0?32768:32767));metrics.samples++;if(sample!==0)metrics.nonzero++;
                    }
                };
                source.connect(processor);processor.connect(silent);silent.connect(context.destination);
            },error=>{metrics.phase='error';metrics.error=String(error)});
        };
        window.stop=async()=>{
            if(window.processor){processor.onaudioprocess=null;processor.disconnect()};window.source?.disconnect();window.silent?.disconnect();
            for(const track of window.stream?.getTracks()||[])track.stop();await window.context?.close();
            metrics.tracksAfterStop=window.stream?.getTracks().map(t=>t.readyState);metrics.contextAfterStop=window.context?.state;
            return read();
        };
        </script>
        """ : "<!doctype html><title>Hidden main fixture</title><p>Main remains hidden.</p>"
        let data = html.data(using: .utf8)!
        task.didReceive(URLResponse(url: task.request.url!, mimeType: "text/html", expectedContentLength: data.count, textEncodingName: "utf-8"))
        task.didReceive(data)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    func evaluate(_ source: String, _ done: @escaping (Any?) -> Void) {
        pet.callAsyncJavaScript("return await eval(source)", arguments: ["source": source], in: nil, in: .page) { result in
            switch result {
            case .success(let value): done(value)
            case .failure(let error): self.fail("JavaScript: \(error)")
            }
        }
    }

    func read(_ event: String, _ done: @escaping ([String: Any]) -> Void) {
        evaluate("read()") { value in
            guard let text = value as? String, let data = text.data(using: .utf8),
                  let metrics = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { self.fail("Invalid metrics"); return }
            self.emit(event, metrics)
            guard !self.mainWindow.isVisible else { self.fail("Main window became visible"); return }
            done(metrics)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !loaded else { return }
        loaded = true
        read("packaged-origin") { metrics in
            guard metrics["secure"] as? Bool == true, metrics["media"] as? Bool == true,
                  metrics["url"] as? String == "tauri://localhost/pet.html" else { self.fail("Packaged pet scheme cannot use mediaDevices securely"); return }
            if self.sessionLocked || !self.onConsole {
                self.emit("BLOCKED", ["reason": "Unlock the console session to verify visible pet PCM and cleanup", "sessionLocked": self.sessionLocked, "onConsole": self.onConsole])
                exit(77)
            }
            self.evaluate("start();null") { _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    self.read("hidden-pet-request") { hidden in
                        guard hidden["phase"] as? String == "pending", hidden["visibility"] as? String == "hidden" else { self.fail("Hidden pet did not defer getUserMedia"); return }
                        self.petWindow.deminiaturize(nil)
                        self.petWindow.orderFront(nil)
                        NSApplication.shared.activate(ignoringOtherApps: false)
                        self.petWindow.makeKeyAndOrderFront(nil)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { self.verifyCapture() }
                    }
                }
            }
        }
    }

    func verifyCapture() {
        read("visible-pet-capture") { metrics in
            guard self.petWindow.isVisible, self.petWindow.occlusionState.contains(.visible),
                  metrics["visibility"] as? String == "visible", metrics["phase"] as? String == "resolved",
                  (metrics["samples"] as? Int ?? 0) > 0, (metrics["nonzero"] as? Int ?? 0) > 0 else { self.fail("Visible pet did not deliver nonzero 16 kHz PCM"); return }
            self.evaluate("stop()") { value in
                guard let text = value as? String, let data = text.data(using: .utf8),
                      let stopped = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                      stopped["tracksAfterStop"] as? [String] == ["ended"], stopped["contextAfterStop"] as? String == "closed" else { self.fail("Pet microphone resources were not released"); return }
                self.emit("capture-released", stopped)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    self.read("after-stop") { final in
                        guard final["samples"] as? Int == stopped["samples"] as? Int else { self.fail("PCM continued after stop"); return }
                        self.emit("PASS", ["scenarios": ["packaged secure origin", "main hidden", "pet visible nonzero PCM", "tracks and context released"]])
                        exit(0)
                    }
                }
            }
        }
    }
}

@main
struct Entry {
    @MainActor static func main() {
        let app = NSApplication.shared
        let harness = Harness()
        app.delegate = harness
        app.run()
        withExtendedLifetime(harness) {}
    }
}
