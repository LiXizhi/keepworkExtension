import Cocoa
import WebKit

// Actual AIChat source, real system speech, no microphone, account or network.
// Compile from the repository root:
// xcrun swiftc -parse-as-library -module-cache-path /tmp/wk-persona-module-cache \
//   apps/aichat-rust/scripts/wk-persona-playback.swift -o /tmp/wk-persona-playback \
//   -framework Cocoa -framework WebKit
// Run with PERSONA_MODULE_SOURCE_ROOT pointing to an AIChat source directory:
// PERSONA_MODULE_SOURCE_ROOT=/path/to/AIChat /tmp/wk-persona-playback
// PERSONA_DISABLE_THROTTLING=0 retains WebKit's default scheduling for comparison.
// Exit 77 means the OS cannot run the macOS 14+ scheduling-policy comparison.
@MainActor
final class PersonaPlaybackHarness: NSObject, NSApplicationDelegate, WKURLSchemeHandler, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var requestPaths: [String] = []
    let sourceRoot = ProcessInfo.processInfo.environment["PERSONA_MODULE_SOURCE_ROOT"] ?? ""
    let modulePaths = ["/js/persona_voice.js", "/js/desktop_pet_audio.js", "/js/speech_playback_wait.js"]
    let html = #"""
    <!doctype html><meta charset="utf-8"><title>Actual persona module playback</title><p>This window remains hidden.</p>
    <script type="module">
    const emit=(event,details={})=>webkit.messageHandlers.metrics.postMessage({event,visibility:document.visibilityState,...details});
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const until=async check=>{for(let i=0;i<200;i++){if(check())return;await delay(25)}throw Error('expected playback event timed out')};
    const records=[];let label='';let sdkCalls=0;
    try {
      const {createPersonaSpeech}=await import('./js/persona_voice.js');
      const originalSpeak=speechSynthesis.speak.bind(speechSynthesis);
      speechSynthesis.speak=utterance=>{
        const record={label,text:utterance.text,lang:utterance.lang,rate:utterance.rate,voice:utterance.voice?.name||null,uri:utterance.voice?.voiceURI||null,queuedAt:performance.now()};
        records.push(record);emit('utterance-enqueued',record);
        utterance.addEventListener('start',()=>{record.startedAt=performance.now();emit('utterance-start',{label:record.label})});
        utterance.addEventListener('end',event=>{record.endedAt=performance.now();record.elapsed=event.elapsedTime;emit('utterance-end',{label:record.label,elapsed:record.elapsed,wallMs:record.endedAt-record.startedAt})});
        utterance.addEventListener('error',event=>{record.error=event.error;emit('utterance-error',{label:record.label,error:event.error})});
        originalSpeak(utterance);
      };
      const forbidden=()=>{sdkCalls++;throw Error('system speech unexpectedly used SDK/cloud')};
      const speech=createPersonaSpeech({speech:{rate:4,playSystemAudio:forbidden,stopAllAudio:forbidden},speechRTC:{createSession:forbidden}},()=> 'system');
      for(let round=1;round<=3;round++){
        label='full-round-'+round;
        const began=performance.now();await speech.speak('你好，声音测试。');
        // WebKit may run the product's onend promise continuation before this
        // observer listener, so await the actual observer as well.
        const record=records.at(-1);await until(()=>!!record.endedAt||!!record.error);
        const wall=performance.now()-began;
        if(!record.startedAt||!record.endedAt||record.error||wall<1000||record.rate!==1||record.lang!=='zh-CN'||!record.voice)throw Error('full speech round did not really complete: '+JSON.stringify(record));
        emit('round-complete',{round,wallMs:wall,voice:record.voice});
      }
      label='stopped-old';
      const old=speech.speak('这是一段将被停止的长语音。现在我们确认主动停止能够立即释放旧的一轮，并且不会影响下一条新的语音回复。');
      const stoppedRecord=records.at(-1);await until(()=>!!stoppedRecord.startedAt);await delay(250);
      const stoppedAt=performance.now();speech.stopSpeaking();
      label='replacement';
      const next=speech.speak('你好，这是新的语音回复。');
      await Promise.race([old,delay(300).then(()=>{throw Error('old promise did not resolve immediately after stop')})]);
      const oldSettleMs=performance.now()-stoppedAt;
      emit('old-promise-released',{elapsedMs:oldSettleMs});
      setTimeout(()=>emit('replacement-after-5s',{speaking:speechSynthesis.speaking,pending:speechSynthesis.pending,paused:speechSynthesis.paused}),5000);
      await next;
      const replacement=records.at(-1);await until(()=>!!replacement.endedAt||!!replacement.error);
      const duration=replacement.endedAt-replacement.startedAt;
      if(replacement.label!=='replacement'||!replacement.startedAt||!replacement.endedAt||replacement.error||duration<1000)throw Error('replacement was cut short: '+JSON.stringify(replacement));
      if(sdkCalls)throw Error('SDK was called');
      emit('PASS',{fullRounds:3,oldSettleMs,replacementDurationMs:duration,sdkCalls,utterances:records.length});
    }catch(error){emit('FAIL',{error:String(error),stack:error.stack})}
    </script>
    """#

    func emit(_ values: [String: Any]) {
        var data = values
        data["mainVisible"] = window?.isVisible ?? false
        if let bytes = try? JSONSerialization.data(withJSONObject: data, options: [.sortedKeys]),
           let text = String(data: bytes, encoding: .utf8) {
            print(text)
            fflush(stdout)
        }
    }

    func fail(_ reason: String) {
        emit(["event": "FAIL", "reason": reason])
        exit(1)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard #available(macOS 14.0, *) else {
            emit(["event": "BLOCKED", "reason": "macOS 14+ is required to compare inactiveSchedulingPolicy"])
            exit(77)
        }
        guard !sourceRoot.isEmpty else {
            fail("Set PERSONA_MODULE_SOURCE_ROOT to an AIChat source directory")
            return
        }
        for modulePath in modulePaths {
            guard FileManager.default.isReadableFile(atPath: sourceRoot + modulePath) else {
                fail("Required source file is not readable: " + modulePath)
                return
            }
        }
        NSApplication.shared.setActivationPolicy(.accessory)
        let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
        emit([
            "event": "native-start",
            "locked": (session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false,
            "onConsole": (session["kCGSessionOnConsoleKey"] as? NSNumber)?.boolValue ?? false,
            "sourceRoot": sourceRoot,
        ])
        window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 600, height: 360),
                          styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.mediaTypesRequiringUserActionForPlayback = []
        let disableThrottling = ProcessInfo.processInfo.environment["PERSONA_DISABLE_THROTTLING"] != "0"
        if disableThrottling { config.preferences.inactiveSchedulingPolicy = .none }
        emit(["event": "scheduling-policy", "backgroundThrottlingDisabled": disableThrottling])
        config.userContentController.add(self, name: "metrics")
        config.setURLSchemeHandler(self, forURLScheme: "tauri")
        web = WKWebView(frame: window.contentView!.bounds, configuration: config)
        window.contentView = web
        // Never show, focus or order this main window front.
        web.load(URLRequest(url: URL(string: "tauri://localhost/index.html")!))
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
            self.emit(["event": "FAIL", "reason": "30s native deadline", "requestPaths": self.requestPaths])
            exit(2)
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard var value = message.body as? [String: Any] else { return }
        if window.isVisible { value = ["event": "FAIL", "error": "main window unexpectedly visible"] }
        emit(value)
        if value["event"] as? String == "PASS" { exit(0) }
        if value["event"] as? String == "FAIL" { exit(1) }
    }

    func webView(_ view: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.host == "localhost" else {
            task.didFailWithError(NSError(domain: "PersonaPlaybackFixture", code: 1))
            return
        }
        requestPaths.append(url.path)
        let data: Data
        let mime: String
        if url.path == "/index.html" {
            data = html.data(using: .utf8)!
            mime = "text/html"
        } else if modulePaths.contains(url.path),
                  let source = try? Data(contentsOf: URL(fileURLWithPath: sourceRoot + url.path)) {
            data = source
            mime = "text/javascript"
            emit(["event": "actual-source-served", "path": url.path, "bytes": source.count])
        } else {
            task.didFailWithError(NSError(domain: "PersonaPlaybackFixture", code: 2))
            return
        }
        task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: "utf-8"))
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ view: WKWebView, stop task: WKURLSchemeTask) {}
}

@main
struct Entry {
    @MainActor static func main() {
        let app = NSApplication.shared
        let harness = PersonaPlaybackHarness()
        app.delegate = harness
        app.run()
        withExtendedLifetime(harness) {}
    }
}
