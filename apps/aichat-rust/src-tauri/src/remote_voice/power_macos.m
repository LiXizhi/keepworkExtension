#import <AppKit/AppKit.h>
#include <stdbool.h>

void keepwork_voice_observe_power(void (*notify)(bool sleeping)) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSNotificationCenter *center = NSWorkspace.sharedWorkspace.notificationCenter;
        [center addObserverForName:NSWorkspaceWillSleepNotification object:nil queue:nil
            usingBlock:^(NSNotification *note) { (void)note; notify(true); }];
        [center addObserverForName:NSWorkspaceDidWakeNotification object:nil queue:nil
            usingBlock:^(NSNotification *note) { (void)note; notify(false); }];
    });
}
