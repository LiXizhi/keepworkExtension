#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import "chromium_ax_macos.h"
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef struct {
    pthread_t thread;
    pthread_mutex_t mutex;
    pthread_cond_t condition;
    atomic_bool enabled;
    bool ready;
    bool success;
    bool detached;
    bool cancelled;
    CFRunLoopRef runloop;
} KeepworkVoiceTap;

static pthread_mutex_t lifecycle = PTHREAD_MUTEX_INITIALIZER;
static KeepworkVoiceTap *currentTap;

// A session tap ordinarily has no public keyboard-device field. Newer macOS
// exports can recover the underlying HID sender. Unknown senders pass through.
extern CFTypeRef CGEventCopyIOHIDEvent(CGEventRef) __attribute__((weak_import));
extern uint64_t IOHIDEventGetSenderID(CFTypeRef) __attribute__((weak_import));
extern bool keepwork_remote_home_sender(uint64_t sender);
extern bool keepwork_remote_dialogue_ok_edge(bool down) __attribute__((weak_import));

bool keepwork_remote_event_from_selected_remote(CGEventRef event) {
    if (!event || !CGEventCopyIOHIDEvent || !IOHIDEventGetSenderID) return false;
    CFTypeRef hid = CGEventCopyIOHIDEvent(event);
    if (!hid) return false;
    uint64_t sender = IOHIDEventGetSenderID(hid);
    CFRelease(hid);
    return sender && keepwork_remote_home_sender(sender);
}

// The global tap has first refusal for a visible pet or an active voice call.
// The local monitor handles only an identified remote Return in the chat window.
static bool consumeMainNarrationOK(CGEventRef source, bool down, bool repeat, bool chatKeyWindow,
    bool modified, bool *held, bool (*pause)(void)) {
    if (!source || !keepwork_remote_event_from_selected_remote(source)) return false;
    if (!down) {
        bool consumed = *held;
        *held = false;
        return consumed;
    }
    if (repeat) return *held;
    *held = chatKeyWindow && !modified && pause();
    return *held;
}

void keepwork_watch_main_narration_ok(void *rawWindow, bool (*handler)(void)) {
    __weak NSWindow *main = (__bridge NSWindow *)rawWindow;
    __block bool held = false;
    [NSEvent addLocalMonitorForEventsMatchingMask:(NSEventMaskKeyDown | NSEventMaskKeyUp)
        handler:^NSEvent *(NSEvent *event) {
        if (event.keyCode != 36 && event.keyCode != 76) return event;
        bool chat = main && main.isKeyWindow && event.window == main && !main.attachedSheet;
        bool modified = (event.modifierFlags & (NSEventModifierFlagCommand | NSEventModifierFlagControl |
            NSEventModifierFlagOption | NSEventModifierFlagShift)) != 0;
        return consumeMainNarrationOK(event.CGEvent, event.type == NSEventTypeKeyDown, event.isARepeat,
            chat, modified, &held, handler) ? nil : event;
    }];
}

static CGEventRef voiceKey(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *raw) {
    (void)proxy;
    KeepworkVoiceTap *tap = raw;
    if (!atomic_load_explicit(&tap->enabled, memory_order_acquire)) return event;
    // F5 (hardware keycode 96) is intentionally reserved process-wide while
    // this user-enabled ATVV session is ready. No device distinction is claimed.
    if (type == kCGEventKeyDown || type == kCGEventKeyUp) {
        int64_t key = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
        if (key == 96 || (key == 115 && keepwork_remote_event_from_selected_remote(event))) return NULL;
        if ((key == 36 || key == 76) && keepwork_remote_dialogue_ok_edge && keepwork_remote_event_from_selected_remote(event)
            && keepwork_remote_dialogue_ok_edge(type == kCGEventKeyDown)) return NULL;
    }
    return event;
}

static void freeTap(KeepworkVoiceTap *tap) {
    pthread_cond_destroy(&tap->condition);
    pthread_mutex_destroy(&tap->mutex);
    free(tap);
}

static void *tapThread(void *raw) {
    @autoreleasepool {
        KeepworkVoiceTap *tap = raw;
        CFMachPortRef port = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
            kCGEventTapOptionDefault,
            CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp), voiceKey, tap);
        CFRunLoopSourceRef source = port ? CFMachPortCreateRunLoopSource(NULL, port, 0) : NULL;
        CFRunLoopRef runloop = CFRunLoopGetCurrent();
        if (source) CFRunLoopAddSource(runloop, source, kCFRunLoopDefaultMode);
        pthread_mutex_lock(&tap->mutex);
        tap->runloop = runloop;
        CFRetain(runloop);
        tap->ready = true;
        tap->success = port && source && !tap->cancelled;
        atomic_store_explicit(&tap->enabled, tap->success, memory_order_release);
        pthread_cond_signal(&tap->condition);
        pthread_mutex_unlock(&tap->mutex);
        while (atomic_load_explicit(&tap->enabled, memory_order_acquire)) {
            // A bounded loop also handles stop arriving just before its first
            // iteration, without relying on CFRunLoopStop-before-Run semantics.
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, false);
            if (port && !CGEventTapIsEnabled(port)) {
                if (AXIsProcessTrusted()) CGEventTapEnable(port, true);
                else atomic_store_explicit(&tap->enabled, false, memory_order_release);
            }
        }
        if (source) {
            CFRunLoopRemoveSource(runloop, source, kCFRunLoopDefaultMode);
            CFRelease(source);
        }
        if (port) {
            CFMachPortInvalidate(port);
            CFRelease(port);
        }
        pthread_mutex_lock(&tap->mutex);
        tap->runloop = NULL;
        bool detached = tap->detached;
        pthread_mutex_unlock(&tap->mutex);
        CFRelease(runloop);
        if (detached) freeTap(tap);
        return NULL;
    }
}

// Only the explicit Start action may pass request=true. Request one missing
// grant per click and return while the user completes it in System Settings.
int keepwork_voice_input_permissions(bool request) {
    if (!AXIsProcessTrusted()) {
        if (!request) return 1;
        NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES};
        if (!AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options)) return 1;
    }
    if (@available(macOS 10.15, *)) {
        if (!CGPreflightListenEventAccess() && (!request || !CGRequestListenEventAccess())) return 2;
    }
    return 0;
}

// 0 success, 1 Accessibility, 2 Input Monitoring, 3 already owned, 4 failure.
int keepwork_voice_input_start(void) {
    int permission = keepwork_voice_input_permissions(false);
    if (permission) return permission;
    pthread_mutex_lock(&lifecycle);
    if (currentTap) { pthread_mutex_unlock(&lifecycle); return 3; }
    KeepworkVoiceTap *tap = calloc(1, sizeof(*tap));
    if (!tap) { pthread_mutex_unlock(&lifecycle); return 4; }
    pthread_mutex_init(&tap->mutex, NULL);
    pthread_cond_init(&tap->condition, NULL);
    atomic_init(&tap->enabled, false);
    if (pthread_create(&tap->thread, NULL, tapThread, tap) != 0) {
        freeTap(tap);
        pthread_mutex_unlock(&lifecycle);
        return 4;
    }
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += 2;
    pthread_mutex_lock(&tap->mutex);
    while (!tap->ready) {
        if (pthread_cond_timedwait(&tap->condition, &tap->mutex, &deadline) != 0) break;
    }
    if (!tap->ready) {
        tap->cancelled = true;
        tap->detached = true;
        atomic_store_explicit(&tap->enabled, false, memory_order_release);
        pthread_detach(tap->thread);
        pthread_mutex_unlock(&tap->mutex);
        pthread_mutex_unlock(&lifecycle);
        // The detached startup thread owns and releases the cancelled context.
        return 4;
    }
    bool success = tap->success;
    pthread_mutex_unlock(&tap->mutex);
    if (success) currentTap = tap;
    else { pthread_join(tap->thread, NULL); freeTap(tap); }
    pthread_mutex_unlock(&lifecycle);
    return success ? 0 : 4;
}

void keepwork_voice_input_stop(void) {
    pthread_mutex_lock(&lifecycle);
    KeepworkVoiceTap *tap = currentTap;
    currentTap = NULL;
    if (tap) {
        atomic_store_explicit(&tap->enabled, false, memory_order_release);
        pthread_mutex_lock(&tap->mutex);
        if (tap->runloop) CFRunLoopWakeUp(tap->runloop);
        pthread_mutex_unlock(&tap->mutex);
        pthread_join(tap->thread, NULL);
        freeTap(tap);
    }
    pthread_mutex_unlock(&lifecycle);
}

bool keepwork_voice_input_modifiers(void) {
    CGEventFlags flags = CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState);
    return (flags & (kCGEventFlagMaskCommand | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskShift)) != 0;
}

bool keepwork_voice_input_copy(const char *bytes, size_t length) {
    @autoreleasepool {
        NSString *text = [[NSString alloc] initWithBytes:bytes length:length encoding:NSUTF8StringEncoding];
        if (!text) return false;
        NSPasteboard *clipboard = NSPasteboard.generalPasteboard;
        [clipboard clearContents];
        return [clipboard setString:text forType:NSPasteboardTypeString];
    }
}

static bool postKeyboardPair(CGKeyCode key, CGEventFlags flags) {
    if (!AXIsProcessTrusted()) return false;
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, key, true);
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, key, false);
    if (!down || !up) {
        if (down) CFRelease(down);
        if (up) CFRelease(up);
        return false;
    }
    CGEventSetFlags(down, flags);
    CGEventSetFlags(up, flags);
    CGEventPost(kCGHIDEventTap, down);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(down);
    CFRelease(up);
    return true;
}

// Cmd+V is delivered by the keyboard responder. Only remember its dispatch
// time so an immediate Back can let the renderer publish its new AX state.
static _Atomic(uint64_t) dictationPostedAt;
static _Atomic(pid_t) dictationPostedTo;

bool keepwork_voice_input_paste(void) {
    pid_t pid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    bool posted = postKeyboardPair(9, kCGEventFlagMaskCommand);
    if (posted) {
        atomic_store(&dictationPostedTo, pid);
        atomic_store(&dictationPostedAt, clock_gettime_nsec_np(CLOCK_UPTIME_RAW));
    }
    return posted;
}

bool keepwork_voice_input_submit(void) {
    return postKeyboardPair(36, 0);
}

static AXUIElementRef copyAXElement(AXUIElementRef owner, CFStringRef attribute, AXError *status) {
    CFTypeRef element = NULL;
    *status = AXUIElementCopyAttributeValue(owner, attribute, &element);
    if (*status == kAXErrorSuccess && element && CFGetTypeID(element) == AXUIElementGetTypeID())
        return (AXUIElementRef)element;
    if (element) CFRelease(element);
    return NULL;
}

static AXUIElementRef copyFocusedInput(AXUIElementRef owner) {
    AXError status;
    return copyAXElement(owner, kAXFocusedUIElementAttribute, &status);
}

static bool writableAXAttribute(AXUIElementRef field, CFStringRef attribute) {
    Boolean writable = false;
    return AXUIElementIsAttributeSettable(field, attribute, &writable) == kAXErrorSuccess && writable;
}

static bool ordinaryTextField(AXUIElementRef input) {
    CFTypeRef role = NULL, subrole = NULL, enabled = NULL;
    AXError subroleStatus = AXUIElementCopyAttributeValue(input, kAXSubroleAttribute, &subrole);
    bool ordinary = subroleStatus == kAXErrorNoValue || subroleStatus == kAXErrorAttributeUnsupported ||
        (subroleStatus == kAXErrorSuccess && subrole && CFGetTypeID(subrole) == CFStringGetTypeID() &&
         !CFEqual(subrole, kAXSecureTextFieldSubrole));
    bool editable = ordinary && AXUIElementCopyAttributeValue(input, kAXRoleAttribute, &role) == kAXErrorSuccess &&
        role && (CFEqual(role, kAXTextFieldRole) || CFEqual(role, kAXTextAreaRole)) &&
        AXUIElementCopyAttributeValue(input, kAXEnabledAttribute, &enabled) == kAXErrorSuccess &&
        enabled && CFEqual(enabled, kCFBooleanTrue);
    if (enabled) CFRelease(enabled);
    if (subrole) CFRelease(subrole);
    if (role) CFRelease(role);
    return editable;
}

static pid_t backFrontmostPid(void) {
    return NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
}

static _Atomic(uint64_t) backEpoch;

void keepwork_voice_interrupt_back(void) {
    atomic_fetch_add_explicit(&backEpoch, 1, memory_order_release);
}

typedef struct {
    pid_t pid;
    uint64_t epoch;
    uint64_t start;
    double timeout;
    AXUIElementRef system;
} BackPress;

static double backElapsed(BackPress press) {
    return (clock_gettime_nsec_np(CLOCK_UPTIME_RAW) - press.start) / 1e9;
}

static bool backPressCurrent(BackPress press) {
    double elapsed = backElapsed(press);
    return atomic_load_explicit(&backEpoch, memory_order_acquire) == press.epoch &&
        backFrontmostPid() == press.pid && elapsed < press.timeout &&
        CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGEventKeyDown) >= elapsed &&
        CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGEventLeftMouseDown) >= elapsed &&
        CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGEventRightMouseDown) >= elapsed;
}

static bool pendingBrowserAX(AXError status) {
    return status == kAXErrorNoValue || status == kAXErrorCannotComplete ||
        status == kAXErrorAttributeUnsupported || status == kAXErrorSuccess;
}

static bool backFocusPending(AXUIElementRef field, AXError status, KeepworkChromiumHost host) {
    if (!field) return host == KeepworkOtherHost ? status == kAXErrorNoValue : pendingBrowserAX(status);
    bool chromium = host != KeepworkOtherHost;
    CFTypeRef role = NULL;
    status = AXUIElementCopyAttributeValue(field, kAXRoleAttribute, &role);
    bool placeholder = !role ? chromium && pendingBrowserAX(status) : CFEqual(role, CFSTR("AXWebArea")) ||
        (chromium && (CFEqual(role, kAXApplicationRole) || CFEqual(role, kAXWindowRole) || CFEqual(role, kAXGroupRole)));
    if (role) CFRelease(role);
    return placeholder;
}

// Keyboard input follows system focus. App-local AX may still expose the
// webview wrapper after a field receives keyboard or programmatic focus.
static AXUIElementRef copyBackFocus(AXUIElementRef app, BackPress press, AXError *status) {
    AXUIElementRef active = press.system ? copyAXElement(press.system, kAXFocusedApplicationAttribute, status) : NULL;
    if (active) {
        bool foreground = CFEqual(active, app);
        CFRelease(active);
        if (!foreground) { *status = kAXErrorInvalidUIElement; return NULL; }
        AXUIElementRef keyboard = copyAXElement(press.system, kAXFocusedUIElementAttribute, status);
        if (keyboard) {
            if (!backFocusPending(keyboard, *status, KeepworkChromiumBrowser)) {
                AXUIElementRef owner = copyAXElement(keyboard, kAXWindowAttribute, status);
                AXUIElementRef frontWindow = copyAXElement(app, kAXFocusedWindowAttribute, status);
                pid_t fieldPid = 0;
                // A WK remote accessibility object can be owned by its content
                // process. Its containing window must still be the focused window.
                bool belongs = owner && frontWindow ? CFEqual(owner, frontWindow) :
                    AXUIElementGetPid(keyboard, &fieldPid) == kAXErrorSuccess && fieldPid == press.pid;
                if (owner) CFRelease(owner);
                if (frontWindow) CFRelease(frontWindow);
                CFTypeRef focused = NULL;
                if (AXUIElementCopyAttributeValue(keyboard, kAXFocusedAttribute, &focused) == kAXErrorSuccess &&
                    focused && CFEqual(focused, kCFBooleanFalse)) belongs = false;
                if (focused) CFRelease(focused);
                if (belongs) { *status = kAXErrorSuccess; return keyboard; }
                CFRelease(keyboard);
                *status = kAXErrorInvalidUIElement;
                return NULL;
            }
            CFRelease(keyboard);
        }
    }
    return copyAXElement(app, kAXFocusedUIElementAttribute, status);
}

// A cold WebKit/Chromium tree can report no field, or a browser wrapper,
// before the actual focused element arrives. Pin the window during this wait.
static AXUIElementRef copyBackField(AXUIElementRef app, KeepworkChromiumHost host, BackPress *press, int *result) {
    AXError status;
    AXUIElementRef field = copyBackFocus(app, *press, &status);
    if (!backFocusPending(field, status, host)) {
        if (!field && status == kAXErrorInvalidUIElement) *result = 5;
        return field;
    }
    if (field) CFRelease(field);
    field = NULL;
    bool chromium = host != KeepworkOtherHost;
    AXUIElementRef window = copyAXElement(app, kAXFocusedWindowAttribute, &status);
    // Electron may expose its main window before it exposes AXFocusedWindow.
    // Require that same object to become the focused window before editing.
    if (!window && chromium && pendingBrowserAX(status)) window = copyAXElement(app, kAXMainWindowAttribute, &status);
    if (!window) return NULL;
    // Electron's full tree has a two-second debounce plus renderer startup.
    // Give discovery a wall-clock budget, with time reserved for the actual edit.
    if (chromium) press->timeout = 4.5;
    bool requested = enableChromiumTree(app, host, ^bool { return backPressCurrent(*press); });
    unsigned optInProbes = 1;
    double discoveryDeadline = chromium ? 4.0 : 0.3;
    while (backElapsed(*press) < discoveryDeadline) {
        usleep(90000);
        if (!backPressCurrent(*press)) { *result = 5; break; }
        AXUIElementRef current = copyAXElement(app, kAXFocusedWindowAttribute, &status);
        // IPC may time out while the renderer starts. Keep the original window
        // pinned and suspend field resolution until its identity is confirmed.
        if (!current && chromium && pendingBrowserAX(status)) continue;
        bool sameWindow = current && CFEqual(window, current);
        if (current) CFRelease(current);
        if (!sameWindow) { *result = 5; break; }
        field = copyBackFocus(app, *press, &status);
        if (!backFocusPending(field, status, host)) {
            if (!field && status == kAXErrorInvalidUIElement) *result = 5;
            break;
        }
        if (field) CFRelease(field);
        field = NULL;
        // A startup timeout in the initial read-only flag probe can recover.
        // Once a setter was dispatched, repeating it would restart Electron's timer.
        if (chromium && !requested && optInProbes++ < 3)
            requested = enableChromiumTree(app, host, ^bool { return backPressCurrent(*press); });
    }
    CFRelease(window);
    return field;
}

static int backFieldStatus(AXUIElementRef app, AXUIElementRef field, BackPress press) {
    AXError status;
    AXUIElementRef now = copyBackFocus(app, press, &status);
    bool same = now && CFEqual(field, now);
    if (now) CFRelease(now);
    if (!same || !backPressCurrent(press)) return 5;
    return keepwork_voice_input_modifiers() ? 3 : 0;
}

// Only read numeric metadata, never the field's value or selected text.
static CFIndex backCharacterCount(AXUIElementRef field) {
    CFTypeRef number = NULL;
    CFIndex count = -1;
    if (AXUIElementCopyAttributeValue(field, kAXNumberOfCharactersAttribute, &number) == kAXErrorSuccess &&
        number && CFGetTypeID(number) == CFNumberGetTypeID()) {
        if (!CFNumberGetValue(number, kCFNumberCFIndexType, &count)) count = -1;
    }
    if (number) CFRelease(number);
    return count;
}

// Chromium's AXNumberOfCharacters uses the accessible value, which can add
// paragraph separators. AXSelectedTextRange measures the text marker range.
static CFIndex backSelectionLength(AXUIElementRef field, CFIndex fallback) {
    CFTypeRef markers = NULL, number = NULL;
    CFIndex length = fallback;
    if (AXUIElementCopyParameterizedAttributeValue(field, CFSTR("AXTextMarkerRangeForUIElement"),
        field, &markers) == kAXErrorSuccess && markers &&
        AXUIElementCopyParameterizedAttributeValue(field, CFSTR("AXLengthForTextMarkerRange"),
        markers, &number) == kAXErrorSuccess && number && CFGetTypeID(number) == CFNumberGetTypeID()) {
        if (!CFNumberGetValue(number, kCFNumberCFIndexType, &length)) length = -1;
    }
    if (markers) CFRelease(markers);
    if (number) CFRelease(number);
    return length;
}

static bool backRangeFromStart(AXUIElementRef field, CFIndex length) {
    CFTypeRef value = NULL;
    CFRange range;
    bool full = AXUIElementCopyAttributeValue(field, kAXSelectedTextRangeAttribute, &value) == kAXErrorSuccess &&
        value && CFGetTypeID(value) == AXValueGetTypeID() &&
        AXValueGetValue(value, kAXValueCFRangeType, &range) && range.location == 0 && range.length == length;
    if (value) CFRelease(value);
    return full;
}

// Chromium may retain a <p><br></p> or a bare <br> after deletion.
// An editor with no AX children can also contain a real character, so that
// shape is only evidence of completion after a verified whole-field deletion.
static bool chromiumEmptyStructure(AXUIElementRef field, bool justDeleted) {
    CFTypeRef children = NULL, subrole = NULL;
    bool placeholder = false;
    if (AXUIElementCopyAttributeValue(field, kAXChildrenAttribute, &children) == kAXErrorSuccess && children &&
        CFGetTypeID(children) == CFArrayGetTypeID()) {
        CFIndex count = CFArrayGetCount(children);
        if (count == 0) placeholder = justDeleted;
        if (count == 1) {
            AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, 0);
            placeholder = CFGetTypeID(child) == AXUIElementGetTypeID() &&
                AXUIElementCopyAttributeValue(child, kAXSubroleAttribute, &subrole) == kAXErrorSuccess &&
                subrole && CFEqual(subrole, CFSTR("AXEmptyGroup"));
        }
    }
    if (subrole) CFRelease(subrole);
    if (children) CFRelease(children);
    return placeholder;
}

static int postBackspaceToField(AXUIElementRef app, AXUIElementRef field, BackPress press) {
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, 51, true);
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, 51, false);
    int status = down && up ? backFieldStatus(app, field, press) : 2;
    if (!status) {
        CGEventSetFlags(down, 0);
        CGEventSetFlags(up, 0);
        CGEventPostToPid(press.pid, down);
        CGEventPostToPid(press.pid, up);
    }
    if (down) CFRelease(down);
    if (up) CFRelease(up);
    return status;
}

// AXValue="" can change Chromium's DOM without delivering an input event to
// the editor model. Use its normal editing path, including one undoable deletion.
static int clearBackSelection(AXUIElementRef app, AXUIElementRef field, BackPress press, bool chromium) {
    // Paste goes through an event queue and the accessibility tree updates
    // asynchronously. Never treat its previous empty state as a completed clear.
    uint64_t paste = atomic_load(&dictationPostedAt);
    if (paste && press.pid == atomic_load(&dictationPostedTo)) {
        while (clock_gettime_nsec_np(CLOCK_UPTIME_RAW) - paste < 180000000) {
            if (!backPressCurrent(press)) return 5;
            usleep(12000);
        }
    }
    CFIndex count = backCharacterCount(field);
    CFIndex length = chromium ? backSelectionLength(field, count) : count;
    if (count < 0 || length < 0) return 1;
    // A zero marker length cannot establish emptiness when the text count is positive.
    if (length == 0 && count != 0) length = count;
    int status = backFieldStatus(app, field, press);
    if (status || length == 0) return status;
    if (chromium && count == 1 && length == 1 && chromiumEmptyStructure(field, false)) return 0;

    CFRange all = CFRangeMake(0, length);
    AXValueRef selection = AXValueCreate(kAXValueCFRangeType, &all);
    if (!selection) return 2;
    AXError selected = AXUIElementSetAttributeValue(field, kAXSelectedTextRangeAttribute, selection);
    CFRelease(selection);
    if (selected != kAXErrorSuccess) return 2;

    // Editors apply selection asynchronously. A stale or partial selection
    // must never turn into a destructive edit.
    for (int attempt = 0; attempt < 10; attempt++) {
        bool full = backRangeFromStart(field, length) && backCharacterCount(field) == count;
        if (full && (!ordinaryTextField(field) || !(writableAXAttribute(field, kAXValueAttribute) ||
            writableAXAttribute(field, kAXSelectedTextAttribute)))) return 1;
        status = backFieldStatus(app, field, press);
        if (status) return status;
        if (full) {
            if (chromium) {
                status = postBackspaceToField(app, field, press);
                if (status) return status;
            } else if (AXUIElementSetAttributeValue(field, kAXSelectedTextAttribute, CFSTR("")) != kAXErrorSuccess) {
                return 2;
            }
            // Never repeat the edit, even if the provider times out or refuses it.
            for (int check = 0; check < 10 && backElapsed(press) < press.timeout; check++) {
                CFIndex remaining = backCharacterCount(field);
                if (remaining == 0) return 0;
                if (chromium && remaining == 1 && backRangeFromStart(field, 0) &&
                    chromiumEmptyStructure(field, true)) return 0;
                usleep(12000);
            }
            return 2;
        }
        usleep(12000);
    }
    return 2;
}

int keepwork_voice_input_clear_back(void) {
    @autoreleasepool {
        uint64_t epoch = atomic_load_explicit(&backEpoch, memory_order_acquire);
        NSRunningApplication *front = (NSRunningApplication *)(id)NSWorkspace.sharedWorkspace.frontmostApplication;
        pid_t pid = front.processIdentifier;
        if (pid <= 0) return 1;
        if (!AXIsProcessTrusted()) return 2;
        BackPress press = { .pid = pid, .epoch = epoch, .start = clock_gettime_nsec_np(CLOCK_UPTIME_RAW), .timeout = 0.75 };
        KeepworkChromiumHost host = chromiumHost(front);
        AXUIElementRef app = AXUIElementCreateApplication(pid);
        if (!app) return 1;
        AXUIElementSetMessagingTimeout(app, 0.12);
        press.system = AXUIElementCreateSystemWide();
        if (press.system) AXUIElementSetMessagingTimeout(press.system, 0.10);
        int result = 1;
        AXUIElementRef field = copyBackField(app, host, &press, &result);
        if (field) {
            AXUIElementSetMessagingTimeout(field, 0.12);
            if (ordinaryTextField(field)) {
                bool valueWritable = writableAXAttribute(field, kAXValueAttribute);
                bool useSelection = host != KeepworkOtherHost || !valueWritable;
                if (useSelection && (valueWritable || writableAXAttribute(field, kAXSelectedTextAttribute)) &&
                    writableAXAttribute(field, kAXSelectedTextRangeAttribute))
                    result = clearBackSelection(app, field, press, host != KeepworkOtherHost);
                else if (!useSelection) {
                    result = backFieldStatus(app, field, press);
                    if (!result) result = AXUIElementSetAttributeValue(field, kAXValueAttribute, CFSTR("")) == kAXErrorSuccess ? 0 : 2;
                }
            }
            CFRelease(field);
        }
        if (press.system) CFRelease(press.system);
        CFRelease(app);
        return result;
    }
}

// Clear alone inspects current role/editability. Dictation and Return never
// need an AX range/value snapshot, and no accessibility text is read here.
int keepwork_voice_input_clear(void) {
    if (!AXIsProcessTrusted()) return 2;
    AXUIElementRef system = AXUIElementCreateSystemWide();
    if (!system) return 1;
    AXUIElementSetMessagingTimeout(system, 0.5);
    AXUIElementRef focus = copyFocusedInput(system);
    if (focus) AXUIElementSetMessagingTimeout(focus, 0.5);
    bool editable = focus && ordinaryTextField(focus) && writableAXAttribute(focus, kAXValueAttribute);
    if (focus) CFRelease(focus);
    CFRelease(system);
    if (!editable) return 1;
    if (keepwork_voice_input_modifiers()) return 2;
    // Create every event before posting the first, so allocation failure cannot
    // leave a destructive half sequence. Do not retry an uncertain mutation.
    CGKeyCode keys[] = {0, 0, 51, 51};
    CGEventRef events[4] = {NULL};
    for (int i = 0; i < 4; i++) {
        events[i] = CGEventCreateKeyboardEvent(NULL, keys[i], i % 2 == 0);
        if (!events[i]) {
            for (int j = 0; j < i; j++) CFRelease(events[j]);
            return 2;
        }
        CGEventSetFlags(events[i], i < 2 ? kCGEventFlagMaskCommand : 0);
    }
    for (int i = 0; i < 4; i++) { CGEventPost(kCGHIDEventTap, events[i]); CFRelease(events[i]); }
    return 0;
}
