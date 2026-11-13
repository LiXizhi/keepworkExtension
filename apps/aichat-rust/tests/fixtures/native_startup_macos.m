// The production AppKit view is exercised in a hidden, isolated NSWindow.
// No application activation, WebView, service, account or user profile is used.
#import <Cocoa/Cocoa.h>
#include <assert.h>
#include "../../src-tauri/src/app/native_startup_macos.m"

typedef struct {
    unsigned retries;
    unsigned hides;
    unsigned releases;
} FixtureActions;

static void action(void *context, bool retry) {
    assert([NSThread isMainThread]);
    FixtureActions *actions = context;
    if (retry) actions->retries++;
    else actions->hides++;
}

static void releaseContext(void *context) {
    FixtureActions *actions = context;
    actions->releases++;
}

static void assertNativeTree(NSView *view) {
    NSString *name = NSStringFromClass(view.class);
    assert([name rangeOfString:@"WebView" options:NSCaseInsensitiveSearch].location == NSNotFound);
    for (NSView *child in view.subviews) assertNativeTree(child);
}

static void assertState(KeepworkStartupView *view, BOOL failed) {
    [view layoutSubtreeIfNeeded];
    assert([view.iconView isKindOfClass:NSImageView.class]);
    assert([view.titleLabel isKindOfClass:NSTextField.class]);
    assert([view.summaryLabel isKindOfClass:NSTextField.class]);
    assert([view.spinner isKindOfClass:NSProgressIndicator.class]);
    assert(view.spinner.style == NSProgressIndicatorStyleSpinning);
    assert(view.spinner.hidden == failed);
    assert(view.retryButton.hidden == !failed);
    assert(view.hideButton.hidden == !failed);
    assert(view.retryButton.enabled && view.hideButton.enabled);
    assert([view.titleLabel.stringValue isEqualToString:@"KeepWork 第二大脑"]);
    assert([view.summaryLabel.stringValue isEqualToString:failed ? @"暂时无法打开工作台" : @"正在准备工作台…"]);
    if (failed) assert([view.summaryLabel.toolTip isEqualToString:@"请检查网络或本地服务后重试。"]);
    else assert(view.summaryLabel.toolTip == nil);
    assert(view.titleLabel.cell.cellSize.width <= NSWidth(view.titleLabel.frame));
    assert(view.summaryLabel.cell.cellSize.width <= NSWidth(view.summaryLabel.frame));
    for (NSView *child in view.subviews) assert(NSContainsRect(view.bounds, child.frame));
    assert(!NSIntersectsRect(view.titleLabel.frame, view.summaryLabel.frame));
    assert(!NSIntersectsRect(view.iconView.frame, view.titleLabel.frame));
    assert(!NSIntersectsRect(view.iconView.frame, view.summaryLabel.frame));
    NSRect identity = NSUnionRect(view.iconView.frame,
        NSUnionRect(view.titleLabel.frame, view.summaryLabel.frame));
    assert(fabs(NSMidX(identity) - NSMidX(view.bounds)) <= 1);
    if (!failed) {
        assert(fabs(NSMidY(identity) - NSMidY(view.bounds)) <= 1);
        assert(NSMidY(view.spinner.frame) == NSMidY(view.summaryLabel.frame));
        assert(!NSIntersectsRect(view.spinner.frame, view.summaryLabel.frame));
    } else {
        assert(!NSIntersectsRect(view.hideButton.frame, view.retryButton.frame));
        assert(!NSIntersectsRect(view.summaryLabel.frame, view.retryButton.frame));
    }
    NSButton *close = [view.window standardWindowButton:NSWindowCloseButton];
    assert(close && !close.hidden && close.enabled);
    NSRect closeFrame = [view convertRect:close.frame fromView:close.superview];
    for (NSView *child in view.subviews) {
        if (!child.hidden) assert(!NSIntersectsRect(closeFrame, child.frame));
    }
    assertNativeTree(view);
}

int main(void) {
    FixtureActions actions = {0};
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        assert(!keepwork_startup_install(NULL, &actions, action, releaseContext));
        assert(!keepwork_startup_update(NULL, false));
        assert(actions.releases == 0);
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 360, 176)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskFullSizeContentView
            backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        assert(!window.visible);
        assert(!keepwork_startup_update((__bridge void *)window, true));
        assert(keepwork_startup_install((__bridge void *)window, &actions, action, releaseContext));
        assert(window.titleVisibility == NSWindowTitleHidden);
        assert(window.titlebarAppearsTransparent);
        assert(window.movableByWindowBackground);
        @autoreleasepool {
            KeepworkStartupView *view = (KeepworkStartupView *)window.contentView;
            NSRect originalFrame = window.frame;
            for (NSAppearanceName appearance in @[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]) {
                window.appearance = [NSAppearance appearanceNamed:appearance];
                assert(keepwork_startup_update((__bridge void *)window, false));
                assertState(view, NO);
                assert(keepwork_startup_update((__bridge void *)window, true));
                assertState(view, YES);
                assert(NSEqualRects(window.frame, originalFrame));
            }
            assert(keepwork_startup_update((__bridge void *)window, false));
            assertState(view, NO);
            assert([view.retryButton.keyEquivalent isEqualToString:@"\r"]);
            assert([view.hideButton.keyEquivalent isEqualToString:@"\e"]);
            assert(view.acceptsFirstResponder);
            assert(window.firstResponder == view);
            // Escape must reach the native responder while the failure-only
            // buttons are still hidden, without requiring a visible window.
            [view cancelOperation:nil];
            assert(actions.hides == 1);
            NSEvent *escape = [NSEvent keyEventWithType:NSEventTypeKeyDown
                location:NSZeroPoint modifierFlags:0 timestamp:0
                windowNumber:window.windowNumber context:nil characters:@"\e"
                charactersIgnoringModifiers:@"\e" isARepeat:NO keyCode:53];
            [view keyDown:escape];
            assert(actions.hides == 2);

            assert(keepwork_startup_update((__bridge void *)window, true));
            assertState(view, YES);
            [view.retryButton performClick:nil];
            assert([view.hideButton performKeyEquivalent:escape]);
            assert(actions.retries == 1 && actions.hides == 3);
            assert(actions.releases == 0);

            // Reusing the same controls must preserve callbacks and reset UI.
            assert(keepwork_startup_update((__bridge void *)window, false));
            assertState(view, NO);
            assert(keepwork_startup_update((__bridge void *)window, true));
            [view.retryButton performClick:nil];
            assert(actions.retries == 2 && actions.hides == 3);
            assert(!window.visible);
        }
        window.contentView = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 360, 176)];
        assert(!keepwork_startup_update((__bridge void *)window, true));
        [window close];
    }
    assert(actions.releases == 1);
    puts("native startup AppKit controls passed");
    return 0;
}
