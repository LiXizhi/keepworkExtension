#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

typedef void (*KeepworkMinimizeCallback)(void *);
typedef void (*KeepworkMinimizeNotify)(void *, bool);

// Restoring from the Dock may synchronously redraw a Tao window. Run window
// transitions outside Tao's locked event callback, inline within our own turn
// so consecutive Home/Back actions see the preceding native window state.
void keepwork_run_window_action(void *context, KeepworkMinimizeCallback action) {
    static BOOL performingWindowAction = NO;
    if (NSThread.isMainThread && performingWindowAction) {
        action(context);
        return;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        performingWindowAction = YES;
        action(context);
        performingWindowAction = NO;
    });
}

// Observe the main window without replacing the delegate installed by Tao.
@interface KeepworkMinimizeObserver : NSObject
@property(nonatomic, assign) void *context;
@property(nonatomic, assign) KeepworkMinimizeNotify notify;
@property(nonatomic, assign) KeepworkMinimizeCallback releaseContext;
@property(nonatomic, strong) NSObject *remoteMinimizeRequest;
@property(nonatomic, assign) BOOL animationStarted;
@property(nonatomic, assign) BOOL restoreAfterMinimize;
- (void)beginRemoteMinimize:(NSWindow *)window;
@end

@implementation KeepworkMinimizeObserver
- (void)beginRemoteMinimize:(NSWindow *)window {
    NSObject *request = [NSObject new];
    self.remoteMinimizeRequest = request;
    self.animationStarted = NO;
    self.restoreAfterMinimize = NO;
    [window miniaturize:window];
    // AppKit can decline a minimize request. Expire only requests for which
    // AppKit never began the animation, so the next Home can try again.
    __weak KeepworkMinimizeObserver *weakObserver = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        KeepworkMinimizeObserver *observer = weakObserver;
        if (observer.remoteMinimizeRequest == request && !observer.animationStarted) {
            BOOL restore = observer.restoreAfterMinimize;
            observer.remoteMinimizeRequest = nil;
            observer.restoreAfterMinimize = NO;
            if (restore) observer.notify(observer.context, true);
        }
    });
}
- (void)willMiniaturize:(NSNotification *)notification {
    self.animationStarted = YES;
}
- (void)didMiniaturize:(NSNotification *)notification {
    BOOL restore = self.restoreAfterMinimize;
    self.remoteMinimizeRequest = nil;
    self.restoreAfterMinimize = NO;
    if (restore) {
        // Leave the AppKit animation callback before ordering the window front.
        dispatch_async(dispatch_get_main_queue(), ^{ self.notify(self.context, true); });
    } else {
        self.notify(self.context, false);
    }
}
- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
    self.releaseContext(self.context);
}
@end

static char KeepworkMinimizeObserverKey;

bool keepwork_begin_remote_main_minimize(void *rawWindow) {
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    KeepworkMinimizeObserver *observer = objc_getAssociatedObject(window, &KeepworkMinimizeObserverKey);
    if (!observer) return false;
    [observer beginRemoteMinimize:window];
    return true;
}

bool keepwork_queue_restore_after_remote_minimize(void *rawWindow, bool toggle) {
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    KeepworkMinimizeObserver *observer = objc_getAssociatedObject(window, &KeepworkMinimizeObserverKey);
    if (!observer.remoteMinimizeRequest) return false;
    observer.restoreAfterMinimize = !toggle || !observer.restoreAfterMinimize;
    return true;
}

void keepwork_observe_main_minimize(void *rawWindow, void *context,
    KeepworkMinimizeNotify notify, KeepworkMinimizeCallback releaseContext) {
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    KeepworkMinimizeObserver *observer = [KeepworkMinimizeObserver new];
    observer.context = context;
    observer.notify = notify;
    observer.releaseContext = releaseContext;
    [NSNotificationCenter.defaultCenter addObserver:observer selector:@selector(willMiniaturize:)
        name:NSWindowWillMiniaturizeNotification object:window];
    [NSNotificationCenter.defaultCenter addObserver:observer selector:@selector(didMiniaturize:)
        name:NSWindowDidMiniaturizeNotification object:window];
    objc_setAssociatedObject(window, &KeepworkMinimizeObserverKey, observer, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
