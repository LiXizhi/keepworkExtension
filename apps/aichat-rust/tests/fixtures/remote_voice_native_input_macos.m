// Compile the real snapshot implementation against fake Accessibility calls.
// This fixture never starts an event tap, touches the clipboard or posts input.
#define AXIsProcessTrusted fixtureTrusted
#define AXUIElementCreateSystemWide fixtureSystemWide
#define AXUIElementSetMessagingTimeout fixtureTimeout
#define AXUIElementCopyAttributeValue fixtureAttribute
#define AXUIElementGetPid fixturePid
#include "../../src-tauri/src/remote_voice/native_input_macos.m"
#include <assert.h>
#include <stdio.h>

static bool trusted = true;
static bool missingWindow;
static bool missingRange;
static bool invalidRange;
static bool negativeRange;
static bool wrongValueType;
static CFIndex caret = 7;

Boolean fixtureTrusted(void) { return trusted; }
AXUIElementRef fixtureSystemWide(void) { return (AXUIElementRef)CFRetain(CFSTR("fixture-system")); }
AXError fixtureTimeout(AXUIElementRef element, float seconds) {
    (void)element;
    assert(seconds > 0 && seconds <= 0.2f);
    return kAXErrorSuccess;
}
AXError fixturePid(AXUIElementRef element, pid_t *pid) {
    (void)element;
    *pid = 4242;
    return kAXErrorSuccess;
}
AXError fixtureAttribute(AXUIElementRef element, CFStringRef attribute, CFTypeRef *value) {
    (void)element;
    *value = NULL;
    if (CFEqual(attribute, kAXFocusedApplicationAttribute)) *value = CFRetain(CFSTR("fixture-app"));
    else if (CFEqual(attribute, kAXFocusedUIElementAttribute)) *value = CFRetain(CFSTR("fixture-control"));
    else if (CFEqual(attribute, kAXFocusedWindowAttribute)) {
        if (missingWindow) return kAXErrorAttributeUnsupported;
        *value = CFRetain(CFSTR("fixture-window"));
    } else if (CFEqual(attribute, kAXSelectedTextRangeAttribute)) {
        if (missingRange) return kAXErrorAttributeUnsupported;
        if (invalidRange) *value = CFRetain(CFSTR("not-an-AXValue"));
        else if (wrongValueType) {
            CGPoint point = CGPointMake(1, 2);
            *value = AXValueCreate(kAXValueCGPointType, &point);
        } else {
            CFRange range = CFRangeMake(negativeRange ? -1 : caret, 0);
            *value = AXValueCreate(kAXValueCFRangeType, &range);
        }
    } else return kAXErrorAttributeUnsupported;
    return kAXErrorSuccess;
}

int main(void) {
    uint64_t original[12], current[12];
    assert(keepwork_voice_input_target(original));
    assert(original[0] == 4242 && original[2] != 0 && original[3] == 1);
    assert(original[4] == 7 && original[5] == 0);
    assert(keepwork_voice_input_target(current));
    assert(memcmp(original, current, sizeof(original)) == 0);
    caret = 8;
    assert(keepwork_voice_input_target(current));
    assert(memcmp(original, current, sizeof(original)) != 0);
    missingWindow = true;
    assert(!keepwork_voice_input_target(current));
    missingWindow = false;
    missingRange = true;
    assert(!keepwork_voice_input_target(current));
    missingRange = false;
    invalidRange = true;
    assert(!keepwork_voice_input_target(current));
    invalidRange = false;
    negativeRange = true;
    assert(!keepwork_voice_input_target(current));
    negativeRange = false;
    wrongValueType = true;
    assert(!keepwork_voice_input_target(current));
    wrongValueType = false;
    trusted = false;
    assert(!keepwork_voice_input_target(current));
    assert(!keepwork_voice_input_target(NULL));
    puts("native voice input focus snapshots passed");
    return 0;
}
