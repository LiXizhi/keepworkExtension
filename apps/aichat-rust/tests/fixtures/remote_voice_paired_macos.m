// Exercise the production inventory with fake system providers. No Bluetooth
// central, pairing query, HID listener or permission prompt reaches the OS.
#import <Foundation/Foundation.h>
#import <CoreBluetooth/CoreBluetooth.h>
#import <IOBluetooth/IOBluetooth.h>
#import <IOKit/IOKitLib.h>
#import <IOKit/hid/IOHIDKeys.h>
#include <assert.h>

static CBManagerAuthorization fakeAuthorization;
static BOOL fakeControllerPresent;
static BluetoothHCIPowerState fakeControllerPower;
static NSArray *fakePaired;
static NSArray<NSDictionary *> *fakeHID;
static unsigned pairedQueries, controllerQueries, registryIndex;
static kern_return_t fakeRegistryResult;

@interface InventoryTestManager : NSObject
+ (CBManagerAuthorization)authorization;
@end
@implementation InventoryTestManager
+ (CBManagerAuthorization)authorization { return fakeAuthorization; }
@end

@interface InventoryTestController : NSObject
+ (instancetype)defaultController;
- (BluetoothHCIPowerState)powerState;
@end
@implementation InventoryTestController
+ (instancetype)defaultController {
    controllerQueries++;
    return fakeControllerPresent ? [self new] : nil;
}
- (BluetoothHCIPowerState)powerState { return fakeControllerPower; }
@end

@interface InventoryTestDevice : NSObject
@property NSString *name;
@property NSString *addressString;
@property BOOL paired;
@property BOOL connected;
+ (NSArray *)pairedDevices;
- (BOOL)isPaired;
- (BOOL)isConnected;
@end
@implementation InventoryTestDevice
+ (NSArray *)pairedDevices { pairedQueries++; return fakePaired; }
- (BOOL)isPaired { return self.paired; }
- (BOOL)isConnected { return self.connected; }
@end

static kern_return_t inventoryTestGetMatchingServices(mach_port_t port, CFDictionaryRef match, io_iterator_t *iterator) {
    (void)port;
    if (match) CFRelease(match); // The real matching API consumes this dictionary.
    registryIndex = 0;
    *iterator = fakeRegistryResult == KERN_SUCCESS ? 1 : IO_OBJECT_NULL;
    return fakeRegistryResult;
}
static io_object_t inventoryTestIteratorNext(io_iterator_t iterator) {
    (void)iterator;
    return registryIndex < fakeHID.count ? 100 + registryIndex++ : IO_OBJECT_NULL;
}
static kern_return_t inventoryTestEntryID(io_registry_entry_t entry, uint64_t *registry) {
    *registry = entry;
    return KERN_SUCCESS;
}
static kern_return_t inventoryTestProperties(io_registry_entry_t entry, CFMutableDictionaryRef *properties, CFAllocatorRef allocator, IOOptionBits options) {
    (void)allocator; (void)options;
    *properties = (__bridge_retained CFMutableDictionaryRef)[fakeHID[entry - 100] mutableCopy];
    return KERN_SUCCESS;
}
static kern_return_t inventoryTestRelease(io_object_t object) { (void)object; return KERN_SUCCESS; }

#define CBManager InventoryTestManager
#define IOBluetoothHostController InventoryTestController
#define IOBluetoothDevice InventoryTestDevice
#define IOServiceGetMatchingServices inventoryTestGetMatchingServices
#define IOIteratorNext inventoryTestIteratorNext
#define IORegistryEntryGetRegistryEntryID inventoryTestEntryID
#define IORegistryEntryCreateCFProperties inventoryTestProperties
#define IOObjectRelease inventoryTestRelease
#include "../../src-tauri/src/remote_voice/paired_macos.m"

static NSDictionary *remoteHID(void) {
    return @{
        @kIOHIDVendorIDKey: @0x2717,
        @kIOHIDProductIDKey: @0x32B8,
        @kIOHIDTransportKey: @"Bluetooth Low Energy",
        @kIOHIDPrimaryUsagePageKey: @1,
        @kIOHIDPrimaryUsageKey: @6,
        @kIOHIDProductKey: @"小米蓝牙语音遥控器",
        @"DeviceAddress": @"AA:BB:CC:DD:EE:01",
    };
}
static void reset(CBManagerAuthorization authorization) {
    fakeAuthorization = authorization;
    fakeControllerPresent = YES;
    fakeControllerPower = kBluetoothHCIPowerStateON;
    fakePaired = @[];
    fakeHID = @[remoteHID()];
    fakeRegistryResult = KERN_SUCCESS;
    pairedQueries = controllerQueries = registryIndex = 0;
}
static NSDictionary *exportedInventory(void) {
    char *raw = keepwork_paired_remotes_json();
    assert(raw);
    NSData *data = [[NSString stringWithUTF8String:raw] dataUsingEncoding:NSUTF8StringEncoding];
    keepwork_paired_remotes_free(raw);
    NSDictionary *inventory = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    assert([inventory isKindOfClass:NSDictionary.class]);
    return inventory;
}
static void assertConnectedRemote(NSDictionary *inventory) {
    NSArray *candidates = inventory[@"candidates"];
    assert(candidates.count == 1);
    NSDictionary *candidate = candidates[0];
    assert([candidate[@"connected"] boolValue]);
    assert([candidate[@"hardwareSupported"] boolValue]);
    assert(![candidate[@"paired"] boolValue]);
}

int main(void) {
    @autoreleasepool {
        for (NSNumber *access in @[@(CBManagerAuthorizationNotDetermined), @(CBManagerAuthorizationDenied), @(CBManagerAuthorizationRestricted)]) {
            reset(access.unsignedIntegerValue);
            NSDictionary *inventory = exportedInventory();
            assertConnectedRemote(inventory);
            assert(![inventory[@"bluetoothAllowed"] boolValue]);
            assert([inventory[@"bluetoothNotDetermined"] isKindOfClass:NSNumber.class]);
            assert([inventory[@"bluetoothNotDetermined"] boolValue] == (fakeAuthorization == CBManagerAuthorizationNotDetermined));
            assert(controllerQueries == 0 && pairedQueries == 0);
            assert(keepwork_voice_bluetooth_denied() == (fakeAuthorization != CBManagerAuthorizationNotDetermined));
        }
        reset(CBManagerAuthorizationAllowedAlways);
        NSDictionary *allowed = exportedInventory();
        assertConnectedRemote(allowed);
        assert([allowed[@"bluetoothAllowed"] boolValue]);
        assert(![allowed[@"bluetoothNotDetermined"] boolValue]);
        assert(!keepwork_voice_bluetooth_denied());
        assert(pairedQueries == 1);

        for (NSNumber *present in @[@YES, @NO]) {
            reset(CBManagerAuthorizationAllowedAlways);
            fakeControllerPower = kBluetoothHCIPowerStateOFF;
            fakeControllerPresent = present.boolValue;
            assertConnectedRemote(exportedInventory());
        }

        reset(CBManagerAuthorizationAllowedAlways);
        InventoryTestDevice *pairedRemote = [InventoryTestDevice new];
        pairedRemote.name = @"Xiaomi Bluetooth Remote 2 Pro";
        pairedRemote.addressString = @"AA:BB:CC:DD:EE:01";
        pairedRemote.paired = YES;
        fakePaired = @[pairedRemote];
        NSArray *sources = exportedInventory()[@"candidates"];
        assert(sources.count == 2);
        assert([sources[0][@"paired"] boolValue]);
        assert([sources[0][@"hardwareKey"] isEqual:sources[1][@"hardwareKey"]]);

        reset(CBManagerAuthorizationAllowedAlways);
        NSMutableDictionary *unrelated = [remoteHID() mutableCopy];
        unrelated[@kIOHIDVendorIDKey] = @0x2718;
        fakeHID = @[unrelated];
        assert([exportedInventory()[@"candidates"] count] == 0);

        reset(CBManagerAuthorizationAllowedAlways);
        fakeRegistryResult = kIOReturnError;
        NSDictionary *temporary = exportedInventory();
        assert([temporary[@"error"] length] > 0 && [temporary[@"retry"] boolValue]);
        reset(CBManagerAuthorizationAllowedAlways);
        fakeRegistryResult = kIOReturnNotPermitted;
        NSDictionary *blocked = exportedInventory();
        assert([blocked[@"error"] length] > 0 && ![blocked[@"retry"] boolValue]);
        puts("isolated pairing inventory authorization, HID and retry scenarios passed");
    }
}
