// Pairing inventory only: no discovery, connection, HID listener or input API.
#import <Foundation/Foundation.h>
#import <CoreBluetooth/CoreBluetooth.h>
#import <IOBluetooth/IOBluetooth.h>
#import <IOKit/IOKitLib.h>
#import <IOKit/hid/IOHIDKeys.h>
#include <stdlib.h>
#include <string.h>

static NSString *canonicalAddress(NSString *raw) {
    if (![raw isKindOfClass:NSString.class]) return nil;
    NSString *compact = [[[raw stringByReplacingOccurrencesOfString:@":" withString:@""]
        stringByReplacingOccurrencesOfString:@"-" withString:@""] uppercaseString];
    if (compact.length != 12 || [compact isEqualToString:@"000000000000"] || [compact isEqualToString:@"FFFFFFFFFFFF"]) return nil;
    NSCharacterSet *invalid = [[NSCharacterSet characterSetWithCharactersInString:@"0123456789ABCDEF"] invertedSet];
    if ([compact rangeOfCharacterFromSet:invalid].location != NSNotFound) return nil;
    NSMutableArray *parts = [NSMutableArray new];
    for (NSUInteger i = 0; i < 12; i += 2) [parts addObject:[compact substringWithRange:NSMakeRange(i, 2)]];
    return [parts componentsJoinedByString:@":"];
}

static NSString *stringProperty(NSDictionary *properties, NSString *key) {
    id value = properties[key];
    return [value isKindOfClass:NSString.class] && [value length] ? value : nil;
}

static BOOL knownKeyboard(NSDictionary *properties) {
    id vendor = properties[@kIOHIDVendorIDKey], product = properties[@kIOHIDProductIDKey];
    if (![vendor isKindOfClass:NSNumber.class] || ![product isKindOfClass:NSNumber.class]
        || [vendor unsignedLongLongValue] != 0x2717 || [product unsignedLongLongValue] != 0x32B8) return NO;
    NSString *transport = stringProperty(properties, @kIOHIDTransportKey);
    if (![transport isEqualToString:@kIOHIDTransportBluetoothValue]
        && ![transport isEqualToString:@kIOHIDTransportBluetoothLowEnergyValue]) return NO;
    NSArray *pairs = properties[@kIOHIDDeviceUsagePairsKey];
    if ([pairs isKindOfClass:NSArray.class]) {
        for (id pair in pairs) {
            if (![pair isKindOfClass:NSDictionary.class]) continue;
            id page = pair[@kIOHIDDeviceUsagePageKey], usage = pair[@kIOHIDDeviceUsageKey];
            if ([page isKindOfClass:NSNumber.class] && [usage isKindOfClass:NSNumber.class]
                && [page unsignedLongLongValue] == 1 && [usage unsignedLongLongValue] == 6) return YES;
        }
    }
    id page = properties[@kIOHIDPrimaryUsagePageKey], usage = properties[@kIOHIDPrimaryUsageKey];
    return [page isKindOfClass:NSNumber.class] && [usage isKindOfClass:NSNumber.class]
        && [page unsignedLongLongValue] == 1 && [usage unsignedLongLongValue] == 6;
}

static NSDictionary *connectedKeyboard(NSDictionary *properties, uint64_t registry) {
    if (!registry || !knownKeyboard(properties)) return nil;
    NSString *physical = stringProperty(properties, @"PhysicalDeviceUniqueID")
        ?: stringProperty(properties, @kIOHIDUniqueIDKey);
    NSString *address = canonicalAddress(stringProperty(properties, @"DeviceAddress"))
        ?: canonicalAddress(physical);
    NSString *hardwareKey = address ? [@"mac:" stringByAppendingString:address] : nil;
    if (!hardwareKey && physical.length >= 8 && physical.length <= 160) {
        NSCharacterSet *placeholder = [NSCharacterSet characterSetWithCharactersInString:@"0:- "];
        if ([[physical stringByTrimmingCharactersInSet:placeholder] length]) hardwareKey = [@"physical:" stringByAppendingString:physical];
    }
    if (!hardwareKey) hardwareKey = [NSString stringWithFormat:@"hid:%llu", (unsigned long long)registry];
    return @{
        @"name": stringProperty(properties, @kIOHIDProductKey) ?: @"Xiaomi Bluetooth Remote RC003",
        @"hardwareKey": hardwareKey,
        @"paired": @NO,
        @"connected": @YES,
        @"hardwareSupported": @YES,
    };
}

static NSDictionary *pairedInventory(void) {
    // Querying authorization is passive. Creating a central manager or inquiry
    // here could present consent UI; automatic probes must never do that.
    if (@available(macOS 10.15, *)) {
        if (CBManager.authorization != CBManagerAuthorizationAllowedAlways) {
            return @{@"error":@"尚未允许 Keepwork 使用蓝牙，自动启用已暂停；请在系统隐私设置授权，或手动开启语音输入。"};
        }
    } else {
        return @{@"error":@"系统无法无提示地确认蓝牙授权，请手动开启语音输入。"};
    }
    IOBluetoothHostController *controller = IOBluetoothHostController.defaultController;
    if (!controller || controller.powerState == kBluetoothHCIPowerStateOFF) {
        return @{@"candidates":@[]};
    }
    NSMutableArray *candidates = [NSMutableArray new];
    // Classic pairedDevices is an existing system inventory, never an inquiry.
    // BLE HID can be absent from it, so live known HID registry services below
    // provide an independent connected-device evidence path.
    NSArray *paired = [IOBluetoothDevice pairedDevices];
    if (paired.count > 256) return @{@"error":@"已配对设备过多，请在设置中指定遥控器设备 ID。"};
    for (IOBluetoothDevice *device in paired) {
        if (![device isPaired]) continue;
        NSString *address = canonicalAddress(device.addressString);
        [candidates addObject:@{
            @"name": device.name ?: @"",
            @"hardwareKey": address ? [@"mac:" stringByAppendingString:address] : (id)NSNull.null,
            @"paired": @YES,
            @"connected": @([device isConnected]),
            @"hardwareSupported": @NO,
        }];
    }
    io_iterator_t iterator = IO_OBJECT_NULL;
    kern_return_t result = IOServiceGetMatchingServices(0, IOServiceMatching("IOHIDDevice"), &iterator);
    if (result != KERN_SUCCESS) return @{@"error":@"无法只读查询已连接遥控器，请检查系统蓝牙权限后手动开启。"};
    io_service_t service;
    NSUInteger seen = 0;
    while ((service = IOIteratorNext(iterator))) {
        CFMutableDictionaryRef rawProperties = NULL;
        uint64_t registry = 0;
        if (IORegistryEntryGetRegistryEntryID(service, &registry) == KERN_SUCCESS
            && IORegistryEntryCreateCFProperties(service, &rawProperties, NULL, 0) == KERN_SUCCESS && rawProperties) {
            NSDictionary *candidate = connectedKeyboard((__bridge NSDictionary *)rawProperties, registry);
            if (candidate) [candidates addObject:candidate];
        }
        if (rawProperties) CFRelease(rawProperties);
        IOObjectRelease(service);
        if (++seen > 4096 || candidates.count > 256) {
            IOObjectRelease(iterator);
            return @{@"error":@"系统蓝牙设备记录过多，请手动开启语音输入。"};
        }
    }
    IOObjectRelease(iterator);
    // Registry addresses are not CoreBluetooth UUIDs. identifiers intentionally
    // remain absent so selection cannot pretend an explicit UUID was verified.
    return @{@"candidates":candidates};
}

char *keepwork_paired_remotes_json(void) {
    @autoreleasepool {
        @try {
            NSData *data = [NSJSONSerialization dataWithJSONObject:pairedInventory() options:0 error:nil];
            if (!data || data.length > 131072) return NULL;
            char *bytes = malloc(data.length + 1);
            if (!bytes) return NULL;
            memcpy(bytes, data.bytes, data.length);
            bytes[data.length] = 0;
            return bytes;
        } @catch (NSException *exception) {
            (void)exception;
            return NULL;
        }
    }
}

void keepwork_paired_remotes_free(char *value) { free(value); }
