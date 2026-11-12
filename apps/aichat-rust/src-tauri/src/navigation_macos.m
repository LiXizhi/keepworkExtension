#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <stdbool.h>

extern bool keepwork_allowed_subframe_navigation(const char *url);

// Wry's URL-only navigation handler cannot distinguish a preview iframe from
// the main document. Preserve its delegate for every event except subframe
// navigation decisions, where WebKit still supplies the actual target frame.
@interface KeepworkFrameNavigationDelegate : NSObject <WKNavigationDelegate>
@property(nonatomic, weak) id<WKNavigationDelegate> downstream;
@end

@implementation KeepworkFrameNavigationDelegate
- (BOOL)respondsToSelector:(SEL)selector {
    return [super respondsToSelector:selector] || [self.downstream respondsToSelector:selector];
}

- (id)forwardingTargetForSelector:(SEL)selector {
    id downstream = self.downstream;
    return [downstream respondsToSelector:selector] ? downstream : [super forwardingTargetForSelector:selector];
}

- (void)webView:(WKWebView *)webview
    decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))handler {
    BOOL download = NO;
    if (@available(macOS 11.3, *)) download = action.shouldPerformDownload;
    if (action.targetFrame && !action.targetFrame.mainFrame && !download) {
        const char *url = action.request.URL.absoluteString.UTF8String;
        handler(keepwork_allowed_subframe_navigation(url)
            ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
        return;
    }
    // nil targetFrame is a new window request, not an embedded navigation.
    // Forward main document, popup and download decisions unchanged to Wry.
    id<WKNavigationDelegate> downstream = self.downstream;
    if ([downstream respondsToSelector:_cmd]) {
        [downstream webView:webview decidePolicyForNavigationAction:action decisionHandler:handler];
    } else {
        handler(WKNavigationActionPolicyCancel);
    }
}
@end

bool keepwork_install_frame_navigation(void *rawWebview) {
    WKWebView *webview = (__bridge WKWebView *)rawWebview;
    if (!webview || !webview.navigationDelegate) return false;
    if ([webview.navigationDelegate isKindOfClass:KeepworkFrameNavigationDelegate.class]) return true;
    KeepworkFrameNavigationDelegate *delegate = [KeepworkFrameNavigationDelegate new];
    delegate.downstream = webview.navigationDelegate;
    static char delegateKey;
    // WebKit retains its delegate weakly. Retain only the proxy here; Wry owns
    // the original delegate. The weak downstream reference avoids a new cycle.
    objc_setAssociatedObject(webview, &delegateKey, delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    webview.navigationDelegate = delegate;
    return true;
}
