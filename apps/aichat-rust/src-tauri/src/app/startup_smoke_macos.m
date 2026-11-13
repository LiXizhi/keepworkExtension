// Linked only into dev-bins builds. Drive this fixture's own AppKit controls;
// never synthesize global keyboard or mouse events or activate the application.
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#include <stdbool.h>

static void KeepworkSmokeNoActivation(id application, SEL selector, BOOL ignore) {
    (void)application; (void)selector; (void)ignore;
}

static Class KeepworkSmokeApplication;
static IMP KeepworkSmokeOriginalActivation;
static const char *KeepworkSmokeActivationType;
static __weak NSWindow *KeepworkSmokeMain;
static __weak NSView *KeepworkSmokeContent;
static __weak NSView *KeepworkSmokeWebView;

static NSView *KeepworkSmokeFindWebView(NSView *view) {
    Class webviewClass = NSClassFromString(@"WKWebView");
    if (webviewClass && [view isKindOfClass:webviewClass]) return view;
    for (NSView *child in view.subviews) {
        NSView *found = KeepworkSmokeFindWebView(child);
        if (found) return found;
    }
    return nil;
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

// Override only this process's activation selector, retaining Tao's original
// object class and ivar layout. Prohibited policy prevents real windows from
// becoming visible and cannot verify the production show/hide path.
bool keepwork_startup_smoke_passive_application(void) {
    if (![NSThread isMainThread]) return false;
    Class original = object_getClass(NSApp);
    SEL activate = NSSelectorFromString(@"activateIgnoringOtherApps:");
    Method method = class_getInstanceMethod(original, activate);
    if (!method) return false;
    KeepworkSmokeApplication = original;
    KeepworkSmokeOriginalActivation = method_getImplementation(method);
    KeepworkSmokeActivationType = method_getTypeEncoding(method);
    class_replaceMethod(original, activate, (IMP)KeepworkSmokeNoActivation, KeepworkSmokeActivationType);
    return true;
}

void keepwork_startup_smoke_restore_application(void) {
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
    if (action == 0) {
        NSButton *close = [window standardWindowButton:NSWindowCloseButton];
        if (!close || close.hidden || !close.enabled) return false;
        [close performClick:nil];
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
