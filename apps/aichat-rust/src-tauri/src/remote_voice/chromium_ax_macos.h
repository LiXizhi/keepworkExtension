// Foreground Chromium windows may need an assistive client to enable the web AX tree.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

typedef NS_ENUM(NSInteger, KeepworkChromiumHost) {
    KeepworkOtherHost, KeepworkChromiumBrowser, KeepworkElectronApp
};

static KeepworkChromiumHost chromiumHost(NSRunningApplication *front) {
    NSString *bundle = front.bundleIdentifier;
    NSArray *browsers = @[@"com.google.Chrome", @"com.google.Chrome.beta", @"com.google.Chrome.dev",
        @"com.google.Chrome.canary", @"org.chromium.Chromium", @"com.microsoft.edgemac", @"com.brave.Browser",
        @"com.vivaldi.Vivaldi", @"company.thebrowser.Browser"];
    if (bundle && [browsers containsObject:bundle]) return KeepworkChromiumBrowser;
    // The Codex desktop bundle ships its Chromium runtime as "Codex Framework".
    if ([bundle isEqualToString:@"com.openai.codex"]) return KeepworkElectronApp;
    if (!front.bundleURL) return KeepworkOtherHost;
    NSURL *framework = [front.bundleURL URLByAppendingPathComponent:@"Contents/Frameworks/Electron Framework.framework"];
    return [NSFileManager.defaultManager fileExistsAtPath:framework.path] ? KeepworkElectronApp : KeepworkOtherHost;
}

// No global preferences. The caller must check the actual focus after the request.
static bool enableChromiumTree(AXUIElementRef app, KeepworkChromiumHost host, bool (^stillCurrent)(void)) {
    if (host == KeepworkOtherHost) return false;
    NSArray *flags = host == KeepworkElectronApp ? @[@"AXManualAccessibility", @"AXEnhancedUserInterface"] : @[@"AXEnhancedUserInterface"];
    for (NSString *flag in flags) {
        CFStringRef attribute = (__bridge CFStringRef)flag;
        CFTypeRef current = NULL;
        AXError status = AXUIElementCopyAttributeValue(app, attribute, &current);
        bool disabled = status == kAXErrorSuccess && current && CFEqual(current, kCFBooleanFalse);
        if (current) CFRelease(current);
        Boolean writable = false;
        if (!disabled || AXUIElementIsAttributeSettable(app, attribute, &writable) != kAXErrorSuccess || !writable) continue;
        if (!stillCurrent()) return false;
        // Some versions enable the tree while returning kAXErrorNotImplemented.
        AXUIElementSetAttributeValue(app, attribute, kCFBooleanTrue);
        return true;
    }
    return false;
}
