// Exercise the actual AppKit key-equivalent path in this process only.
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <objc/runtime.h>
#include <assert.h>

static int fixturePermissions;
static unsigned tapCount;
static bool failHardwareTap;
static CGEventTapCallBack installedCallbacks[3];

int keepwork_voice_input_permissions(bool request) {
    assert(!request);
    return fixturePermissions;
}

static void fixturePortCallback(CFMachPortRef port, void *message, CFIndex size, void *context) {
    (void)port; (void)message; (void)size; (void)context;
    abort();
}

static CFMachPortRef fixtureEventTap(CGEventTapLocation location, CGEventTapPlacement placement,
    CGEventTapOptions options, CGEventMask mask, CGEventTapCallBack callback, void *context) {
    assert(placement == kCGHeadInsertEventTap);
    CGEventMask keyboard = CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp)
        | CGEventMaskBit(kCGEventFlagsChanged);
    CGEventMask media = CGEventMaskBit((CGEventType)NSEventTypeSystemDefined);
    unsigned slot = tapCount % 3;
    CGEventMask hardware = media | keyboard;
    assert(location == (slot == 2 ? kCGHIDEventTap : kCGSessionEventTap));
    assert(options == kCGEventTapOptionDefault && mask == (slot == 0 ? keyboard : slot == 1 ? media : hardware));
    assert(callback && context);
    installedCallbacks[slot] = callback;
    tapCount++;
    if (slot == 2 && failHardwareTap) return NULL;
    // Attach a private run-loop source in place of installing an OS event tap.
    return CFMachPortCreate(NULL, fixturePortCallback, NULL, NULL);
}

static bool fixtureTapEnabled(CFMachPortRef port) { return CFMachPortIsValid(port); }

static NSEvent * (^localHandler)(NSEvent *);
static NSEventMask localMask;
@interface NSEvent (FixtureMonitor)
+ (id)fixture_addLocalMonitorForEventsMatchingMask:(NSEventMask)mask handler:(NSEvent * (^)(NSEvent *))handler;
@end
@implementation NSEvent (FixtureMonitor)
+ (id)fixture_addLocalMonitorForEventsMatchingMask:(NSEventMask)mask handler:(NSEvent * (^)(NSEvent *))handler {
    localHandler = [handler copy];
    localMask = mask;
    return [self addLocalMonitorForEventsMatchingMask:mask handler:handler];
}
@end

#define CGEventTapCreate fixtureEventTap
#define CGEventTapIsEnabled fixtureTapEnabled
#define addLocalMonitorForEventsMatchingMask fixture_addLocalMonitorForEventsMatchingMask
#include "../../src-tauri/src/remote_voice/demo_input_macos.m"
#undef addLocalMonitorForEventsMatchingMask
#undef CGEventTapCreate
#undef CGEventTapIsEnabled

static bool fixtureRemoteSource;
bool keepwork_remote_event_from_selected_remote(CGEventRef event) {
    assert(event);
    return fixtureRemoteSource;
}

static __weak NSWindow *fixtureKeyWindow;
static BOOL fixtureActive = NO;
static NSWindow *appKeyWindow(id application, SEL selector) { return fixtureKeyWindow; }
static BOOL appIsActive(id application, SEL selector) { return fixtureActive; }

@interface FixtureWindow : NSWindow
@property(nonatomic, weak) NSWindow *fixtureSheet;
@end
@implementation FixtureWindow
- (BOOL)isKeyWindow { return fixtureKeyWindow == self; }
- (NSWindow *)attachedSheet { return self.fixtureSheet; }
@end

// The native monitor only queries these fields when checking a mouse edge.
@interface MouseEdge : NSObject
@property(nonatomic) NSEventType type;
@property(nonatomic) NSInteger buttonNumber;
@property(nonatomic, weak) NSWindow *window;
@end
@implementation MouseEdge
@end

@interface MenuProbe : NSObject
@property(nonatomic) unsigned actions;
@end
@implementation MenuProbe
- (void)record:(id)sender { self.actions++; }
@end

static void addMenuCommand(NSMenu *menu, NSString *title, NSString *key,
    NSEventModifierFlags modifiers, MenuProbe *probe) {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:@selector(record:) keyEquivalent:key];
    item.keyEquivalentModifierMask = modifiers;
    item.target = probe;
    [menu addItem:item];
}

static void postKey(NSWindow *window, NSString *characters, unsigned short code,
    NSEventModifierFlags modifiers, NSEventType type, bool repeat) {
    NSEvent *event = [NSEvent keyEventWithType:type location:NSZeroPoint modifierFlags:modifiers
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
        context:nil characters:characters charactersIgnoringModifiers:characters isARepeat:repeat keyCode:code];
    [NSApp postEvent:event atStart:NO];
}

static void postPair(NSWindow *window, NSString *characters, unsigned short code,
    NSEventModifierFlags modifiers) {
    postKey(window, characters, code, modifiers, NSEventTypeKeyDown, false);
    postKey(window, characters, code, modifiers, NSEventTypeKeyUp, false);
}

static void postAccelerators(NSWindow *window, NSString *f11) {
    postKey(window, @"r", kVK_ANSI_R, NSEventModifierFlagCommand, NSEventTypeKeyDown, false);
    postKey(window, @"r", kVK_ANSI_R, NSEventModifierFlagCommand, NSEventTypeKeyDown, true);
    postKey(window, @"r", kVK_ANSI_R, NSEventModifierFlagCommand, NSEventTypeKeyUp, false);
    postPair(window, @"w", kVK_ANSI_W, NSEventModifierFlagCommand);
    postPair(window, @"q", kVK_ANSI_Q, NSEventModifierFlagCommand);
    postPair(window, f11, kVK_F11, NSEventModifierFlagFunction);
}

typedef struct { unsigned downs; unsigned ups; } EdgeCount;
static EdgeCount edges[DemoControlCount];

static void report(void *context, uint32_t code, bool down) {
    assert(code > DemoNone && code < DemoControlCount);
    assert((code != DemoUnavailable && code != DemoEnded) || !down);
    EdgeCount *record = &((EdgeCount *)context)[code];
    if (down) record->downs++;
    else record->ups++;
}

static NSEvent *media(unsigned code, unsigned state) {
    return [NSEvent otherEventWithType:NSEventTypeSystemDefined location:NSZeroPoint modifierFlags:0
        timestamp:0 windowNumber:0 context:nil subtype:NX_SUBTYPE_AUX_CONTROL_BUTTONS
        data1:(code << 16) | (state << 8) data2:0];
}

// Only exercise the registered filter callback. Never post power/sleep
// packets to the OS, even when the simulated source is the selected remote.
static bool hardwareConsumesMedia(KeepworkRemoteDemo *demo, NSEvent *mediaEvent) {
    static char proxy;
    CGEventRef event = mediaEvent.CGEvent;
    assert(event);
    return installedCallbacks[2]((CGEventTapProxy)&proxy, (CGEventType)NSEventTypeSystemDefined,
        event, (__bridge void *)demo) == NULL;
}

static void testRemotePower(KeepworkRemoteDemo *demo) {
    EdgeCount before = edges[DemoPower];
    NSEvent *down = media(NX_POWER_KEY, NX_KEYDOWN), *up = media(NX_POWER_KEY, NX_KEYUP);
    NSEvent *notification = [NSEvent otherEventWithType:NSEventTypeSystemDefined location:NSZeroPoint
        modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:NX_SUBTYPE_POWER_KEY data1:0 data2:0];
    assert(!hardwareConsumesMedia(demo, notification));
    assert(!hardwareConsumesMedia(demo, down));
    assert(!hardwareConsumesMedia(demo, up));
    fixtureRemoteSource = true;
    assert(hardwareConsumesMedia(demo, notification));
    assert(edges[DemoPower].downs == before.downs && edges[DemoPower].ups == before.ups);
    assert(hardwareConsumesMedia(demo, down));
    assert(hardwareConsumesMedia(demo, down));
    assert(edges[DemoPower].downs == before.downs + 1 && edges[DemoPower].ups == before.ups);
    assert(hardwareConsumesMedia(demo, up));
    assert(edges[DemoPower].ups == before.ups + 1);
    fixtureRemoteSource = false;
}

static void testMedia(KeepworkRemoteDemo *demo) {
    NSEvent *volumeDown = media(NX_KEYTYPE_SOUND_UP, NX_KEYDOWN);
    CGEventRef systemEvent = volumeDown.CGEvent;
    assert(systemEvent && filterSessionInput(NULL, (CGEventType)NSEventTypeSystemDefined,
        systemEvent, (__bridge void *)demo) == NULL);
    assert(consumeMediaEvent(demo, volumeDown));
    assert(consumeMediaEvent(demo, media(NX_KEYTYPE_MUTE, NX_KEYDOWN)));
    assert(consumeMediaEvent(demo, media(NX_KEYTYPE_SOUND_UP, NX_KEYUP)));
    assert(edges[DemoVolume].downs == 1 && edges[DemoVolume].ups == 0);
    assert(consumeMediaEvent(demo, media(NX_KEYTYPE_MUTE, NX_KEYUP)));
    assert(edges[DemoVolume].downs == 1 && edges[DemoVolume].ups == 1);
    assert(consumeMediaEvent(demo, media(NX_KEYTYPE_PLAY, NX_KEYDOWN)));
    assert(consumeMediaEvent(demo, media(NX_KEYTYPE_BRIGHTNESS_UP, NX_KEYDOWN)));
    assert(consumeMediaEvent(demo, media(NX_KEYTYPE_EJECT, NX_KEYDOWN)));
    assert(consumeMediaEvent(demo, media(NX_KEYTYPE_ILLUMINATION_UP, NX_KEYDOWN)));
    assert(!consumeMediaEvent(demo, media(NX_POWER_KEY, NX_KEYDOWN)));
    assert(consumeMediaEvent(demo, media(0xffff, NX_KEYDOWN)));
    assert(consumeMediaEvent(demo, media(0xffff, NX_KEYUP)));
    const short specialTypes[] = {NX_SUBTYPE_EJECT_KEY, NX_SUBTYPE_MENU};
    for (unsigned i = 0; i < sizeof(specialTypes) / sizeof(*specialTypes); i++) {
        NSEvent *event = [NSEvent otherEventWithType:NSEventTypeSystemDefined location:NSZeroPoint
            modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:specialTypes[i] data1:0 data2:0];
        assert(consumeMediaEvent(demo, event));
    }
}

static bool testKeyAtTap(unsigned slot, KeepworkRemoteDemo *demo, CGKeyCode key, CGEventType type,
    CGEventFlags flags, bool repeat) {
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, key, type != kCGEventKeyUp);
    assert(event);
    CGEventSetType(event, type);
    CGEventSetFlags(event, flags);
    CGEventSetIntegerValueField(event, kCGKeyboardEventAutorepeat, repeat);
    static char fixtureProxy;
    bool consumed = installedCallbacks[slot]((CGEventTapProxy)&fixtureProxy,
        type, event, (__bridge void *)demo) == NULL;
    CFRelease(event);
    return consumed;
}

static bool testSessionFilter(KeepworkRemoteDemo *demo, CGKeyCode key, CGEventType type,
    CGEventFlags flags, bool repeat) {
    return testKeyAtTap(0, demo, key, type, flags, repeat);
}

static bool testSessionKey(KeepworkRemoteDemo *demo, CGKeyCode key, bool down, CGEventFlags flags, bool repeat) {
    return testSessionFilter(demo, key, down ? kCGEventKeyDown : kCGEventKeyUp, flags, repeat);
}

static void testSessionShortcuts(KeepworkRemoteDemo *demo) {
    assert(!testSessionFilter(demo, kVK_Command, kCGEventFlagsChanged, 0, false));
    assert(testSessionFilter(demo, kVK_Command, kCGEventFlagsChanged, kCGEventFlagMaskCommand, false));
    assert(testSessionFilter(demo, kVK_Command, kCGEventFlagsChanged, 0, false));
    assert(testSessionKey(demo, kVK_F11, true, kCGEventFlagMaskSecondaryFn, false));
    assert(testSessionKey(demo, kVK_F11, false, 0, false));
    assert(testSessionKey(demo, kVK_Tab, true, kCGEventFlagMaskCommand, false));
    assert(testSessionKey(demo, kVK_Tab, true, 0, true));
    assert(testSessionKey(demo, kVK_Tab, false, 0, false));
    assert(!testSessionKey(demo, kVK_Tab, true, kCGEventFlagMaskShift, false));
    assert(!testSessionKey(demo, kVK_Tab, false, 0, false));
    assert(!testSessionKey(demo, kVK_Escape, true, 0, false));
    assert(testSessionKey(demo, kVK_LeftArrow, true, 0, false));
    assert(testSessionKey(demo, kVK_LeftArrow, true, 0, true));
    assert(testSessionKey(demo, kVK_LeftArrow, false, 0, false));
    assert(edges[DemoLeft].downs == 1 && edges[DemoLeft].ups == 1);
}

static void testHardwareKeys(KeepworkRemoteDemo *demo) {
    const CGKeyCode keys[] = {kVK_VolumeUp, kVK_VolumeDown, kVK_Mute, kVK_RightArrow, kVK_Return,
        kVK_ANSI_KeypadEnter, kVK_F5, kVK_Home, kVK_ContextualMenu};
    const unsigned controls[] = {DemoVolume, DemoVolume, DemoVolume, DemoRight, DemoOK,
        DemoOK, DemoVoice, DemoHome, DemoMenu};
    for (unsigned i = 0; i < sizeof(keys) / sizeof(*keys); i++) {
        EdgeCount before = edges[controls[i]];
        assert(testKeyAtTap(2, demo, keys[i], kCGEventKeyDown, 0, false));
        assert(testKeyAtTap(2, demo, keys[i], kCGEventKeyDown, 0, true));
        assert(edges[controls[i]].downs == before.downs + 1 && edges[controls[i]].ups == before.ups);
        assert(testKeyAtTap(2, demo, keys[i], kCGEventKeyUp, 0, false));
        assert(edges[controls[i]].ups == before.ups + 1);
    }
    const CGKeyCode safeKeys[] = {kVK_Space, kVK_Escape, kVK_Tab, kVK_Tab};
    for (unsigned i = 0; i < sizeof(safeKeys) / sizeof(*safeKeys); i++) {
        CGEventFlags flags = i == 3 ? kCGEventFlagMaskShift : 0;
        // HID is upstream of the session tap, including for releases. Both
        // callbacks must remember that the matching down was allowed.
        assert(!testKeyAtTap(2, demo, safeKeys[i], kCGEventKeyDown, flags, false));
        assert(!testKeyAtTap(0, demo, safeKeys[i], kCGEventKeyDown, flags, false));
        assert(!testKeyAtTap(2, demo, safeKeys[i], kCGEventKeyUp, 0, false));
        assert(!testKeyAtTap(0, demo, safeKeys[i], kCGEventKeyUp, 0, false));
    }
}

static void testMouseEdges(NSWindow *owner, NSWindow *other) {
    assert((localMask & NSEventMaskOtherMouseDown) && (localMask & NSEventMaskOtherMouseUp));
    assert(!(localMask & (NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp)));
    MouseEdge *mouse = [MouseEdge new];
    NSEvent *event = (NSEvent *)mouse;
    for (NSEventType type = NSEventTypeOtherMouseDown; type <= NSEventTypeOtherMouseUp; type++) {
        mouse.type = type;
        mouse.window = owner;
        mouse.buttonNumber = 2;
        assert(localHandler(event) == event);
        for (NSInteger side = 3; side <= 4; side++) {
            mouse.buttonNumber = side;
            assert(localHandler(event) == nil);
        }
        mouse.window = other;
        assert(localHandler(event) == event);
        mouse.window = nil;
        assert(localHandler(event) == event);
    }
}

static void testSuspension(FixtureWindow *owner, NSWindow *sheet, NSNotificationName name, id sender) {
    uint64_t token = 0;
    const unsigned before = edges[DemoEnded].ups;
    assert(keepwork_remote_demo_start((__bridge void *)owner, report, edges, &token) == 0);
    assert(testSessionKey(activeDemo, kVK_F11, true, 0, false));
    assert(testKeyAtTap(2, activeDemo, kVK_F5, kCGEventKeyDown, 0, false));
    owner.fixtureSheet = sheet;
    if (sheet) assert(!testSessionKey(activeDemo, kVK_F11, true, 0, false));
    [NSNotificationCenter.defaultCenter postNotificationName:name object:sender];
    [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidResignKeyNotification object:owner];
    owner.fixtureSheet = nil;
    assert(edges[DemoEnded].ups == before + 1);
    assert(!testSessionKey(activeDemo, kVK_F11, true, 0, false));
    assert(!testKeyAtTap(2, activeDemo, kVK_F5, kCGEventKeyUp, 0, false));
    fixtureRemoteSource = true;
    assert(!hardwareConsumesMedia(activeDemo, media(NX_POWER_KEY, NX_KEYUP)));
    fixtureRemoteSource = false;
    keepwork_remote_demo_stop(token);
}

static void awaitEvents(dispatch_block_t block) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC), dispatch_get_main_queue(), block);
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        // Model foreground ownership in the private fixture without activating it.
        class_replaceMethod(object_getClass(NSApp), @selector(keyWindow), (IMP)appKeyWindow, "@@:");
        class_replaceMethod(object_getClass(NSApp), @selector(isActive), (IMP)appIsActive, "B@:");
        MenuProbe *probe = [MenuProbe new];
        NSMenu *bar = [[NSMenu alloc] initWithTitle:@"Fixture"];
        NSMenuItem *root = [[NSMenuItem alloc] initWithTitle:@"Fixture" action:NULL keyEquivalent:@""];
        NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Fixture"];
        menu.autoenablesItems = NO;
        NSString *f11 = [NSString stringWithCharacters:(unichar[]){NSF11FunctionKey} length:1];
        addMenuCommand(menu, @"Reload", @"r", NSEventModifierFlagCommand, probe);
        addMenuCommand(menu, @"Close", @"w", NSEventModifierFlagCommand, probe);
        addMenuCommand(menu, @"Quit", @"q", NSEventModifierFlagCommand, probe);
        addMenuCommand(menu, @"Full Screen", f11, 0, probe);
        [bar addItem:root];
        root.submenu = menu;
        NSApp.mainMenu = bar;

        FixtureWindow *owner = [[FixtureWindow alloc] initWithContentRect:NSMakeRect(0,0,160,80)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        FixtureWindow *other = [[FixtureWindow alloc] initWithContentRect:NSMakeRect(0,0,160,80)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        dispatch_async(dispatch_get_main_queue(), ^{
            [owner orderBack:nil];
            fixtureKeyWindow = owner;
            postAccelerators(owner, f11);
            awaitEvents(^{
                assert(probe.actions == 5);
                uint64_t token = 0;
                fixtureActive = YES;
                fixturePermissions = 1;
                assert(keepwork_remote_demo_start((__bridge void *)owner, report, edges, &token) == 1);
                assert(tapCount == 0 && token == 0);
                fixturePermissions = 0;
                assert(keepwork_remote_demo_start((__bridge void *)other, report, edges, &token) == 3);
                owner.fixtureSheet = other;
                assert(keepwork_remote_demo_start((__bridge void *)owner, report, edges, &token) == 3);
                assert(tapCount == 0 && token == 0);
                owner.fixtureSheet = nil;
                failHardwareTap = true;
                assert(keepwork_remote_demo_start((__bridge void *)owner, report, edges, &token) == 4);
                assert(activeDemo == nil && token == 0);
                failHardwareTap = false;
                assert(keepwork_remote_demo_start((__bridge void *)owner, report, edges, &token) == 0);
                assert(tapCount == 6 && token != 0);
                testMedia(activeDemo);
                testRemotePower(activeDemo);
                testHardwareKeys(activeDemo);
                testSessionShortcuts(activeDemo);
                testMouseEdges(owner, other);
                postAccelerators(owner, f11);
                NSString *up = [NSString stringWithCharacters:(unichar[]){NSUpArrowFunctionKey} length:1];
                postPair(owner, up, kVK_UpArrow, NSEventModifierFlagFunction);
                awaitEvents(^{
                    assert(probe.actions == 5);
                    assert(edges[DemoUp].downs == 1 && edges[DemoUp].ups == 1);
                    [other orderBack:nil];
                    fixtureKeyWindow = other;
                    assert(!testSessionKey(activeDemo, kVK_Tab, true, kCGEventFlagMaskCommand, false));
                    postAccelerators(other, f11);
                    awaitEvents(^{
                        assert(probe.actions == 10);
                        unsigned before = edges[DemoEnded].ups;
                        [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidResignKeyNotification object:owner];
                        [NSNotificationCenter.defaultCenter postNotificationName:NSApplicationDidResignActiveNotification object:NSApp];
                        assert(edges[DemoEnded].ups == before + 1);
                        fixtureKeyWindow = owner;
                        assert(!testSessionKey(activeDemo, kVK_F11, true, kCGEventFlagMaskSecondaryFn, false));
                        keepwork_remote_demo_stop(token);
                        testSuspension(owner, nil, NSApplicationDidResignActiveNotification, NSApp);
                        testSuspension(owner, other, NSWindowWillBeginSheetNotification, owner);
                        postAccelerators(owner, f11);
                        awaitEvents(^{
                            assert(probe.actions == 15);
                            puts("AppKit demo shortcut fixture passed");
                            exit(0);
                        });
                    });
                });
            });
        });
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ exit(1); });
        [NSApp run];
    }
    return 0;
}
