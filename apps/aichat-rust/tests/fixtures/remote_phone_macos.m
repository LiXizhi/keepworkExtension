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

static BOOL MockDevicesEnabled(WKPreferences *preferences) {
    SEL getMock = NSSelectorFromString(@"_mockCaptureDevicesEnabled");
    return [preferences respondsToSelector:getMock] && ((BOOL (*)(id, SEL))objc_msgSend)(preferences, getMock);
}

@interface PhoneDelegate : NSObject <WKUIDelegate>
@property BOOL allow;
@property WKMediaCaptureType expectedType;
@property NSInteger port;
@property NSUInteger requests;
@end
@implementation PhoneDelegate
- (void)webView:(WKWebView *)view requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
        initiatedByFrame:(WKFrameInfo *)frame type:(WKMediaCaptureType)type decisionHandler:(void (^)(WKPermissionDecision))reply {
    BOOL trusted = [origin.protocol isEqual:@"http"] && [origin.host isEqual:@"127.0.0.1"] && origin.port == self.port &&
        frame.mainFrame && [view.URL.path isEqual:@"/main"] && type == self.expectedType;
    BOOL mocked = MockDevicesEnabled(view.configuration.preferences);
    self.requests++;
    reply(trusted && mocked && self.allow ? WKPermissionDecisionGrant : WKPermissionDecisionDeny);
    Check(mocked, @"an unverified media source must never be granted access");
    Check(trusted, @"only the expected device was requested by the trusted main document");
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

static void Scenario(NSURL *base, BOOL allow, BOOL camera, BOOL simulateClearDisplay) {
    @autoreleasepool {
        WKWebViewConfiguration *cfg = [WKWebViewConfiguration new];
        cfg.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        // Wry enables autoplay for the retained desktop document.
        cfg.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
        SEL setMock = NSSelectorFromString(@"_setMockCaptureDevicesEnabled:");
        SEL getMock = NSSelectorFromString(@"_mockCaptureDevicesEnabled");
        if (![cfg.preferences respondsToSelector:setMock] || ![cfg.preferences respondsToSelector:getMock]) {
            puts("No WebKit mock capture"); exit(77);
        }
        ((void (*)(id, SEL, BOOL))objc_msgSend)(cfg.preferences, setMock, YES);
        Check(MockDevicesEnabled(cfg.preferences), @"mock capture enabled before creating any media-capable view");
        SEL setMediaDevices = NSSelectorFromString(@"_setMediaDevicesEnabled:");
        Check([cfg.preferences respondsToSelector:setMediaDevices], @"WebKit media devices fixture preference is available");
        ((void (*)(id, SEL, BOOL))objc_msgSend)(cfg.preferences, setMediaDevices, YES);
        NSRect desktop = NSMakeRect(40, 60, 840, 560);
        FixtureWindow *main = [[FixtureWindow alloc] initWithContentRect:desktop styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        FixtureWindow *petWindow = [[FixtureWindow alloc] initWithContentRect:NSMakeRect(30, 40, 160, 160)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        main.simulateClearDisplay = petWindow.simulateClearDisplay = simulateClearDisplay;
        WKWebView *mainView = Load(main, cfg, [base URLByAppendingPathComponent:@"main"]);
        WKWebViewConfiguration *petConfig = [WKWebViewConfiguration new];
        petConfig.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        ((void (*)(id, SEL, BOOL))objc_msgSend)(petConfig.preferences, setMediaDevices, NO);
        WKWebView *pet = Load(petWindow, petConfig, [base URLByAppendingPathComponent:@"pet"]);
        PhoneDelegate *delegate = [PhoneDelegate new];
        delegate.allow = allow;
        delegate.expectedType = camera ? WKMediaCaptureTypeCamera : WKMediaCaptureTypeMicrophone;
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
        NSDictionary *mediaApi = Eval(mainView, @"({url:location.href,secure:isSecureContext,hidden:document.hidden,"
            "mediaDevices:typeof navigator.mediaDevices,getUserMedia:typeof navigator.mediaDevices?.getUserMedia})");
        Check([mediaApi isKindOfClass:NSDictionary.class] && [mediaApi[@"secure"] boolValue] &&
            [mediaApi[@"mediaDevices"] isEqual:@"object"] && [mediaApi[@"getUserMedia"] isEqual:@"function"],
            [NSString stringWithFormat:@"secure mock media API must exist before capture: %@", mediaApi]);
        // Start in exactly the state where WebKit can defer getUserMedia. Reparenting must unblock this same request.
        if (!camera) {
            Eval(mainView, @"startPhone();true");
            BOOL earlyDecision = Until(^BOOL { return ![Eval(mainView, @"captureState") isEqual:@"waiting"]; }, 0.25);
            Check(!earlyDecision && delegate.requests == 0, @"the ordered-out main still awaits microphone access");
        }
        void *owner = (__bridge void *)main;
        void *host = (__bridge void *)petWindow;
        Check(keepwork_attach_phone_view(owner, host, (__bridge void *)mainView) != 0, @"hidden main view attached");
        Check(!main.visible && mainView.window == petWindow && pet.window == petWindow, @"desktop stays ordered out; both webviews share the pet window");
        Check(Until(^BOOL { return ![Eval(mainView, @"document.hidden") boolValue]; }, 3), @"main document is presented in the pet window");
        Check([Eval(mainView, @"[innerWidth, innerHeight].join('x')") isEqual:viewport], @"desktop viewport retained during presentation");
        ClickPet(pet);
        if (camera) Eval(mainView, @"takePhoto();true");
        Check(Until(^BOOL { return ![Eval(mainView, @"captureState") isEqual:@"waiting"]; }, 6), @"mock capture makes a permission decision");
        Check(delegate.requests == 1, @"exactly one site-level media permission decision");
        if (delegate.allow) {
            Check([Eval(mainView, @"captureState") isEqual:camera ? @"captured" : @"listening"],
                [NSString stringWithFormat:@"mock capture completed: %@", Eval(mainView, @"captureState")]);
            Check([Eval(mainView, @"track.label") hasPrefix:@"Mock"], @"only WebKit's synthetic capture device is used");
            if (camera) {
                Check([Eval(mainView, @"window.photoWidth > 0 && window.jpegLength > 1000 && window.mockPattern") boolValue], @"camera decoded the synthetic test pattern and encoded it to JPEG");
                Check([Eval(mainView, @"track.readyState") isEqual:@"ended"], @"camera track stopped before returning to the original hierarchy");
            }
        } else {
            Check([Eval(mainView, @"captureState") isEqual:@"NotAllowedError"], @"permission denied stays denied");
        }
        if (delegate.allow && !camera) {
            Eval(mainView, @"reacquireMic().catch(e=>window.reacquireError=e.name);true");
            Check(Until(^BOOL { return [Eval(mainView, @"window.samples || 0") integerValue] >= 2; }, 8),
                @"an active listening call can reacquire the mock microphone and process nonzero 16 kHz Web Audio frames");
            Check(mainView.window == petWindow && !main.visible, @"chat stayed hidden while recording new speech");
            Eval(mainView, @"processor.disconnect();source.disconnect();ctx.close();track.stop();true");
        }
        keepwork_restore_phone_view(owner);
        keepwork_restore_phone_view(owner);
        Check(mainView.superview == parent && NSEqualRects(mainView.frame, frame) && !main.visible, @"restoration returns to the original ordered-out hierarchy");
        if (delegate.allow) {
            Check([Eval(mainView, @"track.readyState") isEqual:@"ended"], @"hangup ends the active mock track");
        }
        // A Dock restore can race startup or hangup. Exercising a second presentation checks cleanup of the first.
        Check(keepwork_attach_phone_view(owner, host, (__bridge void *)mainView) != 0, @"subsequent presentation works");
        keepwork_restore_phone_view(owner);
        [main orderFront:nil];
        keepwork_restore_phone_view(owner);
        Check(main.visible && mainView.window == main && mainView.superview == parent && NSEqualRects(mainView.frame, frame), @"Dock restores desktop geometry and original parent");
        Check([mainView.URL isEqual:url] && [Eval(mainView, @"window.sessionMarker") isEqual:marker] &&
            [Eval(mainView, camera ? @"window.photoStarts" : @"window.phoneStarts") integerValue] == 1, @"one request in the original main JS context throughout");
        [main orderOut:nil];
        [petWindow orderOut:nil];
        printf("passed: %s %s\n", camera ? "camera" : "phone", allow ? "grant" : "deny");
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
            Scenario(base, YES, NO, simulateClearDisplay);
            Scenario(base, NO, NO, simulateClearDisplay);
            Scenario(base, YES, YES, simulateClearDisplay);
            Scenario(base, NO, YES, simulateClearDisplay);
            [NSApp terminate:nil];
        }];
        [NSApp run];
    }
    return 0;
}
