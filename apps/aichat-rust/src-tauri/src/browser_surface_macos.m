#import <WebKit/WebKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#include <stdbool.h>
#include <stdlib.h>

extern bool keepwork_allowed_subframe_navigation(const char *url);

// The visible aperture can shrink or scroll without resizing the web page's
// layout viewport. Flipped coordinates keep the crop offsets in CSS order.
@interface KeepworkBrowserViewportClip : NSView
@end
@implementation KeepworkBrowserViewportClip
- (BOOL)isFlipped { return YES; }
- (BOOL)wantsDefaultClipping { return YES; }
@end

// Deliberately not a Tauri webview: remote documents get neither the desktop
// initialization scripts nor any IPC message handler or shared website store.
@interface KeepworkBrowserSurface : NSObject <WKNavigationDelegate, WKUIDelegate>
@property(nonatomic, weak) WKWebView *owner;
@property(nonatomic, strong) WKWebView *view;
@property(nonatomic, strong) KeepworkBrowserViewportClip *clip;
@property(nonatomic, copy) NSString *identifier;
@property(nonatomic, strong) WKNavigation *navigation;
@end

static NSString *KeepworkJSON(id value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingFragmentsAllowed error:nil];
    return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"null";
}
static NSString *KeepworkBounded(NSString *value, NSUInteger limit) {
    return value.length > limit ? [value substringToIndex:limit] : (value ?: @"");
}

@implementation KeepworkBrowserSurface
- (void)emit:(NSString *)event error:(NSString *)error {
    NSURLComponents *url = [NSURLComponents componentsWithURL:self.view.URL resolvingAgainstBaseURL:NO];
    url.user = nil;
    url.password = nil;
    NSMutableArray *query = [NSMutableArray new];
    NSRegularExpression *secret = [NSRegularExpression regularExpressionWithPattern:@"token|authorization|password|secret|cookie|api.?key" options:NSRegularExpressionCaseInsensitive error:nil];
    for (NSURLQueryItem *item in url.queryItems) {
        BOOL sensitive = [secret firstMatchInString:item.name options:0 range:NSMakeRange(0, item.name.length)] != nil;
        [query addObject:sensitive ? [NSURLQueryItem queryItemWithName:item.name value:@"[redacted]"] : item];
    }
    if (url.queryItems) url.queryItems = query;
    // Fragments can also contain OAuth credentials. They are unnecessary for
    // display/history controls and are never relayed to the application.
    url.fragment = nil;
    NSDictionary *payload = @{
        @"id": self.identifier, @"event": event,
        @"url": KeepworkBounded(url.string, 4000), @"title": KeepworkBounded(self.view.title, 500),
        @"error": KeepworkBounded(error, 1000), @"canGoBack": @(self.view.canGoBack),
        @"canGoForward": @(self.view.canGoForward)
    };
    NSString *script = [NSString stringWithFormat:@"window.dispatchEvent(new CustomEvent('__aichat_desktop_event__',{detail:{event:'browser-surface',payload:%@}}));", KeepworkJSON(payload)];
    [self.owner evaluateJavaScript:script completionHandler:nil];
}
- (void)webView:(WKWebView *)view decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))handler {
    BOOL download = NO;
    if (@available(macOS 11.3, *)) download = action.shouldPerformDownload;
    BOOL allowed = !download && keepwork_allowed_subframe_navigation(action.request.URL.absoluteString.UTF8String);
    if (allowed && !action.targetFrame) {
        self.navigation = [view loadRequest:action.request];
        handler(WKNavigationActionPolicyCancel);
        return;
    }
    handler(allowed ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
    if (!allowed && action.targetFrame.mainFrame) [self emit:@"error" error:@"Only HTTP(S) browser navigation is supported"];
}
- (void)webView:(WKWebView *)view decidePolicyForNavigationResponse:(WKNavigationResponse *)response decisionHandler:(void (^)(WKNavigationResponsePolicy))handler {
    BOOL allowed = response.canShowMIMEType;
    handler(allowed ? WKNavigationResponsePolicyAllow : WKNavigationResponsePolicyCancel);
    if (!allowed && response.forMainFrame) [self emit:@"error" error:@"This resource cannot be displayed as a web page"];
}
- (void)webView:(WKWebView *)view didStartProvisionalNavigation:(WKNavigation *)navigation {
    self.navigation = navigation;
    [self emit:@"loading" error:nil];
}
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    if (self.navigation != navigation) return;
    [self emit:@"loaded" error:nil];
}
- (void)webView:(WKWebView *)view didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if (self.navigation != navigation) return;
    if (error.code != NSURLErrorCancelled) [self emit:@"error" error:error.localizedDescription];
}
- (void)webView:(WKWebView *)view didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if (self.navigation != navigation) return;
    if (error.code != NSURLErrorCancelled) [self emit:@"error" error:error.localizedDescription];
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)view {
    [self emit:@"error" error:@"The web page process stopped. Reload to try again."];
}
- (void)webView:(WKWebView *)view requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin initiatedByFrame:(WKFrameInfo *)frame type:(WKMediaCaptureType)type decisionHandler:(void (^)(WKPermissionDecision))handler API_AVAILABLE(macos(12.0)) {
    handler(WKPermissionDecisionDeny);
}
- (WKWebView *)webView:(WKWebView *)view createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {
    // Keep target=_blank links in this isolated surface. Do not give them an
    // opener or hand arbitrary URLs to the OS/application's main window.
    if (keepwork_allowed_subframe_navigation(action.request.URL.absoluteString.UTF8String)) {
        self.navigation = [view loadRequest:action.request];
    }
    return nil;
}
@end

static char surfaceKey;
static NSMutableDictionary *KeepworkSurfaces(WKWebView *owner) {
    NSMutableDictionary *surfaces = objc_getAssociatedObject(owner, &surfaceKey);
    if (!surfaces) {
        surfaces = [NSMutableDictionary new];
        objc_setAssociatedObject(owner, &surfaceKey, surfaces, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    return surfaces;
}

void keepwork_browser_surface_reset(void *rawOwner) {
    WKWebView *owner = (__bridge WKWebView *)rawOwner;
    NSMutableDictionary *surfaces = KeepworkSurfaces(owner);
    for (KeepworkBrowserSurface *surface in surfaces.allValues) {
        surface.view.navigationDelegate = nil;
        surface.view.UIDelegate = nil;
        [surface.view stopLoading];
        [surface.view removeFromSuperview];
        [surface.clip removeFromSuperview];
    }
    [surfaces removeAllObjects];
}

static NSDictionary *KeepworkSurfaceCommand(WKWebView *owner, NSDictionary *command) {
    NSString *identifier = command[@"id"];
    NSString *operation = command[@"op"];
    NSMutableDictionary *surfaces = KeepworkSurfaces(owner);
    KeepworkBrowserSurface *surface = surfaces[identifier];
    if ([operation isEqualToString:@"close"]) {
        surface.view.navigationDelegate = nil;
        surface.view.UIDelegate = nil;
        [surface.view stopLoading];
        [surface.view removeFromSuperview];
        [surface.clip removeFromSuperview];
        [surfaces removeObjectForKey:identifier];
        return @{};
    }
    if ([operation isEqualToString:@"open"] && !surface) {
        if (surfaces.count >= 8) return @{@"error": @"Too many open browser surfaces"};
        WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
        configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        configuration.userContentController = [WKUserContentController new];
        // Remote sites cannot request native media capture without a prompt.
        // The empty UIDelegate uses WebKit's default denial for native dialogs.
        surface = [KeepworkBrowserSurface new];
        surface.owner = owner;
        surface.identifier = identifier;
        surface.clip = [[KeepworkBrowserViewportClip alloc] initWithFrame:NSZeroRect];
        surface.clip.wantsLayer = YES;
        surface.clip.layer.masksToBounds = YES;
        surface.clip.autoresizesSubviews = NO;
        surface.view = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:configuration];
        surface.view.navigationDelegate = surface;
        surface.view.UIDelegate = surface;
        surface.view.hidden = YES;
        surface.clip.hidden = YES;
        surfaces[identifier] = surface;
        [surface.clip addSubview:surface.view];
        [owner addSubview:surface.clip];
    }
    if (!surface) {
        if ([operation isEqualToString:@"hide"] || [operation isEqualToString:@"bounds"]) return @{};
        return @{@"error": @"Unknown browser surface"};
    }
    NSDictionary *bounds = command[@"bounds"];
    if (bounds) {
        CGFloat x = [bounds[@"x"] doubleValue], y = [bounds[@"y"] doubleValue];
        CGFloat width = [bounds[@"width"] doubleValue], height = [bounds[@"height"] doubleValue];
        if (!owner.isFlipped) y = owner.bounds.size.height - y - height;
        NSRect requested = NSMakeRect(x, y, width, height);
        NSRect visible = NSIntersectionRect(requested, owner.bounds);
        surface.clip.frame = visible;
        NSDictionary *viewport = command[@"viewport"];
        CGFloat scale = viewport[@"scale"] ? [viewport[@"scale"] doubleValue] : 1.0;
        // Scale the enclosing native coordinate system, not the web page's
        // layout zoom. Both WebKit rendering and AppKit pointer conversion use
        // this transform while innerWidth/innerHeight keep the selected size.
        surface.clip.bounds = NSMakeRect(0, 0, visible.size.width / scale, visible.size.height / scale);
        CGFloat fullWidth = viewport ? [viewport[@"width"] doubleValue] : width;
        CGFloat fullHeight = viewport ? [viewport[@"height"] doubleValue] : height;
        CGFloat offsetX = viewport ? [viewport[@"offsetX"] doubleValue] : 0;
        CGFloat offsetY = viewport ? [viewport[@"offsetY"] doubleValue] : 0;
        offsetX += (NSMinX(visible) - NSMinX(requested)) / scale;
        offsetY += (owner.isFlipped ? NSMinY(visible) - NSMinY(requested) : NSMaxY(requested) - NSMaxY(visible)) / scale;
        if (@available(macOS 11.0, *)) {
            surface.view.pageZoom = command[@"zoom"] ? [command[@"zoom"] doubleValue] : 1.0;
        }
        surface.view.frame = NSMakeRect(-offsetX, -offsetY, fullWidth, fullHeight);
    }
    if ([operation isEqualToString:@"hide"]) { surface.view.hidden = YES; surface.clip.hidden = YES; }
    else if (command[@"visible"]) { surface.view.hidden = ![command[@"visible"] boolValue]; surface.clip.hidden = surface.view.hidden; }
    if ([operation isEqualToString:@"open"] || [operation isEqualToString:@"navigate"]) {
        if ([operation isEqualToString:@"open"]) { surface.view.hidden = NO; surface.clip.hidden = NO; }
        surface.navigation = [surface.view loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:command[@"url"]]]];
    } else if ([operation isEqualToString:@"back"] && surface.view.canGoBack) surface.navigation = [surface.view goBack];
    else if ([operation isEqualToString:@"forward"] && surface.view.canGoForward) surface.navigation = [surface.view goForward];
    else if ([operation isEqualToString:@"reload"]) surface.navigation = [surface.view reload];
    return @{@"canGoBack": @(surface.view.canGoBack), @"canGoForward": @(surface.view.canGoForward)};
}

// Invoked only on the native webview thread after Rust sender/URL/rect checks.
char *keepwork_browser_surface_command(void *rawOwner, const char *rawCommand) {
    @autoreleasepool {
        WKWebView *owner = (__bridge WKWebView *)rawOwner;
        NSDictionary *command = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:rawCommand] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        NSDictionary *result = owner && command ? KeepworkSurfaceCommand(owner, command) : @{@"error": @"Invalid browser command"};
        return strdup(KeepworkJSON(result).UTF8String);
    }
}
void keepwork_browser_surface_free(char *result) { free(result); }
