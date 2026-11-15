#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

typedef void (*KeepworkMinimizeCallback)(void *);

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
@property(nonatomic, assign) KeepworkMinimizeCallback notify;
@property(nonatomic, assign) KeepworkMinimizeCallback releaseContext;
@end

@implementation KeepworkMinimizeObserver
- (void)didMiniaturize:(NSNotification *)notification {
    self.notify(self.context);
}
- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
    self.releaseContext(self.context);
}
@end

void keepwork_observe_main_minimize(void *rawWindow, void *context,
    KeepworkMinimizeCallback notify, KeepworkMinimizeCallback releaseContext) {
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    KeepworkMinimizeObserver *observer = [KeepworkMinimizeObserver new];
    observer.context = context;
    observer.notify = notify;
    observer.releaseContext = releaseContext;
    [NSNotificationCenter.defaultCenter addObserver:observer selector:@selector(didMiniaturize:)
        name:NSWindowDidMiniaturizeNotification object:window];
    static char key;
    objc_setAssociatedObject(window, &key, observer, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
