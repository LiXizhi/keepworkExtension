#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>

// WebKit defers getUserMedia until its document has a visible window. During
// phone startup the pet presents the same WKWebView behind its status display.
// WebKit still owns the origin, the permission prompt and the microphone.
@interface KeepworkPhoneHost : NSView
@property(nonatomic, strong) WKWebView *phone;
@property(nonatomic, weak) NSView *originalParent;
@property(nonatomic, weak) NSView *nextSibling;
@property(nonatomic) NSRect originalFrame;
@property(nonatomic) NSAutoresizingMaskOptions originalMask;
@end

@implementation KeepworkPhoneHost
- (NSView *)hitTest:(NSPoint)point { return nil; }
- (BOOL)acceptsFirstResponder { return NO; }
@end

static char phoneHostKey;

void keepwork_restore_phone_view(void *mainWindow) {
    NSWindow *window = (__bridge NSWindow *)mainWindow;
    KeepworkPhoneHost *host = objc_getAssociatedObject(window, &phoneHostKey);
    if (!host) return;
    WKWebView *phone = host.phone;
    NSView *parent = host.originalParent;
    if (phone.superview == host && parent) {
        NSView *next = host.nextSibling;
        if (next && next.superview == parent) {
            [parent addSubview:phone positioned:NSWindowBelow relativeTo:next];
        } else {
            [parent addSubview:phone];
        }
        phone.frame = host.originalFrame;
        phone.autoresizingMask = host.originalMask;
    }
    [host removeFromSuperview];
    objc_setAssociatedObject(window, &phoneHostKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

int keepwork_attach_phone_view(void *mainWindow, void *petWindow, void *mainWebView) {
    NSWindow *main = (__bridge NSWindow *)mainWindow;
    NSWindow *pet = (__bridge NSWindow *)petWindow;
    WKWebView *phone = (__bridge WKWebView *)mainWebView;
    if (!NSThread.isMainThread || !main || !pet.visible || pet.miniaturized ||
            (main.visible && !main.miniaturized) || ![phone isKindOfClass:WKWebView.class]) return 0;
    KeepworkPhoneHost *current = objc_getAssociatedObject(main, &phoneHostKey);
    if (current) return current.phone == phone && current.window == pet;
    NSView *parent = phone.superview;
    if (!parent || phone.window != main || !pet.contentView) return 0;
    KeepworkPhoneHost *host = [[KeepworkPhoneHost alloc] initWithFrame:NSMakeRect(0, 0, 1, 1)];
    host.phone = phone;
    host.originalParent = parent;
    NSArray<NSView *> *siblings = parent.subviews;
    NSUInteger index = [siblings indexOfObjectIdenticalTo:phone];
    if (index != NSNotFound && index + 1 < siblings.count) host.nextSibling = siblings[index + 1];
    host.originalFrame = phone.frame;
    host.originalMask = phone.autoresizingMask;
    host.wantsLayer = YES;
    host.layer.masksToBounds = YES;
    host.layer.opacity = 0; // Never paint private chat text on the transparent pet.
    [pet.contentView addSubview:host positioned:NSWindowBelow relativeTo:nil];
    phone.autoresizingMask = NSViewNotSizable;
    [host addSubview:phone];
    objc_setAssociatedObject(main, &phoneHostKey, host, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    return 1;
}
