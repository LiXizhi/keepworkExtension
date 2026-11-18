// Linked only into dev-bins builds. Drive this fixture's own AppKit controls;
// never synthesize global keyboard or mouse events or activate the application.
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <objc/runtime.h>
#include <stdbool.h>

static void KeepworkSmokeNoActivation(id application, SEL selector, BOOL ignore) {
    (void)application; (void)selector; (void)ignore;
}

// This process deliberately stays in the background. Model its own normal-size
// main window as the Home target, regardless of the user's foreground application.
static NSRunningApplication *KeepworkSmokeFrontmostApplication(id workspace, SEL selector) {
    (void)workspace; (void)selector;
    return NSRunningApplication.currentApplication;
}
static Method KeepworkSmokeFrontmostMethod;
static IMP KeepworkSmokeOriginalFrontmost;
static Class KeepworkSmokeApplication;
static IMP KeepworkSmokeOriginalActivation;
static const char *KeepworkSmokeActivationType;
static __weak NSWindow *KeepworkSmokeMain;
static __weak NSView *KeepworkSmokeContent;
static __weak NSView *KeepworkSmokeWebView;

unsigned int keepwork_startup_smoke_voice_modifier_state(void) {
    CGEventFlags mask = kCGEventFlagMaskCommand | kCGEventFlagMaskControl |
        kCGEventFlagMaskAlternate | kCGEventFlagMaskShift;
    return (CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState) & mask ? 1 : 0) |
        (CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState) & mask ? 2 : 0);
}

static NSView *KeepworkSmokeFindWebView(NSView *view) {
    Class webviewClass = NSClassFromString(@"WKWebView");
    if (webviewClass && [view isKindOfClass:webviewClass]) return view;
    for (NSView *child in view.subviews) {
        NSView *found = KeepworkSmokeFindWebView(child);
        if (found) return found;
    }
    return nil;
}

static NSButton *KeepworkSmokeButtonWithTitle(NSView *view, NSString *title) {
    if ([view isKindOfClass:NSButton.class] && [((NSButton *)view).title isEqualToString:title]) {
        return (NSButton *)view;
    }
    for (NSView *child in view.subviews) {
        NSButton *button = KeepworkSmokeButtonWithTitle(child, title);
        if (button) return button;
    }
    return nil;
}

// Only operate on this process's screenshot dialog. A modal-mode timer runs
// while NSAlert.runModal owns the main loop and the fixture webview stays hidden.
void keepwork_startup_smoke_cancel_screenshot_alert(void) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:7];
    NSTimer *timer = [NSTimer timerWithTimeInterval:0.03 repeats:YES block:^(NSTimer *probe) {
        NSWindow *modal = NSApp.modalWindow;
        if (modal.visible && !modal.sheetParent && !KeepworkSmokeMain.visible
            && KeepworkSmokeButtonWithTitle(modal.contentView, @"始终允许此来源截图")) {
            NSButton *cancel = KeepworkSmokeButtonWithTitle(modal.contentView, @"取消");
            if (cancel.enabled) {
                [probe invalidate];
                [cancel performClick:nil];
            }
        }
        if (deadline.timeIntervalSinceNow < 0) [probe invalidate];
    }];
    [NSRunLoop.mainRunLoop addTimer:timer forMode:NSDefaultRunLoopMode];
    [NSRunLoop.mainRunLoop addTimer:timer forMode:NSModalPanelRunLoopMode];
}

bool keepwork_startup_smoke_capture_main(void *rawWindow) {
    if (![NSThread isMainThread] || !rawWindow) return false;
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    KeepworkSmokeMain = window;
    KeepworkSmokeContent = window.contentView;
    KeepworkSmokeWebView = KeepworkSmokeFindWebView(window.contentView);
    return KeepworkSmokeWebView != nil;
}

bool keepwork_startup_smoke_main_intact(void *rawWindow) {
    if (![NSThread isMainThread] || !rawWindow) return false;
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    return window == KeepworkSmokeMain && window.contentView == KeepworkSmokeContent
        && KeepworkSmokeWebView && KeepworkSmokeWebView.window == window
        && KeepworkSmokeFindWebView(window.contentView) == KeepworkSmokeWebView;
}

// Override activation and foreground lookup only in this test process, retaining
// Tao's original object class and ivar layout. Prohibited policy prevents real windows from
// becoming visible and cannot verify the production show/hide path.
bool keepwork_startup_smoke_passive_application(void) {
    if (![NSThread isMainThread]) return false;
    Class original = object_getClass(NSApp);
    SEL activate = NSSelectorFromString(@"activateIgnoringOtherApps:");
    Method method = class_getInstanceMethod(original, activate);
    KeepworkSmokeFrontmostMethod = class_getInstanceMethod(
        object_getClass(NSWorkspace.sharedWorkspace), @selector(frontmostApplication));
    if (!method || !KeepworkSmokeFrontmostMethod) return false;
    KeepworkSmokeOriginalFrontmost = method_setImplementation(
        KeepworkSmokeFrontmostMethod, (IMP)KeepworkSmokeFrontmostApplication);
    KeepworkSmokeApplication = original;
    KeepworkSmokeOriginalActivation = method_getImplementation(method);
    KeepworkSmokeActivationType = method_getTypeEncoding(method);
    class_replaceMethod(original, activate, (IMP)KeepworkSmokeNoActivation, KeepworkSmokeActivationType);
    return true;
}

// Dispatch via AppKit's installed Tao delegate outside an active Tao callback,
// just as the Dock's reopen Apple event does. Only fixture windows are queried.
bool keepwork_startup_smoke_dock_reopen(bool expectedVisible) {
    if (![NSThread isMainThread]) return false;
    id<NSApplicationDelegate> delegate = NSApp.delegate;
    if (![delegate respondsToSelector:@selector(applicationShouldHandleReopen:hasVisibleWindows:)]) return false;
    BOOL visible = NO;
    for (NSWindow *window in NSApp.windows) {
        if (window.visible && !window.miniaturized) {
            visible = YES;
            break;
        }
    }
    if (visible != expectedVisible) return false;
    dispatch_async(dispatch_get_main_queue(), ^{
        [delegate applicationShouldHandleReopen:NSApp hasVisibleWindows:visible];
    });
    return true;
}

void keepwork_startup_smoke_restore_application(void) {
    if (KeepworkSmokeOriginalFrontmost) {
        method_setImplementation(KeepworkSmokeFrontmostMethod, KeepworkSmokeOriginalFrontmost);
    }
    if (KeepworkSmokeApplication && KeepworkSmokeOriginalActivation) {
        class_replaceMethod(KeepworkSmokeApplication, NSSelectorFromString(@"activateIgnoringOtherApps:"),
            KeepworkSmokeOriginalActivation, KeepworkSmokeActivationType);
    }
}

// The startup overlay is a native subview of the MAIN window's content view,
// above the WKWebView. There is no separate startup window to probe.
static NSView *KeepworkSmokeOverlay(NSWindow *window) {
    Class overlayClass = NSClassFromString(@"KeepworkStartupView");
    if (!overlayClass || !window) return nil;
    for (NSView *subview in window.contentView.subviews) {
        if ([subview isKindOfClass:overlayClass]) return subview;
    }
    return nil;
}

bool keepwork_startup_smoke_overlay_present(void *rawWindow) {
    if (![NSThread isMainThread] || !rawWindow) return false;
    return KeepworkSmokeOverlay((__bridge NSWindow *)rawWindow) != nil;
}

bool keepwork_startup_smoke_overlay_covers(void *rawWindow) {
    if (![NSThread isMainThread] || !rawWindow) return false;
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    NSView *overlay = KeepworkSmokeOverlay(window);
    return overlay && overlay.isOpaque && !overlay.hidden
        && window.contentView.subviews.lastObject == overlay
        && NSEqualRects(overlay.frame, window.contentView.bounds);
}

bool keepwork_startup_smoke_document_focused(void *rawWindow) {
    if (![NSThread isMainThread] || !rawWindow) return false;
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    NSResponder *responder = window.firstResponder;
    if (responder == KeepworkSmokeWebView) return true;
    return [responder isKindOfClass:NSView.class]
        && [(NSView *)responder isDescendantOf:KeepworkSmokeWebView];
}

bool keepwork_startup_smoke_action(void *rawWindow, unsigned int action) {
    if (![NSThread isMainThread] || !rawWindow) return false;
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    if (action == 0 || action == 3) {
        NSWindowButton type = action == 0 ? NSWindowCloseButton : NSWindowMiniaturizeButton;
        NSButton *button = [window standardWindowButton:type];
        if (!button || button.hidden || !button.enabled) return false;
        [button performClick:nil];
    } else if (action == 1) {
        NSView *overlay = KeepworkSmokeOverlay(window);
        if (!overlay) return false;
        NSEvent *escape = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint modifierFlags:0 timestamp:0
            windowNumber:window.windowNumber context:nil characters:@"\e"
            charactersIgnoringModifiers:@"\e" isARepeat:NO keyCode:53];
        // Route through the AppKit input interpreter so Escape reaches the
        // overlay's cancelOperation: exactly as a real key press would.
        [overlay interpretKeyEvents:@[escape]];
    } else if (action == 2) {
        NSView *overlay = KeepworkSmokeOverlay(window);
        if (!overlay || ![overlay respondsToSelector:NSSelectorFromString(@"retryButton")]) return false;
        NSButton *retry = [overlay valueForKey:@"retryButton"];
        if (!retry || retry.hidden || !retry.enabled) return false;
        [retry performClick:nil];
    } else return false;
    return true;
}
