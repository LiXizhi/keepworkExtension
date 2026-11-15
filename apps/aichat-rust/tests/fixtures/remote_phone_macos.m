#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/message.h>

extern int keepwork_attach_phone_view(void *mainWindow, void *petWindow, void *mainWebView);
extern void keepwork_restore_phone_view(void *mainWindow);

static void Check(BOOL ok, NSString *message) {
    if (!ok) { fprintf(stderr, "remote phone: %s\n", message.UTF8String); exit(1); }
}

static BOOL Until(BOOL (^test)(void), NSTimeInterval timeout) {
    NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:timeout];
    do {
        if (test()) return YES;
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]
            inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
        [NSApp updateWindows];
    } while (limit.timeIntervalSinceNow > 0);
    return NO;
}

static id Eval(WKWebView *view, NSString *js) {
    __block BOOL done = NO;
    __block id value;
    __block NSError *failure;
    [view evaluateJavaScript:js completionHandler:^(id result, NSError *error) { value = result; failure = error; done = YES; }];
    Check(Until(^BOOL { return done; }, 4), @"JavaScript response timed out");
    Check(!failure, [NSString stringWithFormat:@"JavaScript error in %@: %@", js, failure]);
    return value;
}

// A locked/asleep display occludes every window, including the pet. Model an otherwise
// unobscured pet on those hosts while leaving WebKit, both real windows, and orderOut intact.
@interface FixtureWindow : NSWindow
@property BOOL simulateClearDisplay;
@end
@implementation FixtureWindow
- (NSWindowOcclusionState)occlusionState {
    if (self.simulateClearDisplay && self.visible) return NSWindowOcclusionStateVisible;
    return super.occlusionState;
}
@end

@interface PhoneDelegate : NSObject <WKUIDelegate>
@property BOOL allow;
@property NSInteger port;
@property NSUInteger requests;
@end
@implementation PhoneDelegate
- (void)webView:(WKWebView *)view requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
        initiatedByFrame:(WKFrameInfo *)frame type:(WKMediaCaptureType)type decisionHandler:(void (^)(WKPermissionDecision))reply {
    BOOL trusted = [origin.protocol isEqual:@"http"] && [origin.host isEqual:@"127.0.0.1"] && origin.port == self.port &&
        frame.mainFrame && [view.URL.path isEqual:@"/main"] && type == WKMediaCaptureTypeMicrophone;
    self.requests++;
    reply(trusted && self.allow ? WKPermissionDecisionGrant : WKPermissionDecisionDeny);
    Check(trusted, @"only the trusted main document requested microphone access");
}
@end

static WKWebView *Load(NSWindow *window, WKWebViewConfiguration *config, NSURL *url) {
    NSView *root = window.contentView;
    WKWebView *view = [[WKWebView alloc] initWithFrame:root.bounds configuration:config];
    view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [root addSubview:view];
    [view loadRequest:[NSURLRequest requestWithURL:url]];
    return view;
}

static void ClickPet(WKWebView *pet) {
    NSPoint point = NSMakePoint(NSMidX(pet.bounds), NSMidY(pet.bounds));
    NSPoint inWindow = [pet convertPoint:point toView:nil];
    NSView *root = pet.window.contentView;
    NSView *hit = [root hitTest:[pet convertPoint:point toView:root]];
    Check(hit == pet || [hit isDescendantOf:pet], @"the pet receives native hit testing while sharing its window");
    for (NSNumber *kind in @[@(NSEventTypeLeftMouseDown), @(NSEventTypeLeftMouseUp)]) {
        NSEventType type = kind.unsignedIntegerValue;
        NSEvent *event = [NSEvent mouseEventWithType:type location:inWindow modifierFlags:0
            timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:pet.window.windowNumber context:nil
            eventNumber:1 clickCount:1 pressure:type == NSEventTypeLeftMouseDown ? 1 : 0];
        if (type == NSEventTypeLeftMouseDown) [hit mouseDown:event]; else [hit mouseUp:event];
    }
    Check(Until(^BOOL { return [Eval(pet, @"window.petClicks") integerValue] == 1; }, 2), @"pet button received native click");
}

static void Scenario(NSURL *base, BOOL allow, BOOL simulateClearDisplay) {
    @autoreleasepool {
        WKWebViewConfiguration *cfg = [WKWebViewConfiguration new];
        cfg.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        SEL setMock = NSSelectorFromString(@"_setMockCaptureDevicesEnabled:");
        SEL getMock = NSSelectorFromString(@"_mockCaptureDevicesEnabled");
        if (![cfg.preferences respondsToSelector:setMock] || ![cfg.preferences respondsToSelector:getMock]) {
            puts("No WebKit mock capture"); exit(77);
        }
        ((void (*)(id, SEL, BOOL))objc_msgSend)(cfg.preferences, setMock, YES);
        Check(((BOOL (*)(id, SEL))objc_msgSend)(cfg.preferences, getMock), @"mock capture enabled before creating any media-capable view");
        NSRect desktop = NSMakeRect(40, 60, 840, 560);
        FixtureWindow *main = [[FixtureWindow alloc] initWithContentRect:desktop styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        FixtureWindow *petWindow = [[FixtureWindow alloc] initWithContentRect:NSMakeRect(30, 40, 160, 160)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        main.simulateClearDisplay = petWindow.simulateClearDisplay = simulateClearDisplay;
        WKWebView *mainView = Load(main, cfg, [base URLByAppendingPathComponent:@"main"]);
        WKWebViewConfiguration *petConfig = [WKWebViewConfiguration new];
        petConfig.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        WKWebView *pet = Load(petWindow, petConfig, [base URLByAppendingPathComponent:@"pet"]);
        PhoneDelegate *delegate = [PhoneDelegate new];
        delegate.allow = allow;
        delegate.port = base.port.integerValue;
        mainView.UIDelegate = delegate;
        Check(Until(^BOOL { return [mainView.title isEqual:@"main"] && [pet.title isEqual:@"pet"]; }, 7), @"both documents loaded");
        [main center];
        [petWindow center];
        [main orderFrontRegardless];
        petWindow.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
        petWindow.level = NSStatusWindowLevel;
        petWindow.hidesOnDeactivate = NO;
        [petWindow orderFrontRegardless];
        Check(Until(^BOOL { return ![Eval(pet, @"document.hidden") boolValue]; }, 5), @"pet window initially visible");
        NSURL *url = mainView.URL;
        NSString *marker = Eval(mainView, @"window.sessionMarker");
        Check(marker.length > 0, @"main document owns its session");
        NSView *parent = mainView.superview;
        NSRect frame = mainView.frame;
        NSString *viewport = Eval(mainView, @"[innerWidth, innerHeight].join('x')");
        Check([viewport isEqual:@"840x560"], @"desktop viewport established");
        [main orderOut:nil];
        Check(Until(^BOOL { return [Eval(mainView, @"document.hidden") boolValue]; }, 3), @"main page initially hidden");
        // Start in exactly the state where WebKit can defer getUserMedia. Reparenting must unblock this same request.
        Eval(mainView, @"startPhone();true");
        BOOL earlyDecision = Until(^BOOL { return ![Eval(mainView, @"captureState") isEqual:@"waiting"]; }, 0.25);
        Check(!earlyDecision && delegate.requests == 0, @"the ordered-out main still awaits microphone access");
        void *owner = (__bridge void *)main;
        void *host = (__bridge void *)petWindow;
        Check(keepwork_attach_phone_view(owner, host, (__bridge void *)mainView) != 0, @"hidden main view attached");
        Check(!main.visible && mainView.window == petWindow && pet.window == petWindow, @"desktop stays ordered out; both webviews share the pet window");
        Check(Until(^BOOL { return ![Eval(mainView, @"document.hidden") boolValue]; }, 3), @"main document is presented in the pet window");
        Check([Eval(mainView, @"[innerWidth, innerHeight].join('x')") isEqual:viewport], @"desktop viewport retained during presentation");
        ClickPet(pet);
        Check(Until(^BOOL { return ![Eval(mainView, @"captureState") isEqual:@"waiting"]; }, 6), @"mock capture makes a permission decision");
        Check(delegate.requests == 1, @"exactly one site-level microphone permission decision");
        if (delegate.allow) {
            Check([Eval(mainView, @"captureState") isEqual:@"listening"], @"phone starts listening");
            Check([Eval(mainView, @"track.label") hasPrefix:@"Mock"], @"only WebKit's synthetic microphone is used");
        } else {
            Check([Eval(mainView, @"captureState") isEqual:@"NotAllowedError"], @"permission denied stays denied");
        }
        keepwork_restore_phone_view(owner);
        keepwork_restore_phone_view(owner);
        Check(mainView.superview == parent && NSEqualRects(mainView.frame, frame) && !main.visible, @"restoration returns to the original ordered-out hierarchy");
        if (delegate.allow) {
            Check(Until(^BOOL { return [Eval(mainView, @"document.hidden") boolValue]; }, 3), @"listening main page returns to hidden");
            Eval(mainView, @"window.recorder = new MediaRecorder(stream);window.recorded = 0;"
                 "recorder.ondataavailable = e => window.recorded += e.data.size;recorder.start();true");
            NSDate *afterHandoff = [NSDate dateWithTimeIntervalSinceNow:0.6];
            Until(^BOOL { return afterHandoff.timeIntervalSinceNow <= 0; }, 1);
            Check([Eval(mainView, @"track.readyState === 'live' && !track.muted && track.enabled") boolValue],
                @"acquired track stays live and unmuted after restoring to hidden main");
            Eval(mainView, @"recorder.stop();true");
            Check(Until(^BOOL { return [Eval(mainView, @"window.recorded") integerValue] > 256; }, 3),
                @"hidden main recorded a nonempty audio chunk from the existing synthetic track");
            Eval(mainView, @"track.stop();true");
            keepwork_restore_phone_view(owner);
            Check([Eval(mainView, @"track.readyState") isEqual:@"ended"], @"hangup ends the same track");
        }
        // A Dock restore can race startup or hangup. Exercising a second presentation checks cleanup of the first.
        Check(keepwork_attach_phone_view(owner, host, (__bridge void *)mainView) != 0, @"subsequent presentation works");
        keepwork_restore_phone_view(owner);
        [main orderFront:nil];
        keepwork_restore_phone_view(owner);
        Check(main.visible && mainView.window == main && mainView.superview == parent && NSEqualRects(mainView.frame, frame), @"Dock restores desktop geometry and original parent");
        Check([mainView.URL isEqual:url] && [Eval(mainView, @"window.sessionMarker") isEqual:marker] &&
            [Eval(mainView, @"window.phoneStarts") integerValue] == 1, @"one call in the original main JS context throughout");
        [main orderOut:nil];
        [petWindow orderOut:nil];
        printf("passed: %s\n", allow ? "grant" : "deny");
    }
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        Check(argc == 2, @"loopback origin required");
        NSURL *base = [NSURL URLWithString:[NSString stringWithUTF8String:argv[1]]];
        Check([base.host isEqual:@"127.0.0.1"], @"loopback fixture only");
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
        BOOL simulateClearDisplay = [session[@"CGSSessionScreenIsLocked"] boolValue] || CGDisplayIsAsleep(CGMainDisplayID());
        if (simulateClearDisplay) puts("Using fixture window visibility on a locked/asleep display.");
        [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:NO block:^(NSTimer *timer) {
            Scenario(base, YES, simulateClearDisplay);
            Scenario(base, NO, simulateClearDisplay);
            [NSApp terminate:nil];
        }];
        [NSApp run];
    }
    return 0;
}
