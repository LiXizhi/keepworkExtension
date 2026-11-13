// Real WKWebView and production native handler, self-authored static HTML only.
// All HTTP requests target test-owned loopback mocks; no account or user files.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#include <stdio.h>
#include "../../src-tauri/src/local_mcp_macos.m"

@interface LocalMcpFixture : NSObject <NSApplicationDelegate, WKNavigationDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *webview;
@property(nonatomic, copy) NSString *script;
@property(nonatomic, copy) NSString *base;
@property(nonatomic) BOOL started;
@end
@implementation LocalMcpFixture
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    WKWebViewConfiguration *config = [WKWebViewConfiguration new];
    config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
    if (@available(macOS 14.0, *)) config.preferences.inactiveSchedulingPolicy = WKInactiveSchedulingPolicyNone;
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 900, 640)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    self.window.releasedWhenClosed = NO;
    self.webview = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:config];
    self.window.contentView = self.webview;
    self.webview.navigationDelegate = self;
    if (!keepwork_install_local_mcp((__bridge void *)self.webview, "https://keepwork.com/chat")) {
        fprintf(stderr, "native handler did not install\n"); exit(1);
    }
    [self.webview loadHTMLString:@"<!doctype html><meta charset=utf-8><title>Isolated MCP fixture</title><p>Self-authored guest HTML</p>"
        baseURL:[NSURL URLWithString:self.base]];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 40 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        fprintf(stderr, "native MCP fixture timed out\n"); exit(2);
    });
}
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    if (self.started) return;
    self.started = YES;
    [webView callAsyncJavaScript:self.script arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld
        completionHandler:^(id value, NSError *error) {
            if (error) { fprintf(stderr, "%s\n", error.description.UTF8String); exit(1); }
            if (!value || ![NSJSONSerialization isValidJSONObject:value]) {
                fprintf(stderr, "invalid fixture result\n"); exit(1);
            }
            NSData *json = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
            printf("%s\n", [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
            fflush(stdout);
            keepwork_reset_local_mcp((__bridge void *)webView);
            exit(0);
        }];
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    fprintf(stderr, "fixture navigation failed: %s\n", error.description.UTF8String); exit(1);
}
@end
int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc != 3) { fprintf(stderr, "usage: native-mcp script.js https-base-url\n"); return 2; }
        LocalMcpFixture *fixture = [LocalMcpFixture new];
        fixture.script = [NSString stringWithContentsOfFile:@(argv[1]) encoding:NSUTF8StringEncoding error:nil];
        fixture.base = @(argv[2]);
        if (!fixture.script) return 2;
        NSApplication *app = NSApplication.sharedApplication;
        app.delegate = fixture;
        [app run];
    }
    return 0;
}
