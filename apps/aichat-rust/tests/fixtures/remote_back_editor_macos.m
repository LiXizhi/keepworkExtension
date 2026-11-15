// Real cross-process AX. Guard every mutation with the child fixture PID; no
// unrelated foreground application can receive a write or a global key event.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <assert.h>
#include <unistd.h>

static pid_t editorPid;
static NSString *fieldMarker;
static BOOL chromiumFixture, matchedSelection, postingPaste, wrapperAfterPaste;
static AXError editorAttribute(AXUIElementRef element, CFStringRef attribute, CFTypeRef *value) {
    if (wrapperAfterPaste && CFEqual(attribute, kAXFocusedUIElementAttribute)) {
        pid_t pid = 0;
        if (AXUIElementGetPid(element, &pid) == kAXErrorSuccess && pid == editorPid) {
            CFTypeRef role = NULL;
            AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &role);
            BOOL app = role && CFEqual(role, kAXApplicationRole);
            if (role) CFRelease(role);
            if (app) return AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute, value);
        }
    }
    return AXUIElementCopyAttributeValue(element, attribute, value);
}
static AXError onlyEditor(AXUIElementRef field, CFStringRef attr, CFTypeRef value) {
    pid_t pid = 0;
    if (!editorPid || AXUIElementGetPid(field, &pid) != kAXErrorSuccess ||
        NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != editorPid) return kAXErrorCannotComplete;
    BOOL selectRange = CFEqual(attr, kAXSelectedTextRangeAttribute);
    BOOL enableTree = CFEqual(attr, CFSTR("AXManualAccessibility")) || CFEqual(attr, CFSTR("AXEnhancedUserInterface"));
    if (pid != editorPid || (chromiumFixture && !enableTree)) {
        CFTypeRef label = NULL;
        AXUIElementCopyAttributeValue(field, kAXDescriptionAttribute, &label);
        BOOL matches = label && [(__bridge id)label isEqual:fieldMarker];
        if (label) CFRelease(label);
        if (!matches) return kAXErrorCannotComplete;
        if (selectRange) matchedSelection = YES;
    }
    return AXUIElementSetAttributeValue(field, attr, value);
}
static void guardedKeys(CGEventTapLocation location, CGEventRef event) {
    assert(postingPaste && CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode) == 9);
    assert((CGEventGetFlags(event) & kCGEventFlagMaskCommand) != 0);
    assert(editorPid > 0 && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == editorPid);
    CGEventPostToPid(editorPid, event);
}
static void __attribute__((unused)) onlyEditorKeys(pid_t pid, CGEventRef event) {
    assert(chromiumFixture && matchedSelection);
    assert(pid > 0 && pid == editorPid && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == pid);
    CGEventPostToPid(pid, event);
}
#define CGEventPostToPid onlyEditorKeys
#define CGEventPost guardedKeys
#define AXUIElementCopyAttributeValue editorAttribute
#define AXUIElementSetAttributeValue onlyEditor
#include "../../src-tauri/src/remote_voice/native_input_macos.m"
#undef AXUIElementSetAttributeValue
#undef CGEventPost
#undef AXUIElementCopyAttributeValue
#undef CGEventPostToPid
bool keepwork_remote_home_sender(uint64_t sender) { return false; }
bool keepwork_remote_dialogue_ok_edge(bool down) { return false; }

static BOOL waitFor(NSTimeInterval seconds, BOOL (^condition)(void)) {
    NSDate *end = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (!condition() && end.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]
            inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
        [NSApp updateWindows];
    }
    return condition();
}

static void mark(NSString *dir, NSString *name) {
    assert([@"" writeToFile:[dir stringByAppendingPathComponent:name] atomically:YES encoding:NSUTF8StringEncoding error:NULL]);
}
static BOOL marked(NSString *dir, NSString *name) {
    return [NSFileManager.defaultManager fileExistsAtPath:[dir stringByAppendingPathComponent:name]];
}
static id js(WKWebView *web, NSString *expression) {
    __block id result = nil;
    __block BOOL finished = NO;
    [web evaluateJavaScript:expression completionHandler:^(id value, NSError *error) {
        result = value; finished = YES;
    }];
    waitFor(2, ^{ return finished; });
    return result;
}

static int runEditor(NSString *mode, NSString *dir) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(40, 80, 420, 230)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.title = @"Disposable Back-key editor";
    BOOL mainWeb = [mode isEqualToString:@"web-main"];
    NSTextField *field = nil;
    WKWebView *web = nil;
    if ([mode isEqualToString:@"native"]) {
        field = [[NSTextField alloc] initWithFrame:NSMakeRect(15, 90, 260, 28)];
        field.stringValue = @"Fixture text";
        [window.contentView addSubview:field];
    } else {
        WKWebViewConfiguration *config = [WKWebViewConfiguration new];
        config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        web = [[WKWebView alloc] initWithFrame:window.contentView.bounds configuration:config];
        window.contentView = web;
        NSString *html = [NSString stringWithFormat:@"<!doctype html><textarea id='f' aria-label='%@'>Fixture text</textarea><script>window.events=0;document.getElementById('f').oninput=()=>window.events++</script>", fieldMarker];
        if (mainWeb) {
            NSString *page = NSProcessInfo.processInfo.environment[@"AICHAT_BACK_MAIN_FIXTURE"];
            html = [NSString stringWithContentsOfFile:page encoding:NSUTF8StringEncoding error:NULL];
            assert(html);
            NSMenu *menu = [NSMenu new], *edit = [NSMenu new];
            NSMenuItem *item = [menu addItemWithTitle:@"Edit" action:nil keyEquivalent:@""];
            item.submenu = edit;
            [edit addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
            NSApp.mainMenu = menu;
        }
        [web loadHTMLString:html baseURL:nil];
    }
    [window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    if (!waitFor(4, ^{ return (BOOL)(NSApp.active && window.keyWindow); })) return 77;
    if (web) {
        [window makeFirstResponder:web];
        if (mainWeb) {
            if (!waitFor(3, ^{ return (BOOL)[js(web, @"!!document.getElementById('chatInput')") boolValue]; })) return 1;
            if (![js(web, @"chatInput.focus();document.activeElement===chatInput") boolValue]) return 1;
        } else {
            if (!waitFor(3, ^{ return (BOOL)[js(web, @"!!document.getElementById('f')") boolValue]; })) return 1;
            NSPoint inside = [web convertPoint:NSMakePoint(20, 20) toView:nil];
            for (NSNumber *type in @[@(NSEventTypeLeftMouseDown), @(NSEventTypeLeftMouseUp)]) {
                NSEvent *e = [NSEvent mouseEventWithType:type.unsignedIntegerValue location:inside modifierFlags:0
                    timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil
                    eventNumber:0 clickCount:1 pressure:1];
                [window sendEvent:e];
            }
            if (!waitFor(2, ^{ return (BOOL)[js(web, @"document.activeElement===f") boolValue]; })) return 1;
        }
    } else if (![window makeFirstResponder:field]) return 1;
    mark(dir, @"ready");
    if (mainWeb) {
        if (!waitFor(3, ^{ return (BOOL)[js(web, @"window.receivedPaste && model==='Dictated without a click'") boolValue]; })) {
            fprintf(stderr, "WKWebView did not receive the trusted native paste shortcut in its keyboard-focused AIChat composer.\n"); return 1;
        }
        mark(dir, @"pasted");
    }
    if (!waitFor(6, ^{ return marked(dir, @"verify"); })) return 1;
    BOOL ok = NO;
    if (mainWeb) {
        NSString *source = [NSString stringWithContentsOfFile:NSProcessInfo.processInfo.environment[@"AICHAT_BACK_MAIN_SCRIPT"]
            encoding:NSUTF8StringEncoding error:NULL];
        assert(source);
        BOOL cleared = [js(web, source) isEqual:@1] && [js(web,
            @"model==='' && chatInput.innerText.trim()==='' && document.activeElement===chatInput && "
             "edits.length===2 && edits.every(e=>e[0]) && edits[1][1].startsWith('delete')") boolValue];
        BOOL undo = [js(web, @"document.execCommand('undo'); model==='Dictated without a click' && chatInput.innerText.trim()===model") boolValue];
        js(web, @"search.focus()");
        BOOL searchSafe = [js(web, source) isEqual:@0] && [js(web, @"document.activeElement===search && search.value==='Retain search' && model==='Dictated without a click'") boolValue];
        js(web, @"modal.showModal();message.focus()");
        BOOL modalSafe = [js(web, source) isEqual:@0] && [js(web, @"document.activeElement===message && message.value==='Retain modal input' && model==='Dictated without a click'") boolValue];
        ok = cleared && undo && searchSafe && modalSafe;
        if (!ok) fprintf(stderr,"WK main cleared=%d undo=%d search=%d modal=%d\n",cleared,undo,searchSafe,modalSafe);
    } else if (web) {
        NSArray *state = js(web, @"[f.value,window.events,document.activeElement===f]");
        ok = state.count == 3 && [state[0] isEqual:@""] && [state[1] integerValue] > 0 && [state[2] boolValue];
        if (!ok) fprintf(stderr, "WKWebView expected empty focused textarea and input event; %s\n", state.description.UTF8String);
    } else {
        ok = field.currentEditor && field.currentEditor.string.length == 0;
    }
    if (ok) mark(dir, @"cleared");
    waitFor(5, ^{ return marked(dir, @"done"); });
    [window close];
    return ok ? 0 : 1;
}

static int runHost(NSString *executable, NSString *mode, NSString *dir) {
    if (!AXIsProcessTrusted()) { fprintf(stderr, "No Accessibility permission for fixture; no permission requested.\n"); return 77; }
    NSWindow *pet = [[NSWindow alloc] initWithContentRect:NSMakeRect(30,50,140,70)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    NSTextField *draft = [[NSTextField alloc] initWithFrame:NSMakeRect(5,15,120,26)];
    draft.stringValue = @"Keep pet draft";
    [pet.contentView addSubview:draft];
    [pet orderOut:nil];
    NSTask *peer = [NSTask new];
    peer.executableURL = [NSURL fileURLWithPath:executable];
    peer.arguments = @[@"editor", mode, dir];
    if (![peer launchAndReturnError:NULL]) return 1;
    editorPid = peer.processIdentifier;
    @try {
        if (!waitFor(6, ^{ return (BOOL)(marked(dir, @"ready") || !peer.running); }) || !peer.running)
            return !peer.running && peer.terminationStatus == 77 ? 77 : 1;
        if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != editorPid) {
            fprintf(stderr, "Fixture editor lost foreground before verification.\n"); return 77;
        }
        BOOL mainWeb = [mode isEqualToString:@"web-main"];
        if (mainWeb) {
            postingPaste = YES;
            bool posted = keepwork_voice_input_paste();
            postingPaste = NO;
            if (!posted || !waitFor(4, ^{ return marked(dir, @"pasted"); })) return 1;
        }
        int status = mainWeb ? 0 : keepwork_voice_input_clear_back();
        if (status != 0) {
            AXUIElementRef app = AXUIElementCreateApplication(editorPid);
            AXUIElementRef field = copyFocusedInput(app);
            CFTypeRef role = NULL, enabled = NULL, subrole = NULL;
            Boolean writable = false;
            if (field) {
                AXUIElementCopyAttributeValue(field, kAXRoleAttribute, &role);
                AXUIElementCopyAttributeValue(field, kAXSubroleAttribute, &subrole);
                AXUIElementCopyAttributeValue(field, kAXEnabledAttribute, &enabled);
                AXUIElementIsAttributeSettable(field, kAXValueAttribute, &writable);
            }
            fprintf(stderr, "external Back returned %d for %s (fixture AX role=%s subrole=%s enabled=%d writable=%d)\n",
                status, mode.UTF8String, [(__bridge id)role description].UTF8String ?: "unknown",
                [(__bridge id)subrole description].UTF8String ?: "unknown", enabled == kCFBooleanTrue, writable);
            if (field) CFRelease(field); CFRelease(app); if (role) CFRelease(role); if (subrole) CFRelease(subrole); if (enabled) CFRelease(enabled);
            return 1;
        }
        mark(dir, @"verify");
        if (!waitFor(3, ^{ return marked(dir, @"cleared"); })) return 1;
        if (pet.visible || ![draft.stringValue isEqual:@"Keep pet draft"] ||
            NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != editorPid) return 1;
        printf("passed external %s active field clear; retained focus and pet draft\n", mode.UTF8String);
        return 0;
    } @finally {
        mark(dir, @"done");
        if (!waitFor(1, ^{ return (BOOL)!peer.running; }) && peer.running) [peer terminate];
        [pet orderOut:nil];
        editorPid = 0;
    }
}
// The caller owns a new Chrome process, a unique profile and the page. Bind
// this fixture to both its browser PID and its focused editor's unique name.
static int runChrome(NSString *pidString, NSString *marker, BOOL cold, NSString *pasteAck, BOOL wrapper) {
    editorPid = pidString.intValue;
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:editorPid];
    if (!AXIsProcessTrusted()) return 77;
    BOOL fixtureRuntime = [app.bundleIdentifier isEqualToString:@"com.google.Chrome"] ||
        [app.bundleIdentifier isEqualToString:@"com.github.Electron"];
    if (editorPid <= 0 || !fixtureRuntime) return 1;
    if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != editorPid) {
        fprintf(stderr, "Disposable Chromium window did not become foreground.\n");
        return 1;
    }
    chromiumFixture = YES;
    fieldMarker = marker;
    if (pasteAck) {
        postingPaste = YES;
        bool posted = keepwork_voice_input_paste();
        postingPaste = NO;
        if (!posted) return 1;
        BOOL immediate = [pasteAck isEqualToString:@"in-flight"];
        for (int i = 0; !immediate && i < 150 && ![NSFileManager.defaultManager fileExistsAtPath:pasteAck]; i++) usleep(10000);
        if (!immediate && ![NSFileManager.defaultManager fileExistsAtPath:pasteAck]) {
            fprintf(stderr, "The disposable editor did not receive Cmd+V.\n"); return 1;
        }
        wrapperAfterPaste = wrapper;
        printf("Chrome Back status %d\n", keepwork_voice_input_clear_back());
        return 0;
    }
    if (cold) {
        printf("Chrome Back status %d\n", keepwork_voice_input_clear_back());
        return 0;
    }
    AXUIElementRef browser = AXUIElementCreateApplication(editorPid);
    AXUIElementRef field = copyFocusedInput(browser);
    CFRelease(browser);
    if (!field) return 1;
    CFTypeRef label = NULL, role = NULL, count = NULL, selection = NULL;
    AXUIElementCopyAttributeValue(field, kAXDescriptionAttribute, &label);
    AXUIElementCopyAttributeValue(field, kAXRoleAttribute, &role);
    AXUIElementCopyAttributeValue(field, kAXNumberOfCharactersAttribute, &count);
    AXUIElementCopyAttributeValue(field, kAXSelectedTextRangeAttribute, &selection);
    CFRange range = {-1, -1};
    if (selection && CFGetTypeID(selection) == AXValueGetTypeID())
        AXValueGetValue((AXValueRef)selection, kAXValueCFRangeType, &range);
    Boolean value = false, text = false, rangeWritable = false;
    AXUIElementIsAttributeSettable(field, kAXValueAttribute, &value);
    AXUIElementIsAttributeSettable(field, kAXSelectedTextAttribute, &text);
    AXUIElementIsAttributeSettable(field, kAXSelectedTextRangeAttribute, &rangeWritable);
    BOOL matches = label && [(__bridge NSString *)label isEqualToString:marker];
    fprintf(stderr, "Chrome field marker matched=%d role=%s count=%s selection=%ld,%ld writable(value,text,range)=%d,%d,%d\n",
        matches, [(__bridge id)role description].UTF8String ?: "?", [(__bridge id)count description].UTF8String ?: "?",
        range.location, range.length, value, text, rangeWritable);
    CFRelease(field);
    if (count) CFRelease(count); if (role) CFRelease(role); if (selection) CFRelease(selection); if (label) CFRelease(label);
    if (!matches) return 1;
    printf("Chrome Back status %d\n", keepwork_voice_input_clear_back());
    return 0;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc == 5 && (!strcmp(argv[1], "paste-back") || !strcmp(argv[1], "paste-back-wrapper")))
            return runChrome(@(argv[2]), @(argv[3]), NO, @(argv[4]), !strcmp(argv[1], "paste-back-wrapper"));
        if (argc != 4) return 1;
        if (!strcmp(argv[1], "chrome") || !strcmp(argv[1], "cold-chromium"))
            return runChrome(@(argv[2]), @(argv[3]), !strcmp(argv[1], "cold-chromium"), nil, NO);
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp finishLaunching];
        fieldMarker = [NSString stringWithFormat:@"Back test %@", [@(argv[3]) stringByDeletingLastPathComponent].lastPathComponent];
        return !strcmp(argv[1], "editor") ? runEditor(@(argv[2]), @(argv[3])) : runHost(@(argv[1]), @(argv[2]), @(argv[3]));
    }
}
