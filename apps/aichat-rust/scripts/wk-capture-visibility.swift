import Cocoa
import WebKit
import ObjectiveC

// Standalone, nonpersistent WebKit fixture. Never loads an account or cloud
// service. Mock devices are confined to this WKWebView configuration; the
// getUserMedia focus/visibility protection stays explicitly enabled.
@MainActor
final class Harness: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var overlay: NSWindow?
    var records: [[String: Any]] = []
    var failure: String?
    var phase = 0

    func setBool(_ object: NSObject, _ selectorName: String, _ value: Bool) {
        let selector = NSSelectorFromString(selectorName)
        guard object.responds(to: selector) else { fail("Missing WebKit test selector: \(selectorName)"); return }
        typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
        let call = unsafeBitCast(object.method(for: selector), to: Setter.self)
        call(object, selector, value)
    }

    func emit(_ kind: String, _ extra: [String: Any] = [:]) {
        var record = extra
        record["event"] = kind
        record["nativeVisible"] = window?.isVisible ?? false
        record["nativeOccluded"] = !(window?.occlusionState.contains(.visible) ?? false)
        records.append(record)
        if let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) { print(text); fflush(stdout) }
    }

    func fail(_ reason: String) {
        guard failure == nil else { return }
        failure = reason
        emit("FAIL", ["reason": reason])
        shutdown()
    }

    func shutdown() {
        // Cocoa window teardown can enter a nested event loop. Tracks/context
        // were already released; process exit removes only these test windows.
        fflush(stdout)
        exit(failure == nil ? 0 : 1)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.mediaTypesRequiringUserActionForPlayback = []
        setBool(config.preferences, "_setMockCaptureDevicesEnabled:", true)
        setBool(config.preferences, "_setMockCaptureDevicesPromptEnabled:", false)
        setBool(config.preferences, "_setGetUserMediaRequiresFocus:", true)
        setBool(config.preferences, "_setMediaDevicesEnabled:", true)
        guard failure == nil else { return }
        window = NSWindow(contentRect: NSRect(x: 150, y: 150, width: 620, height: 420), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Isolated WebKit capture test"
        window.isReleasedWhenClosed = false
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 620, height: 420), configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        window.contentView = web
        let html = """
        <!doctype html><meta charset="utf-8"><title>Capture visibility fixture</title>
        <style>body{font:18px system-ui;background:#eef4ef;padding:24px}</style>
        <h1>Isolated WebKit audio test</h1><p>Generated test microphone only. No account, recordings, or cloud requests.</p>
        <script>
        window.metrics = {phase:'idle',visibility:document.visibilityState,visibilities:[],samples:0,nonzero:0,tracks:[]};
        document.addEventListener('visibilitychange',()=>metrics.visibilities.push(document.visibilityState));
        window.startCapture = () => {
            metrics.phase='pending'; metrics.requestVisibility=document.visibilityState;
            navigator.mediaDevices.getUserMedia({audio:{channelCount:1}}).then(async stream=>{
                window.stream=stream; metrics.phase='resolved'; metrics.resolvedVisibility=document.visibilityState;
                metrics.tracks=stream.getTracks().map(t=>({state:t.readyState,label:t.label}));
                const context=new AudioContext(); window.context=context; await context.resume();
                const source=context.createMediaStreamSource(stream), processor=context.createScriptProcessor(4096,1,1), silent=context.createGain();
                window.source=source; window.processor=processor; window.silent=silent; silent.gain.value=0;
                processor.onaudioprocess=e=>{const a=e.inputBuffer.getChannelData(0);metrics.samples+=a.length;for(const x of a)if(x!==0)metrics.nonzero++;};
                source.connect(processor); processor.connect(silent); silent.connect(context.destination);
            },error=>{metrics.phase='error';metrics.error=String(error);});
        };
        window.stopCapture = async () => {
            if(window.processor){processor.onaudioprocess=null;processor.disconnect();}
            window.source?.disconnect();window.silent?.disconnect();
            for(const track of window.stream?.getTracks()||[])track.stop();
            await window.context?.close();
            metrics.tracksAfterStop=(window.stream?.getTracks()||[]).map(t=>t.readyState);
            metrics.contextAfterStop=window.context?.state;
            return metrics;
        };
        window.readMetrics=()=>JSON.stringify({...metrics,visibility:document.visibilityState});
        </script>
        """
        web.loadHTMLString(html, baseURL: URL(string: "http://127.0.0.1:3001/wk-capture-fixture.html"))
        DispatchQueue.main.asyncAfter(deadline: .now() + 18) { self.fail("Native fixture exceeded 18 second deadline") }
    }

    func evaluate(_ script: String, _ completion: @escaping (Any?) -> Void) {
        web.callAsyncJavaScript("return await eval(source)", arguments: ["source": script], in: nil, in: .page) { result in
            switch result {
            case .success(let value): completion(value)
            case .failure(let error): self.fail("JavaScript: \(error as NSError)")
            }
        }
    }

    func read(_ kind: String, _ completion: @escaping ([String:Any]) -> Void) {
        evaluate("readMetrics()") { value in
            guard let text=value as? String, let data=text.data(using:.utf8), let metrics=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else {self.fail("Invalid metrics");return}
            self.emit(kind, metrics)
            completion(metrics)
        }
    }

    func showOwner() {
        // Mirrors native unminimize -> show -> set_focus without hiding the pet.
        window.deminiaturize(nil)
        window.orderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: false)
        window.makeKeyAndOrderFront(nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard phase == 0 else { return }
        phase = 1
        emit("hidden-document-loaded")
        evaluate("JSON.stringify({secure:isSecureContext,url:location.href,origin:location.origin,media:!!navigator.mediaDevices})") { value in if let value {self.emit("document-origin",["state":value])} }
        evaluate("startCapture();null") { _ in
            DispatchQueue.main.asyncAfter(deadline:.now()+1) {
                self.read("hidden-request") { metrics in
                    guard metrics["phase"] as? String == "pending", metrics["visibility"] as? String == "hidden" else {self.fail("Hidden document should defer getUserMedia");return}
                    self.showOwner()
                    DispatchQueue.main.asyncAfter(deadline:.now()+2.5) {
                        self.read("visible-capture") { metrics in
                            guard metrics["phase"] as? String == "resolved", (metrics["samples"] as? Int ?? 0)>0, (metrics["nonzero"] as? Int ?? 0)>0 else {self.fail("Showing the window did not unlock mock capture and nonzero PCM");return}
                            self.testOverlay()
                        }
                    }
                }
            }
        }
    }

    func testOverlay() {
        evaluate("stopCapture().then(()=>{metrics={phase:'idle',visibility:document.visibilityState,visibilities:[],samples:0,nonzero:0,tracks:[]};window.stream=null;window.context=null;})") { _ in
            let area=NSScreen.main?.frame ?? NSRect(x:0,y:0,width:1440,height:900)
            let layer=NSWindow(contentRect:area,styleMask:[.borderless],backing:.buffered,defer:false)
            layer.title="Isolated transparent pet canvas"
            layer.isReleasedWhenClosed=false
            layer.isOpaque=false;layer.backgroundColor = .clear;layer.level = .floating;layer.ignoresMouseEvents=true
            let view=WKWebView(frame:area)
            view.setValue(false,forKey:"drawsBackground")
            view.loadHTMLString("<!doctype html><style>html,body{margin:0;background:transparent}span{position:fixed;right:25px;bottom:25px;background:#bfe4c8;padding:12px;border-radius:14px}</style><span>Isolated pet canvas</span>",baseURL:nil)
            layer.contentView=view
            self.overlay=layer
            layer.orderFrontRegardless()
            DispatchQueue.main.asyncAfter(deadline:.now()+0.6) {
                self.evaluate("startCapture();null") { _ in
                    DispatchQueue.main.asyncAfter(deadline:.now()+1) {
                        self.read("transparent-overlay-request") { metrics in
                            guard metrics["visibility"] as? String == "visible", metrics["phase"] as? String == "resolved",(metrics["nonzero"] as? Int ?? 0)>0 else {self.fail("Transparent pet canvas occluded capture owner");return}
                            self.overlay?.orderOut(nil)
                            self.showOwner()
                            DispatchQueue.main.asyncAfter(deadline:.now()+1.5) {
                                self.read("after-overlay-hidden") { final in
                                    guard final["phase"] as? String == "resolved",(final["samples"] as? Int ?? 0)>0 else {self.fail("Capture failed after test overlay removal");return}
                                    self.evaluate("stopCapture().then(()=>readMetrics())") { value in
                                        guard let text=value as? String, let data=text.data(using:.utf8), let released=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any], released["tracksAfterStop"] as? [String] == ["ended"], released["contextAfterStop"] as? String == "closed" else {self.fail("Capture resources were not released");return}
                                        self.emit("capture-released",released)
                                        self.emit("PASS",["scenarios":2])
                                        self.shutdown()
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@main
struct Entry {
    @MainActor static func main() {
        let app=NSApplication.shared
        let harness=Harness()
        app.delegate=harness
        app.run()
        exit(harness.failure == nil ? 0 : 1)
    }
}
