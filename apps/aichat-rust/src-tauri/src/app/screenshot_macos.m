// Invoked on a Rust blocking worker. All screenshot pixels stay in memory.
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <ImageIO/ImageIO.h>
#import <dlfcn.h>

// runModal creates a standalone alert even when the main AIChat window is hidden.
int keepwork_screenshot_consent(const char *origin, bool setting) {
    @autoreleasepool {
        NSRunningApplication *previous = NSWorkspace.sharedWorkspace.frontmostApplication;
        NSAlert *alert = [NSAlert new];
        alert.messageText = @"Keepwork · 主屏幕截图授权";
        alert.informativeText = [NSString stringWithFormat:@"来源：%s\n允许截取主屏幕并将画面交给当前会话的 AI 吗？截图可能包含其他应用的内容。可在聊天的 MCP 设置中关闭始终允许截图。", origin];
        if (!setting) [alert addButtonWithTitle:@"允许本次"];
        [alert addButtonWithTitle:@"始终允许此来源截图"];
        NSButton *cancel = [alert addButtonWithTitle:@"取消"];
        cancel.keyEquivalent = @"\e";
        alert.window.identifier = @"org.keepwork.aichat.screenshot-consent";
        alert.window.level = NSModalPanelWindowLevel;
        alert.window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
        [NSApp activateIgnoringOtherApps:YES];
        NSModalResponse answer = [alert runModal];
        [alert.window orderOut:nil];
        if (previous && previous.processIdentifier != NSProcessInfo.processInfo.processIdentifier && NSApp.isActive) {
            if (@available(macOS 14.0, *)) {
                [NSApp yieldActivationToApplication:previous];
                [previous activateWithOptions:0];
            } else {
                [previous activateWithOptions:NSApplicationActivateIgnoringOtherApps];
            }
        }
        if (answer == NSAlertFirstButtonReturn) return setting ? 2 : 1;
        if (!setting && answer == NSAlertSecondButtonReturn) return 2;
        return 0;
    }
}

static NSData *encodeJPEG(CGImageRef image, size_t w, size_t h, size_t cap) {
    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(NULL, w, h, 8, 0, color, (CGBitmapInfo)kCGImageAlphaNoneSkipLast);
    CGColorSpaceRelease(color);
    if (!ctx) return nil;
    CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
    CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), image);
    CGImageRef scaled = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    if (!scaled) return nil;
    NSData *result = nil;
    for (NSNumber *quality in @[@0.78, @0.57, @0.38]) {
        NSMutableData *bytes = [NSMutableData data];
        CGImageDestinationRef dest = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)bytes, CFSTR("public.jpeg"), 1, NULL);
        if (!dest) break;
        CGImageDestinationAddImage(dest, scaled, (__bridge CFDictionaryRef)@{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality: quality});
        BOOL ok = CGImageDestinationFinalize(dest);
        CFRelease(dest);
        if (ok && bytes.length > 0 && bytes.length <= cap) { result = bytes; break; }
    }
    CGImageRelease(scaled);
    return result;
}

int keepwork_copy_primary_jpeg(CGImageRef image, size_t w, size_t h, uint8_t *out, size_t capacity, size_t *length) {
    NSData *jpeg = encodeJPEG(image, w, h, capacity);
    if (!jpeg) return 2;
    memcpy(out, jpeg.bytes, jpeg.length);
    *length = jpeg.length;
    return 0;
}

int keepwork_capture_primary(uint8_t *out, size_t capacity, size_t *length, uint32_t *width, uint32_t *height) {
    @autoreleasepool {
        if (!CGPreflightScreenCaptureAccess() && !CGRequestScreenCaptureAccess()) return 1;
        CGDirectDisplayID main = CGMainDisplayID();
        CGRect bounds = CGDisplayBounds(main);
        size_t w = CGRectGetWidth(bounds), h = CGRectGetHeight(bounds);
        if (!w || !h || w > 32767 || h > 32767 || w*h > 32*1024*1024) return 2;
        __block id captured = nil;
        if (@available(macOS 14.0, *)) {
            dispatch_semaphore_t done = dispatch_semaphore_create(0);
            [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content, NSError *error) {
                SCDisplay *primary = nil;
                for (SCDisplay *display in content.displays) {
                    if (display.displayID == main) { primary = display; break; }
                }
                if (error || !primary) { dispatch_semaphore_signal(done); return; }
                SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:primary excludingWindows:@[]];
                SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
                config.width = w;
                config.height = h;
                config.showsCursor = NO;
                [SCScreenshotManager captureImageWithFilter:filter configuration:config completionHandler:^(CGImageRef image, NSError *error) {
                    if (!error && image) captured = CFBridgingRelease(CGImageRetain(image));
                    dispatch_semaphore_signal(done);
                }];
            }];
            if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 12*NSEC_PER_SEC))) return 3;
        } else {
            // macOS 11–13 predates SCScreenshotManager.
            CGImageRef (*copyDisplay)(CGDirectDisplayID) = dlsym(RTLD_DEFAULT, "CGDisplayCreateImage");
            if (copyDisplay) captured = CFBridgingRelease(copyDisplay(main));
        }
        if (!captured) return 4;
        *width = (uint32_t)w;
        *height = (uint32_t)h;
        return keepwork_copy_primary_jpeg((__bridge CGImageRef)captured, w, h, out, capacity, length);
    }
}
