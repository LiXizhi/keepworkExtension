// Run the actual AppKit panel and worker with only the target AX metadata isolated.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <assert.h>
#include <stdatomic.h>
#include <unistd.h>

static _Atomic(int) fieldKind;
static _Atomic(bool) holdLookup, lookupEntered;
static _Atomic(int) horizontal = 80;
static _Atomic(int) writableChecks;

static Boolean trustedFixture(void) { return true; }
static AXUIElementRef appFixture(pid_t pid) {
    assert(pid > 0);
    return (AXUIElementRef)CFDictionaryCreate(NULL, NULL, NULL, 0, NULL, NULL);
}
static AXError focusFixture(AXUIElementRef app, CFStringRef attr, CFTypeRef *value) {
    assert(app && CFEqual(attr, kAXFocusedUIElementAttribute));
    *value = CFRetain(app);
    return kAXErrorSuccess;
}
static AXError timeoutFixture(AXUIElementRef app, float timeout) {
    assert(app && timeout < 0.5f);
    return kAXErrorSuccess;
}
static AXError fieldsFixture(AXUIElementRef app, CFArrayRef attrs, AXCopyMultipleAttributeOptions options, CFArrayRef *out) {
    assert(app && !options && CFArrayGetCount(attrs) == 5);
    CFStringRef expected[] = {kAXRoleAttribute, kAXSubroleAttribute, kAXEnabledAttribute, kAXPositionAttribute, kAXSizeAttribute};
    for (int i = 0; i < 5; i++) assert(CFEqual(expected[i], CFArrayGetValueAtIndex(attrs, i)));
    if (atomic_load(&holdLookup)) {
        atomic_store(&lookupEntered, true);
        while (atomic_load(&holdLookup)) usleep(2000);
    }
    int kind = atomic_load(&fieldKind);
    AXError missing = kAXErrorAttributeUnsupported;
    AXValueRef unsupported = AXValueCreate(kAXValueAXErrorType, &missing);
    CGPoint point = CGPointMake(atomic_load(&horizontal), 80);
    CGSize size = kind == 7 ? CGSizeMake(0, 18) : kind == 8 ? CGSizeMake(1200, 700) : CGSizeMake(160, 28);
    AXValueRef pos = AXValueCreate(kAXValueCGPointType, &point), extent = AXValueCreate(kAXValueCGSizeType, &size);
    const void *values[] = {kind == 3 ? kAXButtonRole : kAXTextAreaRole,
        kind == 1 ? (CFTypeRef)kAXSecureTextFieldSubrole : unsupported,
        kind == 2 ? kCFBooleanFalse : kCFBooleanTrue, kind == 5 ? unsupported : pos, extent};
    *out = CFArrayCreate(NULL, values, 5, &kCFTypeArrayCallBacks);
    CFRelease(pos); CFRelease(extent); CFRelease(unsupported);
    return kAXErrorSuccess;
}
static AXError writableFixture(AXUIElementRef field, CFStringRef attribute, Boolean *writable) {
    assert(field && (CFEqual(attribute, kAXValueAttribute) || CFEqual(attribute, kAXSelectedTextAttribute)));
    atomic_fetch_add(&writableChecks, 1);
    int kind = atomic_load(&fieldKind);
    *writable = kind != 4 && (kind != 6 || CFEqual(attribute, kAXSelectedTextAttribute));
    return kAXErrorSuccess;
}
#define AXIsProcessTrusted trustedFixture
#define AXUIElementCreateApplication appFixture
#define AXUIElementGetTypeID CFDictionaryGetTypeID
#define AXUIElementCopyAttributeValue focusFixture
#define AXUIElementSetMessagingTimeout timeoutFixture
#define AXUIElementCopyMultipleAttributeValues fieldsFixture
#define AXUIElementIsAttributeSettable writableFixture
#include "../../src-tauri/src/remote_voice/highlight_macos.m"

static bool until(BOOL (^condition)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:1.5];
    while (!condition() && [deadline timeIntervalSinceNow] > 0)
        [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    return condition();
}

static void emitFixturePreview(uint64_t press, NSString *text) {
    NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
    keepwork_voice_highlight_preview(press, data.bytes, data.length);
}

static NSBitmapImageRep *renderIndicator(KeepworkVoiceOutlineView *view) {
    NSBitmapImageRep *image = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
        pixelsWide:(NSInteger)NSWidth(view.bounds) pixelsHigh:(NSInteger)NSHeight(view.bounds)
        bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace
        bytesPerRow:0 bitsPerPixel:0];
    [NSGraphicsContext saveGraphicsState];
    NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:image];
    [view drawRect:view.bounds];
    [NSGraphicsContext restoreGraphicsState];
    return image;
}

int main(void) {
    @autoreleasepool {
        NSArray *monitors = @[[NSValue valueWithRect:NSMakeRect(0, 0, 1440, 900)],
                              [NSValue valueWithRect:NSMakeRect(-1920, 100, 1920, 1080)]];
        assert(NSEqualRects(voiceScreenFrame(CGRectMake(-1300, -100, 80, 30), 900, monitors),
                            NSMakeRect(-1300, 970, 80, 30)));
        assert(NSIsEmptyRect(voiceScreenFrame(CGRectMake(15000, 40, 80, 30), 900, monitors)));
        NSRect above = voiceWaitingFrame(NSMakeRect(-1900, 100, 250, 20), [(NSValue *)monitors[1] rectValue], NSZeroPoint);
        assert(above.size.width == 44 && above.size.height == 22 && NSMinY(above) == 123);
        for (int kind = 0; kind <= 6; kind++) {
            atomic_store(&fieldKind, kind);
            assert(CGRectIsNull(voiceEditableFrame(1, 0)) == (kind != 0 && kind != 6));
        }
        assert(atomic_load(&writableChecks) == 5); // Secure and disabled fields exit before checking writability.
        atomic_store(&fieldKind, 0);
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
        if (!NSScreen.screens.count || !front) {
            puts("headless: outline metadata and monitor geometry passed");
            return 0;
        }
        keepwork_voice_highlight_start(100);
        assert(until(^BOOL { return voicePanel.visible; }));
        assert(voicePanel.ignoresMouseEvents && !voicePanel.canBecomeKeyWindow && !voicePanel.canBecomeMainWindow);
        assert(!voicePanel.keyWindow && (voicePanel.styleMask & NSWindowStyleMaskNonactivatingPanel));
        assert(!NSApp.active && !NSApp.keyWindow);
        NSBitmapImageRep *recordingPixels = renderIndicator((KeepworkVoiceOutlineView *)voicePanel.contentView);
        NSColor *stroke = [recordingPixels colorAtX:60 y:1];
        assert(stroke.alphaComponent >= 0.43 && stroke.alphaComponent < 0.55);
        assert(stroke.redComponent > stroke.greenComponent && stroke.greenComponent > 0.29);
        assert([recordingPixels colorAtX:60 y:3].alphaComponent == 0); // Two-point stroke.
        atomic_store(&horizontal, 165);
        assert(until(^BOOL { return voicePanel.visible && NSMinX(voicePanel.frame) == 165; }));
        emitFixturePreview(99, @"上一轮");
        emitFixturePreview(100, @"第一句话。");
        assert(until(^BOOL { return previewPanel.visible && [previewLabel.stringValue isEqual:@"第一句话。"]; }));
        assert(!previewPanel.canBecomeKeyWindow && !previewPanel.keyWindow && previewPanel.ignoresMouseEvents);
        assert(NSContainsRect(previewPanel.screen.visibleFrame, previewPanel.frame));
        assert(!NSApp.active && !NSApp.keyWindow);
        emitFixturePreview(100, @"第一句话。第二句话。");
        assert(until(^BOOL { return previewPanel.visible && [previewLabel.stringValue isEqual:@"第一句话。第二句话。"]; }));
        emitFixturePreview(100, @"");
        assert(until(^BOOL { return !previewPanel.visible; }));
        emitFixturePreview(100, @"收尾句。");
        assert(until(^BOOL { return previewPanel.visible; }));
        keepwork_voice_highlight_transcribing(99);
        keepwork_voice_highlight_transcribing(100);
        assert(until(^BOOL { return transcribing && voicePanel.visible && NSWidth(voicePanel.frame) == 44; }));
        assert(NSHeight(voicePanel.frame) == 22);
        assert(NSMinX(voicePanel.frame) == 173 && !voicePanel.keyWindow);
        NSBitmapImageRep *waitingPixels = renderIndicator((KeepworkVoiceOutlineView *)voicePanel.contentView);
        CGFloat background = [waitingPixels colorAtX:6 y:11].redComponent;
        for (NSInteger x = 12; x <= 32; x += 10) {
            CGFloat peak = 0;
            for (NSInteger y = 5; y <= 17; y++) peak = MAX(peak, [waitingPixels colorAtX:x y:y].redComponent);
            assert(peak > background + 0.25);
        }
        atomic_store(&horizontal, 90);
        assert(until(^BOOL { return voicePanel.visible && NSMinX(voicePanel.frame) == 98; }));
        atomic_store(&fieldKind, 1);
        assert(until(^BOOL { return voicePanel.visible && CGRectIsNull(currentTarget); })); // General status only.
        NSScreen *current = voicePanel.screen;
        assert(NSContainsRect(current.visibleFrame, voicePanel.frame));
        atomic_store(&fieldKind, 8);
        assert(until(^BOOL { return voicePanel.visible && currentTarget.size.width == 1200; }));
        NSRect nearPointer = voiceWaitingFrame(NSZeroRect, current.visibleFrame, NSEvent.mouseLocation);
        assert(fabs(NSMinX(voicePanel.frame) - NSMinX(nearPointer)) < 2 && fabs(NSMinY(voicePanel.frame) - NSMinY(nearPointer)) < 2);
        atomic_store(&fieldKind, 0);
        keepwork_voice_highlight_start(101);
        emitFixturePreview(100, @"迟到的上一轮文字");
        keepwork_voice_highlight_transcribing(100);
        keepwork_voice_highlight_end(100);
        assert(until(^BOOL { return activePress == 101 && !transcribing && voicePanel.visible && NSWidth(voicePanel.frame) == 160; }));
        assert(!previewPanel.visible);
        emitFixturePreview(101, @"新录音");
        assert(until(^BOOL { return previewPanel.visible && [previewLabel.stringValue isEqual:@"新录音"]; }));
        keepwork_voice_highlight_end(101);
        emitFixturePreview(101, @"结束后的文字");
        keepwork_voice_highlight_transcribing(101);
        keepwork_voice_highlight_start(101);
        assert(until(^BOOL { return !activePress && !voicePanel && !voiceTimer && !previewPanel.visible; }));
        assert(!NSApp.active && !NSApp.keyWindow);
        atomic_store(&fieldKind, 7);
        atomic_store(&holdLookup, true);
        keepwork_voice_highlight_start(102);
        assert(until(^BOOL { return atomic_load(&lookupEntered); }));
        keepwork_voice_highlight_transcribing(102);
        assert(until(^BOOL { return voicePanel.visible && NSWidth(voicePanel.frame) == 44 && dotsTimer.valid; }));
        assert(lookupPending); // Even the first blocked AX lookup cannot delay the waiting overlay.
        atomic_store(&holdLookup, false);
        assert(until(^BOOL { return !lookupPending && CGRectIsNull(currentTarget) && voicePanel.visible; }));
        keepwork_voice_highlight_end(102);
        assert(until(^BOOL { return !voicePanel && !dotsTimer && !voiceTimer; }));
        puts("AppKit current-field outline passed");
    }
}
