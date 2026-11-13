#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#include <stdbool.h>
#include <math.h>

typedef void (*KeepworkStartupAction)(void *, bool);
typedef void (*KeepworkStartupRelease)(void *);

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
- (void)cancelOperation:(id)sender {
    [self hide:sender];
}
- (void)layout {
    [super layout];
    // Center the visible identity, using its text rather than an empty label
    // column. The two text lines keep their shared left edge beside the icon.
    CGFloat top = self.failed ? NSHeight(self.bounds) - 54 : NSHeight(self.bounds) / 2 + 25;
    CGFloat textWidth = MIN(NSWidth(self.bounds) - 120, ceil(MAX(
        self.titleLabel.cell.cellSize.width,
        self.summaryLabel.cell.cellSize.width + (self.failed ? 0 : 18))));
    CGFloat left = floor((NSWidth(self.bounds) - 48 - 16 - textWidth) / 2);
    CGFloat textLeft = left + 48 + 16;
    self.iconView.frame = NSMakeRect(left, top - 48, 48, 48);
    self.titleLabel.frame = NSMakeRect(textLeft, top - 22, textWidth, 24);
    self.spinner.frame = NSMakeRect(textLeft, top - 47, 12, 12);
    self.summaryLabel.frame = NSMakeRect(textLeft + (self.failed ? 0 : 18), top - 52,
        textWidth - (self.failed ? 0 : 18), 22);
    self.retryButton.frame = NSMakeRect(NSWidth(self.bounds) - 112, 22, 84, 30);
    self.hideButton.frame = NSMakeRect(NSWidth(self.bounds) - 204, 22, 84, 30);
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

bool keepwork_startup_install(void *rawWindow, void *context,
    KeepworkStartupAction action, KeepworkStartupRelease release) {
    if (![NSThread isMainThread] || !rawWindow) return false;
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    window.titleVisibility = NSWindowTitleHidden;
    window.titlebarAppearsTransparent = YES;
    window.titlebarSeparatorStyle = NSTitlebarSeparatorStyleNone;
    window.movableByWindowBackground = YES;
    [window standardWindowButton:NSWindowMiniaturizeButton].hidden = YES;
    [window standardWindowButton:NSWindowZoomButton].hidden = YES;
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
    window.contentView = view;
    [window makeFirstResponder:view];
    window.backgroundColor = NSColor.controlBackgroundColor;
    [view setFailed:NO];
    return true;
}

bool keepwork_startup_update(void *rawWindow, bool failed) {
    if (![NSThread isMainThread] || !rawWindow) return false;
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    if (![window.contentView isKindOfClass:KeepworkStartupView.class]) return false;
    [(KeepworkStartupView *)window.contentView setFailed:failed];
    return true;
}
