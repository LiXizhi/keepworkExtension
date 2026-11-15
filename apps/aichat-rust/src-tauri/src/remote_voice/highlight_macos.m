// Nonactivating recording and transcription feedback for the current dictation target.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <math.h>
#include <stdatomic.h>
#include <stdint.h>

static _Atomic(uint64_t) queryPress;

// Chromium can withhold its accessibility tree until an assistive client requests it.
// Scope this application-level request to the foreground process during a physical press.
// Never change a global preference or disable a tree other clients may be using.
static void requestChromiumTree(AXUIElementRef app, pid_t pid, uint64_t press) {
    static uint64_t lastPress;
    static pid_t lastPid;
    static NSCache<NSString *, NSNumber *> *requested;
    if (!press || atomic_load(&queryPress) != press || (lastPress == press && lastPid == pid)) return;
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (front.processIdentifier != pid || !front.bundleURL) return;
    lastPress = press;
    lastPid = pid;
    NSString *key = [NSString stringWithFormat:@"%d/%f", pid, front.launchDate.timeIntervalSinceReferenceDate];
    if ([requested objectForKey:key]) return;
    NSString *bundle = front.bundleIdentifier;
    NSSet *browsers = [NSSet setWithArray:@[@"com.google.Chrome", @"com.google.Chrome.beta", @"com.google.Chrome.dev",
        @"com.google.Chrome.canary", @"org.chromium.Chromium", @"com.microsoft.edgemac", @"com.brave.Browser",
        @"com.vivaldi.Vivaldi", @"company.thebrowser.Browser"]];
    NSURL *framework = [front.bundleURL URLByAppendingPathComponent:@"Contents/Frameworks/Electron Framework.framework"];
    BOOL electron = [NSFileManager.defaultManager fileExistsAtPath:framework.path];
    if (!electron && (!bundle || ![browsers containsObject:bundle])) return;
    NSArray *flags = electron ? @[@"AXManualAccessibility", @"AXEnhancedUserInterface"] : @[@"AXEnhancedUserInterface"];
    for (NSString *flag in flags) {
        CFStringRef attribute = (__bridge CFStringRef)flag;
        CFTypeRef current = NULL;
        AXError status = AXUIElementCopyAttributeValue(app, attribute, &current);
        bool disabled = status == kAXErrorSuccess && current && CFEqual(current, kCFBooleanFalse);
        if (current) CFRelease(current);
        Boolean writable = false;
        if (!disabled || AXUIElementIsAttributeSettable(app, attribute, &writable) != kAXErrorSuccess || !writable) continue;
        if (atomic_load(&queryPress) != press || NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid) return;
        if (!requested) { requested = [NSCache new]; requested.countLimit = 64; }
        [requested setObject:@YES forKey:key];
        // Some Chrome versions expose the tree even though the setter reports kAXErrorNotImplemented.
        // Probe the real focused field on the next refresh and never infer success from the return code.
        AXUIElementSetAttributeValue(app, attribute, kCFBooleanTrue);
        return;
    }
}

// Confine AX IPC to a worker. Read only control metadata and geometry.
static CGRect voiceEditableFrame(pid_t pid, uint64_t press) {
    if (pid <= 0 || !AXIsProcessTrusted()) return CGRectNull;
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    if (!app) return CGRectNull;
    AXUIElementSetMessagingTimeout(app, 0.12);
    CFTypeRef focus = NULL;
    AXError result = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, &focus);
    if (result != kAXErrorSuccess || !focus || CFGetTypeID(focus) != AXUIElementGetTypeID()) {
        requestChromiumTree(app, pid, press);
        CFRelease(app);
        if (focus) CFRelease(focus);
        return CGRectNull;
    }

    CFRelease(app);
    AXUIElementRef field = (AXUIElementRef)focus;
    AXUIElementSetMessagingTimeout(field, 0.12);
    NSArray *attributes = @[(__bridge NSString *)kAXRoleAttribute, (__bridge NSString *)kAXSubroleAttribute,
        (__bridge NSString *)kAXEnabledAttribute, (__bridge NSString *)kAXPositionAttribute,
        (__bridge NSString *)kAXSizeAttribute];
    CFArrayRef values = NULL;
    result = AXUIElementCopyMultipleAttributeValues(field, (__bridge CFArrayRef)attributes, 0, &values);
    CGRect rect = CGRectNull;
    if (result == kAXErrorSuccess && values && CFArrayGetCount(values) == 5) {
        CFTypeRef role = CFArrayGetValueAtIndex(values, 0), subrole = CFArrayGetValueAtIndex(values, 1);
        CFTypeRef enabled = CFArrayGetValueAtIndex(values, 2);
        AXValueRef position = CFArrayGetValueAtIndex(values, 3), size = CFArrayGetValueAtIndex(values, 4);
        AXError missing = kAXErrorSuccess;
        // Subrole is optional. Unavailable/timeout errors cannot establish that a field is safe.
        bool ordinary = (CFGetTypeID(subrole) == CFStringGetTypeID() && !CFEqual(subrole, kAXSecureTextFieldSubrole))
            || (CFGetTypeID(subrole) == AXValueGetTypeID() && AXValueGetValue(subrole, kAXValueAXErrorType, &missing)
                && (missing == kAXErrorAttributeUnsupported || missing == kAXErrorNoValue));
        CGPoint origin;
        CGSize extent;
        Boolean editable = false;
        if (ordinary && (CFEqual(role, kAXTextFieldRole) || CFEqual(role, kAXTextAreaRole) || CFEqual(role, kAXComboBoxRole))
            && CFEqual(enabled, kCFBooleanTrue)
            && CFGetTypeID(position) == AXValueGetTypeID() && AXValueGetValue(position, kAXValueCGPointType, &origin)
            && CFGetTypeID(size) == AXValueGetTypeID() && AXValueGetValue(size, kAXValueCGSizeType, &extent)
            && isfinite(origin.x) && isfinite(origin.y) && isfinite(extent.width) && isfinite(extent.height)
            && extent.width >= 4 && extent.height >= 4
            && ((AXUIElementIsAttributeSettable(field, kAXValueAttribute, &editable) == kAXErrorSuccess && editable)
                || (AXUIElementIsAttributeSettable(field, kAXSelectedTextAttribute, &editable) == kAXErrorSuccess && editable))) {
            rect = (CGRect){origin, extent};
        }
    }
    if (values) CFRelease(values);
    CFRelease(focus);
    return rect;
}

@interface KeepworkVoiceOutlineView : NSView
@property NSTimeInterval started;
@property BOOL transcribing;
@end
@implementation KeepworkVoiceOutlineView
- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    NSTimeInterval held = NSProcessInfo.processInfo.systemUptime - self.started;
    BOOL reduceMotion = NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
    if (self.transcribing) {
        [[NSColor colorWithWhite:0.17 alpha:0.9] setFill];
        [[NSBezierPath bezierPathWithRoundedRect:self.bounds xRadius:11 yRadius:11] fill];
        for (int index = 0; index < 3; index++) {
            CGFloat wave = cos(2 * M_PI * (held / 0.95 - index / 3.0));
            CGFloat lift = reduceMotion ? 0 : 2.5 * wave;
            [[NSColor colorWithWhite:1 alpha:reduceMotion ? 1 : 0.82 + 0.18 * wave] setFill];
            [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(9 + 10 * index, 8 + lift, 6, 6)] fill];
        }
        return;
    }
    CGFloat alpha = 0.52;
    if (!reduceMotion) {
        alpha = 0.49 + 0.045 * cos(held * 2 * M_PI / 1.2);
    }
    [[NSColor colorWithSRGBRed:0.87 green:0.37 blue:0.34 alpha:alpha] setStroke];
    NSBezierPath *ring = [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds, 1, 1)
        xRadius:5 yRadius:5];
    ring.lineWidth = 2;
    [ring stroke];
}
@end

@interface KeepworkVoiceOutlinePanel : NSPanel
@end
@implementation KeepworkVoiceOutlinePanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

// AX uses global top-left coordinates; AppKit uses bottom-left relative to the primary screen.
static NSRect voiceScreenFrame(CGRect target, CGFloat primaryTop, NSArray<NSValue *> *screens) {
    if (CGRectIsNull(target)) return NSZeroRect;
    NSRect appKit = NSMakeRect(target.origin.x, primaryTop - CGRectGetMaxY(target), target.size.width, target.size.height);
    NSRect best = NSZeroRect;
    for (NSValue *screen in screens) {
        NSRect clipped = NSIntersectionRect(appKit, screen.rectValue);
        if (clipped.size.width * clipped.size.height > best.size.width * best.size.height) best = clipped;
    }
    return best;
}

// A compact field has a meaningful nearby edge. Large editors, inaccessible fields
// and virtual text controls use a general status indicator beside the pointer.
static bool voiceCompactField(NSRect field, NSRect workArea) {
    return !NSIsEmptyRect(field) && NSHeight(field) <= MIN(180, NSHeight(workArea) * 0.33);
}

static NSRect voiceWaitingFrame(NSRect field, NSRect screen, NSPoint pointer) {
    const CGFloat width = 44, height = 22;
    CGFloat x, y;
    if (voiceCompactField(field, screen)) {
        x = NSMinX(field) + 8;
        y = NSMaxY(field) + 3;
        if (y + height > NSMaxY(screen)) y = NSMinY(field) - 3 - height;
    } else {
        x = pointer.x + 16;
        if (x + width > NSMaxX(screen)) x = pointer.x - 16 - width;
        y = pointer.y - 12 - height;
        if (y < NSMinY(screen)) y = pointer.y + 12;
    }
    return NSMakeRect(MAX(NSMinX(screen), MIN(x, NSMaxX(screen) - width)),
        MAX(NSMinY(screen), MIN(y, NSMaxY(screen) - height)), width, height);
}

static KeepworkVoiceOutlinePanel *voicePanel;
static KeepworkVoiceOutlinePanel *previewPanel;
static NSTextField *previewLabel;
static NSString *previewText;
static NSTimer *voiceTimer, *dotsTimer;
static uint64_t latestPress, activePress;
static bool lookupPending, transcribing;
static CGRect currentTarget;
static pid_t displayedPid;
static NSTimeInterval pressedAt;

// Separate from the outline and dots so live captions never cover the insertion point.
static void placeVoicePreview(NSRect field, NSScreen *screen, NSPoint pointer) {
    if (!screen || !previewText.length) {
        [previewPanel orderOut:nil];
        return;
    }
    if (!previewPanel) {
        previewPanel = [[KeepworkVoiceOutlinePanel alloc] initWithContentRect:NSZeroRect
            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
            backing:NSBackingStoreBuffered defer:NO];
        previewPanel.opaque = NO;
        previewPanel.backgroundColor = NSColor.clearColor;
        previewPanel.ignoresMouseEvents = YES;
        previewPanel.hidesOnDeactivate = NO;
        previewPanel.level = NSStatusWindowLevel;
        previewPanel.sharingType = NSWindowSharingNone;
        previewPanel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorIgnoresCycle
            | NSWindowCollectionBehaviorTransient;
        NSView *background = [NSView new];
        background.wantsLayer = YES;
        background.layer.backgroundColor = [NSColor colorWithWhite:0.16 alpha:0.94].CGColor;
        background.layer.cornerRadius = 8;
        previewPanel.contentView = background;
        previewLabel = [NSTextField labelWithString:@""];
        previewLabel.font = [NSFont systemFontOfSize:14];
        previewLabel.textColor = NSColor.whiteColor;
        previewLabel.lineBreakMode = NSLineBreakByTruncatingHead;
        previewLabel.maximumNumberOfLines = 1;
        [background addSubview:previewLabel];
    }
    if (![previewLabel.stringValue isEqualToString:previewText]) previewLabel.stringValue = previewText;
    NSRect area = screen.visibleFrame;
    CGFloat width = MIN(NSWidth(area), MIN(440, MAX(68, ceil(previewLabel.intrinsicContentSize.width) + 24)));
    CGFloat height = 30;
    BOOL compact = voiceCompactField(field, area);
    CGFloat x = compact ? NSMinX(field) + 8 : pointer.x + 16;
    CGFloat y = compact ? NSMaxY(field) + 5 : pointer.y + 16;
    if (transcribing) y += 24;
    if (y + height > NSMaxY(area)) y = compact ? NSMinY(field) - height - 5 : pointer.y - height - 14;
    NSRect rect = NSMakeRect(MAX(NSMinX(area), MIN(x, NSMaxX(area) - width)),
        MAX(NSMinY(area), MIN(y, NSMaxY(area) - height)), width, height);
    if (!NSEqualRects(previewPanel.frame, rect)) [previewPanel setFrame:rect display:NO];
    previewLabel.frame = NSMakeRect(10, 5, width - 20, 20);
    if (!previewPanel.visible) [previewPanel orderFrontRegardless];
}

static void showVoiceFrame(CGRect target, pid_t pid) {
    NSArray<NSScreen *> *screens = NSScreen.screens;
    NSMutableArray *bounds = [NSMutableArray arrayWithCapacity:screens.count];
    for (NSScreen *screen in screens) [bounds addObject:[NSValue valueWithRect:screen.frame]];
    NSRect frame = voiceScreenFrame(target, NSMaxY(screens.firstObject.frame), bounds);
    currentTarget = target;
    if ((transcribing || previewText.length) && screens.count) {
        NSPoint pointer = NSEvent.mouseLocation;
        NSScreen *anchor = nil, *pointerScreen = nil;
        for (NSScreen *screen in screens) {
            if (!NSIsEmptyRect(frame) && NSContainsRect(screen.frame, frame) && voiceCompactField(frame, screen.visibleFrame))
                anchor = screen;
            if (NSPointInRect(pointer, screen.frame)) pointerScreen = screen;
        }
        NSScreen *display = anchor ?: pointerScreen ?: NSScreen.mainScreen ?: screens.firstObject;
        placeVoicePreview(anchor ? frame : NSZeroRect, display, pointer);
        if (transcribing) frame = voiceWaitingFrame(anchor ? frame : NSZeroRect, display.visibleFrame, pointer);
    }
    if (NSIsEmptyRect(frame)) {
        [voicePanel orderOut:nil];
        displayedPid = 0;
        return;
    }
    if (!voicePanel) {
        voicePanel = [[KeepworkVoiceOutlinePanel alloc] initWithContentRect:frame
            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
            backing:NSBackingStoreBuffered defer:NO];
        voicePanel.opaque = NO;
        voicePanel.backgroundColor = NSColor.clearColor;
        voicePanel.hasShadow = NO;
        voicePanel.ignoresMouseEvents = YES;
        voicePanel.hidesOnDeactivate = NO;
        voicePanel.level = NSStatusWindowLevel;
        voicePanel.animationBehavior = NSWindowAnimationBehaviorNone;
        voicePanel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorIgnoresCycle
            | NSWindowCollectionBehaviorTransient;
        voicePanel.contentView = [KeepworkVoiceOutlineView new];
        [voicePanel setAccessibilityElement:NO];
    }
    KeepworkVoiceOutlineView *view = (KeepworkVoiceOutlineView *)voicePanel.contentView;
    bool redraw = !voicePanel.visible || !NSEqualRects(voicePanel.frame, frame)
        || view.transcribing != transcribing || view.started != pressedAt;
    view.started = pressedAt;
    view.transcribing = transcribing;
    if (!NSEqualRects(voicePanel.frame, frame)) [voicePanel setFrame:frame display:NO];
    if (redraw || !transcribing) [view setNeedsDisplay:YES];
    if (!voicePanel.visible) [voicePanel orderFrontRegardless];
    displayedPid = pid;
}

static void refreshVoiceOutline(uint64_t press) {
    if (activePress != press) return;
    pid_t pid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    if (displayedPid != pid) showVoiceFrame(CGRectNull, pid);
    if (lookupPending || !pid) return;
    lookupPending = true;
    static dispatch_queue_t queue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ queue = dispatch_queue_create("keepwork.voice.focus-geometry", DISPATCH_QUEUE_SERIAL); });
    dispatch_async(queue, ^{
        if (atomic_load(&queryPress) != press) return;
        CGRect target = voiceEditableFrame(pid, press);
        dispatch_async(dispatch_get_main_queue(), ^{
            if (activePress != press) return;
            lookupPending = false;
            if (pid != NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) {
                showVoiceFrame(CGRectNull, NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
                return;
            }
            showVoiceFrame(target, pid);
        });
    });
}

static void clearVoiceOutline(void) {
    activePress = 0;
    atomic_store(&queryPress, 0);
    [voiceTimer invalidate];
    voiceTimer = nil;
    [dotsTimer invalidate];
    dotsTimer = nil;
    [voicePanel orderOut:nil];
    voicePanel = nil;
    [previewPanel orderOut:nil];
    previewPanel = nil;
    previewLabel = nil;
    previewText = nil;
    displayedPid = 0;
    lookupPending = false;
    transcribing = false;
    currentTarget = CGRectNull;
}

void keepwork_voice_highlight_start(uint64_t press) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!press || press <= latestPress) return;
        clearVoiceOutline();
        latestPress = activePress = press;
        atomic_store(&queryPress, press);
        pressedAt = NSProcessInfo.processInfo.systemUptime;
        refreshVoiceOutline(press);
        voiceTimer = [NSTimer timerWithTimeInterval:0.12 repeats:YES block:^(NSTimer *timer) {
            (void)timer;
            refreshVoiceOutline(press);
        }];
        [NSRunLoop.mainRunLoop addTimer:voiceTimer forMode:NSRunLoopCommonModes];
    });
}

void keepwork_voice_highlight_preview(uint64_t press, const uint8_t *bytes, size_t length) {
    NSString *text = [[NSString alloc] initWithBytes:bytes length:length encoding:NSUTF8StringEncoding];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!press || press != activePress) return;
        previewText = text;
        if (!text.length) {
            previewLabel.stringValue = @"";
            [previewPanel orderOut:nil];
            return;
        }
        pid_t pid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
        showVoiceFrame(displayedPid == pid ? currentTarget : CGRectNull, pid);
    });
}

void keepwork_voice_highlight_transcribing(uint64_t press) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!press || press != activePress || transcribing) return;
        transcribing = true;
        pressedAt = NSProcessInfo.processInfo.systemUptime;
        pid_t frontPid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
        showVoiceFrame(voicePanel.visible && displayedPid == frontPid ? currentTarget : CGRectNull, frontPid);
        // AX queries can take longer than a frame; keep the dots moving on the GUI clock.
        dotsTimer = [NSTimer timerWithTimeInterval:1.0 / 30 repeats:YES block:^(NSTimer *timer) {
            (void)timer;
            if (!NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) [voicePanel.contentView setNeedsDisplay:YES];
        }];
        [NSRunLoop.mainRunLoop addTimer:dotsTimer forMode:NSRunLoopCommonModes];
        refreshVoiceOutline(press);
    });
}

void keepwork_voice_highlight_end(uint64_t press) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (press < latestPress) return;
        latestPress = press;
        clearVoiceOutline();
    });
}
