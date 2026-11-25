#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <IOKit/hidsystem/IOLLEvent.h>
#import <IOKit/hidsystem/ev_keymap.h>
#include <stdbool.h>
#include <stdint.h>

extern int keepwork_voice_input_permissions(bool request);
extern bool keepwork_remote_event_from_selected_remote(CGEventRef event);

typedef enum {
    DemoNone, DemoUp, DemoDown, DemoLeft, DemoRight, DemoBack, DemoHome, DemoMenu,
    DemoVolume, DemoOK, DemoUnavailable, DemoEnded, DemoPower, DemoVoice, DemoControlCount
} DemoControl;
typedef void (*DemoReport)(void *, uint32_t, bool);

enum { KeyboardCodes = 128, MediaCodes = 32, TapCount = 3 };

typedef struct {
    CFMachPortRef port;
    CFRunLoopSourceRef source;
} DemoTap;

// The HID and session taps can both see a navigation key. Each stage
// must remember its own down so the matching up can pass both stages.
typedef struct {
    bool passed[KeyboardCodes];
    bool blocked[KeyboardCodes];
    bool modifierCaptured[KeyboardCodes];
} DemoKeyboardStage;

@interface KeepworkRemoteDemo : NSObject {
@public
    bool passed[KeyboardCodes];
    DemoKeyboardStage hardware;
    DemoKeyboardStage session;
    DemoControl held[KeyboardCodes + MediaCodes];
    uint16_t pressed[DemoControlCount];
    DemoTap taps[TapCount];
}
@property(nonatomic, weak) NSWindow *window;
@property(nonatomic) uint64_t token;
@property(nonatomic) DemoReport report;
@property(nonatomic) void *context;
@property(nonatomic) BOOL suspended;
@property(nonatomic) BOOL failed;
@property(nonatomic, strong) id localMonitor;
@property(nonatomic, strong) id windowBlur;
@property(nonatomic, strong) id appBlur;
@property(nonatomic, strong) id windowSheet;
@end

@implementation KeepworkRemoteDemo
@end

static KeepworkRemoteDemo *activeDemo;
static uint64_t nextToken = 1;

static BOOL ownsDemoWindow(NSWindow *window) {
    return window && window.isVisible && window.isKeyWindow && !window.attachedSheet
        && NSApp.isActive && NSApp.keyWindow == window;
}

static BOOL filtersEvents(KeepworkRemoteDemo *demo) {
    return !demo.suspended && ownsDemoWindow(demo.window);
}

static void reportEdge(KeepworkRemoteDemo *demo, unsigned source, DemoControl control, bool down) {
    DemoControl wasHeld = demo->held[source];
    if (down) {
        if (wasHeld != DemoNone || control == DemoNone) return;
        demo->held[source] = control;
        if (++demo->pressed[control] == 1) demo.report(demo.context, control, true);
    } else if (wasHeld != DemoNone) {
        demo->held[source] = DemoNone;
        if (--demo->pressed[wasHeld] == 0) demo.report(demo.context, wasHeld, false);
    }
}

static DemoControl keyboardControl(unsigned key) {
    switch (key) {
        case kVK_UpArrow: return DemoUp;
        case kVK_DownArrow: return DemoDown;
        case kVK_LeftArrow: return DemoLeft;
        case kVK_RightArrow: return DemoRight;
        case kVK_Return:
        case kVK_ANSI_KeypadEnter: return DemoOK;
        case kVK_Delete: return DemoBack;
        case kVK_Home: return DemoHome;
        case kVK_ContextualMenu: return DemoMenu;
        case kVK_F5: return DemoVoice;
        case kVK_VolumeUp:
        case kVK_VolumeDown:
        case kVK_Mute: return DemoVolume;
        default: return DemoNone;
    }
}

static BOOL safeKeyboardKey(unsigned key, NSEventModifierFlags flags) {
    // Tab and Shift+Tab move accessibility focus. The settings document
    // handles plain Escape and accessible activation of its own controls.
    NSEventModifierFlags shortcuts = flags & (NSEventModifierFlagCommand | NSEventModifierFlagControl
        | NSEventModifierFlagOption | NSEventModifierFlagShift);
    return key == kVK_Tab ? (shortcuts & ~NSEventModifierFlagShift) == 0
        : shortcuts == 0 && (key == kVK_Escape || key == kVK_Space);
}

static BOOL allowKeyboardEvent(KeepworkRemoteDemo *demo, unsigned key, NSEventModifierFlags flags,
    bool down, bool repeat) {
    if (key >= KeyboardCodes) return NO;
    if (!down) {
        BOOL wasPassed = demo->passed[key];
        demo->passed[key] = false;
        reportEdge(demo, key, DemoNone, false);
        return wasPassed;
    }
    if (safeKeyboardKey(key, flags)) {
        demo->passed[key] = true;
        return YES;
    }
    NSEventModifierFlags shortcuts = NSEventModifierFlagCommand | NSEventModifierFlagControl
        | NSEventModifierFlagOption | NSEventModifierFlagShift;
    if (!(flags & shortcuts) && !repeat) reportEdge(demo, key, keyboardControl(key), true);
    return NO;
}

static BOOL consumeMediaInput(KeepworkRemoteDemo *demo, NSEvent *event, CGEventRef source) {
    if (event.type != NSEventTypeSystemDefined) return NO;
    // Standalone power/menu notifications have no reliable up/down state.
    // The selected remote's HID report supplies those diagram edges.
    if (event.subtype == NX_SUBTYPE_POWER_KEY)
        return keepwork_remote_event_from_selected_remote(source);
    if (event.subtype == NX_SUBTYPE_EJECT_KEY || event.subtype == NX_SUBTYPE_MENU) return YES;
    if (event.subtype != NX_SUBTYPE_AUX_CONTROL_BUTTONS) return NO;
    uint32_t data = (uint32_t)event.data1;
    unsigned code = data >> 16;
    DemoControl control;
    switch (code) {
        case NX_KEYTYPE_SOUND_UP:
        case NX_KEYTYPE_SOUND_DOWN:
        case NX_KEYTYPE_MUTE: control = DemoVolume; break;
        case NX_KEYTYPE_MENU: control = DemoMenu; break;
        case NX_POWER_KEY:
            if (!keepwork_remote_event_from_selected_remote(source)) return NO;
            control = DemoPower;
            break;
        // Other auxiliary buttons have no matching hotspot. Consume their
        // system operation without using an unknown code as a feedback index.
        default: return YES;
    }
    // NX_SYSDEFINED auxiliary controls encode key state in the next byte.
    unsigned state = (data >> 8) & 0xff;
    if (state == NX_KEYDOWN || state == NX_KEYUP) {
        reportEdge(demo, KeyboardCodes + code, control, state == NX_KEYDOWN);
    }
    return YES;
}

static BOOL consumeMediaEvent(KeepworkRemoteDemo *demo, NSEvent *event) {
    return consumeMediaInput(demo, event, event.CGEvent);
}

static id installLocalMonitor(KeepworkRemoteDemo *demo) {
    __weak KeepworkRemoteDemo *weak = demo;
    return [NSEvent addLocalMonitorForEventsMatchingMask:(NSEventMaskKeyDown | NSEventMaskKeyUp
        | NSEventMaskSystemDefined | NSEventMaskOtherMouseDown | NSEventMaskOtherMouseUp)
        handler:^NSEvent *(NSEvent *event) {
        KeepworkRemoteDemo *current = weak;
        if (!current || !filtersEvents(current) || (event.window && event.window != current.window)) return event;
        if (event.type == NSEventTypeSystemDefined) {
            return consumeMediaEvent(current, event) ? nil : event;
        }
        if (event.type == NSEventTypeOtherMouseDown || event.type == NSEventTypeOtherMouseUp) {
            // WebKit handles mouse Back/Forward before ordinary DOM clicks.
            return event.window == current.window && event.buttonNumber > 2 ? nil : event;
        }
        bool down = event.type == NSEventTypeKeyDown;
        return allowKeyboardEvent(current, event.keyCode, event.modifierFlags, down, down && event.isARepeat)
            ? event : nil;
    }];
}

static CGEventFlags modifierFlag(unsigned key, CGEventFlags flags) {
    switch (key) {
        case kVK_Command:
        case kVK_RightCommand:
            if (!(flags & (NX_DEVICELCMDKEYMASK | NX_DEVICERCMDKEYMASK))) return kCGEventFlagMaskCommand;
            return key == kVK_Command ? NX_DEVICELCMDKEYMASK : NX_DEVICERCMDKEYMASK;
        case kVK_Control:
        case kVK_RightControl:
            if (!(flags & (NX_DEVICELCTLKEYMASK | NX_DEVICERCTLKEYMASK))) return kCGEventFlagMaskControl;
            return key == kVK_Control ? NX_DEVICELCTLKEYMASK : NX_DEVICERCTLKEYMASK;
        case kVK_Option:
        case kVK_RightOption:
            if (!(flags & (NX_DEVICELALTKEYMASK | NX_DEVICERALTKEYMASK))) return kCGEventFlagMaskAlternate;
            return key == kVK_Option ? NX_DEVICELALTKEYMASK : NX_DEVICERALTKEYMASK;
        case kVK_Shift:
        case kVK_RightShift:
            if (!(flags & (NX_DEVICELSHIFTKEYMASK | NX_DEVICERSHIFTKEYMASK))) return kCGEventFlagMaskShift;
            return key == kVK_Shift ? NX_DEVICELSHIFTKEYMASK : NX_DEVICERSHIFTKEYMASK;
        case kVK_Function: return kCGEventFlagMaskSecondaryFn;
        case kVK_CapsLock: return kCGEventFlagMaskAlphaShift;
        default: return 0;
    }
}

static CGEventRef filterDemoInput(KeepworkRemoteDemo *demo, DemoKeyboardStage *stage,
    CGEventType type, CGEventRef event) {
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        // Defer signalling to avoid tearing down this Mach port from its callback.
        if (!demo.failed && filtersEvents(demo)) {
            demo.failed = YES;
            dispatch_async(dispatch_get_main_queue(), ^{
                if (activeDemo == demo) demo.report(demo.context, DemoUnavailable, false);
            });
        }
        return event;
    }
    if (!filtersEvents(demo)) return event;
    if (type == kCGEventKeyDown || type == kCGEventKeyUp || type == kCGEventFlagsChanged) {
        int64_t key = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
        if (key < 0 || key >= KeyboardCodes) return NULL;
        CGEventFlags flags = CGEventGetFlags(event);
        if (type == kCGEventFlagsChanged) {
            CGEventFlags flag = modifierFlag((unsigned)key, flags);
            if (flag && (flags & flag)) {
                stage->modifierCaptured[key] = true;
                return NULL;
            }
            // An earlier modifier down may have reached AppKit before entry.
            // Its corresponding release must still clear the earlier state.
            bool captured = stage->modifierCaptured[key];
            stage->modifierCaptured[key] = false;
            return captured ? NULL : event;
        }
        if (type == kCGEventKeyUp) {
            bool wasPassed = stage->passed[key];
            stage->passed[key] = false;
            stage->blocked[key] = false;
            reportEdge(demo, (unsigned)key, DemoNone, false);
            return wasPassed ? event : NULL;
        }
        if (stage->blocked[key]) return NULL;
        if (safeKeyboardKey((unsigned)key, (NSEventModifierFlags)flags)) {
            stage->passed[key] = true;
            return event;
        }
        bool repeat = CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) != 0;
        if (!repeat) {
            stage->blocked[key] = true;
            CGEventFlags shortcuts = kCGEventFlagMaskCommand | kCGEventFlagMaskControl
                | kCGEventFlagMaskAlternate | kCGEventFlagMaskShift;
            if (!(flags & shortcuts)) reportEdge(demo, (unsigned)key, keyboardControl((unsigned)key), true);
        }
        return NULL;
    }
    NSEvent *media = [NSEvent eventWithCGEvent:event];
    return media && consumeMediaInput(demo, media, event) ? NULL : event;
}

static CGEventRef filterHardwareInput(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *raw) {
    (void)proxy;
    KeepworkRemoteDemo *demo = (__bridge KeepworkRemoteDemo *)raw;
    return filterDemoInput(demo, &demo->hardware, type, event);
}

// Events posted directly to the login session bypass the hardware tap.
static CGEventRef filterSessionInput(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *raw) {
    (void)proxy;
    KeepworkRemoteDemo *demo = (__bridge KeepworkRemoteDemo *)raw;
    return filterDemoInput(demo, &demo->session, type, event);
}

static void uninstall(KeepworkRemoteDemo *demo) {
    demo.suspended = YES;
    if (demo.localMonitor) [NSEvent removeMonitor:demo.localMonitor];
    NSNotificationCenter *notifications = NSNotificationCenter.defaultCenter;
    if (demo.windowBlur) [notifications removeObserver:demo.windowBlur];
    if (demo.appBlur) [notifications removeObserver:demo.appBlur];
    if (demo.windowSheet) [notifications removeObserver:demo.windowSheet];
    for (unsigned i = 0; i < TapCount; i++) {
        DemoTap tap = demo->taps[i];
        if (tap.source) {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), tap.source, kCFRunLoopCommonModes);
            CFRelease(tap.source);
        }
        if (tap.port) {
            CFMachPortInvalidate(tap.port);
            CFRelease(tap.port);
        }
    }
}

static bool prepareTap(KeepworkRemoteDemo *demo, DemoTap *tap, CGEventTapLocation location,
    CGEventMask mask, CGEventTapCallBack callback) {
    tap->port = CGEventTapCreate(location, kCGHeadInsertEventTap, kCGEventTapOptionDefault,
        mask, callback, (__bridge void *)demo);
    if (!tap->port) return false;
    tap->source = CFMachPortCreateRunLoopSource(NULL, tap->port, 0);
    return tap->source && CGEventTapIsEnabled(tap->port);
}

static void suspendDemo(KeepworkRemoteDemo *demo) {
    if (!demo || demo.suspended) return;
    demo.suspended = YES;
    demo.report(demo.context, DemoEnded, false);
}

static int startDemo(NSWindow *window, DemoReport report, void *context, uint64_t *token) {
    if (!ownsDemoWindow(window)) return 3;
    int permission = keepwork_voice_input_permissions(false);
    if (permission) return permission;
    if (activeDemo) return 4;
    KeepworkRemoteDemo *demo = [KeepworkRemoteDemo new];
    demo.window = window;
    demo.token = nextToken++;
    demo.report = report;
    demo.context = context;
    // Keep separate masks so an unavailable media tap cannot silently fall
    // back to keyboard-only filtering when the OS strips unsupported bits.
    CGEventMask keys = CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp)
        | CGEventMaskBit(kCGEventFlagsChanged);
    CGEventMask media = CGEventMaskBit((CGEventType)NSEventTypeSystemDefined);
    if (!prepareTap(demo, &demo->taps[0], kCGSessionEventTap, keys, filterSessionInput)
        || !prepareTap(demo, &demo->taps[1], kCGSessionEventTap, media, filterSessionInput)
        || !prepareTap(demo, &demo->taps[2], kCGHIDEventTap, keys | media, filterHardwareInput)) {
        uninstall(demo);
        return 4;
    }
    demo.localMonitor = installLocalMonitor(demo);
    if (!demo.localMonitor) {
        uninstall(demo);
        return 4;
    }
    NSNotificationCenter *notifications = NSNotificationCenter.defaultCenter;
    __weak KeepworkRemoteDemo *weak = demo;
    demo.windowBlur = [notifications addObserverForName:NSWindowDidResignKeyNotification object:window
        queue:nil usingBlock:^(__unused NSNotification *note) { suspendDemo(weak); }];
    demo.appBlur = [notifications addObserverForName:NSApplicationDidResignActiveNotification object:NSApp
        queue:nil usingBlock:^(__unused NSNotification *note) { suspendDemo(weak); }];
    demo.windowSheet = [notifications addObserverForName:NSWindowWillBeginSheetNotification object:window
        queue:nil usingBlock:^(__unused NSNotification *note) { suspendDemo(weak); }];
    activeDemo = demo;
    for (unsigned i = 0; i < TapCount; i++) {
        CFRunLoopAddSource(CFRunLoopGetMain(), demo->taps[i].source, kCFRunLoopCommonModes);
    }
    *token = demo.token;
    return 0;
}

int keepwork_remote_demo_start(void *rawWindow, DemoReport report, void *context, uint64_t *token) {
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    if (NSThread.isMainThread) return startDemo(window, report, context, token);
    __block int result;
    dispatch_sync(dispatch_get_main_queue(), ^{ result = startDemo(window, report, context, token); });
    return result;
}

void keepwork_remote_demo_stop(uint64_t token) {
    void (^stop)(void) = ^{
        KeepworkRemoteDemo *demo = activeDemo;
        if (!demo || demo.token != token) return;
        activeDemo = nil;
        uninstall(demo);
    };
    if (NSThread.isMainThread) stop();
    else dispatch_sync(dispatch_get_main_queue(), stop);
}
