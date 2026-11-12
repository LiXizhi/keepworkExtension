// Exercise production source/edge logic only. Native manager construction,
// permission inspection and thread creation abort if any test reaches them.
#import <Foundation/Foundation.h>
#import <IOKit/hid/IOHIDManager.h>
#import <IOKit/hidsystem/IOHIDLib.h>
#include <pthread.h>
#include <assert.h>
static IOHIDManagerRef forbiddenManager(CFAllocatorRef allocator, IOOptionBits options);
static IOHIDAccessType forbiddenAccess(IOHIDRequestType type);
static int forbiddenThread(pthread_t *thread, const pthread_attr_t *attributes, void *(*start)(void *), void *raw);
#define IOHIDManagerCreate forbiddenManager
#define IOHIDCheckAccess forbiddenAccess
#define pthread_create forbiddenThread
#include "../../src-tauri/src/remote_voice/buttons_macos.m"
#undef IOHIDManagerCreate
#undef IOHIDCheckAccess
#undef pthread_create

static IOHIDManagerRef forbiddenManager(CFAllocatorRef allocator, IOOptionBits options) {
    (void)allocator; (void)options; assert(!"fixture must not create a HID manager"); return NULL;
}
static IOHIDAccessType forbiddenAccess(IOHIDRequestType type) {
    (void)type; assert(!"fixture must not inspect native input access"); return kIOHIDAccessTypeDenied;
}
static int forbiddenThread(pthread_t *thread, const pthread_attr_t *attributes, void *(*start)(void *), void *raw) {
    (void)thread; (void)attributes; (void)start; (void)raw;
    assert(!"fixture must not start a native listener thread"); return 1;
}

static void initialize(ButtonContext *context) {
    memset(context, 0, sizeof(*context));
    assert(pthread_mutex_init(&context->mutex, NULL) == 0);
    context->enabled = true;
}
static void finish(ButtonContext *context) {
    assert(context->runloop == NULL && !context->startup_done);
    assert(pthread_mutex_destroy(&context->mutex) == 0);
}
static ButtonSource source(uint64_t registry, const char *physical) {
    ButtonSource value = {.registry = registry, .device = (uintptr_t)(registry + 100)};
    snprintf(value.physical, sizeof(value.physical), "%s", physical);
    snprintf(value.label, sizeof(value.label), "Xiaomi RC003");
    return value;
}
static void click(ButtonContext *context, uint64_t registry, uint64_t when) {
    buttonEdge(context, registry, 7, 0xF1, true, when);
    buttonEdge(context, registry, 7, 0xF1, false, when + 50);
}

static void known_device_and_source_selection(void) {
    assert(knownRemote(0x2717, 0x32B8, "Bluetooth", 1, 6));
    assert(knownRemote(0x2717, 0x32B8, "BluetoothLowEnergy", 1, 6));
    assert(!knownRemote(0x2718, 0x32B8, "Bluetooth", 1, 6));
    assert(!knownRemote(0x2717, 0x32B9, "Bluetooth", 1, 6));
    assert(!knownRemote(0x2717, 0x32B8, "USB", 1, 6));
    assert(!knownRemote(0x2717, 0x32B8, NULL, 1, 6));
    assert(!knownRemote(0x2717, 0x32B8, "bluetooth", 1, 6));
    assert(!knownRemote(0x2717, 0x32B8, "Bluetooth", 0x0C, 6));
    assert(!knownRemote(0x2717, 0x32B8, "Bluetooth", 1, 2));
    ButtonSource sources[] = {source(1, "physical-remote-A"), source(2, "physical-remote-A")};
    assert(selectSources(NULL, 0) == NoSource);
    assert(selectSources(sources, 1) == UniqueSource);
    assert(selectSources(sources, 2) == UniqueSource);
    assert(selectSources(sources, BUTTON_SOURCE_LIMIT + 1) == AmbiguousSource);
    assert(selectSources(NULL, 1) == AmbiguousSource);
    sources[1] = source(2, "physical-remote-B");
    assert(selectSources(sources, 2) == AmbiguousSource);
    sources[0] = source(1, ""); sources[1] = source(2, "");
    assert(selectSources(sources, 1) == UniqueSource);
    assert(selectSources(sources, 2) == AmbiguousSource);
    sources[0] = source(1, "physical-remote-A"); sources[1] = sources[0];
    assert(selectSources(sources, 2) == AmbiguousSource);
    sources[0].registry = 0;
    assert(selectSources(sources, 1) == AmbiguousSource);
}

static void only_selected_back_releases_trigger_once(void) {
    ButtonContext context; initialize(&context);
    ButtonSource remote = source(1, "physical-remote-A");
    applySources(&context, &remote, 1);
    assert(context.ready && !context.blocked);
    for (uint32_t usage = 0; usage < 0x100; usage++) {
        if (usage == 0xF1) continue; // Includes OK/Enter (0x28), Escape and Backspace.
        buttonEdge(&context, 1, 7, usage, true, 10);
        buttonEdge(&context, 1, 7, usage, false, 20);
        assert(!pollContextAt(&context, 21));
    }
    click(&context, 999, 100); // A second keyboard with exactly the same code.
    assert(!pollContextAt(&context, 151));
    buttonEdge(&context, 1, 0x0C, 0xF1, true, 200);
    buttonEdge(&context, 1, 0x0C, 0xF1, false, 250);
    assert(!pollContextAt(&context, 251));
    buttonEdge(&context, 1, 7, 0xF1, false, 300); // No preceding down.
    assert(!pollContextAt(&context, 301));
    buttonEdge(&context, 1, 7, 0xF1, true, 400);
    buttonEdge(&context, 1, 7, 0xF1, true, 450); // Hardware autorepeat.
    assert(!pollContextAt(&context, 451));
    buttonEdge(&context, 1, 7, 0xF1, false, 500);
    assert(pollContextAt(&context, 501));
    assert(!pollContextAt(&context, 502));
    buttonEdge(&context, 1, 7, 0xF1, false, 503);
    assert(!pollContextAt(&context, 504));
    click(&context, 1, 600);
    assert(pollContextAt(&context, 651));
    finish(&context);
}

static void long_press_and_pending_action_age_are_bounded(void) {
    ButtonContext context; initialize(&context);
    ButtonSource remote = source(1, "physical-remote-A");
    applySources(&context, &remote, 1);
    buttonEdge(&context, 1, 7, 0xF1, true, 1000);
    buttonEdge(&context, 1, 7, 0xF1, true, 1900);
    buttonEdge(&context, 1, 7, 0xF1, false, 2500);
    assert(!pollContextAt(&context, 2501)); // Repeat cannot reset the press start.
    buttonEdge(&context, 1, 7, 0xF1, true, 3000);
    buttonEdge(&context, 1, 7, 0xF1, false, 4000);
    assert(!pollContextAt(&context, 4001)); // Exactly 1000 ms is a long press.
    buttonEdge(&context, 1, 7, 0xF1, true, 5000);
    buttonEdge(&context, 1, 7, 0xF1, false, 5999);
    assert(pollContextAt(&context, 6000));
    buttonEdge(&context, 1, 7, 0xF1, true, 7000);
    buttonEdge(&context, 1, 7, 0xF1, false, 6999);
    assert(!pollContextAt(&context, 7001)); // A backwards clock cannot underflow.
    click(&context, 1, 8000);
    assert(pollContextAt(&context, 9049)); // 999 ms old.
    click(&context, 1, 10000);
    assert(!pollContextAt(&context, 11050)); // 1000 ms old: never clear a later focus.
    assert(!pollContextAt(&context, 11051));
    click(&context, 1, 12000);
    click(&context, 1, 12100);
    assert(pollContextAt(&context, 12151)); // One pending slot, not an action queue.
    assert(!pollContextAt(&context, 12152));
    finish(&context);
}

static void collections_share_one_press_and_reordering_drops_partial_edges(void) {
    ButtonContext context; initialize(&context);
    ButtonSource sources[] = {source(1, "physical-remote-A"), source(2, "physical-remote-A")};
    applySources(&context, sources, 2);
    buttonEdge(&context, 1, 7, 0xF1, true, 100);
    buttonEdge(&context, 2, 7, 0xF1, true, 110);
    buttonEdge(&context, 1, 7, 0xF1, false, 150);
    assert(!pollContextAt(&context, 151));
    buttonEdge(&context, 2, 7, 0xF1, false, 160);
    assert(pollContextAt(&context, 161));
    buttonEdge(&context, 1, 7, 0xF1, true, 200);
    ButtonSource reversed[] = {sources[1], sources[0]};
    applySources(&context, reversed, 2);
    assert(context.ready && !context.blocked);
    buttonEdge(&context, 1, 7, 0xF1, true, 225); // A repeat from the still-held old press.
    buttonEdge(&context, 1, 7, 0xF1, false, 250);
    buttonEdge(&context, 2, 7, 0xF1, false, 251);
    assert(!pollContextAt(&context, 252));
    click(&context, 1, 300);
    assert(pollContextAt(&context, 351));
    buttonEdge(&context, 1, 7, 0xF1, true, 400);
    applySources(&context, sources, 1); // Removing a same-physical collection.
    assert(context.ready && !context.blocked);
    buttonEdge(&context, 1, 7, 0xF1, false, 450);
    assert(!pollContextAt(&context, 451));
    click(&context, 1, 500);
    assert(pollContextAt(&context, 551));
    finish(&context);
}

static void startup_held_or_unknown_state_requires_release_before_a_new_click(void) {
    ButtonContext context; initialize(&context);
    ButtonSource remote = source(1, "physical-remote-A");
    remote.needsRelease = true; // Startup sampled a held key or could not read its value.
    applySources(&context, &remote, 1);
    assert(!context.snapshot.ready && context.snapshot.code == 10);
    buttonEdge(&context, 1, 7, 0x28, false, 10); // Native OK cannot lift Back's barrier.
    assert(!context.snapshot.ready && !pollContextAt(&context, 11));
    buttonEdge(&context, 1, 7, 0xF1, true, 20);
    buttonEdge(&context, 1, 7, 0xF1, false, 50);
    assert(context.snapshot.ready && !pollContextAt(&context, 51));
    click(&context, 1, 100);
    assert(pollContextAt(&context, 151));
    finish(&context);

    initialize(&context);
    ButtonSource sources[] = {remote, source(2, "physical-remote-A")};
    applySources(&context, sources, 2);
    buttonEdge(&context, 2, 7, 0xF1, true, 200); // Companion joins the same held barrier.
    buttonEdge(&context, 1, 7, 0xF1, false, 220);
    assert(!context.snapshot.ready && !pollContextAt(&context, 221));
    buttonEdge(&context, 2, 7, 0xF1, false, 230);
    assert(context.snapshot.ready && !pollContextAt(&context, 231));
    click(&context, 1, 300);
    assert(pollContextAt(&context, 351));
    finish(&context);
}

static void source_changes_and_shutdown_invalidate_pressed_and_pending_actions(void) {
    ButtonSource remote = source(1, "physical-remote-A");
    ButtonSource other = source(2, "physical-remote-B");
    ButtonContext context; initialize(&context);
    applySources(&context, &remote, 1);
    click(&context, 1, 100);
    applySources(&context, &other, 1);
    assert(context.blocked && !context.ready);
    assert(!pollContextAt(&context, 151));
    applySources(&context, &remote, 1);
    click(&context, 1, 200);
    assert(!pollContextAt(&context, 251)); // Sticky disabled until a fresh session.
    finish(&context);
    initialize(&context);
    applySources(&context, &remote, 1);
    buttonEdge(&context, 1, 7, 0xF1, true, 300);
    applySources(&context, NULL, 0);
    buttonEdge(&context, 1, 7, 0xF1, false, 350);
    assert(context.blocked && !pollContextAt(&context, 351));
    finish(&context);
    initialize(&context);
    applySources(&context, &remote, 1);
    click(&context, 1, 400);
    disableButtons(&context, 4);
    assert(!pollContextAt(&context, 451));
    finish(&context);
    initialize(&context);
    applySources(&context, &remote, 1);
    buttonEdge(&context, 1, 7, 0xF1, false, 500);
    assert(!pollContextAt(&context, 501)); // A release from an old session does nothing.
    click(&context, 1, 600);
    assert(pollContextAt(&context, 651));
    finish(&context);
}

int main(void) {
    assert(activeButtons == NULL);
    known_device_and_source_selection();
    only_selected_back_releases_trigger_once();
    long_press_and_pending_action_age_are_bounded();
    collections_share_one_press_and_reordering_drops_partial_edges();
    startup_held_or_unknown_state_requires_release_before_a_new_click();
    source_changes_and_shutdown_invalidate_pressed_and_pending_actions();
    assert(activeButtons == NULL);
    puts("device-scoped remote button fixtures passed");
    return 0;
}
