#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdint.h>
#include <unistd.h>

extern bool keepwork_pet_overlay_target(void *, void *, int32_t *, int32_t *, int32_t *, int32_t *);
extern bool keepwork_pet_overlay_show(void *);
extern bool keepwork_pet_rect_fills_screen(CGRect, CGRect, CGRect);
extern void keepwork_pet_overlay_finish(void *, bool);

extern void keepwork_pet_watch_ok(void *, void (*)(uint64_t));
extern bool keepwork_pet_queue_ok(uint64_t);
static int deliveredOK;
static void petOK(uint64_t epoch) { if (epoch == 42) deliveredOK++; }

static BOOL waitFor(NSTimeInterval seconds, BOOL (^condition)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (!condition() && deadline.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]
            inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
        [NSApp updateWindows];
    }
    return condition();
}

static NSWindow *makeWindow(NSString *title, NSWindowStyleMask style, NSRect frame) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:frame styleMask:style
        backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.title = title;
    return window;
}

static pid_t foreground(void) {
    return NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
}

// This process owns the regular, resizable foreground window. No accessibility,
// synthetic input, or calls to another application's windows are needed.
static int editor(NSString *mode, NSString *dir) {
    pid_t host = getppid();
    NSWindow *window = makeWindow(@"Home overlay fixture editor",
        NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable |
        NSWindowStyleMaskMiniaturizable, NSMakeRect(40, 60, 420, 300));
    window.collectionBehavior = NSWindowCollectionBehaviorFullScreenPrimary;
    [window center];
    [window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    if (!waitFor(5, ^{ return (BOOL)(foreground() == getpid() && window.isKeyWindow); })) {
        fprintf(stderr, "Fixture editor could not become foreground.\n");
        return 77;
    }
    BOOL full = [mode isEqualToString:@"fullscreen"];
    __block BOOL entered = NO;
    id observer = [NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidEnterFullScreenNotification
        object:window queue:nil usingBlock:^(__unused NSNotification *event) { entered = YES; }];
    if (full) [window toggleFullScreen:nil];
    else [window performZoom:nil];
    BOOL positioned = waitFor(8, ^{
        return (BOOL)((full ? entered && (window.styleMask & NSWindowStyleMaskFullScreen) : window.isZoomed)
            && window.isOnActiveSpace && foreground() == getpid());
    });
    [NSNotificationCenter.defaultCenter removeObserver:observer];
    if (!positioned) {
        fprintf(stderr, "WindowServer did not enter fixture %s mode.\n", mode.UTF8String);
        return 77;
    }
    NSString *ready = [dir stringByAppendingPathComponent:@"ready"];
    NSNumber *display = window.screen.deviceDescription[@"NSScreenNumber"];
    if (!display || ![@{@"editor": @(window.windowNumber), @"display": display} writeToFile:ready atomically:YES]) return 1;
    NSString *done = [dir stringByAppendingPathComponent:@"done"];
    waitFor(15, ^{ return (BOOL)(getppid() != host || [NSFileManager.defaultManager fileExistsAtPath:done]); });
    if (full) {
        [window toggleFullScreen:nil];
        waitFor(3, ^{ return (BOOL)!(window.styleMask & NSWindowStyleMaskFullScreen); });
    }
    [window close];
    return 0;
}

static NSInteger onscreenIndex(NSArray *list, NSInteger number, pid_t owner) {
    return [list indexOfObjectPassingTest:^BOOL(NSDictionary *entry, NSUInteger i, BOOL *stop) {
        return [entry[(id)kCGWindowNumber] integerValue] == number &&
            [entry[(id)kCGWindowOwnerPID] intValue] == owner;
    }];
}

static NSArray *onscreen(void) {
    return CFBridgingRelease(CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
}

static int testOverlay(NSString *executable, NSString *mode, NSString *dir) {
    NSWindow *chat = makeWindow(@"Home overlay fixture chat", NSWindowStyleMaskTitled, NSMakeRect(80, 80, 400, 200));
    NSWindow *pet = makeWindow(@"Home overlay fixture pet", NSWindowStyleMaskBorderless, NSMakeRect(140, 140, 96, 96));
    pet.backgroundColor = NSColor.systemGreenColor;
    NSWindowCollectionBehavior behavior = pet.collectionBehavior;
    NSWindowLevel level = pet.level;
    NSTask *peer = [NSTask new];
    peer.executableURL = [NSURL fileURLWithPath:executable];
    peer.arguments = @[@"editor", mode, dir];
    NSError *error = nil;
    if (![peer launchAndReturnError:&error]) {
        fprintf(stderr, "Could not start fixture editor.\n");
        return 1;
    }
    int result = 1;
    @try {
        NSString *ready = [dir stringByAppendingPathComponent:@"ready"];
        if (!waitFor(16, ^{ return (BOOL)(!peer.running || [NSFileManager.defaultManager fileExistsAtPath:ready]); })) {
            fprintf(stderr, "Timed out waiting for fixture editor.\n");
            return 1;
        }
        if (!peer.running) return peer.terminationStatus == 77 ? 77 : 1;
        keepwork_pet_watch_ok((__bridge void *)pet, petOK);
        if (keepwork_pet_queue_ok(42)) return 1; // The editor owns Return before presentation.
        NSDictionary *info = [NSDictionary dictionaryWithContentsOfFile:ready];
        NSInteger editorID = [info[@"editor"] integerValue];
        if (foreground() != peer.processIdentifier || editorID <= 0) {
            fprintf(stderr, "Foreground changed before overlay check.\n");
            return 77;
        }
        int32_t x = 0, y = 0, width = 0, height = 0;
        if (!keepwork_pet_overlay_target((__bridge void *)chat, (__bridge void *)pet, &x, &y, &width, &height)
                || width <= 0 || height <= 0) {
            fprintf(stderr, "Production target lookup missed the foreground %s editor.\n", mode.UTF8String);
            return 1;
        }
        CGRect display = CGDisplayBounds([info[@"display"] unsignedIntValue]);
        if (!CGRectEqualToRect(display, CGRectMake(x, y, width, height))) {
            fprintf(stderr, "Detected the wrong display for the fixture editor.\n"); return 1;
        }
        for (NSScreen *screen in NSScreen.screens) {
            if ([screen.deviceDescription[@"NSScreenNumber"] isEqual:info[@"display"]]) {
                [pet setFrameOrigin:NSMakePoint(NSMidX(screen.frame), NSMidY(screen.frame))];
                break;
            }
        }
        for (int press = 0; press < 2; ++press) {
            if (!keepwork_pet_overlay_show((__bridge void *)pet)) {
                fprintf(stderr, "Production show helper failed.\n"); return 1;
            }
            BOOL above = waitFor(2, ^{
                NSArray *list = onscreen();
                NSInteger editorIdx = onscreenIndex(list, editorID, peer.processIdentifier);
                NSInteger petIdx = onscreenIndex(list, pet.windowNumber, getpid());
                return (BOOL)(editorIdx != NSNotFound && petIdx != NSNotFound && petIdx < editorIdx &&
                    pet.isVisible && pet.isOnActiveSpace && foreground() == peer.processIdentifier && !chat.visible);
            });
            if (!above) {
                NSArray *list = onscreen();
                fprintf(stderr, "Pet order check failed for %s. Foreground retained=%d, pet visible=%d, on active Space=%d, chat visible=%d, order pet=%ld editor=%ld (NSNotFound=%ld), level=%ld.\n",
                    mode.UTF8String, foreground() == peer.processIdentifier, pet.visible, pet.onActiveSpace,
                    chat.visible, (long)onscreenIndex(list, pet.windowNumber, getpid()),
                    (long)onscreenIndex(list, editorID, peer.processIdentifier), (long)NSNotFound, (long)pet.level);
                return 1;
            }
            if (!keepwork_pet_queue_ok(42) || !waitFor(1, ^{ return (BOOL)(deliveredOK == press + 1); }) ||
                foreground() != peer.processIdentifier) {
                fprintf(stderr, "Visible overlay did not consume exactly one OK without activating.\n");
                return 1;
            }
            if (!keepwork_pet_queue_ok(42)) return 1; // Hide before this callback is dispatched.
            if (press == 1) [pet orderOut:nil]; // Normal Tauri hide precedes native style restoration.
            keepwork_pet_overlay_finish((__bridge void *)pet, press == 0);
            if (!waitFor(1, ^{
                return (BOOL)(!pet.visible && !chat.visible && pet.level == level && pet.collectionBehavior == behavior &&
                    foreground() == peer.processIdentifier &&
                    onscreenIndex(onscreen(), pet.windowNumber, getpid()) == NSNotFound);
            })) {
                fprintf(stderr, "Dismissing the fixture pet altered focus, restored chat, or left overlay flags.\n");
                return 1;
            }
            if (keepwork_pet_queue_ok(42) || deliveredOK != press + 1) return 1;
        }
        printf("passed %s: foreground retained, pet above editor on active Space, chat hidden, two show/hide cycles\n",
               mode.UTF8String);
        result = 0;
    } @finally {
        [pet orderOut:nil];
        [chat close];
        NSString *done = [dir stringByAppendingPathComponent:@"done"];
        [@"done" writeToFile:done atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        if (!waitFor(5, ^{ return (BOOL)!peer.running; }) && peer.running) [peer terminate];
    }
    return result;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        CGRect secondary = CGRectMake(-1440, -160, 1440, 900);
        CGRect work = CGRectInset(secondary, 0, 24);
        if (!keepwork_pet_rect_fills_screen(secondary, secondary, work) ||
            !keepwork_pet_rect_fills_screen(work, secondary, work) ||
            !keepwork_pet_rect_fills_screen(CGRectInset(work, 8, 8), secondary, work) ||
            keepwork_pet_rect_fills_screen(CGRectMake(-1440, -136, 720, 852), secondary, work) ||
            keepwork_pet_rect_fills_screen(CGRectMake(-1440, -136, 2880, 852), secondary, work) ||
            keepwork_pet_rect_fills_screen(CGRectInset(work, 56, 56), secondary, work) ||
            keepwork_pet_rect_fills_screen(CGRectNull, secondary, work)) {
            fprintf(stderr, "Failed fullscreen, margin-fill, half-tile or secondary-display geometry.\n");
            return 1;
        }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp finishLaunching];
        if (argc == 4 && !strcmp(argv[1], "editor"))
            return editor(@(argv[2]), @(argv[3]));
        if (argc == 4)
            return testOverlay(@(argv[1]), @(argv[2]), @(argv[3]));
        return 1;
    }
}
