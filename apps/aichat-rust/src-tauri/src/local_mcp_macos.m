#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <stdbool.h>

// WKWebView blocks HTTPS -> HTTP loopback as mixed content. This deliberately
// narrow native transport keeps the public page and its existing MCP identity.
// It never changes WebKit security preferences or reads its cookie store.
#ifndef KEEPWORK_LOCAL_MCP_TEST_PORT
#define KEEPWORK_LOCAL_MCP_TEST_PORT 8089
#endif
static const NSUInteger KeepworkMcpBodyLimit = 32 * 1024 * 1024;
static const NSUInteger KeepworkMcpBufferLimit = 1024 * 1024;
static const NSUInteger KeepworkMcpChunkLimit = 64 * 1024;
typedef void (^KeepworkMcpReply)(id, NSString *);
@class KeepworkLocalMcp;

static NSString *KeepworkMcpOrigin(NSURL *url) {
    if (!url || url.user != nil || url.password != nil || !url.host.length ||
        ![@[@"https", @"http"] containsObject:url.scheme.lowercaseString]) return nil;
    NSNumber *port = url.port;
    BOOL standard = port == nil || ([url.scheme.lowercaseString isEqualToString:@"https"] && port.integerValue == 443) ||
        ([url.scheme.lowercaseString isEqualToString:@"http"] && port.integerValue == 80);
    return [NSString stringWithFormat:@"%@://%@%@", url.scheme.lowercaseString, url.host.lowercaseString,
        standard ? @"" : [NSString stringWithFormat:@":%@", port]];
}

static NSString *KeepworkMcpPath(NSURL *url) {
    NSString *encoded = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO].percentEncodedPath;
    NSString *path = encoded.length ? encoded : @"/";
    while (path.length > 1 && [path hasSuffix:@"/"]) path = [path substringToIndex:path.length - 1];
    return path;
}

static BOOL KeepworkMcpSamePage(NSURL *left, NSURL *right) {
    NSString *origin = KeepworkMcpOrigin(left);
    return origin && [origin isEqualToString:KeepworkMcpOrigin(right)] &&
        [KeepworkMcpPath(left) isEqualToString:KeepworkMcpPath(right)];
}

static BOOL KeepworkMcpHeaderName(NSString *value) {
    if (!value.length || value.length > 200) return NO;
    static NSCharacterSet *invalid;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        invalid = [[NSCharacterSet characterSetWithCharactersInString:
            @"!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"] invertedSet];
    });
    return [value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static BOOL KeepworkMcpHeaderValue(NSString *value) {
    if (value.length > 16384) return NO;
    for (NSUInteger i = 0; i < value.length; i++) {
        unichar unit = [value characterAtIndex:i];
        if ((unit < 32 && unit != 9) || unit == 127 || unit > 255) return NO;
    }
    return YES;
}

@interface KeepworkMcpRequest : NSObject <NSURLSessionDataDelegate>
@property(nonatomic, weak) KeepworkLocalMcp *owner;
@property(nonatomic, copy) NSString *identifier;
@property(nonatomic, copy) NSString *document;
@property(nonatomic, copy) NSString *origin;
@property(nonatomic, copy) NSString *originalURL;
@property(nonatomic, strong) NSURLSession *session;
@property(nonatomic, strong) NSURLSessionDataTask *task;
@property(nonatomic, strong) NSMutableData *buffer;
@property(nonatomic, copy) KeepworkMcpReply startReply;
@property(nonatomic, copy) KeepworkMcpReply readReply;
@property(nonatomic, copy) NSString *error;
@property(nonatomic) BOOL paused;
@property(nonatomic) BOOL done;
@property(nonatomic) NSTimeInterval touched;
- (void)fail:(NSString *)error;
- (void)read:(KeepworkMcpReply)reply;
- (void)flush;
@end

@interface KeepworkLocalMcp : NSObject <WKScriptMessageHandlerWithReply>
@property(nonatomic, weak) WKWebView *webview;
@property(nonatomic, strong) NSURL *entry;
@property(nonatomic, strong) NSMutableDictionary<NSString *, KeepworkMcpRequest *> *requests;
@property(nonatomic, copy) NSString *document;
@property(nonatomic, strong) NSTimer *timer;
- (void)reset;
@end

@implementation KeepworkMcpRequest
- (void)pause {
    if (!self.paused && !self.done) { [self.task suspend]; self.paused = YES; }
}
- (void)fail:(NSString *)error {
    self.error = error;
    self.done = YES;
    [self.task cancel];
    [self.session invalidateAndCancel];
    if (self.startReply) {
        KeepworkMcpReply reply = self.startReply; self.startReply = nil;
        reply(nil, error);
        [self.owner.requests removeObjectForKey:self.identifier];
    }
    [self flush];
}
- (void)flush {
    if (!self.readReply) return;
    if (self.buffer.length) {
        NSUInteger size = MIN(self.buffer.length, KeepworkMcpChunkLimit);
        NSData *chunk = [self.buffer subdataWithRange:NSMakeRange(0, size)];
        [self.buffer replaceBytesInRange:NSMakeRange(0, size) withBytes:NULL length:0];
        KeepworkMcpReply reply = self.readReply; self.readReply = nil;
        reply(@{@"data": [chunk base64EncodedStringWithOptions:0], @"done": @NO}, nil);
    } else if (self.done) {
        KeepworkMcpReply reply = self.readReply; self.readReply = nil;
        [self.owner.requests removeObjectForKey:self.identifier];
        reply(self.error ? nil : @{@"done": @YES}, self.error);
    }
}
- (void)read:(KeepworkMcpReply)reply {
    if (self.readReply) { reply(nil, @"Only one MCP stream read may be pending"); return; }
    self.touched = NSDate.timeIntervalSinceReferenceDate;
    self.readReply = reply;
    [self flush];
    if (self.readReply && self.paused && !self.done) {
        self.paused = NO;
        [self.task resume];
    }
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task
    didReceiveResponse:(NSURLResponse *)response completionHandler:(void (^)(NSURLSessionResponseDisposition))completion {
    if (self.done || ![response isKindOfClass:NSHTTPURLResponse.class]) {
        completion(NSURLSessionResponseCancel);
        if (!self.done) [self fail:@"Invalid MCP HTTP response"];
        return;
    }
    NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
    NSString *allow = [http valueForHTTPHeaderField:@"Access-Control-Allow-Origin"];
    if (![allow isEqualToString:self.origin] && ![allow isEqualToString:@"*"]) {
        completion(NSURLSessionResponseCancel);
        [self fail:@"MCP response did not allow this page origin"];
        return;
    }
    NSMutableArray *headers = [NSMutableArray new];
    NSMutableSet *exposed = [NSMutableSet setWithArray:@[@"cache-control", @"content-language", @"content-length", @"content-type", @"expires", @"last-modified", @"pragma"]];
    for (NSString *name in [[http valueForHTTPHeaderField:@"Access-Control-Expose-Headers"] componentsSeparatedByString:@","]) {
        [exposed addObject:[name stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].lowercaseString];
    }
    BOOL exposeAll = [exposed containsObject:@"*"];
    for (NSString *name in http.allHeaderFields) {
        NSString *lower = name.lowercaseString;
        if ((exposeAll || [exposed containsObject:lower]) && ![lower isEqualToString:@"set-cookie"] && ![lower isEqualToString:@"set-cookie2"]) {
            [headers addObject:@[name, [http.allHeaderFields[name] description]]];
        }
    }
    [self pause];
    completion(NSURLSessionResponseAllow);
    KeepworkMcpReply reply = self.startReply; self.startReply = nil;
    self.touched = NSDate.timeIntervalSinceReferenceDate;
    if (reply) reply(@{@"status": @(http.statusCode), @"statusText": @"", @"headers": headers, @"url": self.originalURL}, nil);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
    if (self.done) return;
    [self pause];
    if (data.length > KeepworkMcpBufferLimit - self.buffer.length) {
        [self fail:@"MCP response stream exceeded its bounded buffer"];
        return;
    }
    [self.buffer appendData:data];
    [self flush];
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
    if (!self.done) {
        self.done = YES;
        if (error) self.error = @"MCP connection ended before completion";
        if (self.startReply) {
            KeepworkMcpReply reply = self.startReply; self.startReply = nil;
            reply(nil, self.error ?: @"MCP response headers were not received");
            [self.owner.requests removeObjectForKey:self.identifier];
        }
        [self flush];
    }
    [session finishTasksAndInvalidate];
    self.session = nil;
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
    willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request
    completionHandler:(void (^)(NSURLRequest *))completion {
    completion(nil);
    [self fail:@"MCP redirects are not supported by the desktop connection"];
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
    didReceiveChallenge:(NSURLAuthenticationChallenge *)challenge
    completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))completion {
    // Neither a nil credential nor RejectProtectionSpace prevents Foundation
    // from replaying a POST. Non-MCP authentication schemes are unavailable at
    // this feature boundary; the daemon's ordinary Bearer 401 stays an HTTP
    // response, without entering Foundation's Basic/Digest/NTLM machinery.
    completion(NSURLSessionAuthChallengeCancelAuthenticationChallenge, nil);
    [self fail:@"MCP_HTTP_AUTH_CHALLENGE_UNSUPPORTED: 此原生通道不支持 HTTP 认证挑战；Keepwork 配对认证请使用 Bearer 令牌。"];
}
@end

@implementation KeepworkLocalMcp
- (void)reset {
    NSArray *requests = self.requests.allValues;
    [self.requests removeAllObjects];
    self.document = nil;
    for (KeepworkMcpRequest *request in requests) [request fail:@"MCP request was cancelled"];
}
- (void)dealloc { [self.timer invalidate]; [self reset]; }
- (NSString *)originForMessage:(WKScriptMessage *)message {
    if (!message.frameInfo.mainFrame || message.webView != self.webview || !self.webview) return nil;
    NSURL *frame = message.frameInfo.request.URL;
    NSURL *actual = self.webview.URL;
    if (![frame.scheme.lowercaseString isEqualToString:@"https"]) return nil;
    NSURL *published = [NSURL URLWithString:@"https://keepwork.com/chat"];
    if (!(KeepworkMcpSamePage(frame, published) || KeepworkMcpSamePage(frame, self.entry)) ||
        !KeepworkMcpSamePage(frame, actual)) return nil;
    WKSecurityOrigin *security = message.frameInfo.securityOrigin;
    NSInteger port = frame.port.integerValue;
    if (!port) port = [frame.scheme.lowercaseString isEqualToString:@"https"] ? 443 : 80;
    NSInteger securityPort = security.port;
    if (!securityPort) securityPort = [security.protocol.lowercaseString isEqualToString:@"https"] ? 443 : 80;
    if (![security.protocol.lowercaseString isEqualToString:frame.scheme.lowercaseString] ||
        ![security.host.lowercaseString isEqualToString:frame.host.lowercaseString] || securityPort != port) return nil;
    return KeepworkMcpOrigin(frame);
}
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message
    replyHandler:(void (^)(id, NSString *))reply {
    NSString *origin = [self originForMessage:message];
    if (!origin) { reply(nil, @"MCP transport is restricted to the trusted main document"); return; }
    NSDictionary *input = [message.body isKindOfClass:NSDictionary.class] ? message.body : nil;
    NSString *op = [input[@"op"] isKindOfClass:NSString.class] ? input[@"op"] : nil;
    NSString *identifier = [input[@"id"] isKindOfClass:NSString.class] ? input[@"id"] : nil;
    NSString *document = [input[@"document"] isKindOfClass:NSString.class] ? input[@"document"] : nil;
    if (!identifier || !document || ![[NSUUID alloc] initWithUUIDString:identifier] || ![[NSUUID alloc] initWithUUIDString:document]) {
        reply(nil, @"Invalid MCP request identity"); return;
    }
    if (self.document && ![self.document isEqualToString:document]) {
        reply(nil, @"MCP request belongs to a different document"); return;
    }
    KeepworkMcpRequest *existing = self.requests[identifier];
    if ([op isEqualToString:@"cancel"]) {
        if (existing && [existing.document isEqualToString:document]) {
            [self.requests removeObjectForKey:identifier];
            [existing fail:@"MCP request was cancelled"];
        }
        reply(@{}, nil); return;
    }
    if ([op isEqualToString:@"read"]) {
        if (!existing || ![existing.document isEqualToString:document]) { reply(nil, @"MCP response stream is no longer available"); return; }
        [existing read:reply]; return;
    }
    if (![op isEqualToString:@"start"] || existing) { reply(nil, @"Invalid or duplicate MCP request"); return; }
    if (self.requests.count >= 32) { reply(nil, @"Too many active desktop MCP requests"); return; }
    NSString *rawURL = [input[@"url"] isKindOfClass:NSString.class] ? input[@"url"] : nil;
    NSURLComponents *url = rawURL && rawURL.length <= 8192 ? [NSURLComponents componentsWithString:rawURL] : nil;
    if (![url.scheme isEqualToString:@"http"] || ![@[@"localhost", @"127.0.0.1"] containsObject:url.host.lowercaseString] ||
        url.port.integerValue != KEEPWORK_LOCAL_MCP_TEST_PORT || url.user != nil || url.password != nil || url.fragment != nil) {
        reply(nil, @"Desktop MCP requires the configured loopback HTTP endpoint"); return;
    }
    NSString *method = [input[@"method"] isKindOfClass:NSString.class] ? input[@"method"] : @"GET";
    if (![@[@"GET", @"HEAD", @"POST", @"PUT", @"DELETE", @"PATCH", @"OPTIONS"] containsObject:method]) {
        reply(nil, @"Unsupported MCP request method"); return;
    }
    id bodyInput = input[@"body"];
    NSData *body = nil;
    if (bodyInput && bodyInput != NSNull.null) {
        if (![bodyInput isKindOfClass:NSString.class] || [bodyInput length] > ((KeepworkMcpBodyLimit + 2) / 3) * 4) {
            reply(nil, @"MCP request body exceeds the 32 MiB desktop limit"); return;
        }
        body = [[NSData alloc] initWithBase64EncodedString:bodyInput options:0];
        if (!body || body.length > KeepworkMcpBodyLimit || [@[@"GET", @"HEAD"] containsObject:method]) {
            reply(nil, @"Invalid MCP request body"); return;
        }
    }
    url.host = @"127.0.0.1";
    if (!url.URL) { reply(nil, @"Invalid MCP request URL"); return; }
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url.URL cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:300];
    request.HTTPMethod = method;
    request.HTTPBody = body;
    NSArray *headers = [input[@"headers"] isKindOfClass:NSArray.class] ? input[@"headers"] : nil;
    if (!headers || headers.count > 100) { reply(nil, @"Invalid MCP request headers"); return; }
    NSSet *forbidden = [NSSet setWithArray:@[@"origin", @"host", @"cookie", @"cookie2", @"connection", @"content-length", @"transfer-encoding", @"proxy-authorization", @"proxy-connection", @"upgrade", @"te", @"trailer", @"accept-encoding", @"referer"]];
    for (id pair in headers) {
        if (![pair isKindOfClass:NSArray.class] || [pair count] != 2 ||
            ![pair[0] isKindOfClass:NSString.class] || ![pair[1] isKindOfClass:NSString.class]) {
            reply(nil, @"Invalid MCP request headers"); return;
        }
        NSString *name = pair[0], *value = pair[1], *lower = name.lowercaseString;
        if (!KeepworkMcpHeaderName(name) || !KeepworkMcpHeaderValue(value) ||
            [forbidden containsObject:lower] || [lower hasPrefix:@"sec-"] || [lower hasPrefix:@"proxy-"] ||
            [lower isEqualToString:@"expect"]) {
            reply(nil, @"Forbidden MCP request header"); return;
        }
        [request setValue:value forHTTPHeaderField:name];
    }
    [request setValue:origin forHTTPHeaderField:@"Origin"];
    request.HTTPShouldHandleCookies = NO;
    NSURLSessionConfiguration *config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    config.HTTPCookieStorage = nil;
    config.HTTPShouldSetCookies = NO;
    config.HTTPCookieAcceptPolicy = NSHTTPCookieAcceptPolicyNever;
    config.URLCredentialStorage = nil;
    config.URLCache = nil;
    config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    config.connectionProxyDictionary = @{@"HTTPEnable": @NO, @"HTTPSEnable": @NO, @"SOCKSEnable": @NO,
        @"ProxyAutoConfigEnable": @NO, @"ProxyAutoDiscoveryEnable": @NO};
    config.timeoutIntervalForRequest = 300;
    config.timeoutIntervalForResource = 7 * 24 * 3600;
    KeepworkMcpRequest *stream = [KeepworkMcpRequest new];
    stream.owner = self; stream.identifier = identifier; stream.document = document;
    stream.origin = origin; stream.originalURL = rawURL; stream.buffer = [NSMutableData new];
    stream.startReply = reply; stream.touched = NSDate.timeIntervalSinceReferenceDate;
    stream.session = [NSURLSession sessionWithConfiguration:config delegate:stream delegateQueue:NSOperationQueue.mainQueue];
    stream.task = [stream.session dataTaskWithRequest:request];
    self.document = document;
    self.requests[identifier] = stream;
    [stream.task resume];
}
@end

static char KeepworkLocalMcpKey;
bool keepwork_install_local_mcp(void *rawWebview, const char *rawEntry) {
    if (@available(macOS 11.0, *)) {
        WKWebView *webview = (__bridge WKWebView *)rawWebview;
        if (!webview || !rawEntry) return false;
        if (objc_getAssociatedObject(webview, &KeepworkLocalMcpKey)) return true;
        NSURL *entry = [NSURL URLWithString:[NSString stringWithUTF8String:rawEntry]];
        if (!KeepworkMcpOrigin(entry)) return false;
        KeepworkLocalMcp *handler = [KeepworkLocalMcp new];
        handler.webview = webview; handler.entry = entry; handler.requests = [NSMutableDictionary new];
        __weak KeepworkLocalMcp *weakHandler = handler;
        handler.timer = [NSTimer scheduledTimerWithTimeInterval:15 repeats:YES block:^(NSTimer *timer) {
            KeepworkLocalMcp *current = weakHandler;
            if (!current || !current.webview) { [current reset]; [timer invalidate]; return; }
            NSTimeInterval now = NSDate.timeIntervalSinceReferenceDate;
            for (KeepworkMcpRequest *request in current.requests.allValues) {
                // A pending pull is an active SSE read, not an abandoned stream.
                if (!request.startReply && !request.readReply && now - request.touched > 120) {
                    [current.requests removeObjectForKey:request.identifier];
                    [request fail:@"Unused MCP response stream expired"];
                }
            }
        }];
        [webview.configuration.userContentController addScriptMessageHandlerWithReply:handler contentWorld:WKContentWorld.pageWorld name:@"keepworkLocalMcp"];
        objc_setAssociatedObject(webview, &KeepworkLocalMcpKey, handler, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        return true;
    }
    return false;
}

void keepwork_reset_local_mcp(void *rawWebview) {
    WKWebView *webview = (__bridge WKWebView *)rawWebview;
    KeepworkLocalMcp *handler = objc_getAssociatedObject(webview, &KeepworkLocalMcpKey);
    [handler reset];
}
