#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <stdbool.h>
#include <stdio.h>

extern char *keepwork_browser_surface_command(void *, const char *);
extern void keepwork_browser_surface_free(char *);
extern void keepwork_browser_surface_reset(void *);

bool keepwork_allowed_subframe_navigation(const char *raw) {
    if (!raw) return false;
    NSURL *url = [NSURL URLWithString:[NSString stringWithUTF8String:raw]];
    return url && !url.user.length && !url.password &&
        ((url.host.length && ([url.scheme isEqualToString:@"http"] || [url.scheme isEqualToString:@"https"])) || [url.absoluteString isEqualToString:@"about:blank"]);
}
static void Check(BOOL condition, NSString *message) {
    if (!condition) { fprintf(stderr, "browser surface: %s\n", message.UTF8String); exit(1); }
}
static BOOL Until(BOOL (^predicate)(void), NSTimeInterval timeout) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while (!predicate() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    return predicate();
}
static id Eval(WKWebView *view, NSString *script) {
    __block BOOL done = NO; __block id value = nil; __block NSError *failure = nil;
    [view evaluateJavaScript:script completionHandler:^(id result, NSError *error) { value = result; failure = error; done = YES; }];
    Check(Until(^BOOL { return done; }, 10), @"JavaScript evaluation completed");
    Check(!failure, [NSString stringWithFormat:@"JavaScript error: %@", failure]);
    return value;
}
static void Command(WKWebView *owner, NSDictionary *args) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:args options:0 error:nil];
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    char *raw = keepwork_browser_surface_command((__bridge void *)owner, json.UTF8String);
    Check(raw != NULL, @"command returns result");
    NSDictionary *result = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:raw] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    keepwork_browser_surface_free(raw);
    Check(result && !result[@"error"], [NSString stringWithFormat:@"command succeeded: %@", result]);
}
static WKWebView *Child(WKWebView *owner) {
    for (NSView *view in owner.subviews) {
        if ([view isKindOfClass:WKWebView.class]) return (WKWebView *)view;
        if ([NSStringFromClass(view.class) isEqualToString:@"KeepworkBrowserViewportClip"]) {
            for (NSView *child in view.subviews) if ([child isKindOfClass:WKWebView.class]) return (WKWebView *)child;
        }
    }
    return nil;
}
static BOOL Loaded(WKWebView *owner, NSString *path) {
    NSString *script = [NSString stringWithFormat:@"events.some(e=>e.event==='loaded' && new URL(e.url).pathname === '%@')", path];
    return [Eval(owner, script) isEqual:@YES];
}
static void NativeClick(WKWebView *child, NSWindow *window, NSPoint cssPoint) {
    CGFloat zoom = 1;
    if (@available(macOS 11.0, *)) zoom = child.pageZoom;
    NSPoint local = NSMakePoint(cssPoint.x*zoom, child.isFlipped ? cssPoint.y*zoom : child.bounds.size.height-cssPoint.y*zoom);
    NSPoint inOwner = [child convertPoint:local toView:window.contentView];
    NSPoint inWindow = [child convertPoint:local toView:nil];
    NSView *target = [window.contentView hitTest:inOwner];
    Check(target && (target==child || [target isDescendantOf:child]),@"scaled visual point hits native page");
    for (NSNumber *value in @[@(NSEventTypeLeftMouseDown),@(NSEventTypeLeftMouseUp)]) {
        NSEventType type = value.unsignedIntegerValue;
        NSEvent *event = [NSEvent mouseEventWithType:type location:inWindow modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
            windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:type==NSEventTypeLeftMouseDown?1:0];
        if (type==NSEventTypeLeftMouseDown) [target mouseDown:event]; else [target mouseUp:event];
    }
}
int main(int argc, const char **argv) {
    @autoreleasepool {
        Check(argc == 2 || argc == 3, @"fixture origin required");
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        [NSApp finishLaunching];
        WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
        configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        [configuration.userContentController addUserScript:[[WKUserScript alloc] initWithSource:@"window.aichatDesktop={files:true};window.__TAURI_INTERNALS__={invoke:()=>{}};" injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
        WKWebView *owner = [[WKWebView alloc] initWithFrame:NSMakeRect(0,0,900,700) configuration:configuration];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:owner.frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        window.contentView = owner;
        NSString *origin = [NSString stringWithUTF8String:argv[1]];
        [owner loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:[origin stringByAppendingString:@"/main"]]]];
        Check(Until(^BOOL { return [owner.title isEqualToString:@"Owner fixture"]; }, 15), @"owner loaded");
        Check([Eval(owner, @"!!window.aichatDesktop && document.cookie.includes('owner-secret')") isEqual:@YES], @"owner has its own credentials/bridge");
        NSDictionary *bounds = @{@"x":@40,@"y":@90,@"width":@600,@"height":@400};
        Command(owner, @{@"op":@"open",@"id":@"fixture-browser",@"url":[origin stringByAppendingString:@"/deny"],@"bounds":bounds});
        WKWebView *child = Child(owner);
        Check(child && !child.hidden, @"native surface attached and visible inside owner");
        Check(Until(^BOOL { return Loaded(owner, @"/deny"); }, 15), @"XFO DENY and CSP none page commits as a native document");
        Check([Eval(child,@"document.querySelector('h1').textContent") isEqualToString:@"Native restricted site"], @"restricted page rendered");
        Check([Eval(child,@"typeof window.aichatDesktop === 'undefined' && typeof window.__TAURI_INTERNALS__ === 'undefined' && !document.cookie.includes('owner-secret') && localStorage.getItem('owner-secret')===null") isEqual:@YES], @"native page has no desktop bridge, cookies or storage from owner");
        Check(child.configuration.userContentController.userScripts.count == 0, @"no application scripts installed on native page");
        Check(!child.configuration.websiteDataStore.persistent, @"native site uses separate ephemeral storage");
        Check(NSEqualSizes(child.frame.size, NSMakeSize(600,400)), @"CSS surface bounds applied");
        Eval(child,@"window.viewportStateMarker='keep-this-page';true");
        Command(owner,@{@"op":@"bounds",@"id":@"fixture-browser",@"bounds":bounds,
            @"viewport":@{@"width":@768,@"height":@1024,@"offsetX":@0,@"offsetY":@0},@"visible":@YES});
        Check(Until(^BOOL { return [Eval(child,@"innerWidth === 768 && innerHeight === 1024 && matchMedia('(width:768px) and (height:1024px)').matches") isEqual:@YES]; },3),
            [NSString stringWithFormat:@"tablet viewport remains 768x1024 when clipped to 600x400; got %@", Eval(child,@"JSON.stringify({width:innerWidth,height:innerHeight})")]);
        Command(owner,@{@"op":@"bounds",@"id":@"fixture-browser",@"bounds":bounds,
            @"viewport":@{@"width":@768,@"height":@1024,@"offsetX":@150,@"offsetY":@500},@"visible":@YES});
        Check(NSEqualPoints(child.frame.origin,NSMakePoint(-150,-500)),@"canvas scroll moves crop offsets inside native clip");
        Check([Eval(child,@"innerWidth===768 && innerHeight===1024") isEqual:@YES],@"scrolling the clipped canvas never resizes the page");
        Check(NSEqualSizes(child.superview.frame.size,NSMakeSize(600,400)),@"native clip bounds remain confined to the visible canvas");
        Command(owner,@{@"op":@"bounds",@"id":@"fixture-browser",@"bounds":@{@"x":@40,@"y":@90,@"width":@350,@"height":@250},
            @"viewport":@{@"width":@390,@"height":@844,@"offsetX":@0,@"offsetY":@0},@"visible":@YES});
        Check(Until(^BOOL { return [Eval(child,@"innerWidth===390 && innerHeight===844 && matchMedia('(max-width:400px)').matches") isEqual:@YES]; },3),@"phone viewport responds to media queries while clipped");
        Command(owner,@{@"op":@"bounds",@"id":@"fixture-browser",@"bounds":bounds,
            @"viewport":@{@"width":@1280,@"height":@800,@"offsetX":@0,@"offsetY":@0},@"visible":@YES});
        Check(Until(^BOOL { return [Eval(child,@"innerWidth===1280 && innerHeight===800 && matchMedia('(min-width:1200px)').matches") isEqual:@YES]; },3),@"desktop viewport can exceed its owner window");
        Command(owner,@{@"op":@"bounds",@"id":@"fixture-browser",@"bounds":@{@"x":@40,@"y":@90,@"width":@640,@"height":@400},
            @"viewport":@{@"width":@1280,@"height":@800,@"offsetX":@0,@"offsetY":@0,@"scale":@0.5},@"visible":@YES});
        Check(Until(^BOOL { return [Eval(child,@"innerWidth===1280 && innerHeight===800") isEqual:@YES]; },3),@"fit scaling keeps the selected logical viewport");
        NSRect completePage = [child convertRect:child.bounds toView:owner];
        Check(fabs(completePage.size.width-640)<0.01 && fabs(completePage.size.height-400)<0.01,
            [NSString stringWithFormat:@"entire 1280x800 page must display as 640x400, got %@",NSStringFromRect(completePage)]);
        Check(NSContainsRect(child.visibleRect,NSInsetRect(child.bounds,0.1,0.1)),@"all four page edges remain visible when fitted");
        Eval(child,@"document.querySelector('#fit-input').hidden=false;document.querySelector('#fit-button').hidden=false;true");
        NativeClick(child,window,NSMakePoint(1160,745));
        Check(Until(^BOOL { return [Eval(child,@"window.fitClicked===1") isEqual:@YES]; },5),@"native click at scaled bottom-right reaches the original logical button");
        NativeClick(child,window,NSMakePoint(1120,667));
        Check(Until(^BOOL { return [Eval(child,@"document.activeElement.id==='fit-input'") isEqual:@YES]; },5),@"scaled input can receive native focus");
        NSEvent *key = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
            windowNumber:window.windowNumber context:nil characters:@"k" charactersIgnoringModifiers:@"k" isARepeat:NO keyCode:40];
        [window.firstResponder keyDown:key];
        Check(Until(^BOOL { return [Eval(child,@"document.querySelector('#fit-input').value==='k'") isEqual:@YES]; },5),@"native keyboard input reaches the focused scaled page");
        Command(owner,@{@"op":@"bounds",@"id":@"fixture-browser",@"bounds":@{@"x":@40,@"y":@90,@"width":@640,@"height":@400},
            @"viewport":@{@"width":@2560,@"height":@1600,@"offsetX":@0,@"offsetY":@0,@"scale":@0.25},@"zoom":@2,@"visible":@YES});
        Check(Until(^BOOL { return [Eval(child,@"innerWidth===1280 && innerHeight===800") isEqual:@YES]; },3),@"fit and application zoom independently preserve the logical viewport");
        NSRect zoomedPage = [child convertRect:child.bounds toView:owner];
        Check(fabs(zoomedPage.size.width-640)<0.01 && fabs(zoomedPage.size.height-400)<0.01,@"fit still displays the complete page with application zoom");
        NativeClick(child,window,NSMakePoint(1160,745));
        Check(Until(^BOOL { return [Eval(child,@"window.fitClicked===2") isEqual:@YES]; },5),@"scaled native click remains accurate with application zoom");
        Command(owner,@{@"op":@"bounds",@"id":@"fixture-browser",@"bounds":bounds,
            @"viewport":@{@"width":@1536,@"height":@2048,@"offsetX":@0,@"offsetY":@0},@"zoom":@2,@"visible":@YES});
        Check(Until(^BOOL { return [Eval(child,@"innerWidth===768 && innerHeight===1024") isEqual:@YES]; },3),@"application zoom preserves requested CSS viewport dimensions");
        Command(owner,@{@"op":@"bounds",@"id":@"fixture-browser",@"bounds":bounds,@"visible":@YES});
        Check(Until(^BOOL { return [Eval(child,@"innerWidth===600 && innerHeight===400") isEqual:@YES]; },3),@"legacy bounds-only request restores responsive viewport");
        Check([Eval(child,@"viewportStateMarker") isEqualToString:@"keep-this-page"],@"preset, crop and zoom changes preserve page state without navigation");
        __block BOOL snapshot = NO;
        [child takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *error) { snapshot = image != nil && error == nil; }];
        Check(Until(^BOOL { return snapshot; }, 10), @"native surface produces rendered pixels");
        Eval(child,@"document.querySelector('a').click();true");
        Check(Until(^BOOL { return Loaded(owner,@"/second"); }, 10), @"new window link stays in native browser");
        Command(owner,@{@"op":@"back",@"id":@"fixture-browser"});
        Check(Until(^BOOL { return [child.URL.path isEqualToString:@"/deny"] && !child.loading; }, 10), @"native back works");
        Command(owner,@{@"op":@"forward",@"id":@"fixture-browser"});
        Check(Until(^BOOL { return [child.URL.path isEqualToString:@"/second"] && !child.loading; }, 10), @"native forward works");
        Command(owner,@{@"op":@"navigate",@"id":@"fixture-browser",@"url":[origin stringByAppendingString:@"/csp"]});
        Check(Until(^BOOL { return Loaded(owner,@"/csp"); }, 10), @"CSP-only refusal page commits natively");
        [child loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"file:///etc/passwd"]]];
        Check(Until(^BOOL { return [Eval(owner,@"events.some(e=>e.event==='error')") isEqual:@YES]; },5), @"forbidden native scheme reports bounded error");
        Check([child.URL.scheme isEqualToString:@"http"], @"forbidden scheme never commits");
        Command(owner,@{@"op":@"hide",@"id":@"fixture-browser"});
        Check(child.hidden,@"hidden tool hides native view");
        Command(owner,@{@"op":@"bounds",@"id":@"fixture-browser",@"bounds":bounds,@"visible":@YES});
        Check(!child.hidden,@"selected tool restores native view");
        if (argc == 3 && strcmp(argv[2], "--live-baidu") == 0) {
            Command(owner,@{@"op":@"bounds",@"id":@"fixture-browser",@"bounds":@{@"x":@40,@"y":@90,@"width":@640,@"height":@400},
                @"viewport":@{@"width":@1280,@"height":@800,@"offsetX":@0,@"offsetY":@0,@"scale":@0.5},@"visible":@YES});
            Command(owner,@{@"op":@"navigate",@"id":@"fixture-browser",@"url":@"https://www.baidu.com"});
            Check(Until(^BOOL { return !child.loading && [child.URL.host isEqualToString:@"www.baidu.com"] && child.title.length > 0; },30),@"live Baidu navigation completes");
            Check([Eval(child,@"!!document.querySelector('#kw,input[name=wd],input[name=word]')") isEqual:@YES],@"live Baidu search input is rendered");
            Check([Eval(child,@"typeof aichatDesktop === 'undefined' && typeof __TAURI_INTERNALS__ === 'undefined'") isEqual:@YES],@"live Baidu has no desktop bridge");
            NSString *metrics = Eval(child,@"JSON.stringify({width:innerWidth,height:innerHeight,clientWidth:document.documentElement.clientWidth,clientHeight:document.documentElement.clientHeight,screenWidth:screen.width,documentWidth:document.documentElement.scrollWidth})");
            printf("live fitted Baidu viewport: %s\n", metrics.UTF8String);
            Check([Eval(child,@"innerWidth===1280 && innerHeight===800 && matchMedia('(width:1280px)').matches") isEqual:@YES],@"live Baidu preserves desktop resolution while displayed at half size");
            Check(NSContainsRect(child.visibleRect,NSInsetRect(child.bounds,0.1,0.1)),@"live fitted Baidu has all four viewport edges visible");
            Check([Eval(child,@"['#kw','#su'].every(s=>{const e=document.querySelector(s);if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})") isEqual:@YES],@"live Baidu search field and submit button are fully visible");
            __block BOOL saved = NO;
            WKSnapshotConfiguration *snapshotConfiguration = [WKSnapshotConfiguration new];
            snapshotConfiguration.rect = child.bounds;
            snapshotConfiguration.snapshotWidth = @640;
            [child takeSnapshotWithConfiguration:snapshotConfiguration completionHandler:^(NSImage *image, NSError *error) {
                NSData *png = [[NSBitmapImageRep imageRepWithData:image.TIFFRepresentation] representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
                saved = !error && [png writeToFile:@"/private/tmp/keepwork-native-baidu-fit.png" atomically:YES];
            }];
            Check(Until(^BOOL { return saved; },10),@"live native screenshot saved");
            printf("live native Baidu passed: %s\n", child.title.UTF8String);
        }
        Command(owner,@{@"op":@"close",@"id":@"fixture-browser"});
        Check(!Child(owner),@"closing removes native view");
        Command(owner,@{@"op":@"open",@"id":@"second-browser",@"url":[origin stringByAppendingString:@"/csp"],@"bounds":bounds});
        keepwork_browser_surface_reset((__bridge void *)owner);
        Check(!Child(owner),@"main document reset destroys native views");
        [owner stopLoading];window.contentView=nil;[window close];
        puts("native browser surface tests passed");
    }
    return 0;
}
