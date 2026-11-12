// Passive, source-limited Back button reader. Never remap/seize a keyboard or
// inspect ordinary keyboard values. OK remains the system's native Enter.
#import <Foundation/Foundation.h>
#import <IOKit/hid/IOHIDManager.h>
#import <IOKit/hid/IOHIDKeys.h>
#import <IOKit/hidsystem/IOHIDLib.h>
#import <IOKit/IOKitLib.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define BUTTON_SOURCE_LIMIT 16

typedef struct {
    uint64_t registry;
    uintptr_t device;
    char physical[160];
    char label[128];
    bool needsRelease;
} ButtonSource;

typedef enum { NoSource, UniqueSource, AmbiguousSource } SourceSelection;

typedef struct {
    uint32_t code;
    uint32_t ready;
    uint64_t registry;
    char device[128];
} ButtonSnapshot;

typedef struct {
    pthread_t thread;
    pthread_mutex_t mutex;
    pthread_cond_t condition;
    bool enabled;
    bool ready;
    bool blocked;
    bool seenSource;
    bool pending;
    bool pressed;
    uint32_t downMask;
    uint32_t releaseMask;
    uint64_t pressedAt;
    uint64_t pendingAt;
    ButtonSource sources[BUTTON_SOURCE_LIMIT];
    size_t sourceCount;
    ButtonSnapshot snapshot;
    bool startup_done;
    bool startup_ok;
    bool cancelled;
    bool detached;
    CFRunLoopRef runloop;
} ButtonContext;

static pthread_mutex_t buttonsLifecycle = PTHREAD_MUTEX_INITIALIZER;
static ButtonContext *activeButtons;
static uint64_t monotonicMilliseconds(void);

static bool knownRemote(uint64_t vendor, uint64_t product, const char *transport,
                        uint32_t usagePage, uint32_t usage) {
    return vendor == 0x2717 && product == 0x32B8 && transport
        && (!strcmp(transport, "Bluetooth") || !strcmp(transport, "BluetoothLowEnergy"))
        && usagePage == 1 && usage == 6;
}

static SourceSelection selectSources(const ButtonSource *sources, size_t count) {
    if (!count) return NoSource;
    if (count > BUTTON_SOURCE_LIMIT || !sources || !sources[0].registry) return AmbiguousSource;
    if (count == 1) return UniqueSource;
    // A shared, nonempty physical identifier may unite multiple collections.
    // Product names, VID/PID and nearby timestamps never establish identity.
    if (!sources[0].physical[0]) return AmbiguousSource;
    for (size_t i = 1; i < count; i++) {
        if (!sources[i].registry || !sources[i].physical[0]
            || strcmp(sources[i].physical, sources[0].physical)) return AmbiguousSource;
        for (size_t j = 0; j < i; j++) if (sources[j].registry == sources[i].registry) return AmbiguousSource;
    }
    return UniqueSource;
}

static void clearEdges(ButtonContext *context) {
    context->pending = false;
    context->pressed = false;
    context->downMask = 0;
    context->releaseMask = 0;
    context->pressedAt = 0;
    context->pendingAt = 0;
}

static bool sameSources(const ButtonSource *a, size_t ac, const ButtonSource *b, size_t bc) {
    if (ac != bc) return false;
    for (size_t i = 0; i < ac; i++) {
        bool found = false;
        for (size_t j = 0; j < bc; j++) {
            if (a[i].registry == b[j].registry && !strcmp(a[i].physical, b[j].physical)) { found = true; break; }
        }
        if (!found) return false;
    }
    return true;
}

static void applySources(ButtonContext *context, const ButtonSource *sources, size_t count) {
    pthread_mutex_lock(&context->mutex);
    SourceSelection oldChoice = selectSources(context->sources, context->sourceCount);
    SourceSelection choice = selectSources(sources, count);
    bool changed = !sameSources(context->sources, context->sourceCount, sources, count);
    bool reordered = false;
    if (!changed) {
        for (size_t i = 0; i < count; i++) {
            if (context->sources[i].registry != sources[i].registry) { reordered = true; break; }
        }
    }
    bool samePhysical = oldChoice == UniqueSource && choice == UniqueSource
        && context->sources[0].physical[0] && sources[0].physical[0]
        && !strcmp(context->sources[0].physical, sources[0].physical);
    // Source array positions are not key identities. Preserve every held or
    // unarmed registry before discarding the old index-based masks; otherwise
    // autorepeat after a reorder could look like a fresh short press.
    uint64_t heldRegistries[BUTTON_SOURCE_LIMIT];
    size_t heldCount = 0;
    uint32_t oldHeld = context->downMask | context->releaseMask;
    if (changed || reordered) {
        for (size_t i = 0; i < context->sourceCount; i++) {
            if (oldHeld & (1u << i)) heldRegistries[heldCount++] = context->sources[i].registry;
        }
    }
    if (changed || reordered) clearEdges(context);
    if (count > BUTTON_SOURCE_LIMIT) count = 0;
    if (context->seenSource && changed && !samePhysical) {
        context->blocked = true;
        context->snapshot.code = choice == AmbiguousSource ? 3 : 6;
    } else if (choice == AmbiguousSource) {
        context->blocked = true;
        context->snapshot.code = 3;
    }
    context->sourceCount = count;
    if (count) memcpy(context->sources, sources, count * sizeof(ButtonSource));
    if (changed || reordered) {
        for (size_t i = 0; i < count; i++) {
            if (sources[i].needsRelease) context->releaseMask |= 1u << i;
            for (size_t j = 0; j < heldCount; j++) {
                if (sources[i].registry == heldRegistries[j]) context->releaseMask |= 1u << i;
            }
        }
    }
    context->ready = context->enabled && !context->blocked && choice == UniqueSource;
    context->snapshot.ready = context->ready && !context->releaseMask;
    context->snapshot.registry = count && choice == UniqueSource ? sources[0].registry : 0;
    memset(context->snapshot.device, 0, sizeof(context->snapshot.device));
    if (count && choice == UniqueSource) {
        snprintf(context->snapshot.device, sizeof(context->snapshot.device), "HID-%llu · %.80s",
            (unsigned long long)sources[0].registry, sources[0].label);
    }
    if (!context->blocked) context->snapshot.code = context->ready ? (context->releaseMask ? 10 : 1) : 2;
    if (context->ready) context->seenSource = true;
    pthread_mutex_unlock(&context->mutex);
}

static void buttonEdge(ButtonContext *context, uint64_t registry, uint32_t page,
                       uint32_t usage, bool down, uint64_t now) {
    pthread_mutex_lock(&context->mutex);
    if (!context->enabled || !context->ready || context->blocked) {
        clearEdges(context);
        pthread_mutex_unlock(&context->mutex);
        return;
    }
    size_t index = 0;
    while (index < context->sourceCount && context->sources[index].registry != registry) index++;
    if (index == context->sourceCount || page != 7 || usage != 0xF1) {
        pthread_mutex_unlock(&context->mutex);
        return;
    }
    uint32_t bit = 1u << index;
    if (context->releaseMask) {
        // Held or unknown initial state must reach a release before a new tap
        // can arm. Companion collections join that same release barrier.
        if (down) context->releaseMask |= bit;
        else {
            context->releaseMask &= ~bit;
            context->sources[index].needsRelease = false;
        }
        if (!context->releaseMask) {
            context->snapshot.ready = context->ready;
            context->snapshot.code = 1;
        }
        pthread_mutex_unlock(&context->mutex);
        return;
    }
    if (down) {
        if (!(context->downMask & bit)) {
            if (!context->downMask) context->pressedAt = now;
            context->downMask |= bit;
            context->pressed = true;
        }
    } else if (context->downMask & bit) {
        context->sources[index].needsRelease = false;
        context->downMask &= ~bit;
        if (!context->downMask) {
            if (context->pressed && now >= context->pressedAt && now - context->pressedAt < 1000) {
                // A one-slot queue coalesces identical pending clear actions.
                context->pending = true;
                context->pendingAt = now;
                context->snapshot.code = 1;
            }
            context->pressed = false;
        }
    }
    pthread_mutex_unlock(&context->mutex);
}

static bool pollContextAt(ButtonContext *context, uint64_t now) {
    pthread_mutex_lock(&context->mutex);
    bool clear = context->enabled && context->ready && !context->blocked && !context->releaseMask && context->pending;
    if (clear && (now < context->pendingAt || now - context->pendingAt >= 1000)) {
        clear = false;
        context->snapshot.code = 9;
    }
    context->pending = false;
    context->pendingAt = 0;
    pthread_mutex_unlock(&context->mutex);
    return clear;
}

static bool pollContext(ButtonContext *context) {
    return pollContextAt(context, monotonicMilliseconds());
}

static uint64_t monotonicMilliseconds(void) {
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return (uint64_t)value.tv_sec * 1000 + (uint64_t)value.tv_nsec / 1000000;
}

static void disableButtons(ButtonContext *context, uint32_t code) {
    pthread_mutex_lock(&context->mutex);
    context->blocked = true;
    context->enabled = false;
    context->ready = false;
    context->snapshot.code = code;
    context->snapshot.ready = 0;
    clearEdges(context);
    pthread_mutex_unlock(&context->mutex);
}

static bool stringValue(CFTypeRef value, char *out, size_t size) {
    return value && CFGetTypeID(value) == CFStringGetTypeID()
        && CFStringGetLength((CFStringRef)value) > 0
        && CFStringGetCString((CFStringRef)value, out, (CFIndex)size, kCFStringEncodingUTF8);
}

static uint64_t numberProperty(IOHIDDeviceRef device, const char *name) {
    CFStringRef key = CFStringCreateWithCString(NULL, name, kCFStringEncodingUTF8);
    CFTypeRef value = IOHIDDeviceGetProperty(device, key);
    int64_t number = 0;
    if (value && CFGetTypeID(value) == CFNumberGetTypeID()) CFNumberGetValue((CFNumberRef)value, kCFNumberSInt64Type, &number);
    CFRelease(key);
    return number > 0 ? (uint64_t)number : 0;
}

static void physicalIdentity(IOHIDDeviceRef device, char *out, size_t size) {
    // A vendor serial number can be identical across two remotes. Only HID's
    // physical/unique identity properties may join separate collections.
    const char *keys[] = { "PhysicalDeviceUniqueID", kIOHIDUniqueIDKey };
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
        CFStringRef key = CFStringCreateWithCString(NULL, keys[i], kCFStringEncodingUTF8);
        CFTypeRef value = IOHIDDeviceGetProperty(device, key);
        char raw[112] = {0};
        bool valid = stringValue(value, raw, sizeof(raw)) && strlen(raw) >= 8;
        bool meaningful = false;
        for (size_t j = 0; valid && raw[j]; j++) {
            if (raw[j] != '0' && raw[j] != ':' && raw[j] != '-' && raw[j] != ' ') meaningful = true;
        }
        valid = valid && meaningful;
        if (valid) snprintf(out, size, "%s:%s", keys[i], raw);
        CFRelease(key);
        if (valid) return;
    }
}

static bool sourceFromDevice(IOHIDDeviceRef device, ButtonSource *out) {
    char transport[64] = {0};
    stringValue(IOHIDDeviceGetProperty(device, CFSTR(kIOHIDTransportKey)), transport, sizeof(transport));
    bool keyboard = IOHIDDeviceConformsTo(device, 1, 6);
    if (!knownRemote(numberProperty(device, kIOHIDVendorIDKey), numberProperty(device, kIOHIDProductIDKey), transport, keyboard ? 1 : 0, keyboard ? 6 : 0)) return false;
    NSDictionary *match = @{@kIOHIDElementUsagePageKey:@7, @kIOHIDElementUsageKey:@0xF1};
    CFArrayRef elements = IOHIDDeviceCopyMatchingElements(device, (__bridge CFDictionaryRef)match, kIOHIDOptionsTypeNone);
    bool hasBack = false;
    bool needsRelease = false;
    if (elements) {
        for (CFIndex i = 0; i < CFArrayGetCount(elements); i++) {
            IOHIDElementRef element = (IOHIDElementRef)CFArrayGetValueAtIndex(elements, i);
            IOHIDElementType type = IOHIDElementGetType(element);
            if (type >= kIOHIDElementTypeInput_Misc && type <= kIOHIDElementTypeInput_ScanCodes
                && IOHIDElementGetUsagePage(element) == 7 && IOHIDElementGetUsage(element) == 0xF1) {
                hasBack = true;
                IOHIDValueRef current = NULL;
                if (IOHIDDeviceGetValue(device, element, &current) != kIOReturnSuccess || !current
                    || IOHIDValueGetIntegerValue(current) != 0) needsRelease = true;
            }
        }
        CFRelease(elements);
    }
    if (!hasBack) return false;
    memset(out, 0, sizeof(*out));
    out->needsRelease = needsRelease;
    out->device = (uintptr_t)device;
    io_service_t service = IOHIDDeviceGetService(device);
    if (service) IORegistryEntryGetRegistryEntryID(service, &out->registry);
    physicalIdentity(device, out->physical, sizeof(out->physical));
    if (!stringValue(IOHIDDeviceGetProperty(device, CFSTR(kIOHIDProductKey)), out->label, sizeof(out->label))) strcpy(out->label, "Xiaomi RC003");
    return true;
}

static void deviceMatched(void *raw, IOReturn result, void *sender, IOHIDDeviceRef device) {
    (void)sender;
    ButtonContext *context = raw;
    if (result != kIOReturnSuccess) { disableButtons(context, 8); return; }
    ButtonSource source;
    if (!sourceFromDevice(device, &source)) return;
    if (!source.registry) { disableButtons(context, 8); return; }
    ButtonSource next[BUTTON_SOURCE_LIMIT];
    pthread_mutex_lock(&context->mutex);
    size_t count = context->sourceCount;
    memcpy(next, context->sources, count * sizeof(ButtonSource));
    pthread_mutex_unlock(&context->mutex);
    size_t index = 0;
    while (index < count && next[index].registry != source.registry) index++;
    if (index == count) {
        if (count == BUTTON_SOURCE_LIMIT) { disableButtons(context, 3); return; }
        count++;
    }
    next[index] = source;
    applySources(context, next, count);
}

static void deviceRemoved(void *raw, IOReturn result, void *sender, IOHIDDeviceRef device) {
    (void)result; (void)sender;
    ButtonContext *context = raw;
    ButtonSource next[BUTTON_SOURCE_LIMIT];
    pthread_mutex_lock(&context->mutex);
    size_t count = 0;
    for (size_t i = 0; i < context->sourceCount; i++) {
        if (context->sources[i].device != (uintptr_t)device) next[count++] = context->sources[i];
    }
    pthread_mutex_unlock(&context->mutex);
    applySources(context, next, count);
}

static void inputValue(void *raw, IOReturn result, void *sender, IOHIDValueRef value) {
    (void)sender;
    ButtonContext *context = raw;
    if (result != kIOReturnSuccess) { disableButtons(context, 8); return; }
    IOHIDElementRef element = IOHIDValueGetElement(value);
    IOHIDDeviceRef device = IOHIDElementGetDevice(element);
    io_service_t service = IOHIDDeviceGetService(device);
    uint64_t registry = 0;
    if (!service || IORegistryEntryGetRegistryEntryID(service, &registry) != kIOReturnSuccess) return;
    pthread_mutex_lock(&context->mutex);
    bool allowed = false;
    for (size_t i = 0; i < context->sourceCount; i++) if (context->sources[i].registry == registry) { allowed = true; break; }
    allowed = allowed && context->enabled && context->ready && !context->blocked;
    pthread_mutex_unlock(&context->mutex);
    if (!allowed) return;
    uint32_t page = IOHIDElementGetUsagePage(element);
    uint32_t usage = IOHIDElementGetUsage(element);
    if (page != 7 || usage != 0xF1) return;
    buttonEdge(context, registry, page, usage, IOHIDValueGetIntegerValue(value) != 0, monotonicMilliseconds());
}

static bool listenAllowed(void) {
    if (@available(macOS 10.15, *)) return IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted;
    return false;
}

static void freeContext(ButtonContext *context) {
    pthread_cond_destroy(&context->condition);
    pthread_mutex_destroy(&context->mutex);
    free(context);
}

static void *buttonsThread(void *raw) {
    @autoreleasepool {
        ButtonContext *context = raw;
        IOHIDManagerRef manager = IOHIDManagerCreate(NULL, kIOHIDOptionsTypeNone);
        CFRunLoopRef loop = CFRunLoopGetCurrent();
        bool opened = false;
        if (manager) {
            NSDictionary *base = @{@kIOHIDVendorIDKey:@0x2717, @kIOHIDProductIDKey:@0x32B8,
                @kIOHIDDeviceUsagePageKey:@1, @kIOHIDDeviceUsageKey:@6};
            NSMutableDictionary *bluetooth = [base mutableCopy];
            bluetooth[@kIOHIDTransportKey] = @kIOHIDTransportBluetoothValue;
            NSMutableDictionary *ble = [base mutableCopy];
            ble[@kIOHIDTransportKey] = @kIOHIDTransportBluetoothLowEnergyValue;
            IOHIDManagerSetDeviceMatchingMultiple(manager, (__bridge CFArrayRef)@[bluetooth, ble]);
            IOHIDManagerRegisterDeviceMatchingCallback(manager, deviceMatched, context);
            IOHIDManagerRegisterDeviceRemovalCallback(manager, deviceRemoved, context);
            NSDictionary *backOnly = @{@kIOHIDElementUsagePageKey:@7, @kIOHIDElementUsageKey:@0xF1};
            IOHIDManagerSetInputValueMatching(manager, (__bridge CFDictionaryRef)backOnly);
            IOHIDManagerRegisterInputValueCallback(manager, inputValue, context);
            IOHIDManagerScheduleWithRunLoop(manager, loop, kCFRunLoopDefaultMode);
            opened = IOHIDManagerOpen(manager, kIOHIDOptionsTypeNone) == kIOReturnSuccess;
            if (opened) {
                CFSetRef devices = IOHIDManagerCopyDevices(manager);
                if (devices) {
                    CFIndex count = CFSetGetCount(devices);
                    const void **values = calloc((size_t)count, sizeof(void *));
                    if (values) {
                        CFSetGetValues(devices, values);
                        for (CFIndex i = 0; i < count; i++) deviceMatched(context, kIOReturnSuccess, NULL, (IOHIDDeviceRef)values[i]);
                        free(values);
                    }
                    CFRelease(devices);
                }
            }
        }
        pthread_mutex_lock(&context->mutex);
        context->runloop = loop;
        CFRetain(loop);
        context->startup_done = true;
        context->startup_ok = opened && !context->cancelled;
        if (!context->startup_ok) {
            context->enabled = false;
            context->ready = false;
            context->snapshot.ready = 0;
            context->snapshot.code = 5;
            clearEdges(context);
        }
        pthread_cond_signal(&context->condition);
        pthread_mutex_unlock(&context->mutex);
        while (true) {
            pthread_mutex_lock(&context->mutex);
            bool enabled = context->enabled;
            pthread_mutex_unlock(&context->mutex);
            if (!enabled) break;
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, false);
            if (!listenAllowed()) disableButtons(context, 4);
        }
        if (manager) {
            IOHIDManagerUnscheduleFromRunLoop(manager, loop, kCFRunLoopDefaultMode);
            IOHIDManagerClose(manager, kIOHIDOptionsTypeNone);
            CFRelease(manager);
        }
        pthread_mutex_lock(&context->mutex);
        context->runloop = NULL;
        bool detached = context->detached;
        pthread_mutex_unlock(&context->mutex);
        CFRelease(loop);
        if (detached) freeContext(context);
        return NULL;
    }
}

int keepwork_remote_buttons_start(void) {
    if (!listenAllowed()) return 2;
    pthread_mutex_lock(&buttonsLifecycle);
    if (activeButtons) { pthread_mutex_unlock(&buttonsLifecycle); return 1; }
    ButtonContext *context = calloc(1, sizeof(*context));
    if (!context) { pthread_mutex_unlock(&buttonsLifecycle); return 3; }
    pthread_mutex_init(&context->mutex, NULL);
    pthread_cond_init(&context->condition, NULL);
    context->enabled = true;
    context->snapshot.code = 2;
    if (pthread_create(&context->thread, NULL, buttonsThread, context) != 0) {
        freeContext(context); pthread_mutex_unlock(&buttonsLifecycle); return 3;
    }
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += 2;
    pthread_mutex_lock(&context->mutex);
    while (!context->startup_done) {
        if (pthread_cond_timedwait(&context->condition, &context->mutex, &deadline) != 0) break;
    }
    if (!context->startup_done) {
        context->cancelled = true;
        context->enabled = false;
        context->detached = true;
        clearEdges(context);
        pthread_detach(context->thread);
        pthread_mutex_unlock(&context->mutex);
        pthread_mutex_unlock(&buttonsLifecycle);
        return 3;
    }
    bool started = context->startup_ok;
    pthread_mutex_unlock(&context->mutex);
    if (started) activeButtons = context;
    else { pthread_join(context->thread, NULL); freeContext(context); }
    pthread_mutex_unlock(&buttonsLifecycle);
    return started ? 0 : 3;
}

void keepwork_remote_buttons_stop(void) {
    pthread_mutex_lock(&buttonsLifecycle);
    ButtonContext *context = activeButtons;
    activeButtons = NULL;
    if (context) {
        pthread_mutex_lock(&context->mutex);
        context->enabled = false;
        context->ready = false;
        clearEdges(context);
        if (context->runloop) CFRunLoopWakeUp(context->runloop);
        pthread_mutex_unlock(&context->mutex);
        pthread_join(context->thread, NULL);
        freeContext(context);
    }
    pthread_mutex_unlock(&buttonsLifecycle);
}

bool keepwork_remote_buttons_poll(void) {
    pthread_mutex_lock(&buttonsLifecycle);
    bool clear = activeButtons ? pollContext(activeButtons) : false;
    pthread_mutex_unlock(&buttonsLifecycle);
    return clear;
}

void keepwork_remote_buttons_status(ButtonSnapshot *out) {
    if (!out) return;
    memset(out, 0, sizeof(*out));
    pthread_mutex_lock(&buttonsLifecycle);
    if (activeButtons) {
        pthread_mutex_lock(&activeButtons->mutex);
        *out = activeButtons->snapshot;
        pthread_mutex_unlock(&activeButtons->mutex);
    }
    pthread_mutex_unlock(&buttonsLifecycle);
}
