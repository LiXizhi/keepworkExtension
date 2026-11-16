// dev-bins integration fixture: only authored red pixels, no screen access.
#import <CoreGraphics/CoreGraphics.h>
extern int keepwork_copy_primary_jpeg(CGImageRef image, size_t w, size_t h, uint8_t *out, size_t capacity, size_t *length);

int keepwork_synthetic_screenshot(uint8_t *out, size_t capacity, size_t *length) {
    CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(NULL, 32, 24, 8, 0, srgb, (CGBitmapInfo)kCGImageAlphaNoneSkipLast);
    CGColorSpaceRelease(srgb);
    if (!ctx) return 4;
    CGContextSetRGBFillColor(ctx, 1, 0, 0, 1);
    CGContextFillRect(ctx, CGRectMake(0,0,32,24));
    CGImageRef image = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    if (!image) return 4;
    int code = keepwork_copy_primary_jpeg(image,16,12,out,capacity,length);
    CGImageRelease(image);
    return code;
}
