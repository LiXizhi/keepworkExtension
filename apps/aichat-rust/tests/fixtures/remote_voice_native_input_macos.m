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

@interface FixtureWorkspace : NSObject
+ (instancetype)sharedWorkspace;
@property(nonatomic, readonly) FixtureWorkspace *frontmostApplication;
@property(nonatomic, readonly) pid_t processIdentifier;
@property(nonatomic, readonly) NSString *bundleIdentifier;
@property(nonatomic, readonly) NSURL *bundleURL;
@end
static pid_t frontPid;
static bool allSelected;
static NSUInteger selectionWrites, selectedTextWrites;
static BOOL onlySelectedText;
static BOOL chromium, ignoreSelectAll, switchOnSelect;
static NSUInteger frontReads, switchFrontAt;
static NSUInteger focusReads, changeFocusAt, writes, missingFocusReads, windowReads, changeWindowAt;
static BOOL systemFocus, wrongSystemApp, wrongSystemWindow, systemSecure, switchSystemField;
static NSUInteger systemFieldReads, failedWindowReads;
static NSUInteger interruptAtWindowRead;
static BOOL interruptDuringSelectionCheck;
static AXError writeResult = kAXErrorSuccess;
static double inputAge = 120.0;
static CFTimeInterval fixtureInputAge(CGEventSourceStateID state, CGEventType type) {
    assert(state == kCGEventSourceStateCombinedSessionState);
    return inputAge;
}
static AXUIElementRef fixtureApp(pid_t pid);
static AXError __attribute__((unused)) fixtureParameterized(AXUIElementRef element, CFStringRef attribute, CFTypeRef parameter, CFTypeRef *value) {
    assert(CFEqual(attribute, CFSTR("AXTextMarkerRangeForUIElement")) || CFEqual(attribute, CFSTR("AXLengthForTextMarkerRange")));
    *value = NULL;
    return kAXErrorAttributeUnsupported;
}
static AXError fixtureSetValue(AXUIElementRef element, CFStringRef attribute, CFTypeRef value);
static Boolean fixtureTrusted(void);
static Boolean fixtureRequestTrusted(CFDictionaryRef options);
static bool fixtureListenAllowed(void);
static bool fixtureRequestListen(void);
static void fixturePost(CGEventTapLocation location, CGEventRef event);
static void __attribute__((unused)) fixturePostToPid(pid_t pid, CGEventRef event);
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
#define NSWorkspace FixtureWorkspace
#define AXUIElementCopyParameterizedAttributeValue fixtureParameterized
#define AXUIElementCreateApplication fixtureApp
#define AXUIElementSetAttributeValue fixtureSetValue
#define AXIsProcessTrusted fixtureTrusted
#define AXIsProcessTrustedWithOptions fixtureRequestTrusted
#define CGPreflightListenEventAccess fixtureListenAllowed
#define CGRequestListenEventAccess fixtureRequestListen
#define CGEventPostToPid fixturePostToPid
#define CGEventPost fixturePost
#define CGEventSourceFlagsState fixtureFlags
#define CGEventSourceSecondsSinceLastEventType fixtureInputAge
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
#undef NSWorkspace
#undef AXUIElementCopyParameterizedAttributeValue
#undef AXUIElementCreateApplication
#undef AXUIElementSetAttributeValue
#undef AXIsProcessTrusted
#undef AXIsProcessTrustedWithOptions
#undef CGPreflightListenEventAccess
#undef CGRequestListenEventAccess
#undef CGEventPost
#undef CGEventPostToPid
#undef CGEventSourceFlagsState
#undef CGEventSourceSecondsSinceLastEventType
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
static bool editable = true, secure = false, controlEnabled = true;
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

@implementation FixtureWorkspace
+ (instancetype)sharedWorkspace { static FixtureWorkspace *instance; return instance ?: (instance = [self new]); }
- (FixtureWorkspace *)frontmostApplication { return self; }
- (NSString *)bundleIdentifier { return chromium ? @"com.google.Chrome" : @"com.keepwork.fixture.editor"; }
- (NSURL *)bundleURL { return nil; }
- (pid_t)processIdentifier {
    return switchFrontAt && ++frontReads >= switchFrontAt ? frontPid + 1 : frontPid;
}
@end

static AXUIElementRef fixtureApp(pid_t pid) {
    assert(pid == frontPid); return (AXUIElementRef)CFBridgingRetain(@{@"kind": @"app"});
}
static AXError fixtureSetValue(AXUIElementRef field, CFStringRef attr, CFTypeRef value) {
    assert(field);
    if (systemFocus) assert([(__bridge NSDictionary *)field isEqual:@{@"kind":@"system-field"}]);
    if (CFEqual(attr, kAXSelectedTextRangeAttribute)) {
        CFRange range = {-1,-1};
        assert(AXValueGetValue(value, kAXValueCFRangeType, &range));
        assert(range.location == 0 && range.length == focusedInput.length);
        selectionWrites++;
        allSelected = !ignoreSelectAll;
        if (switchOnSelect) changeFocusAt = focusReads + 1;
        return kAXErrorSuccess;
    }
    if (CFEqual(attr, kAXSelectedTextAttribute)) {
        assert(onlySelectedText && allSelected && CFEqual(value, CFSTR("")));
        selectedTextWrites++;
        [focusedInput setString:@""];
        allSelected = false;
        return kAXErrorSuccess;
    }
    assert(CFEqual(attr, kAXValueAttribute) && CFEqual(value, CFSTR("")));
    writes++;
    if (writeResult == kAXErrorSuccess) [focusedInput setString:@""];
    return writeResult;
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
    NSDictionary *node = (__bridge NSDictionary *)element;
    NSString *kind = node[@"kind"];
    metadataRequests++;
    *value = NULL;
    if (systemFocus && CFEqual(attribute, kAXFocusedApplicationAttribute)) {
        *value = CFBridgingRetain(@{@"kind": wrongSystemApp ? @"other-app" : @"app"});
    } else if (systemFocus && CFEqual(attribute, kAXFocusedUIElementAttribute)) {
        if ([kind isEqual:@"app"]) *value = CFBridgingRetain(@{@"kind":@"wrapper"});
        else {
            systemFieldReads++;
            *value = CFBridgingRetain(@{@"kind": switchSystemField && systemFieldReads > 1 ? @"other-field" : @"system-field"});
        }
    } else if (systemFocus && CFEqual(attribute, kAXWindowAttribute)) {
        *value = CFBridgingRetain(@{@"window": @(wrongSystemWindow ? 999 : 1)});
    } else if (CFEqual(attribute, kAXMainWindowAttribute)) {
        *value = CFBridgingRetain(@{@"window": @1});
    } else if (CFEqual(attribute, kAXFocusedAttribute)) {
        *value = CFRetain(kCFBooleanTrue);
    } else if (CFEqual(attribute, kAXFocusedUIElementAttribute)) {
        if (!focusedInput) return kAXErrorNoValue;
        focusReads++;
        if (focusReads <= missingFocusReads) return kAXErrorNoValue;
        *value = changeFocusAt && focusReads >= changeFocusAt
            ? CFBridgingRetain(@{@"focus": @"other"}) : (CFTypeRef)fixtureSystem();
    } else if (CFEqual(attribute, kAXFocusedWindowAttribute)) {
        windowReads++;
        if (windowReads <= failedWindowReads) return kAXErrorCannotComplete;
        if (interruptAtWindowRead && windowReads == interruptAtWindowRead) keepwork_voice_interrupt_back();
        *value = CFBridgingRetain(@{@"window": @(changeWindowAt && windowReads >= changeWindowAt ? 2 : 1)});
    } else if (CFEqual(attribute, kAXRoleAttribute)) *value = CFRetain([kind isEqual:@"wrapper"] ? kAXWindowRole : (focusedRole ?: kAXTextAreaRole));
    else if (CFEqual(attribute, kAXSubroleAttribute)) *value = CFRetain((secure || (systemSecure && [kind isEqual:@"system-field"])) ? kAXSecureTextFieldSubrole : CFSTR("AXStandardTextField"));
    else if (CFEqual(attribute, kAXEnabledAttribute)) *value = CFRetain(controlEnabled ? kCFBooleanTrue : kCFBooleanFalse);
    else if (CFEqual(attribute, kAXNumberOfCharactersAttribute))
        *value = CFBridgingRetain(@(focusedInput.length));
    else if (CFEqual(attribute, kAXSelectedTextRangeAttribute)) {
        if (interruptDuringSelectionCheck) keepwork_voice_interrupt_back();
        CFRange range = allSelected ? CFRangeMake(0, focusedInput.length) : CFRangeMake(2, 3);
        *value = AXValueCreate(kAXValueCFRangeType, &range);
    } else {
        // The clear operation can check geometry/count, without reading any text.
        assert(!CFEqual(attribute, kAXValueAttribute));
        assert(!CFEqual(attribute, kAXSelectedTextAttribute));
        return kAXErrorAttributeUnsupported;
    }
    return kAXErrorSuccess;
}
static AXUIElementRef fixtureSystem(void) { return (AXUIElementRef)CFDictionaryCreate(NULL, NULL, NULL, 0, NULL, NULL); }
static CFTypeID fixtureAXType(void) { return CFDictionaryGetTypeID(); }
static AXError fixtureTimeout(AXUIElementRef element, float seconds) { (void)element; assert(seconds <= 0.5); return kAXErrorSuccess; }
static AXError fixtureSettable(AXUIElementRef element, CFStringRef attribute, Boolean *settable) {
    (void)element;
    *settable = editable && ((!onlySelectedText && CFEqual(attribute, kAXValueAttribute)) ||
        ((onlySelectedText || chromium) && (CFEqual(attribute, kAXSelectedTextRangeAttribute) || CFEqual(attribute, kAXSelectedTextAttribute))));
    return kAXErrorSuccess;
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

static NSUInteger targetedEvents;
static void fixturePostToPid(pid_t pid, CGEventRef event) {
    assert(pid == frontPid && chromium);
    FixtureEvent *key = keyboardEvent(event);
    assert(key->key == 51 && key->flags == 0);
    targetedEvents++;
    if (key->down) {
        assert(allSelected);
        [focusedInput setString:@""];
        allSelected = false;
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
        trusted = true; editable = true; controlEnabled = true; secure = false;
        focusedRole = kAXTextFieldRole; frontPid = getpid() + 1;
        assert(keepwork_voice_input_clear_back() == 0 && writes == 1 && !current.length);
        [current setString:@"fixture external draft"];
        frontPid = getpid();

        assert(keepwork_voice_input_clear_back() == 0 && writes == 2);
        [current setString:@"preserve"];
        frontPid = getpid() + 1;
        secure = true;
        assert(keepwork_voice_input_clear_back() == 1 && writes == 2);
        secure = false; editable = false;
        assert(keepwork_voice_input_clear_back() == 1 && writes == 2);
        editable = true; heldFlags = kCGEventFlagMaskShift;
        assert(keepwork_voice_input_clear_back() == 3 && writes == 2);
        heldFlags = 0; focusReads = 0; changeFocusAt = 2;
        assert(keepwork_voice_input_clear_back() == 5 && writes == 2);
        changeFocusAt = 0;
        frontReads = 0; switchFrontAt = 2;
        assert(keepwork_voice_input_clear_back() == 5 && writes == 2);
        switchFrontAt = 0; trusted = false;
        assert(keepwork_voice_input_clear_back() == 2 && writes == 2);
        trusted = true;
        writeResult = kAXErrorCannotComplete;
        assert(keepwork_voice_input_clear_back() == 2 && writes == 3);
        assert([current isEqualToString:@"preserve"] && [clipboardText isEqualToString:beforeClear] && posts == 8);
        writeResult = kAXErrorSuccess;
        focusReads = windowReads = 0; missingFocusReads = 1; changeWindowAt = 2;
        assert(keepwork_voice_input_clear_back() == 5 && writes == 3);
        changeWindowAt = 0; inputAge = 0; focusReads = windowReads = 0;
        assert(keepwork_voice_input_clear_back() == 5 && writes == 3);
        inputAge = 120; focusReads = windowReads = 0;
        assert(keepwork_voice_input_clear_back() == 0 && writes == 4 && !current.length);
        assert(posts == 8 && [clipboardText isEqualToString:beforeClear]);
        chromium = true;
        [current setString:@"Partial selection and other paragraphs"];
        focusReads = missingFocusReads = 0;
        assert(keepwork_voice_input_clear_back() == 0);
        assert(selectionWrites == 1 && targetedEvents == 2 && posts == 8 && writes == 4 && !current.length);
        [current setString:@"preserve a partial selection"];
        ignoreSelectAll = true;
        assert(keepwork_voice_input_clear_back() != 0 && selectionWrites == 2 && targetedEvents == 2 && current.length > 0);
        ignoreSelectAll = false; switchOnSelect = true;
        assert(keepwork_voice_input_clear_back() != 0 && selectionWrites == 3 && targetedEvents == 2 && current.length > 0);
        assert(posts == 8 && [clipboardText isEqualToString:beforeClear]);
        switchOnSelect = false; changeFocusAt = 0; allSelected = false;
        onlySelectedText = true; chromium = false;
        assert(keepwork_voice_input_clear_back() == 0 && selectedTextWrites == 1);
        assert(targetedEvents == 2 && posts == 8 && writes == 4 && !current.length);
        // Stop while a cold AX lookup is awaiting its first usable field.
        onlySelectedText = false; chromium = true;
        [current setString:@"Keep this draft after stopping"];
        focusReads = windowReads = 0; missingFocusReads = 1;
        interruptAtWindowRead = 2;
        NSUInteger beforeSelect = selectionWrites;
        assert(keepwork_voice_input_clear_back() == 5 && windowReads == 2);
        assert(selectionWrites == beforeSelect && targetedEvents == 2 && writes == 4);
        assert([current isEqualToString:@"Keep this draft after stopping"]);
        // Also stop after AX accepts the selection, immediately before Delete.
        interruptAtWindowRead = 0; missingFocusReads = 0;
        interruptDuringSelectionCheck = true;
        assert(keepwork_voice_input_clear_back() == 5);
        assert(selectionWrites == beforeSelect + 1 && targetedEvents == 2 && writes == 4);
        assert([current isEqualToString:@"Keep this draft after stopping"]);
        // A fresh physical press can proceed under the new session generation.
        interruptDuringSelectionCheck = false;
        assert(keepwork_voice_input_clear_back() == 0 && targetedEvents == 4 && !current.length);
        assert(posts == 8 && [clipboardText isEqualToString:beforeClear]);
        // A transient focused-window timeout resolves to the same pinned main
        // window on the next probe. No intervening field/window switch occurs.
        [current setString:@"transient"];
        focusReads = windowReads = 0; failedWindowReads = 2; missingFocusReads = 1;
        assert(keepwork_voice_input_clear_back() == 0 && !current.length && windowReads >= 3);
        failedWindowReads = missingFocusReads = 0;
        // App AX returns a web window after keyboard paste. macOS still reports
        // its actual focused field with a containing window in the foreground app.
        chromium = false; systemFocus = true;
        [current setString:@"keyboard pasted"];
        assert(keepwork_voice_input_clear_back() == 0 && !current.length);
        NSUInteger beforeBlocked = writes;
        [current setString:@"survives"];
        systemSecure = true;
        assert(keepwork_voice_input_clear_back() != 0 && writes == beforeBlocked);
        systemSecure = false; wrongSystemApp = true;
        assert(keepwork_voice_input_clear_back() != 0 && writes == beforeBlocked);
        wrongSystemApp = false; wrongSystemWindow = true;
        assert(keepwork_voice_input_clear_back() != 0 && writes == beforeBlocked);
        wrongSystemWindow = false; switchSystemField = true; systemFieldReads = 0;
        assert(keepwork_voice_input_clear_back() != 0 && writes == beforeBlocked);
        assert([current isEqual:@"survives"] && [clipboardText isEqual:beforeClear]);
        puts("native current-focus paste and explicit Return passed with isolated clipboard and event hook");
        return 0;
    }
}
