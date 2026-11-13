#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#include <stdbool.h>
#include <math.h>

typedef void (*KeepworkStartupAction)(void *, bool);
typedef void (*KeepworkStartupRelease)(void *);

// A native overlay rendered INSIDE the main window, above the WKWebView. The
// main window is the only startup surface; this view is added as a subview and
// removed in place when the trusted document is ready. It never replaces the
// window's content view and never owns a second OS window.
@interface KeepworkStartupView : NSView
@property(nonatomic, strong) NSImageView *iconView;
@property(nonatomic, strong) NSTextField *titleLabel;
@property(nonatomic, strong) NSTextField *summaryLabel;
@property(nonatomic, strong) NSProgressIndicator *spinner;
@property(nonatomic, strong) NSButton *retryButton;
@property(nonatomic, strong) NSButton *hideButton;
@property(nonatomic, assign) void *callbackContext;
@property(nonatomic, assign) KeepworkStartupAction actionCallback;
@property(nonatomic, assign) KeepworkStartupRelease releaseCallback;
@property(nonatomic, assign) BOOL failed;
- (void)setFailed:(BOOL)failed;
@end

@implementation KeepworkStartupView
- (void)dealloc {
    if (_callbackContext && _releaseCallback) _releaseCallback(_callbackContext);
}
- (void)retry:(id)sender {
    if (self.actionCallback) self.actionCallback(self.callbackContext, true);
}
- (void)hide:(id)sender {
    if (self.actionCallback) self.actionCallback(self.callbackContext, false);
}
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)isOpaque { return YES; }
- (void)drawRect:(NSRect)dirtyRect {
    [NSColor.windowBackgroundColor setFill];
    NSRectFill(dirtyRect);
}
- (void)viewDidChangeEffectiveAppearance {
    [super viewDidChangeEffectiveAppearance];
    self.needsDisplay = YES;
}
// Drag the window by the overlay background only. This is a view-level trait,
// so removing the overlay restores normal chat text selection; it must never
// become a window-wide movableByWindowBackground setting.
- (BOOL)mouseDownCanMoveWindow { return YES; }
- (void)cancelOperation:(id)sender {
    [self hide:sender];
}
- (void)layout {
    [super layout];
    // Center the identity group as one unit in the full window, keeping the two
    // text lines on a shared left edge beside the icon. On failure the group
    // shifts up so the centered action row fits below it without moving the
    // window. Layout is independent of the webview zoom factor.
    CGFloat width = NSWidth(self.bounds);
    CGFloat height = NSHeight(self.bounds);
    CGFloat textWidth = MIN(width - 120, ceil(MAX(
        self.titleLabel.cell.cellSize.width,
        self.summaryLabel.cell.cellSize.width + (self.failed ? 0 : 18))));
    CGFloat groupWidth = 48 + 16 + textWidth;
    CGFloat left = floor((width - groupWidth) / 2);
    CGFloat textLeft = left + 48 + 16;
    CGFloat top = height / 2 + (self.failed ? 50 : 25);
    self.iconView.frame = NSMakeRect(left, top - 48, 48, 48);
    self.titleLabel.frame = NSMakeRect(textLeft, top - 22, textWidth, 24);
    self.summaryLabel.frame = NSMakeRect(textLeft + (self.failed ? 0 : 18), top - 52,
        textWidth - (self.failed ? 0 : 18), 22);
    self.spinner.frame = NSMakeRect(textLeft, top - 47, 12, 12);
    CGFloat rowWidth = 84 + 12 + 84;
    CGFloat rowLeft = floor((width - rowWidth) / 2);
    CGFloat rowTop = top - 100;
    self.hideButton.frame = NSMakeRect(rowLeft, rowTop, 84, 30);
    self.retryButton.frame = NSMakeRect(rowLeft + 96, rowTop, 84, 30);
}
- (void)setFailed:(BOOL)failed {
    _failed = failed;
    self.summaryLabel.stringValue = failed ? @"暂时无法打开工作台" : @"正在准备工作台…";
    self.summaryLabel.toolTip = failed ? @"请检查网络或本地服务后重试。" : nil;
    self.retryButton.hidden = !failed;
    self.hideButton.hidden = !failed;
    self.spinner.hidden = failed;
    if (failed) [self.spinner stopAnimation:nil];
    else [self.spinner startAnimation:nil];
    self.needsLayout = YES;
    [self layoutSubtreeIfNeeded];
    if (self.window.keyWindow) [self.window makeFirstResponder:failed ? self.retryButton : self];
}
@end

static NSTextField *KeepworkStartupLabel(NSString *text, CGFloat size, NSFontWeight weight, NSRect frame) {
    NSTextField *label = [NSTextField labelWithString:text];
    label.font = [NSFont systemFontOfSize:size weight:weight];
    label.alignment = NSTextAlignmentLeft;
    label.frame = frame;
    return label;
}

static KeepworkStartupView *KeepworkStartupFindView(NSWindow *window) {
    if (!window) return nil;
    for (NSView *subview in window.contentView.subviews) {
        if ([subview isKindOfClass:KeepworkStartupView.class]) {
            return (KeepworkStartupView *)subview;
        }
    }
    return nil;
}

static NSView *KeepworkStartupFindDocument(NSView *view) {
    Class webViewClass = NSClassFromString(@"WKWebView");
    if (webViewClass && [view isKindOfClass:webViewClass]) return view;
    for (NSView *child in view.subviews) {
        NSView *document = KeepworkStartupFindDocument(child);
        if (document) return document;
    }
    return nil;
}

bool keepwork_startup_install(void *rawWindow, void *context,
    KeepworkStartupAction action, KeepworkStartupRelease release) {
    if (![NSThread isMainThread] || !rawWindow) return false;
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    if (KeepworkStartupFindView(window)) return true;
    // Match the main window's existing overlay titlebar; do not hide the
    // minimize/zoom buttons or take over window-wide dragging.
    window.titleVisibility = NSWindowTitleHidden;
    window.titlebarAppearsTransparent = YES;
    window.titlebarSeparatorStyle = NSTitlebarSeparatorStyleNone;
    KeepworkStartupView *view = [[KeepworkStartupView alloc] initWithFrame:window.contentView.bounds];
    view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    view.iconView = [[NSImageView alloc] initWithFrame:NSZeroRect];
    view.iconView.image = NSApp.applicationIconImage;
    view.iconView.imageScaling = NSImageScaleProportionallyUpOrDown;
    view.iconView.wantsLayer = YES;
    view.iconView.layer.cornerRadius = 10;
    view.iconView.layer.masksToBounds = YES;
    [view addSubview:view.iconView];
    view.titleLabel = KeepworkStartupLabel(@"KeepWork 第二大脑", 17, NSFontWeightSemibold, NSZeroRect);
    [view addSubview:view.titleLabel];
    view.summaryLabel = KeepworkStartupLabel(@"正在准备工作台…", 12, NSFontWeightRegular, NSZeroRect);
    view.summaryLabel.textColor = NSColor.secondaryLabelColor;
    [view addSubview:view.summaryLabel];
    view.spinner = [[NSProgressIndicator alloc] initWithFrame:NSZeroRect];
    view.spinner.style = NSProgressIndicatorStyleSpinning;
    view.spinner.controlSize = NSControlSizeSmall;
    view.spinner.displayedWhenStopped = NO;
    [view addSubview:view.spinner];
    view.retryButton = [NSButton buttonWithTitle:@"重试" target:view action:@selector(retry:)];
    view.retryButton.bezelStyle = NSBezelStyleRounded;
    view.retryButton.keyEquivalent = @"\r";
    view.hideButton = [NSButton buttonWithTitle:@"稍后" target:view action:@selector(hide:)];
    view.hideButton.bezelStyle = NSBezelStyleRounded;
    view.hideButton.keyEquivalent = @"\e";
    [view addSubview:view.retryButton];
    [view addSubview:view.hideButton];
    // Only transfer callback ownership after the complete native view exists.
    view.callbackContext = context;
    view.actionCallback = action;
    view.releaseCallback = release;
    // Add above the WKWebView sibling; never replace the content view.
    [window.contentView addSubview:view];
    [window makeFirstResponder:view];
    [view setFailed:NO];
    return true;
}

bool keepwork_startup_update(void *rawWindow, bool failed) {
    if (![NSThread isMainThread] || !rawWindow) return false;
    KeepworkStartupView *view = KeepworkStartupFindView((__bridge NSWindow *)rawWindow);
    if (!view) return false;
    [view setFailed:failed];
    return true;
}

bool keepwork_startup_remove(void *rawWindow) {
    if (![NSThread isMainThread] || !rawWindow) return false;
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    KeepworkStartupView *view = KeepworkStartupFindView(window);
    if (!view) return true;
    [view removeFromSuperview];
    // Return keyboard focus to the document container now that the overlay is
    // gone, so the ready workspace receives input immediately.
    NSView *document = KeepworkStartupFindDocument(window.contentView);
    if (document) [window makeFirstResponder:document];
    return true;
}

bool keepwork_startup_is_installed(void *rawWindow) {
    if (![NSThread isMainThread] || !rawWindow) return false;
    return KeepworkStartupFindView((__bridge NSWindow *)rawWindow) != nil;
}
