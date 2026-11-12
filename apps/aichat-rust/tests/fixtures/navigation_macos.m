#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <stdbool.h>
#include <stdio.h>

extern bool keepwork_install_frame_navigation(void *rawWebview);

static NSUInteger subframeDecisions = 0;

// Production Rust owns this policy. The fixture exercises the native adapter
// with the same HTTP(S)/about:blank contract, without opening any external URL.
bool keepwork_allowed_subframe_navigation(const char *rawURL) {
  subframeDecisions++;
  if (rawURL == NULL) return false;
  NSURL *url = [NSURL URLWithString:[NSString stringWithUTF8String:rawURL]];
  if (url == nil || url.user.length > 0 || url.password != nil) return false;
  if ([url.absoluteString isEqualToString:@"about:blank"]) return true;
  return url.host.length > 0 &&
      ([url.scheme isEqualToString:@"http"] || [url.scheme isEqualToString:@"https"]);
}

static void Check(BOOL condition, NSString *message) {
  if (!condition) {
    fprintf(stderr, "macOS navigation failure: %s\n", message.UTF8String);
    exit(1);
  }
}

static BOOL RunUntil(BOOL (^predicate)(void), NSTimeInterval timeout) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
  while (!predicate() && [deadline timeIntervalSinceNow] > 0) {
    @autoreleasepool {
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                             beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
  }
  return predicate();
}

@interface FixtureDelegate : NSObject <WKNavigationDelegate>
@property(nonatomic) NSUInteger mainDecisions;
@property(nonatomic) NSUInteger externalDecisions;
@property(nonatomic) NSUInteger finishes;
@end

@implementation FixtureDelegate
- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  self.mainDecisions++;
  if ([action.request.URL.path isEqualToString:@"/main"] ||
      [action.request.URL.absoluteString isEqualToString:@"about:blank"]) {
    decisionHandler(WKNavigationActionPolicyAllow);
  } else {
    self.externalDecisions++;
    decisionHandler(WKNavigationActionPolicyCancel);
  }
}
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
  self.finishes++;
}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    Check(argc == 2 || argc == 3, @"expected loopback fixture origin");
    BOOL withoutAdapter = argc == 3 && strcmp(argv[2], "--without-adapter") == 0;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
    configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
    WKWebView *webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 800, 600)
                                         configuration:configuration];
    // Retain a window to give WebKit its ordinary native view lifecycle. It is
    // never shown, so the test does not open browser windows on the user's desk.
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 800, 600)
                                                 styleMask:NSWindowStyleMaskBorderless
                                                   backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.contentView = webView;
    FixtureDelegate *delegate = [FixtureDelegate new];
    webView.navigationDelegate = delegate;
    if (!withoutAdapter) {
      Check(keepwork_install_frame_navigation((__bridge void *)webView), @"install native frame adapter");
    }
    NSString *origin = [NSString stringWithUTF8String:argv[1]];
    NSURL *mainURL = [NSURL URLWithString:[origin stringByAppendingString:@"/main"]];
    [webView loadRequest:[NSURLRequest requestWithURL:mainURL]];

    if (withoutAdapter) {
      Check(RunUntil(^BOOL { return delegate.externalDecisions > 0; }, 10),
            @"old delegate cancels the embedded navigation as an external link");
      Check(subframeDecisions == 0, @"baseline does not install the production frame adapter");
      [webView stopLoading];
      window.contentView = nil;
      [window close];
      puts("legacy iframe rejection reproduced");
      return 0;
    }

    __block BOOL embeddedReady = NO;
    __block BOOL evaluating = NO;
    Check(RunUntil(^BOOL {
      if (!embeddedReady && !evaluating) {
        evaluating = YES;
        [webView evaluateJavaScript:@"window.embeddedReady === true" completionHandler:^(id result, NSError *error) {
          embeddedReady = error == nil && [result isEqual:@YES];
          evaluating = NO;
        }];
      }
      return embeddedReady && delegate.finishes > 0;
    }, 20), @"cross-origin iframe rendered and posted its message through a redirect");
    Check(subframeDecisions >= 2, @"native adapter inspected iframe and redirect URLs");
    Check(delegate.mainDecisions > 0, @"main-frame policy reached the original delegate");
    Check(delegate.externalDecisions == 0, @"iframe navigation never reached the external-browser branch");
    Check(delegate.finishes > 0, @"didFinishNavigation was forwarded to the original delegate");

    NSUInteger decisionsBefore = delegate.mainDecisions;
    NSUInteger finishesBefore = delegate.finishes;
    NSString *externalOrigin = [origin stringByReplacingOccurrencesOfString:@"127.0.0.1" withString:@"localhost"];
    NSURL *blockedURL = [NSURL URLWithString:[externalOrigin stringByAppendingString:@"/top-blocked"]];
    [webView loadRequest:[NSURLRequest requestWithURL:blockedURL]];
    Check(RunUntil(^BOOL { return delegate.externalDecisions == 1; }, 5),
          @"external top-level navigation still enters the old delegate's rejection branch");
    Check(delegate.mainDecisions > decisionsBefore, @"top-level callback remained installed");
    Check([webView.URL isEqual:mainURL], @"blocked top-level URL cannot replace AIChat");

    [webView loadRequest:[NSURLRequest requestWithURL:mainURL]];
    Check(RunUntil(^BOOL { return delegate.finishes > finishesBefore; }, 10),
          @"lifecycle forwarding survives a rejected top-level navigation");
    Check(delegate.externalDecisions == 1, @"the second iframe load still bypasses external opening");
    [webView stopLoading];
    window.contentView = nil;
    [window close];
    puts("macOS frame navigation tests passed");
  }
  return 0;
}
