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
#define NSPasteboard FixturePasteboard
#define AXIsProcessTrusted fixtureTrusted
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
#undef NSPasteboard
#undef AXIsProcessTrusted
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
