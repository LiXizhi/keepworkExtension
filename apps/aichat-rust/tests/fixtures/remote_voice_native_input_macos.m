// Compile the real native copy/paste functions with isolated OS boundaries.
// CGEventPost and the general pasteboard are replaced below. This executable
// cannot send keys to the user's foreground application or read its clipboard.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <assert.h>
#include <stdio.h>

@interface FixturePasteboard : NSObject
+ (instancetype)generalPasteboard;
- (NSInteger)clearContents;
- (BOOL)setString:(NSString *)text forType:(NSPasteboardType)type;
@end

static Boolean fixtureTrusted(void);
static Boolean fixtureRequestTrusted(CFDictionaryRef options);
static bool fixtureListenAllowed(void);
static bool fixtureRequestListen(void);
static void fixturePost(CGEventTapLocation location, CGEventRef event);
static CGEventFlags fixtureFlags(CGEventSourceStateID state);
static AXError fixtureAttribute(AXUIElementRef element, CFStringRef attribute, CFTypeRef *value);
static AXUIElementRef fixtureSystem(void);
static CFTypeID fixtureAXType(void);
static AXError fixtureTimeout(AXUIElementRef element, float seconds);
static AXError fixtureSettable(AXUIElementRef element, CFStringRef attribute, Boolean *settable);
static CGEventRef fixtureCreateKeyboardEvent(CGEventSourceRef source, CGKeyCode key, bool down);
static void fixtureSetFlags(CGEventRef event, CGEventFlags flags);
static int64_t fixtureGetInteger(CGEventRef event, CGEventField field);
// The fixture events below are CFData, so substitute just the optional
// CGEvent -> HID sender lookup. No real keystrokes or input sources are used.
static uint64_t fixtureSender;
#define CGEventCopyIOHIDEvent fixtureCopyHID
#define IOHIDEventGetSenderID fixtureSenderID
bool keepwork_remote_home_sender(uint64_t sender) { return sender == 42; }
#define NSPasteboard FixturePasteboard
#define AXIsProcessTrusted fixtureTrusted
#define AXIsProcessTrustedWithOptions fixtureRequestTrusted
#define CGPreflightListenEventAccess fixtureListenAllowed
#define CGRequestListenEventAccess fixtureRequestListen
#define CGEventPost fixturePost
#define CGEventSourceFlagsState fixtureFlags
#define AXUIElementCopyAttributeValue fixtureAttribute
#define AXUIElementCreateSystemWide fixtureSystem
#define AXUIElementGetTypeID fixtureAXType
#define AXUIElementSetMessagingTimeout fixtureTimeout
#define AXUIElementIsAttributeSettable fixtureSettable
#define CGEventCreateKeyboardEvent fixtureCreateKeyboardEvent
#define CGEventSetFlags fixtureSetFlags
#define CGEventGetIntegerValueField fixtureGetInteger
#include "../../src-tauri/src/remote_voice/native_input_macos.m"
CFTypeRef fixtureCopyHID(CGEventRef event) { return CFRetain(event); }
uint64_t fixtureSenderID(CFTypeRef hid) { return fixtureSender; }
static bool dialogueActive;
static unsigned dialogueDownEdges, dialogueUpEdges;
bool keepwork_remote_dialogue_ok_edge(bool down) {
    assert(fixtureSender == 42); // Only the paired Xiaomi keyboard owns this control.
    if (down) dialogueDownEdges++; else dialogueUpEdges++;
    return dialogueActive;
}
#undef NSPasteboard
#undef AXIsProcessTrusted
#undef AXIsProcessTrustedWithOptions
#undef CGPreflightListenEventAccess
#undef CGRequestListenEventAccess
#undef CGEventPost
#undef CGEventSourceFlagsState
#undef AXUIElementCopyAttributeValue
#undef AXUIElementCreateSystemWide
#undef AXUIElementGetTypeID
#undef AXUIElementSetMessagingTimeout
#undef AXUIElementIsAttributeSettable
#undef CGEventCreateKeyboardEvent
#undef CGEventSetFlags
#undef CGEventGetIntegerValueField

static bool trusted = true;
static bool listenAllowed = false;
static bool allowOnRequest = false;
static NSUInteger axRequests, listenRequests;
static bool clipboardAllowed = true;
static NSString *clipboardText;
static NSMutableString *focusedInput;
static NSUInteger caret;
static NSUInteger posts;
static NSUInteger copies;
static NSUInteger submissions;
static NSString *submittedInput;
static NSUInteger metadataRequests;
static CGEventFlags heldFlags;
static bool editable = true, secure = false, controlEnabled = true, allSelected = false;
static CFStringRef focusedRole;
typedef struct { CGKeyCode key; bool down; CGEventFlags flags; } FixtureEvent;
static FixtureEvent *keyboardEvent(CGEventRef event) {
    return (FixtureEvent *)CFDataGetMutableBytePtr((CFMutableDataRef)event);
}
static CGEventRef fixtureCreateKeyboardEvent(CGEventSourceRef source, CGKeyCode key, bool down) {
    assert(source == NULL);
    CFMutableDataRef event = CFDataCreateMutable(NULL, sizeof(FixtureEvent));
    CFDataSetLength(event, sizeof(FixtureEvent));
    *keyboardEvent((CGEventRef)event) = (FixtureEvent){.key = key, .down = down, .flags = 0};
    return (CGEventRef)event;
}
static void fixtureSetFlags(CGEventRef event, CGEventFlags flags) { keyboardEvent(event)->flags = flags; }
static int64_t fixtureGetInteger(CGEventRef event, CGEventField field) {
    assert(field == kCGKeyboardEventKeycode);
    return keyboardEvent(event)->key;
}

@implementation FixturePasteboard
+ (instancetype)generalPasteboard {
    static FixturePasteboard *clipboard;
    if (!clipboard) clipboard = [FixturePasteboard new];
    return clipboard;
}
- (NSInteger)clearContents { clipboardText = nil; return 1; }
- (BOOL)setString:(NSString *)text forType:(NSPasteboardType)type {
    assert([type isEqualToString:NSPasteboardTypeString]);
    copies++;
    if (!clipboardAllowed) return NO;
    clipboardText = [text copy];
    return YES;
}
@end

static Boolean fixtureTrusted(void) { return trusted; }
static Boolean fixtureRequestTrusted(CFDictionaryRef options) {
    assert(CFDictionaryGetValue(options, kAXTrustedCheckOptionPrompt) == kCFBooleanTrue);
    axRequests++;
    return trusted;
}
static bool fixtureListenAllowed(void) { return listenAllowed; }
static bool fixtureRequestListen(void) {
    listenRequests++;
    return listenAllowed = allowOnRequest;
}
static CGEventFlags fixtureFlags(CGEventSourceStateID state) {
    assert(state == kCGEventSourceStateHIDSystemState);
    return heldFlags;
}
static AXError fixtureAttribute(AXUIElementRef element, CFStringRef attribute, CFTypeRef *value) {
    (void)element;
    metadataRequests++;
    *value = NULL;
    if (CFEqual(attribute, kAXFocusedUIElementAttribute)) {
        if (!focusedInput) return kAXErrorNoValue;
        *value = (CFTypeRef)fixtureSystem();
    } else if (CFEqual(attribute, kAXRoleAttribute)) *value = CFRetain(focusedRole ?: kAXTextAreaRole);
    else if (CFEqual(attribute, kAXSubroleAttribute)) *value = CFRetain(secure ? kAXSecureTextFieldSubrole : CFSTR("AXStandardTextField"));
    else if (CFEqual(attribute, kAXEnabledAttribute)) *value = CFRetain(controlEnabled ? kCFBooleanTrue : kCFBooleanFalse);
    else {
        // Value and selection must never be read, even for clear.
        assert(!CFEqual(attribute, kAXValueAttribute));
        assert(!CFEqual(attribute, kAXSelectedTextRangeAttribute));
        return kAXErrorAttributeUnsupported;
    }
    return kAXErrorSuccess;
}
static AXUIElementRef fixtureSystem(void) { return (AXUIElementRef)CFDictionaryCreate(NULL, NULL, NULL, 0, NULL, NULL); }
static CFTypeID fixtureAXType(void) { return CFDictionaryGetTypeID(); }
static AXError fixtureTimeout(AXUIElementRef element, float seconds) { (void)element; assert(seconds <= 0.5); return kAXErrorSuccess; }
static AXError fixtureSettable(AXUIElementRef element, CFStringRef attribute, Boolean *settable) {
    (void)element; assert(CFEqual(attribute, kAXValueAttribute)); *settable = editable; return kAXErrorSuccess;
}
static void home_does_not_type_into_the_foreground_app(void) {
    KeepworkVoiceTap tap = {0};
    atomic_init(&tap.enabled, true);
    for (int down = 0; down <= 1; down++) {
        CGEventType type = down ? kCGEventKeyDown : kCGEventKeyUp;
        CGEventRef home = fixtureCreateKeyboardEvent(NULL, 115, down);
        fixtureSender = 0;
        assert(voiceKey(NULL, type, home, &tap) == home);
        fixtureSender = 7; // Ordinary keyboard Home keeps its navigation behavior.
        assert(voiceKey(NULL, type, home, &tap) == home);
        fixtureSender = 42;
        assert(voiceKey(NULL, type, home, &tap) == NULL);
        atomic_store(&tap.enabled, false);
        assert(voiceKey(NULL, type, home, &tap) == home);
        atomic_store(&tap.enabled, true);
        CFRelease(home);

        CGEventRef ordinary = fixtureCreateKeyboardEvent(NULL, 0, down);
        assert(voiceKey(NULL, type, ordinary, &tap) == ordinary);
        CFRelease(ordinary);
    }
}

static void remote_ok_routes_only_the_active_dialogue_without_an_extra_enter(void) {
    KeepworkVoiceTap tap = {0};
    atomic_init(&tap.enabled, true);
    for (unsigned k = 0; k < 2; k++) {
        const CGKeyCode key = k == 0 ? 36 : 76;
        for (unsigned active = 0; active < 2; active++) {
            dialogueActive = active != 0;
            for (unsigned i = 0; i < 2; i++) {
                bool down = i == 0;
                CGEventType type = down ? kCGEventKeyDown : kCGEventKeyUp;
                CGEventRef event = fixtureCreateKeyboardEvent(NULL, key, down);
                unsigned before = dialogueDownEdges + dialogueUpEdges;
                for (unsigned sender = 0; sender <= 7; sender += 7) {
                    fixtureSender = sender;
                    assert(voiceKey(NULL, type, event, &tap) == event);
                }
                assert(dialogueDownEdges + dialogueUpEdges == before);
                fixtureSender = 42;
                assert(voiceKey(NULL, type, event, &tap) == (dialogueActive ? NULL : event));
                assert(dialogueDownEdges + dialogueUpEdges == before + 1);
                CFRelease(event);
            }
        }
    }
    assert(dialogueDownEdges == 4 && dialogueUpEdges == 4);
    dialogueActive = false;
}

static void fixturePost(CGEventTapLocation location, CGEventRef event) {
    assert(location == kCGHIDEventTap);
    FixtureEvent *keyboard = keyboardEvent(event);
    assert(keyboard->key == 9 || keyboard->key == 36 || keyboard->key == 0 || keyboard->key == 51);
    assert(keyboard->flags == (keyboard->key == 9 || keyboard->key == 0 ? kCGEventFlagMaskCommand : 0));
    CGEventType type = keyboard->down ? kCGEventKeyDown : kCGEventKeyUp;
    assert(type == (posts % 2 ? kCGEventKeyUp : kCGEventKeyDown));
    posts++;
    if (type == kCGEventKeyDown && keyboard->key == 9 && focusedInput) {
        assert(clipboardText != nil && caret <= focusedInput.length);
        [focusedInput insertString:clipboardText atIndex:caret];
        caret += clipboardText.length;
    } else if (type == kCGEventKeyDown && keyboard->key == 36) {
        submissions++;
        submittedInput = [focusedInput copy];
    } else if (type == kCGEventKeyDown && keyboard->key == 0) {
        allSelected = true;
    } else if (type == kCGEventKeyDown && keyboard->key == 51) {
        assert(allSelected && focusedInput);
        [focusedInput setString:@""]; caret = 0; allSelected = false;
    }
}

int main(void) {
    @autoreleasepool {
        home_does_not_type_into_the_foreground_app();
        remote_ok_routes_only_the_active_dialogue_without_an_extra_enter();
        trusted = false;
        assert(keepwork_voice_input_permissions(false) == 1);
        assert(keepwork_voice_input_start() == 1 && axRequests == 0 && listenRequests == 0);
        assert(keepwork_voice_input_permissions(true) == 1 && axRequests == 1 && listenRequests == 0);
        trusted = true;
        assert(keepwork_voice_input_permissions(false) == 2);
        assert(keepwork_voice_input_start() == 2 && axRequests == 1 && listenRequests == 0);
        assert(keepwork_voice_input_permissions(true) == 2 && listenRequests == 1);
        allowOnRequest = true;
        assert(keepwork_voice_input_permissions(true) == 0 && listenRequests == 2);
        assert(keepwork_voice_input_permissions(true) == 0);
        assert(keepwork_voice_input_permissions(false) == 0);
        assert(axRequests == 1 && listenRequests == 2 && posts == 0 && copies == 0);

        NSMutableString *original = [@"original:" mutableCopy];
        NSMutableString *current = [@"current:tail" mutableCopy];
        focusedInput = original;
        caret = original.length;
        const char *text = "你好，当前输入框";
        assert(keepwork_voice_input_copy(text, strlen(text)));
        // Focus/caret changes while recognition runs: the native Cmd+V must go
        // to the input selected now, even with no AXSelectedTextRange support.
        focusedInput = current;
        caret = [@"current:" length];
        assert(keepwork_voice_input_paste());
        assert([original isEqualToString:@"original:"]);
        assert([current isEqualToString:@"current:你好，当前输入框tail"]);
        assert(posts == 2 && copies == 1 && metadataRequests == 0);
        NSString *clipboardBeforeSubmit = [clipboardText copy];
        assert(keepwork_voice_input_submit());
        assert(posts == 4 && copies == 1 && submissions == 1 && metadataRequests == 0);
        assert([submittedInput isEqualToString:@"current:你好，当前输入框tail"]);
        assert([current isEqualToString:submittedInput]); // Return never inserts command text or a newline.
        assert([clipboardText isEqualToString:clipboardBeforeSubmit]);
        assert(!keepwork_voice_input_modifiers());
        for (int index = 0; index < 4; index++) {
            heldFlags = (CGEventFlags[]){kCGEventFlagMaskCommand, kCGEventFlagMaskControl,
                kCGEventFlagMaskAlternate, kCGEventFlagMaskShift}[index];
            assert(keepwork_voice_input_modifiers());
        }
        heldFlags = 0;
        trusted = false;
        assert(!keepwork_voice_input_paste());
        assert(!keepwork_voice_input_submit());
        assert(posts == 4 && submissions == 1); // Permission failure cannot post an event or retry.
        clipboardAllowed = false;
        assert(!keepwork_voice_input_copy("test", 4));
        assert(posts == 4 && metadataRequests == 0);
        trusted = true;
        clipboardAllowed = true;
        clipboardText = @"keep this clipboard unchanged";
        NSString *beforeClear = [clipboardText copy];
        assert(keepwork_voice_input_clear() == 0);
        assert(current.length == 0 && [original isEqualToString:@"original:"]);
        assert(posts == 8 && submissions == 1 && copies == 2);
        assert(clipboardText == beforeClear || [clipboardText isEqualToString:beforeClear]);
        assert(metadataRequests > 0);
        [current setString:@"preserve"];
        for (int mode = 0; mode < 5; mode++) {
            editable = mode != 0; focusedRole = mode == 1 ? kAXButtonRole : kAXTextAreaRole;
            secure = mode == 2; controlEnabled = mode != 3;
            focusedInput = mode == 4 ? nil : current;
            assert(keepwork_voice_input_clear() == 1);
            assert(posts == 8 && [current isEqualToString:@"preserve"]);
        }
        focusedInput = current; editable = true; secure = false; controlEnabled = true;
        heldFlags = kCGEventFlagMaskShift;
        assert(keepwork_voice_input_clear() == 2 && posts == 8);
        heldFlags = 0; trusted = false;
        assert(keepwork_voice_input_clear() == 2 && posts == 8);
        puts("native current-focus paste and explicit Return passed with isolated clipboard and event hook");
        return 0;
    }
}
