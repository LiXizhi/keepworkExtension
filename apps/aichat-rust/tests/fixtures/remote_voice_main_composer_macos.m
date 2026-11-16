// Real WebKit edit/Undo fixture. This invisible process never reads the
// clipboard or posts native keyboard events. Foreground gates are explicit in
// the JavaScript test; the Tauri smoke separately verifies real window focus.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#include <stdio.h>

@interface MainComposerFixture : NSObject <WKNavigationDelegate, WKScriptMessageHandler>
@property(nonatomic, copy) NSString *script;
@property(nonatomic, copy) NSString *expected;
@property(nonatomic, copy) NSArray<NSString *> *stages;
@property(nonatomic) NSUInteger stage;
@end
@implementation MainComposerFixture
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    if (!message.frameInfo.mainFrame || ![message.body isKindOfClass:NSNumber.class]) return;
    NSNumber *identifier = message.body;
    if (identifier.unsignedLongLongValue > 10000) return;
    __weak WKWebView *view = message.webView;
    // The production host's second phase runs on its native runtime timer.
    // Hidden pages throttle DOM setTimeout to 1s even with inactive scheduling
    // disabled, so mirror that native scheduling without extending deadlines.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 18 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        [view evaluateJavaScript:[NSString stringWithFormat:@"window.__keepworkFixtureTickReply(%llu)",
            identifier.unsignedLongLongValue] completionHandler:nil];
    });
}
- (void)runStage:(WKWebView *)view {
    [view evaluateJavaScript:self.stages[self.stage] completionHandler:^(id result, NSError *error) {
        BOOL last = self.stage + 1 == self.stages.count;
        if (error || !(last ? [result isEqual:self.expected] : [result isEqual:@YES])) {
            fprintf(stderr, "stage=%lu %s\n", (unsigned long)self.stage,
                error.description.UTF8String ?: "unexpected staged main composer result");
            exit(1);
        }
        if (last) { puts(self.expected.UTF8String); exit(0); }
        self.stage++;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 25 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ [self runStage:view]; });
    }];
}
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    if (self.stages) { [self runStage:view]; return; }
    if (@available(macOS 11.0, *)) {
        [view callAsyncJavaScript:self.script arguments:@{} inFrame:nil
            inContentWorld:WKContentWorld.pageWorld completionHandler:^(id result, NSError *error) {
                if (error || ![result isEqual:self.expected]) {
                    fprintf(stderr, "%s\n", error.description.UTF8String ?: "unexpected main composer result");
                    exit(1);
                }
                puts(self.expected.UTF8String);
                exit(0);
            }];
    } else { exit(77); }
}
@end

int main(int argc, const char **argv) { @autoreleasepool {
    if (argc != 3 && argc != 4) return 2;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    MainComposerFixture *runner = [MainComposerFixture new];
    runner.script = [NSString stringWithContentsOfFile:@(argv[1]) encoding:NSUTF8StringEncoding error:NULL];
    runner.expected = @(argv[2]);
    if (!runner.script) return 2;
    if (argc == 4) {
        if (strcmp(argv[3], "staged")) return 2;
        id stages = [NSJSONSerialization JSONObjectWithData:[runner.script dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
        if (![stages isKindOfClass:NSArray.class] || ![stages count]) return 2;
        for (id stage in stages) if (![stage isKindOfClass:NSString.class]) return 2;
        runner.stages = stages;
    }
    WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
    configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
    [configuration.userContentController addScriptMessageHandler:runner name:@"fixtureTick"];
    NSString *ticks = @"(() => {let next=0;const pending=new Map();"
        "window.__keepworkFixturePause=()=>new Promise(resolve=>{const id=++next;pending.set(id,resolve);"
        "window.webkit.messageHandlers.fixtureTick.postMessage(id)});"
        "window.__keepworkFixtureTickReply=id=>{const resolve=pending.get(id);pending.delete(id);resolve?.()};})()";
    [configuration.userContentController addUserScript:[[WKUserScript alloc] initWithSource:ticks
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    if (@available(macOS 14.0, *)) configuration.preferences.inactiveSchedulingPolicy = WKInactiveSchedulingPolicyNone;
    NSRect frame = NSMakeRect(0, 0, 900, 650);
    WKWebView *view = [[WKWebView alloc] initWithFrame:frame configuration:configuration];
    NSWindow * __attribute__((objc_precise_lifetime)) window = [[NSWindow alloc]
        initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.contentView = view;
    view.navigationDelegate = runner;
    [view loadHTMLString:@"<!doctype html><meta charset=utf-8><title>Isolated main composer</title>" baseURL:nil];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 35 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        fputs("main composer WebKit fixture timed out\n", stderr); exit(4);
    });
    [NSApp run];
    (void)runner.script;
} return 0; }
