#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
void *crop_test_window(void) {
 [NSApplication sharedApplication];
 [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
 NSWindow *window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,900,700) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
 [window setReleasedWhenClosed:NO]; [window setOpaque:NO]; [window setBackgroundColor:NSColor.clearColor];
 return (__bridge void *)window;
}
int crop_check_window(void *raw,double x,double y,double width,double height) {
 NSWindow *window=(__bridge NSWindow *)raw; NSRect frame=window.frame;
 double primaryHeight=CGDisplayBounds(CGMainDisplayID()).size.height;
 printf("native frame global=(%.0f,%.0f,%.0f,%.0f), visible=%d\n",frame.origin.x,primaryHeight-frame.origin.y-frame.size.height,frame.size.width,frame.size.height,window.visible);
 return !window.visible && fabs(frame.origin.x-x)<0.5 && fabs(primaryHeight-frame.origin.y-frame.size.height-y)<0.5 && fabs(frame.size.width-width)<0.5 && fabs(frame.size.height-height)<0.5;
}
void crop_close_window(void *raw) {[(NSWindow *)raw close];}
