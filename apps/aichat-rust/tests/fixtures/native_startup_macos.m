// Exercise the production AppKit overlay above one real, ephemeral WKWebView.
// The only window stays hidden; no activation, network, service or profile is used.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
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

static void assertOverlay(NSWindow *window, NSView *container, WKWebView *webview,
    KeepworkStartupView *overlay) {
    assert(window.contentView == container);
    assert(webview.superview == container && webview.window == window);
    assert(container.subviews.lastObject == overlay);
    assert(overlay.superview == container);
    assert(NSEqualRects(overlay.frame, container.bounds));
    assert(overlay.isOpaque);
    assert([container hitTest:NSMakePoint(4, 4)] == overlay);
    NSBitmapImageRep *pixels = [overlay bitmapImageRepForCachingDisplayInRect:overlay.bounds];
    assert(pixels);
    [overlay cacheDisplayInRect:overlay.bounds toBitmapImageRep:pixels];
    // A transparent NSView would leave alpha zero here and expose the loading
    // document underneath even though its controls appeared above the WebView.
    assert([pixels colorAtX:4 y:4].alphaComponent > 0.99);
}

int main(void) {
    FixtureActions actions = {0};
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        assert(!keepwork_startup_install(NULL, &actions, action, releaseContext));
        assert(!keepwork_startup_update(NULL, false));
        assert(!keepwork_startup_remove(NULL));
        assert(!keepwork_startup_is_installed(NULL));
        assert(actions.releases == 0);
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 640, 480)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskFullSizeContentView
            backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        NSView *container = window.contentView;
        WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
        configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        WKWebView *webview = [[WKWebView alloc] initWithFrame:container.bounds configuration:configuration];
        webview.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        [container addSubview:webview];
        BOOL originalDragging = window.movableByWindowBackground;
        assert(!window.visible);
        assert(!keepwork_startup_update((__bridge void *)window, true));
        assert(keepwork_startup_install((__bridge void *)window, &actions, action, releaseContext));
        assert(keepwork_startup_is_installed((__bridge void *)window));
        assert(window.titleVisibility == NSWindowTitleHidden);
        assert(window.titlebarAppearsTransparent);
        assert(window.movableByWindowBackground == originalDragging);
        @autoreleasepool {
            KeepworkStartupView *view = KeepworkStartupFindView(window);
            assert(view);
            assertOverlay(window, container, webview, view);
            NSRect originalFrame = window.frame;
            for (NSAppearanceName appearance in @[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]) {
                window.appearance = [NSAppearance appearanceNamed:appearance];
                assert(keepwork_startup_update((__bridge void *)window, false));
                assertState(view, NO);
                assert(keepwork_startup_update((__bridge void *)window, true));
                assertState(view, YES);
                assertOverlay(window, container, webview, view);
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
            [view interpretKeyEvents:@[escape]];
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

            // Resizing the app during startup must keep the entire WebView
            // covered without replacing the window or its document container.
            [window setContentSize:NSMakeSize(960, 640)];
            [container layoutSubtreeIfNeeded];
            assertOverlay(window, container, webview, view);
            assertState(view, YES);
            assert(window.movableByWindowBackground == originalDragging);

            assert(keepwork_startup_remove((__bridge void *)window));
            assert(!keepwork_startup_is_installed((__bridge void *)window));
            assert(container.subviews.count == 1 && container.subviews.firstObject == webview);
            assert(window.contentView == container && webview.window == window);
            assert(window.firstResponder == webview);
            assert(!window.visible);
        }
        // AppKit may retain a detached view until its current autorelease pool
        // drains; verify all callback releases after leaving that pool below.
        assert(actions.releases <= 1);
        assert(!keepwork_startup_update((__bridge void *)window, true));
        assert(keepwork_startup_remove((__bridge void *)window));
        // A later reload reattaches to the exact same document, with fresh
        // callbacks that release independently when readiness removes it.
        @autoreleasepool {
            assert(keepwork_startup_install((__bridge void *)window, &actions, action, releaseContext));
            KeepworkStartupView *view = KeepworkStartupFindView(window);
            assertOverlay(window, container, webview, view);
            [view.retryButton performClick:nil];
            assert(actions.retries == 3);
            assert(keepwork_startup_remove((__bridge void *)window));
            assert(window.firstResponder == webview);
        }
        assert(actions.releases <= 2);
        [window close];
    }
    assert(actions.releases == 2);
    puts("native startup AppKit controls passed");
    return 0;
}
