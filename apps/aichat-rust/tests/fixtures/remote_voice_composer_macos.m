// Exercise real WebKit selection/editing in an invisible, ephemeral window.
// Foreground scenarios simulate the focus gate. The first assertion tests WebKit's
// real background state. Nothing is pasted into a user's window or clipboard.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

@interface ComposerFixture : NSObject <WKNavigationDelegate>
@property(nonatomic, copy) NSString *testScript;
@end

@implementation ComposerFixture
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    [view evaluateJavaScript:self.testScript completionHandler:^(id result, NSError *error) {
        if (error || ![result isEqual:@"composer routing passed"]) {
            fprintf(stderr, "%s\n", error.description.UTF8String ?: "unexpected test result");
            exit(1);
        }
        puts("composer routing passed");
        exit(0);
    }];
}
@end

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 2) return 2;
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        [NSApp finishLaunching];
        ComposerFixture *runner = [ComposerFixture new];
        runner.testScript = [NSString stringWithContentsOfFile:@(argv[1])
            encoding:NSUTF8StringEncoding error:NULL];
        if (!runner.testScript) return 3;
        WKWebViewConfiguration *config = [WKWebViewConfiguration new];
        config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        NSRect size = NSMakeRect(0, 0, 820, 600);
        WKWebView *view = [[WKWebView alloc] initWithFrame:size configuration:config];
        NSWindow * __attribute__((objc_precise_lifetime)) window = [[NSWindow alloc]
            initWithContentRect:size styleMask:NSWindowStyleMaskBorderless
            backing:NSBackingStoreBuffered defer:NO];
        window.contentView = view;
        view.navigationDelegate = runner;
        [view loadHTMLString:@"<!doctype html><meta charset=utf-8><title>Voice composer fixture</title>"
            baseURL:nil];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 12 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            fputs("WKWebView composer fixture timed out\n", stderr); exit(4);
        });
        [NSApp run];
        (void)runner.testScript;
    }
    return 0;
}
