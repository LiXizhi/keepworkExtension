#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

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

static CGEventRef voiceKey(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *raw) {
    (void)proxy;
    KeepworkVoiceTap *tap = raw;
    if (!atomic_load_explicit(&tap->enabled, memory_order_acquire)) return event;
    // F5 (hardware keycode 96) is intentionally reserved process-wide while
    // this user-enabled ATVV session is ready. No device distinction is claimed.
    if ((type == kCGEventKeyDown || type == kCGEventKeyUp)
        && CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode) == 96) return NULL;
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

// 0 success, 1 Accessibility, 2 Input Monitoring, 3 already owned, 4 failure.
int keepwork_voice_input_start(void) {
    if (!AXIsProcessTrusted()) return 1;
    if (@available(macOS 10.15, *)) {
        if (!CGPreflightListenEventAccess()) return 2;
    }
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

bool keepwork_voice_input_target(uint64_t *out) {
    if (!out || !AXIsProcessTrusted()) return false;
    memset(out, 0, sizeof(uint64_t) * 12);
    AXUIElementRef system = AXUIElementCreateSystemWide();
    AXUIElementSetMessagingTimeout(system, 0.2f);
    AXUIElementRef app = NULL;
    AXUIElementRef focus = NULL;
    AXUIElementRef window = NULL;
    CFTypeRef selected = NULL;
    bool success = false;
    if (AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute, (CFTypeRef *)&app) != kAXErrorSuccess || !app) goto cleanup;
    AXUIElementSetMessagingTimeout(app, 0.2f);
    if (AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, (CFTypeRef *)&focus) != kAXErrorSuccess || !focus) goto cleanup;
    AXUIElementSetMessagingTimeout(focus, 0.2f);
    pid_t pid;
    if (AXUIElementGetPid(app, &pid) != kAXErrorSuccess) goto cleanup;
    out[0] = (uint64_t)pid;
    out[1] = CFHash(focus);
    if (AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, (CFTypeRef *)&window) != kAXErrorSuccess || !window) goto cleanup;
    out[2] = CFHash(window);
    if (AXUIElementCopyAttributeValue(focus, kAXSelectedTextRangeAttribute, &selected) != kAXErrorSuccess || !selected || CFGetTypeID(selected) != AXValueGetTypeID()) goto cleanup;
    CFRange range;
    if (!AXValueGetValue((AXValueRef)selected, kAXValueCFRangeType, &range) || range.location < 0 || range.length < 0) goto cleanup;
    out[3] = 1;
    out[4] = (uint64_t)range.location;
    out[5] = (uint64_t)range.length;
    success = true;
cleanup:
    if (selected) CFRelease(selected);
    if (window) CFRelease(window);
    if (focus) CFRelease(focus);
    if (app) CFRelease(app);
    CFRelease(system);
    return success;
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

bool keepwork_voice_input_paste(void) {
    if (!AXIsProcessTrusted()) return false;
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, 9, true);
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, 9, false);
    if (!down || !up) {
        if (down) CFRelease(down);
        if (up) CFRelease(up);
        return false;
    }
    CGEventSetFlags(down, kCGEventFlagMaskCommand);
    CGEventSetFlags(up, kCGEventFlagMaskCommand);
    CGEventPost(kCGHIDEventTap, down);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(down);
    CFRelease(up);
    return true;
}
