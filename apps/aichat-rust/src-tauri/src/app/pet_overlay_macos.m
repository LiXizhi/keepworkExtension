#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <objc/runtime.h>
#include <math.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <time.h>
#include <stdint.h>

bool keepwork_pet_is_presented(void *window) {
    NSWindow *pet = (__bridge NSWindow *)window;
    __block bool presented = false;
    void (^check)(void) = ^{
        presented = !NSApp.hidden && pet.visible && !pet.miniaturized && pet.onActiveSpace;
    };
    if (NSThread.isMainThread) check();
    else dispatch_sync(dispatch_get_main_queue(), check);
    return presented;
}

// Only the main queue reads AppKit. The event tap can decide immediately whether
// to let the remote's native Return through, even for a nonactivating overlay.
static __weak NSWindow *okPet;
static _Atomic uint64_t okPresentation;
static void (*petOKAction)(uint64_t);

static void updatePetOKVisibility(void) {
    uint64_t epoch = atomic_load(&okPresentation);
    bool visible = keepwork_pet_is_presented((__bridge void *)okPet);
    if ((epoch & 1) != visible) atomic_fetch_add(&okPresentation, 1);
}

void keepwork_pet_watch_ok(void *window, void (*action)(uint64_t)) {
    NSCAssert(NSThread.isMainThread, @"Watch pet presentation on the main queue");
    NSWindow *pet = (__bridge NSWindow *)window;
    if (okPet != pet) {
        // A queued key from a previous window never belongs to its replacement.
        if (atomic_load(&okPresentation) & 1) atomic_fetch_add(&okPresentation, 1);
        okPet = pet;
    }
    petOKAction = action;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
        for (NSString *name in @[NSWindowDidChangeOcclusionStateNotification, NSWindowDidMiniaturizeNotification,
                                 NSWindowDidDeminiaturizeNotification, NSWindowWillCloseNotification]) {
            [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n) {
                if (n.object != okPet) return;
                if ([n.name isEqualToString:NSWindowWillCloseNotification]) okPet = nil;
                updatePetOKVisibility();
            }];
        }
        for (NSString *name in @[NSApplicationDidHideNotification, NSApplicationDidUnhideNotification]) {
            [center addObserverForName:name object:NSApp queue:NSOperationQueue.mainQueue
                usingBlock:^(__unused NSNotification *n) { updatePetOKVisibility(); }];
        }
        [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceActiveSpaceDidChangeNotification
            object:nil queue:NSOperationQueue.mainQueue usingBlock:^(__unused NSNotification *n) { updatePetOKVisibility(); }];
    });
    updatePetOKVisibility();
}

// Called by the source-checked keyboard event tap. No AppKit work on this thread.
bool keepwork_pet_queue_ok(uint64_t deviceEpoch) {
    uint64_t epoch = atomic_load(&okPresentation);
    if (!(epoch & 1)) return false;
    uint64_t pressed = clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
    dispatch_async(dispatch_get_main_queue(), ^{
        updatePetOKVisibility();
        if (epoch == atomic_load(&okPresentation) &&
            clock_gettime_nsec_np(CLOCK_UPTIME_RAW) - pressed < 750000000 && petOKAction) petOKAction(deviceEpoch);
    });
    return true;
}

static bool validRect(CGRect r) {
    return !CGRectIsEmpty(r) && !CGRectIsNull(r) && !CGRectIsInfinite(r) &&
        isfinite(r.origin.x) && isfinite(r.origin.y) &&
        isfinite(r.size.width) && isfinite(r.size.height);
}

// All three rectangles are in global Quartz points. Permit rounding of window
// edges and optional coverage of the menu bar / Dock, but never a window that
// only fills a display because it also extends far onto a second one.
bool keepwork_pet_rect_fills_screen(CGRect window, CGRect display, CGRect work) {
    if (!validRect(window) || !validRect(display) || !validRect(work)) return false;
    const CGFloat tolerance = 3;
    CGRect inside = CGRectInset(work, tolerance, tolerance);
    if (!validRect(inside) || !CGRectContainsRect(CGRectInset(display, -tolerance, -tolerance), window)) return false;
    if (CGRectContainsRect(window, inside)) return true;
    // macOS Fill can leave a small uniform tiling margin around the work area.
    // Check every edge so a side tile, or a window with a gap on only one
    // edge, does not qualify just because its width or height is close.
    CGFloat left = CGRectGetMinX(window) - CGRectGetMinX(work);
    CGFloat right = CGRectGetMaxX(work) - CGRectGetMaxX(window);
    CGFloat bottom = CGRectGetMaxY(work) - CGRectGetMaxY(window);
    CGFloat top = CGRectGetMinY(window) - CGRectGetMinY(work);
    CGFloat maxInset = MAX(MAX(left, right), MAX(bottom, top));
    CGFloat minInset = MIN(MIN(left, right), MIN(bottom, top));
    return minInset > 0 && maxInset <= 16 && maxInset - minInset <= tolerance;
}

static CGRect displayBounds(NSScreen *screen) {
    NSNumber *display = screen.deviceDescription[@"NSScreenNumber"];
    return display ? CGDisplayBounds(display.unsignedIntValue) : CGRectNull;
}

static CGRect workBounds(NSScreen *screen, CGRect display) {
    NSRect frame = screen.frame, visible = screen.visibleFrame;
    return CGRectMake(display.origin.x + NSMinX(visible) - NSMinX(frame),
                      display.origin.y + NSMaxY(frame) - NSMaxY(visible),
                      NSWidth(visible), NSHeight(visible));
}

static NSScreen *screenFilledBy(CGRect window) {
    for (NSScreen *screen in NSScreen.screens) {
        CGRect display = displayBounds(screen);
        if (keepwork_pet_rect_fills_screen(window, display, workBounds(screen, display))) return screen;
    }
    return nil;
}

static CGRect focusedExternalBounds(pid_t pid) {
    // Use existing accessibility access only. No prompt, window title, document
    // content or image is necessary to decide which display the pet belongs on.
    if (!AXIsProcessTrusted()) return CGRectNull;
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    if (!app) return CGRectNull;
    AXUIElementSetMessagingTimeout(app, 0.18f);
    CFTypeRef focused = NULL;
    AXError result = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &focused);
    CFRelease(app);
    if (result != kAXErrorSuccess || !focused) return CGRectNull;
    CGRect bounds = CGRectNull;
    if (CFGetTypeID(focused) == AXUIElementGetTypeID()) {
        AXUIElementRef window = (AXUIElementRef)focused;
        AXUIElementSetMessagingTimeout(window, 0.18f);
        NSArray *attributes = @[(__bridge NSString *)kAXPositionAttribute, (__bridge NSString *)kAXSizeAttribute];
        CFArrayRef values = NULL;
        if (AXUIElementCopyMultipleAttributeValues(window, (__bridge CFArrayRef)attributes, 0, &values) == kAXErrorSuccess &&
            values && CFArrayGetCount(values) == 2) {
            AXValueRef position = CFArrayGetValueAtIndex(values, 0);
            AXValueRef size = CFArrayGetValueAtIndex(values, 1);
            CGPoint origin;
            CGSize extent;
            if (CFGetTypeID(position) == AXValueGetTypeID() &&
                CFGetTypeID(size) == AXValueGetTypeID() &&
                AXValueGetValue(position, kAXValueCGPointType, &origin) &&
                AXValueGetValue(size, kAXValueCGSizeType, &extent)) {
                bounds = (CGRect){origin, extent};
            }
        }
        if (values) CFRelease(values);
    }
    CFRelease(focused);
    return bounds;
}

static CGRect frontmostExternalBounds(pid_t pid) {
    CGRect focused = focusedExternalBounds(pid);
    if (validRect(focused)) return focused;
    // WindowServer supplies front-to-back geometry even when AX is unavailable.
    // A smaller front window must take precedence over a maximized one behind it.
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    for (NSDictionary *entry in windows) {
        if ([entry[(__bridge NSString *)kCGWindowOwnerPID] intValue] != pid ||
            [entry[(__bridge NSString *)kCGWindowLayer] integerValue] != kCGNormalWindowLevel ||
            [entry[(__bridge NSString *)kCGWindowAlpha] doubleValue] <= 0) continue;
        CGRect frame;
        NSDictionary *bounds = entry[(__bridge NSString *)kCGWindowBounds];
        if (bounds && CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bounds, &frame) &&
            validRect(frame)) return frame;
    }
    return CGRectNull;
}

bool keepwork_pet_overlay_target(int32_t *x, int32_t *y, int32_t *width, int32_t *height) {
    if (!NSThread.isMainThread || !x || !y || !width || !height) return false;
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    // Home over our own chat switches windows, including when zoomed or fullscreen.
    if (!front || front.processIdentifier == NSProcessInfo.processInfo.processIdentifier) return false;
    NSScreen *target = screenFilledBy(frontmostExternalBounds(front.processIdentifier));
    if (front.processIdentifier != NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) return false;
    if (!target) return false;
    CGRect display = displayBounds(target);
    if (!validRect(display)) return false;
    *x = (int32_t)lround(display.origin.x);
    *y = (int32_t)lround(display.origin.y);
    *width = (int32_t)lround(display.size.width);
    *height = (int32_t)lround(display.size.height);
    return true;
}

@interface KeepworkPetOverlayStyle : NSObject
@property(nonatomic) NSWindowLevel level;
@property(nonatomic) NSWindowCollectionBehavior behavior;
@property(nonatomic) BOOL hidesOnDeactivate;
@property(nonatomic,strong) NSPanel *anchor;
@end
@implementation KeepworkPetOverlayStyle
@end
static char styleKey;

bool keepwork_pet_overlay_show(void *petWindow) {
    NSWindow *pet = (__bridge NSWindow *)petWindow;
    if (!NSThread.isMainThread || !pet || pet.miniaturized) return false;
    KeepworkPetOverlayStyle *original = objc_getAssociatedObject(pet, &styleKey);
    if (!original) {
        original = [KeepworkPetOverlayStyle new];
        original.level = pet.level;
        original.behavior = pet.collectionBehavior;
        original.hidesOnDeactivate = pet.hidesOnDeactivate;
        objc_setAssociatedObject(pet, &styleKey, original, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    NSWindowCollectionBehavior behavior = original.behavior;
    behavior &= ~(NSWindowCollectionBehaviorMoveToActiveSpace | NSWindowCollectionBehaviorFullScreenPrimary |
                  NSWindowCollectionBehaviorFullScreenNone);
    behavior |= NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
    if (@available(macOS 13.0, *)) {
        behavior &= ~(NSWindowCollectionBehaviorPrimary | NSWindowCollectionBehaviorAuxiliary);
        behavior |= NSWindowCollectionBehaviorCanJoinAllApplications;
    }
    pet.collectionBehavior = behavior;
    pet.hidesOnDeactivate = NO;
    pet.level = MAX(original.level, NSFloatingWindowLevel);
    NSPoint center = NSMakePoint(NSMidX(pet.frame), NSMidY(pet.frame));
    if (!original.anchor && !pet.parentWindow) {
        // A regular app's NSWindow can remain on its old Space even with
        // FullScreenAuxiliary. A nonactivating NSPanel can join the foreground
        // full-screen app and carry the actual interactive pet as a child.
        NSPanel *anchor = [[NSPanel alloc] initWithContentRect:NSMakeRect(center.x, center.y, 1, 1)
            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
            backing:NSBackingStoreBuffered defer:NO];
        anchor.backgroundColor = NSColor.clearColor;
        anchor.opaque = NO;
        anchor.hasShadow = NO;
        anchor.ignoresMouseEvents = YES;
        anchor.hidesOnDeactivate = NO;
        anchor.collectionBehavior = behavior;
        anchor.level = pet.level;
        original.anchor = anchor;
    }
    NSPanel *anchor = original.anchor;
    if (anchor) {
        if (!NSPointInRect(center, anchor.screen.frame)) {
            // Moving a parent also moves its children. Preserve the new pet
            // frame that the host already set on the destination display.
            if (pet.parentWindow == anchor) [anchor removeChildWindow:pet];
            [anchor setFrameOrigin:center];
        }
        [anchor orderFrontRegardless];
        if (!pet.parentWindow) [anchor addChildWindow:pet ordered:NSWindowAbove];
    }
    [pet orderFrontRegardless];
    updatePetOKVisibility();
    return pet.visible;
}

void keepwork_pet_overlay_finish(void *petWindow, bool hide) {
    NSWindow *pet = (__bridge NSWindow *)petWindow;
    if (!NSThread.isMainThread || !pet) return;
    KeepworkPetOverlayStyle *original = objc_getAssociatedObject(pet, &styleKey);
    bool keepHidden = hide || !pet.visible;
    if (hide) [pet orderOut:nil];
    if (!original) return;
    if (original.anchor) {
        [original.anchor removeChildWindow:pet];
        [original.anchor orderOut:nil];
    }
    pet.level = original.level;
    pet.collectionBehavior = original.behavior;
    pet.hidesOnDeactivate = original.hidesOnDeactivate;
    if (keepHidden && pet.visible) [pet orderOut:nil];
    objc_setAssociatedObject(pet, &styleKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    updatePetOKVisibility();
}
