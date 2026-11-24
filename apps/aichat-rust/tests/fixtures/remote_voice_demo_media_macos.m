// Opt-in end-to-end check. The JS parent saves and restores the output device's
// actual volume and mute state, including when this window fails or times out.
#import <Cocoa/Cocoa.h>
#import <CoreAudio/CoreAudio.h>
#import <Carbon/Carbon.h>
#import "../../src-tauri/src/remote_voice/demo_input_macos.m"
#include <math.h>
#include <unistd.h>

int keepwork_voice_input_permissions(bool request) {
    if (!AXIsProcessTrusted()) return 1;
    return CGPreflightListenEventAccess() ? 0 : 2;
}

// The fixture posts synthetic volume/keyboard packets. They have no remote sender.
bool keepwork_remote_event_from_selected_remote(CGEventRef event) { return false; }

static void check(bool ok, const char *message) {
    if (!ok) { fprintf(stderr, "%s\n", message); exit(1); }
}

static AudioDeviceID defaultOutput(void) {
    AudioObjectPropertyAddress address = {kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    AudioDeviceID id = 0;
    UInt32 size = sizeof(id);
    check(AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &id) == noErr && id,
        "A default audio output device is required");
    return id;
}

typedef struct { Float32 volume; UInt32 mute; } AudioState;

static AudioState audioState(AudioDeviceID id, const AudioState *write) {
    AudioState result;
    const AudioObjectPropertySelector selectors[] = { kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyMute };
    void *reads[] = { &result.volume, &result.mute };
    for (unsigned i = 0; i < 2; ++i) {
        AudioObjectPropertyAddress address = {selectors[i], kAudioDevicePropertyScopeOutput, kAudioObjectPropertyElementMain};
        UInt32 size = i == 0 ? sizeof(result.volume) : sizeof(result.mute);
        Boolean writable = false;
        check(AudioObjectIsPropertySettable(id, &address, &writable) == noErr && writable,
            "Run this test with an output device with adjustable master volume and mute");
        if (write) {
            const void *value = i == 0 ? (const void *)&write->volume : (const void *)&write->mute;
            check(AudioObjectSetPropertyData(id, &address, 0, NULL, size, value) == noErr, "System audio write failed");
        }
        check(AudioObjectGetPropertyData(id, &address, 0, NULL, &size, reads[i]) == noErr, "System audio read failed");
    }
    return result;
}

static bool sameAudio(AudioState a, AudioState b) {
    return fabsf(a.volume - b.volume) < 0.0005 && a.mute == b.mute;
}

static const unsigned mediaKeys[] = {NX_KEYTYPE_SOUND_UP, NX_KEYTYPE_SOUND_DOWN, NX_KEYTYPE_MUTE};
static NSWindow *owner;
static AudioDeviceID output;
static uint64_t token;
static int64_t marker;
static unsigned observed, presses, releases;
static unsigned keyboardObserved, arrowPresses, arrowReleases, arrowActions, shortcutActions;

@interface DemoKeyboardProbe : NSView
@end
@implementation DemoKeyboardProbe
- (BOOL)acceptsFirstResponder { return YES; }
- (void)keyDown:(NSEvent *)event {
    if (event.keyCode == kVK_LeftArrow) ++arrowActions;
    else [super keyDown:event];
}
- (void)fixtureReload:(id)sender { ++shortcutActions; }
@end

static void report(void *context, uint32_t control, bool down) {
    if (control == DemoVolume) { if (down) ++presses; else ++releases; }
    else if (control == DemoLeft) { if (down) ++arrowPresses; else ++arrowReleases; }
    else check(control != DemoEnded && control != DemoUnavailable, "Focused demo lost capture");
}

static CGEventRef downstream(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *unused) {
    if (event && CGEventGetIntegerValueField(event, kCGEventSourceUserData) == marker) {
        if (type == (CGEventType)NSEventTypeSystemDefined) ++observed;
        if (type == kCGEventKeyDown || type == kCGEventKeyUp) ++keyboardObserved;
    }
    return event;
}

static void post(unsigned key, bool down, bool repeat) {
    check(defaultOutput() == output && ownsDemoWindow(owner), "Output device or foreground window changed");
    NSEvent *media = [NSEvent otherEventWithType:NSEventTypeSystemDefined location:NSZeroPoint modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:0 context:nil subtype:NX_SUBTYPE_AUX_CONTROL_BUTTONS
        data1:(key << 16) | ((down ? NX_KEYDOWN : NX_KEYUP) << 8) | (repeat ? 1 : 0) data2:-1];
    CGEventRef event = CGEventCreateCopy(media.CGEvent);
    check(event != NULL, "Cannot create a system media event");
    CGEventSetIntegerValueField(event, kCGEventSourceUserData, marker);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
}

static void later(dispatch_block_t block) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 400 * NSEC_PER_MSEC), dispatch_get_main_queue(), block);
}

static void postKeyboard(CGKeyCode key, CGEventFlags flags, bool down, bool repeat) {
    check(ownsDemoWindow(owner), "Foreground window changed during keyboard test");
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, key, down);
    check(event != NULL, "Cannot create a keyboard event");
    CGEventSetFlags(event, flags);
    CGEventSetIntegerValueField(event, kCGKeyboardEventAutorepeat, repeat);
    CGEventSetIntegerValueField(event, kCGEventSourceUserData, marker);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
}

static void testKeyboard(unsigned phase, dispatch_block_t complete) {
    bool active = phase == 1;
    unsigned startObserved = keyboardObserved, startArrow = arrowActions, startShortcut = shortcutActions;
    unsigned startDown = arrowPresses, startUp = arrowReleases;
    postKeyboard(kVK_LeftArrow, 0, true, false);
    later(^{
        check(arrowPresses == startDown + active && arrowReleases == startUp, "Incorrect held arrow feedback");
        if (active) postKeyboard(kVK_LeftArrow, 0, true, true);
        postKeyboard(kVK_LeftArrow, 0, false, false);
        postKeyboard(kVK_ANSI_R, kCGEventFlagMaskCommand, true, false);
        postKeyboard(kVK_ANSI_R, kCGEventFlagMaskCommand, false, false);
        later(^{
            printf("phase=%u keyboard downstream=%u arrowActions=%u shortcutActions=%u down=%u up=%u\n",
                phase, keyboardObserved-startObserved, arrowActions-startArrow, shortcutActions-startShortcut,
                arrowPresses-startDown, arrowReleases-startUp);
            check(arrowActions == startArrow + !active && shortcutActions == startShortcut + !active,
                "Focused window or Cmd+R menu actions did not follow demo state");
            check(arrowPresses == startDown + active && arrowReleases == startUp + active,
                "Incorrect arrow repeat/release feedback");
            check(keyboardObserved == startObserved + (active ? 0 : 4),
                "Unexpected keyboard packets reaching the downstream HID observer");
            complete();
        });
    });
}

static void testKey(unsigned phase, unsigned index) {
    bool active = phase == 1;
    unsigned key = mediaKeys[index], startObserved = observed, startDown = presses, startUp = releases;
    AudioState before = audioState(output, NULL);
    post(key, true, false);
    later(^{
        if (active) {
            check(sameAudio(before, audioState(output, NULL)), "System audio changed on demo key-down");
            check(presses == startDown + 1 && releases == startUp, "Missing key-down feedback");
            post(key, true, true);
        }
        post(key, false, false);
        later(^{
            AudioState after = audioState(output, NULL);
            printf("phase=%u key=%u volume=%.5f->%.5f mute=%u->%u downstream=%u down=%u up=%u\n",
                phase, key, before.volume, after.volume, before.mute, after.mute,
                observed-startObserved, presses-startDown, releases-startUp);
            if (active) {
                check(observed == startObserved, "Media input reached a downstream HID consumer during demo");
                check(sameAudio(before, after), "System audio changed during demo repeat/release");
                check(presses == startDown + 1 && releases == startUp + 1, "Incorrect diagram repeat/release feedback");
            } else {
                check(observed >= startObserved + 2, "Positive control did not reach the downstream HID observer");
                bool changed = key == NX_KEYTYPE_MUTE ? before.mute != after.mute
                    : key == NX_KEYTYPE_SOUND_UP ? before.volume < after.volume : before.volume > after.volume;
                check(changed, "Positive control did not change system audio");
            }
            if (index + 1 < sizeof(mediaKeys)/sizeof(*mediaKeys)) {
                testKey(phase, index + 1);
                return;
            }
            testKeyboard(phase, ^{
                if (phase == 2) {
                    puts("Live system volume, mute, diagram edges and HID interception passed");
                    exit(0);
                }
                if (phase == 0) {
                    int result = keepwork_remote_demo_start((__bridge void *)owner, report, NULL, &token);
                    check(result == 0 && token, "Production demo guard could not start");
                } else keepwork_remote_demo_stop(token);
                audioState(output, &(AudioState){0.5, 0});
                later(^{ testKey(phase + 1, 0); });
            });
        });
    });
}

int main(int argc, const char *argv[]) { @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "snapshot") == 0) {
        AudioDeviceID id = defaultOutput();
        AudioState state = audioState(id, NULL);
        printf("%u %.9g %u\n", id, state.volume, state.mute);
        return 0;
    }
    if (argc == 5 && strcmp(argv[1], "restore") == 0) {
        AudioDeviceID id = (AudioDeviceID)strtoul(argv[2], NULL, 10);
        AudioState state = { strtof(argv[3], NULL), (UInt32)strtoul(argv[4], NULL, 10) };
        audioState(id, &state);
        for (unsigned i=0; i<30; ++i) {
            if (sameAudio(state, audioState(id, NULL))) return 0;
            usleep(20000);
        }
        check(false, "Could not restore original system volume and mute");
    }
    check(argc == 3 && strcmp(argv[1], "test") == 0, "Expected snapshot, test or restore");
    output = (AudioDeviceID)strtoul(argv[2], NULL, 10);
    check(defaultOutput() == output, "Default audio device changed before test");
    check(!keepwork_voice_input_permissions(false) && CGPreflightPostEventAccess(),
        "Accessibility, Input Monitoring and permission to post events are required");
    marker = ((int64_t)getpid() << 32) | 0x4b57544d;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    owner = [[NSWindow alloc] initWithContentRect:NSMakeRect(200, 200, 380, 100)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    owner.title = @"Keepwork · 遥控器音量键实测";
    DemoKeyboardProbe *keyboardProbe = [DemoKeyboardProbe new];
    owner.contentView = keyboardProbe;
    check([owner makeFirstResponder:keyboardProbe], "Cannot install keyboard responder");
    NSMenu *menuBar = [NSMenu new], *testMenu = [NSMenu new];
    NSMenuItem *root = [menuBar addItemWithTitle:@"Test" action:NULL keyEquivalent:@""];
    root.submenu = testMenu;
    NSMenuItem *reload = [testMenu addItemWithTitle:@"Test Reload" action:@selector(fixtureReload:) keyEquivalent:@"r"];
    reload.target = keyboardProbe;
    NSApp.mainMenu = menuBar;
    [owner makeKeyAndOrderFront:nil];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    ProcessSerialNumber psn = {0, kCurrentProcess};
    SetFrontProcessWithOptions(&psn, kSetFrontProcessFrontWindowOnly);
#pragma clang diagnostic pop
    [NSApp activate];
    // This real, passive HID tap counts only our tagged packets and sits before
    // the session boundary. A session-only guard lets the packets reach it.
    CFMachPortRef observer = CGEventTapCreate(kCGHIDEventTap, kCGTailAppendEventTap, kCGEventTapOptionListenOnly,
        CGEventMaskBit((CGEventType)NSEventTypeSystemDefined) | CGEventMaskBit(kCGEventKeyDown)
            | CGEventMaskBit(kCGEventKeyUp), downstream, NULL);
    check(observer != NULL, "Cannot install downstream HID witness");
    CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(NULL, observer, 0);
    check(source != NULL, "Cannot observe the HID event stream");
    CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
    later(^{
        check(ownsDemoWindow(owner), "The live demo window must be focused");
        audioState(output, &(AudioState){0.5, 0});
        later(^{ testKey(0, 0); });
    });
    [NSApp run];
    return 1;
} }
