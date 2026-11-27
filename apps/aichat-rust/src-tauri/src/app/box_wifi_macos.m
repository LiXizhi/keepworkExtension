// Invoked on a Rust blocking worker. Nearby hotspot names stay in memory.
#import <CoreWLAN/CoreWLAN.h>
#import <CoreLocation/CoreLocation.h>
#import <dispatch/dispatch.h>
#include <stdbool.h>
#include <string.h>

// Status codes read by bumi/box_link/wifi.rs.
enum {
    KEEPWORK_WIFI_SCANNED = 0,
    KEEPWORK_WIFI_NO_INTERFACE = 1,
    KEEPWORK_WIFI_OFF = 2,
    KEEPWORK_WIFI_LOCATION_UNANSWERED = 3,
    KEEPWORK_WIFI_LOCATION_DENIED = 4,
    KEEPWORK_WIFI_FAILED = 5,
};

// macOS hides network names until this process may use Location Services.
static const NSTimeInterval kLocationWait = 180.0;
static const NSTimeInterval kMainQueueStartWait = 2.0;
static const NSTimeInterval kPollStep = 0.1;

typedef bool (*keepwork_wifi_cancelled_fn)(const void *context);

static bool isCancelled(keepwork_wifi_cancelled_fn cancelled, const void *context) {
    return cancelled && cancelled(context);
}

static BOOL hasLocationUsageDescription(void) {
    NSBundle *bundle = NSBundle.mainBundle;
    return [bundle objectForInfoDictionaryKey:@"NSLocationWhenInUseUsageDescription"] != nil
        || [bundle objectForInfoDictionaryKey:@"NSLocationUsageDescription"] != nil;
}

@interface KeepworkLocationConsent : NSObject <CLLocationManagerDelegate>
@property(nonatomic, strong) CLLocationManager *manager;
@property(nonatomic, strong) dispatch_semaphore_t done;
@property(nonatomic) CLAuthorizationStatus status;
@property(nonatomic) BOOL answered;
@end

@implementation KeepworkLocationConsent
- (void)finishWithStatus:(CLAuthorizationStatus)status {
    if (self.answered) return;
    self.status = status;
    self.answered = YES;
    self.manager.delegate = nil;
    self.manager = nil;
    if (self.done) dispatch_semaphore_signal(self.done);
}

- (void)startWithRequest:(BOOL)request {
    if (![CLLocationManager locationServicesEnabled]) {
        [self finishWithStatus:kCLAuthorizationStatusDenied];
        return;
    }
    CLLocationManager *manager = [CLLocationManager new];
    CLAuthorizationStatus status = manager.authorizationStatus;
    if (status != kCLAuthorizationStatusNotDetermined || !request) {
        [self finishWithStatus:status];
        return;
    }
    // Without a usage description macOS ignores the request or terminates the process.
    if (!hasLocationUsageDescription()) {
        [self finishWithStatus:status];
        return;
    }
    self.manager = manager;
    self.status = status;
    manager.delegate = self;
    [manager requestWhenInUseAuthorization];
}

- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager {
    CLAuthorizationStatus status = manager.authorizationStatus;
    if (status != kCLAuthorizationStatusNotDetermined) {
        [self finishWithStatus:status];
    }
}

- (CLAuthorizationStatus)closeAndReadStatus {
    if (!self.answered) {
        if (self.manager) self.status = self.manager.authorizationStatus;
        self.answered = YES;
        self.manager.delegate = nil;
        self.manager = nil;
    }
    return self.status;
}
@end

static NSArray<NSDictionary *> *namedNetworks(NSSet<CWNetwork *> *networks) {
    NSMutableArray *items = [NSMutableArray new];
    for (CWNetwork *network in networks) {
        NSData *ssid = network.ssidData;
        if (ssid.length == 0 || ssid.length > 32) continue;
        NSString *name = [[NSString alloc] initWithData:ssid encoding:NSUTF8StringEncoding]
            ?: [[NSString alloc] initWithData:ssid encoding:NSWindowsCP1252StringEncoding];
        if (!name) continue;
        CWChannel *channel = network.wlanChannel;
        NSUInteger modes = 0;
        for (NSInteger mode = kCWSecurityNone; mode <= kCWSecurityOWETransition; mode++) {
            if ([network supportsSecurity:mode]) modes |= 1 << mode;
        }
        [items addObject:@{@"ssid": name, @"rssi": @(network.rssiValue), @"channel": @(channel.channelNumber),
                           @"band": @(channel.channelBand), @"security": @(modes)}];
    }
    return items;
}

// Returns nil when the adapter rejects the scan.
static NSArray<NSDictionary *> *scan(CWInterface *interface) {
    NSSet<CWNetwork *> *networks = [interface scanForNetworksWithSSID:nil includeHidden:NO error:NULL];
    return networks ? namedNetworks(networks) : nil;
}

static bool waitSemaphore(
    dispatch_semaphore_t semaphore,
    NSTimeInterval deadline,
    keepwork_wifi_cancelled_fn cancelled,
    const void *context
) {
    while (!isCancelled(cancelled, context)) {
        NSTimeInterval remaining = deadline - NSProcessInfo.processInfo.systemUptime;
        if (remaining <= 0) return false;
        NSTimeInterval slice = remaining < kPollStep ? remaining : kPollStep;
        dispatch_time_t until = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(slice * (double)NSEC_PER_SEC));
        if (dispatch_semaphore_wait(semaphore, until) == 0) return true;
    }
    return false;
}

static CLAuthorizationStatus authorizeLocation(
    bool request,
    keepwork_wifi_cancelled_fn cancelled,
    const void *context
) {
    if (!request) {
        if (![CLLocationManager locationServicesEnabled]) return kCLAuthorizationStatusDenied;
        return [CLLocationManager new].authorizationStatus;
    }

    KeepworkLocationConsent *consent = [KeepworkLocationConsent new];
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + kLocationWait;

    if (NSThread.isMainThread) {
        [consent startWithRequest:YES];
        while (!consent.answered
               && !isCancelled(cancelled, context)
               && NSProcessInfo.processInfo.systemUptime < deadline) {
            [NSRunLoop.mainRunLoop runMode:NSDefaultRunLoopMode
                                beforeDate:[NSDate dateWithTimeIntervalSinceNow:kPollStep]];
        }
        return [consent closeAndReadStatus];
    }

    // CoreLocation delivers authorization prompts and callbacks on the main run loop.
    dispatch_semaphore_t started = dispatch_semaphore_create(0);
    consent.done = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_main_queue(), ^{
        dispatch_semaphore_signal(started);
        [consent startWithRequest:YES];
    });

    NSTimeInterval startDeadline = NSProcessInfo.processInfo.systemUptime + kMainQueueStartWait;
    if (!waitSemaphore(started, startDeadline, cancelled, context)) {
        return kCLAuthorizationStatusNotDetermined;
    }

    waitSemaphore(consent.done, deadline, cancelled, context);

    __block CLAuthorizationStatus status = kCLAuthorizationStatusNotDetermined;
    dispatch_sync(dispatch_get_main_queue(), ^{
        status = [consent closeAndReadStatus];
    });
    return status;
}

int keepwork_box_wifi_scan(
    char *out,
    size_t capacity,
    bool request_location,
    keepwork_wifi_cancelled_fn cancelled,
    const void *context
) {
    @autoreleasepool {
        if (capacity == 0) return KEEPWORK_WIFI_FAILED;
        out[0] = '\0';
        CWInterface *interface = CWWiFiClient.sharedWiFiClient.interface;
        if (!interface) return KEEPWORK_WIFI_NO_INTERFACE;
        if (!interface.powerOn) return KEEPWORK_WIFI_OFF;
        NSArray<NSDictionary *> *items = scan(interface);
        if (!items) return KEEPWORK_WIFI_FAILED;
        if (items.count == 0 && !isCancelled(cancelled, context)) {
            CLAuthorizationStatus status = authorizeLocation(request_location, cancelled, context);
            if (isCancelled(cancelled, context)) return KEEPWORK_WIFI_LOCATION_UNANSWERED;
            if (status == kCLAuthorizationStatusNotDetermined) return KEEPWORK_WIFI_LOCATION_UNANSWERED;
            if (status != kCLAuthorizationStatusAuthorizedAlways) {
                return KEEPWORK_WIFI_LOCATION_DENIED;
            }
            // A fresh grant reaches CoreWLAN shortly after the system dialog closes.
            for (int attempt = 0; attempt < 3 && items.count == 0 && !isCancelled(cancelled, context); attempt++) {
                if (attempt) [NSThread sleepForTimeInterval:0.35];
                items = scan(interface);
                if (!items) return KEEPWORK_WIFI_FAILED;
            }
        }
        NSData *json = [NSJSONSerialization dataWithJSONObject:items options:0 error:NULL];
        if (!json || json.length >= capacity) return KEEPWORK_WIFI_FAILED;
        memcpy(out, json.bytes, json.length);
        out[json.length] = '\0';
        return KEEPWORK_WIFI_SCANNED;
    }
}
