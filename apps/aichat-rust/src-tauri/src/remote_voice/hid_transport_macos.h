#pragma once
#import <Foundation/Foundation.h>
#import <IOKit/hid/IOHIDKeys.h>

// Some macOS HID devices publish the spaced spelling in the registry.
static inline NSArray<NSString *> *remoteHIDTransports(void) {
    return @[@kIOHIDTransportBluetoothValue, @kIOHIDTransportBluetoothLowEnergyValue, @"Bluetooth Low Energy"];
}
