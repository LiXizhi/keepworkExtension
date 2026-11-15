// NSWorkspace's notification center is in-process. Posting here exercises the
// AppKit bridge without changing the operating system's power or display state.
#import <AppKit/AppKit.h>
#include <assert.h>
#include <stdbool.h>

void keepwork_voice_observe_power(void (*notify)(bool sleeping));

static unsigned eventCount;
static bool events[8];

static void recordPower(bool sleeping) {
    assert(eventCount < sizeof(events) / sizeof(events[0]));
    events[eventCount++] = sleeping;
}

static void drainMainQueue(void) {
    // If the observer schedules delivery on the main queue, wait until all
    // work previously queued by this fixture has had an opportunity to run.
    __block BOOL done = NO;
    dispatch_async(dispatch_get_main_queue(), ^{ done = YES; });
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:1.0];
    while (!done && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.005]];
    }
    assert(done);
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSNotificationCenter *center = NSWorkspace.sharedWorkspace.notificationCenter;
        keepwork_voice_observe_power(recordPower);
        keepwork_voice_observe_power(recordPower);
        drainMainQueue();
        assert(eventCount == 0);

        [center postNotificationName:NSWorkspaceScreensDidSleepNotification object:nil];
        [center postNotificationName:NSWorkspaceScreensDidWakeNotification object:nil];
        [NSNotificationCenter.defaultCenter postNotificationName:NSWorkspaceDidWakeNotification object:nil];
        drainMainQueue();
        assert(eventCount == 0);

        for (unsigned cycle = 0; cycle < 2; cycle++) {
            [center postNotificationName:NSWorkspaceWillSleepNotification object:nil];
            [center postNotificationName:NSWorkspaceDidWakeNotification object:nil];
            drainMainQueue();
            assert(eventCount == (cycle + 1) * 2);
            assert(events[cycle * 2] && !events[cycle * 2 + 1]);
        }
        puts("two isolated workspace sleep/wake cycles passed");
    }
    return 0;
}
