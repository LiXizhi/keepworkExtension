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

bool keepwork_startup_smoke_action(void *rawWindow, unsigned int action) {
    if (![NSThread isMainThread] || !rawWindow) return false;
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    if (action == 0) {
        NSButton *close = [window standardWindowButton:NSWindowCloseButton];
        if (!close || close.hidden || !close.enabled) return false;
        [close performClick:nil];
    } else if (action == 1) {
        NSEvent *escape = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint modifierFlags:0 timestamp:0
            windowNumber:window.windowNumber context:nil characters:@"\e"
            charactersIgnoringModifiers:@"\e" isARepeat:NO keyCode:53];
        [window.contentView keyDown:escape];
    } else if (action == 2) {
        id view = window.contentView;
        if (![view respondsToSelector:NSSelectorFromString(@"retryButton")]) return false;
        NSButton *retry = [view valueForKey:@"retryButton"];
        if (!retry || retry.hidden || !retry.enabled) return false;
        [retry performClick:nil];
    } else return false;
    return true;
}
