// Pairing inventory only: no discovery, connection, HID listener or input API.
#import <Foundation/Foundation.h>
#import <CoreBluetooth/CoreBluetooth.h>
#import <IOBluetooth/IOBluetooth.h>
#import <IOKit/IOKitLib.h>
#import <IOKit/hid/IOHIDKeys.h>
#import "hid_transport_macos.h"
#include <stdbool.h>
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
    if (!transport || ![remoteHIDTransports() containsObject:transport]) return NO;
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

bool keepwork_voice_bluetooth_denied(void) {
    if (@available(macOS 10.15, *)) {
        CBManagerAuthorization access = CBManager.authorization;
        return access == CBManagerAuthorizationDenied || access == CBManagerAuthorizationRestricted;
    }
    return false;
}

static NSDictionary *pairedInventory(void) {
    // HID registry properties are available even on first launch. Keep the
    // Bluetooth inventory behind consent; neither path prompts or connects.
    BOOL allowed = NO;
    BOOL notDetermined = NO;
    if (@available(macOS 10.15, *)) {
        CBManagerAuthorization access = CBManager.authorization;
        allowed = access == CBManagerAuthorizationAllowedAlways;
        notDetermined = access == CBManagerAuthorizationNotDetermined;
    }
    NSMutableArray *candidates = [NSMutableArray new];
    NSArray *paired = nil;
    if (allowed) {
        IOBluetoothHostController *controller = IOBluetoothHostController.defaultController;
        // A missing/off classic controller must not hide an already connected
        // Low Energy HID remote. Query that independent inventory below too.
        if (controller && controller.powerState != kBluetoothHCIPowerStateOFF)
            paired = [IOBluetoothDevice pairedDevices];
    }
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
    if (result == kIOReturnNotPrivileged || result == kIOReturnNotPermitted)
        return @{@"error":@"系统拒绝读取已连接遥控器，请检查访问权限后手动开启。"};
    if (result != KERN_SUCCESS) return @{@"error":@"暂时无法查询已连接遥控器，将自动重试。", @"retry":@YES};
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
    return @{@"candidates":candidates, @"bluetoothAllowed":@(allowed), @"bluetoothNotDetermined":@(notDetermined)};
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
