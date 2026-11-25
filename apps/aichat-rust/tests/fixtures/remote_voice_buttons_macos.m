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
    ButtonSource value = {.registry = registry, .device = (uintptr_t)(registry + 100), .hasHome = true};
    snprintf(value.physical, sizeof(value.physical), "%s", physical);
    snprintf(value.label, sizeof(value.label), "Xiaomi RC003");
    return value;
}
static void click(ButtonContext *context, uint64_t registry, uint64_t when) {
    buttonEdge(context, registry, 7, 0xF1, true, when);
    buttonEdge(context, registry, 7, 0xF1, false, when + 50);
}

static void known_device_and_source_selection(void) {
    assert(knownRemote(0x2717, 0x32B8, @"Bluetooth", 1, 6));
    assert(knownRemote(0x2717, 0x32B8, @"BluetoothLowEnergy", 1, 6));
    assert(knownRemote(0x2717, 0x32B8, @"Bluetooth Low Energy", 1, 6));
    assert(!knownRemote(0x2718, 0x32B8, @"Bluetooth", 1, 6));
    assert(!knownRemote(0x2717, 0x32B9, @"Bluetooth", 1, 6));
    assert(!knownRemote(0x2717, 0x32B8, @"USB", 1, 6));
    assert(!knownRemote(0x2717, 0x32B8, nil, 1, 6));
    assert(!knownRemote(0x2717, 0x32B8, @"bluetooth", 1, 6));
    assert(!knownRemote(0x2717, 0x32B8, @"Bluetooth", 0x0C, 6));
    assert(!knownRemote(0x2717, 0x32B8, @"Bluetooth", 1, 2));
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
        if (usage == 0x4A) assert(pollHomeAt(&context, 21));
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
    click(&context, 1, 12200);
    assert(pollContextAt(&context, 12251));
    assert(pollContextAt(&context, 12252));
    assert(pollContextAt(&context, 12253));
    assert(!pollContextAt(&context, 12254));
    click(&context, 1, 13000);
    click(&context, 1, 13900);
    assert(pollContextAt(&context, 14050)); // Drop the stale first press only.
    assert(!pollContextAt(&context, 14051));
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
    remote.needsRelease[BackButton] = true; // Startup sampled a held key or could not read its value.
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

static void homeTap(ButtonContext *context, uint64_t registry, uint64_t time) {
    buttonEdge(context, registry, 7, 0x4A, true, time);
    buttonEdge(context, registry, 7, 0x4A, false, time + 30);
}

static void back_and_home_are_consumed_in_release_order(void) {
    ButtonContext context; initialize(&context);
    ButtonSource remote = source(1, "physical-remote-A");
    applySources(&context, &remote, 1);
    click(&context, 1, 100);
    homeTap(&context, 1, 180);
    click(&context, 1, 250);
    assert(!pollHomeAt(&context, 310));
    assert(pollContextAt(&context, 311));
    assert(!pollContextAt(&context, 312));
    assert(pollHomeAt(&context, 313));
    assert(pollContextAt(&context, 314));
    assert(!pollHomeAt(&context, 315) && !pollContextAt(&context, 315));
    finish(&context);
}

static void home_taps_remain_distinct_and_independent_of_back(void) {
    ButtonContext context; initialize(&context);
    ButtonSource remote = source(1, "physical-remote-A");
    applySources(&context, &remote, 1);
    for (uint32_t usage = 0; usage < 0x100; usage++) {
        if (usage == 0x4A) continue;
        buttonEdge(&context, 1, 7, usage, true, 10);
        buttonEdge(&context, 1, 7, usage, false, 20);
        assert(!pollHomeAt(&context, 21));
    }
    assert(pollContextAt(&context, 21)); // Back still routes exclusively to clear.
    homeTap(&context, 999, 30);
    buttonEdge(&context, 1, 0x0C, 0x4A, true, 65);
    buttonEdge(&context, 1, 0x0C, 0x4A, false, 70);
    buttonEdge(&context, 1, 7, 0x4A, false, 80);
    assert(!pollHomeAt(&context, 81));
    buttonEdge(&context, 1, 7, 0x4A, true, 100);
    buttonEdge(&context, 1, 7, 0x4A, true, 200); // Held-key repeat.
    click(&context, 1, 201);
    assert(pollContextAt(&context, 252) && !pollHomeAt(&context, 252));
    buttonEdge(&context, 1, 7, 0x4A, false, 260);
    homeTap(&context, 1, 270);
    homeTap(&context, 1, 310);
    assert(!pollContextAt(&context, 350));
    for (int i = 0; i < 3; i++) assert(pollHomeAt(&context, 350));
    assert(!pollHomeAt(&context, 350));
    buttonEdge(&context, 1, 7, 0x4A, true, 500);
    buttonEdge(&context, 1, 7, 0x4A, true, 1450);
    buttonEdge(&context, 1, 7, 0x4A, false, 1500); // Long hold never toggles.
    assert(!pollHomeAt(&context, 1501));
    homeTap(&context, 1, 1600);
    homeTap(&context, 1, 2499);
    assert(pollHomeAt(&context, 2630)); // Old tap expired; the newer one survives.
    assert(!pollHomeAt(&context, 2630));
    finish(&context);
}

static void home_releases_are_scoped_to_the_current_source_and_session(void) {
    ButtonContext context; initialize(&context);
    ButtonSource sources[] = {source(1, "physical-remote-A"), source(2, "physical-remote-A")};
    sources[0].needsRelease[HomeButton] = true;
    applySources(&context, sources, 2);
    click(&context, 1, 100);
    assert(pollContextAt(&context, 151)); // Startup-held Home does not disable Back.
    buttonEdge(&context, 1, 7, 0x4A, true, 160);
    buttonEdge(&context, 1, 7, 0x4A, false, 170);
    assert(!pollHomeAt(&context, 171));
    buttonEdge(&context, 1, 7, 0x4A, true, 200);
    buttonEdge(&context, 2, 7, 0x4A, true, 201);
    buttonEdge(&context, 2, 7, 0x4A, false, 220);
    assert(!pollHomeAt(&context, 220));
    buttonEdge(&context, 1, 7, 0x4A, false, 221);
    assert(pollHomeAt(&context, 221) && !pollHomeAt(&context, 221));
    homeTap(&context, 2, 250);
    buttonEdge(&context, 2, 7, 0x4A, true, 300);
    ButtonSource reversed[] = {context.sources[1], context.sources[0]};
    applySources(&context, reversed, 2);
    assert(!pollHomeAt(&context, 301));
    buttonEdge(&context, 2, 7, 0x4A, true, 320);
    buttonEdge(&context, 2, 7, 0x4A, false, 321);
    assert(!pollHomeAt(&context, 322));
    homeTap(&context, 2, 400);
    assert(pollHomeAt(&context, 431));
    homeTap(&context, 2, 500);
    applySources(&context, NULL, 0);
    assert(!pollHomeAt(&context, 531));
    finish(&context);
}

static void status_reports_home_availability_separately(void) {
    ButtonContext context; initialize(&context);
    activeButtons = &context; // Exercise the exported snapshot without installing a listener.
    ButtonSnapshot status;
    ButtonSource collection = source(1, "physical-remote-A");
    collection.hasHome = false;
    applySources(&context, &collection, 1);
    keepwork_remote_buttons_status(&status);
    assert(status.ready && !status.homeReady);
    homeTap(&context, 1, 1);
    assert(!pollHomeAt(&context, 32));

    collection.hasHome = true;
    collection.needsRelease[HomeButton] = true;
    applySources(&context, &collection, 1);
    keepwork_remote_buttons_status(&status);
    assert(status.ready && !status.homeReady);
    buttonEdge(&context, 1, 7, 0x4A, false, 50);
    keepwork_remote_buttons_status(&status);
    assert(status.ready && status.homeReady);

    ButtonSource collections[] = {context.sources[0], source(2, "physical-remote-A")};
    collections[1].hasHome = false;
    collections[1].needsRelease[BackButton] = true;
    applySources(&context, collections, 2);
    keepwork_remote_buttons_status(&status);
    assert(!status.ready && status.homeReady);
    assert(keepwork_remote_home_sender(collections[0].registry));
    assert(!keepwork_remote_home_sender(collections[1].registry));
    assert(!keepwork_remote_home_sender(0));
    disableButtons(&context, 4);
    keepwork_remote_buttons_status(&status);
    assert(!status.ready && !status.homeReady);
    assert(!keepwork_remote_home_sender(collections[0].registry));
    activeButtons = NULL;
    finish(&context);
}

static void pressed_state_tracks_each_visual_key_without_queuing_actions(void) {
    ButtonContext context; initialize(&context);
    ButtonSource remote = source(1, "physical-remote-A");
    applySources(&context, &remote, 1);
    for (int button = MenuButton; button < ButtonCount; button++) {
        buttonEdge(&context, 1, 7, buttonUsage[button], true, 100);
        buttonEdge(&context, 1, 7, buttonUsage[button], true, 110);
        assert(pressedMask(&context) == (1u << button));
        buttonEdge(&context, 1, 7, buttonUsage[button], false, 120);
        assert(pressedMask(&context) == 0);
        assert(!pollContextAt(&context, 121));
        assert(!pollHomeAt(&context, 121));
    }
    buttonEdge(&context, 1, 7, buttonUsage[UpButton], true, 200);
    buttonEdge(&context, 1, 7, buttonUsage[OkButton], true, 201);
    assert(pressedMask(&context) == ((1u << UpButton) | (1u << OkButton)));
    buttonEdge(&context, 1, 7, buttonUsage[UpButton], false, 202);
    assert(pressedMask(&context) == (1u << OkButton));
    buttonEdge(&context, 1, 7, buttonUsage[OkButton], false, 203);
    finish(&context);
}

static void demo_mode_keeps_visual_feedback_and_discards_taps(void) {
    ButtonContext context; initialize(&context);
    ButtonSource remote = source(1, "physical-remote-A");
    applySources(&context, &remote, 1);
    activeButtons = &context;

    homeTap(&context, 1, 100);
    keepwork_remote_buttons_set_demo_mode(true);
    assert(!pollHomeAt(&context, 131));

    buttonEdge(&context, 1, 7, buttonUsage[BackButton], true, 200);
    assert(pressedMask(&context) == (1u << BackButton));
    buttonEdge(&context, 1, 7, buttonUsage[BackButton], false, 230);
    assert(!pressedMask(&context));
    assert(!pollContextAt(&context, 231));

    buttonEdge(&context, 1, 7, buttonUsage[HomeButton], true, 300);
    keepwork_remote_buttons_set_demo_mode(false);
    assert(pressedMask(&context) == (1u << HomeButton));
    buttonEdge(&context, 1, 7, buttonUsage[HomeButton], false, 330);
    assert(!pressedMask(&context));
    assert(!pollHomeAt(&context, 331));

    homeTap(&context, 1, 400);
    assert(pollHomeAt(&context, 431));
    activeButtons = NULL;
    finish(&context);
}

static void volume_feedback_uses_the_selected_remote_keyboard_page(void) {
    ButtonContext context; initialize(&context);
    ButtonSource remote = source(1, "physical-remote-A");
    applySources(&context, &remote, 1);
    buttonEdge(&context, 1, 7, 0xE2, true, 100);   // Keyboard Left Alt
    buttonEdge(&context, 1, 0x0C, 0xE9, true, 101); // Consumer Volume Increment
    buttonEdge(&context, 2, 7, 0x80, true, 102);   // Other keyboard
    assert(pressedMask(&context) == 0);

    const uint32_t usages[] = {0x80, 0x81, 0x7F};
    const RemoteButton buttons[] = {VolumeUpButton, VolumeDownButton, MuteButton};
    for (size_t i = 0; i < sizeof(usages) / sizeof(usages[0]); i++) {
        buttonEdge(&context, 1, 7, usages[i], true, 110);
        assert(pressedMask(&context) == (1u << buttons[i]));
        buttonEdge(&context, 1, 7, usages[i], false, 120);
        assert(pressedMask(&context) == 0);
    }
    finish(&context);
}

static uint32_t reportedDirections[8];
static size_t reportedDirectionCount;

static void recordDirectionMask(uint32_t mask) {
    assert(reportedDirectionCount < sizeof(reportedDirections) / sizeof(reportedDirections[0]));
    reportedDirections[reportedDirectionCount++] = mask;
}

static int sourceChangeCount;
static void countSourceChange(void) { sourceChangeCount++; }

static void direction_capture_requires_neutral_and_expires_on_reenumeration(void) {
    ButtonContext context;
    initialize(&context);
    context.sourceChanged = countSourceChange;
    ButtonSource remote = source(7, "remote");
    remote.needsRelease[LeftButton] = true;
    applySources(&context, &remote, 1);
    activeButtons = &context;
    assert(!keepwork_remote_directions_released());
    buttonEdge(&context, 7, 7, buttonUsage[LeftButton], false, 20);
    assert(keepwork_remote_directions_released());
    buttonEdge(&context, 7, 7, buttonUsage[RightButton], true, 30);
    assert(!keepwork_remote_directions_released());
    ButtonSource replacement = source(8, "remote");
    applySources(&context, &replacement, 1);
    assert(sourceChangeCount == 1);
    activeButtons = NULL;
    finish(&context);
}

static void rapid_directions_report_every_device_scoped_edge(void) {
    ButtonContext context; initialize(&context);
    ButtonSource remote = source(1, "physical-remote-A");
    applySources(&context, &remote, 1);
    context.reportPressed = recordDirectionMask;
    buttonEdge(&context, 2, 7, buttonUsage[DownButton], true, 99);
    buttonEdge(&context, 1, 7, buttonUsage[UpButton], true, 100);
    buttonEdge(&context, 1, 7, buttonUsage[UpButton], true, 102);
    buttonEdge(&context, 1, 7, buttonUsage[RightButton], true, 103);
    buttonEdge(&context, 1, 7, buttonUsage[UpButton], false, 104);
    buttonEdge(&context, 1, 7, buttonUsage[RightButton], false, 105);
    assert(reportedDirectionCount == 4);
    assert(reportedDirections[0] == (1u << UpButton));
    assert(reportedDirections[1] == ((1u << UpButton) | (1u << RightButton)));
    assert(reportedDirections[2] == (1u << RightButton));
    assert(reportedDirections[3] == 0);
    finish(&context);
}

int main(void) {
    assert(activeButtons == NULL);
    known_device_and_source_selection();
    status_reports_home_availability_separately();
    home_taps_remain_distinct_and_independent_of_back();
    home_releases_are_scoped_to_the_current_source_and_session();
    only_selected_back_releases_trigger_once();
    long_press_and_pending_action_age_are_bounded();
    back_and_home_are_consumed_in_release_order();
    collections_share_one_press_and_reordering_drops_partial_edges();
    startup_held_or_unknown_state_requires_release_before_a_new_click();
    source_changes_and_shutdown_invalidate_pressed_and_pending_actions();
    pressed_state_tracks_each_visual_key_without_queuing_actions();
    demo_mode_keeps_visual_feedback_and_discards_taps();
    volume_feedback_uses_the_selected_remote_keyboard_page();
    rapid_directions_report_every_device_scoped_edge();
    direction_capture_requires_neutral_and_expires_on_reenumeration();
    assert(activeButtons == NULL);
    puts("device-scoped remote button fixtures passed");
    return 0;
}
