import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerArgs } from './computer';

export type MacCommand = (file: string, args: string[]) => Promise<string>;
const command: MacCommand = (file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        // Do not return raw stderr: osascript can include the supplied text.
        const reason = /-128|Desktop approval expired/.test(stderr) ? 'Desktop control denied or approval expired.'
            : /-1743/.test(stderr) ? 'macOS Automation permission is missing for System Events.'
            : /-1719|not allowed assistive access/.test(stderr) ? 'macOS Accessibility permission is missing.'
            : /KEEPWORK_STOP/.test(stderr) ? 'Desktop control stopped locally. Release Escape and move the pointer away from the top-left corner before requesting new consent.'
            : /KEEPWORK_ACCESSIBILITY/.test(stderr) ? 'macOS Accessibility permission is missing.'
            : file === '/usr/sbin/screencapture' ? 'macOS screen capture failed. Check Screen Recording permission.'
            : 'macOS desktop command failed.';
        if (error) reject(new Error(`${reason} Check System Settings > Privacy & Security for the app launching Keepwork (VS Code or Terminal). Do not retry input automatically; inspect the desktop first.`));
        else resolve(stdout.trim());
    });
});

export const macConsentScript = `on run argv
    tell application "System Events" to set targetPid to unix id of first application process whose frontmost is true
    set promptText to "Allow AIChat to control your primary screen for this connection? Screenshots are sent to your model provider. Close private windows first. Consent lasts 24 hours, including idle time. To stop, hold Escape or move the pointer to the top-left corner; the next action will be blocked. Cancel to deny."
    set answer to display dialog promptText with title "Keepwork desktop permission" buttons {"Cancel", "Allow Session"} default button "Cancel" cancel button "Cancel" giving up after 20
    if gave up of answer then error "Desktop approval expired"
    tell application "System Events"
        set frontmost of first application process whose unix id is targetPid to true
        delay 0.2
    end tell
end run`;

export const macActionScript = `on run argv
    set operation to item 1 of argv
    tell application "System Events"
        if operation is "type" then
            keystroke (item 2 of argv)
        else if operation is "key" then
            key code (item 3 of argv as integer)
        end if
    end tell
    delay 0.35
end run`;

// Fixed JXA only; all user values stay in argv. Quartz clicks work on the Dock
// and custom canvases, unlike System Events' accessibility "click at" command.
export const macGuardScript = `ObjC.import('ApplicationServices');
function run(argv) {
    var event = $.CGEventCreate(null);
    var point = $.CGEventGetLocation(event);
    if ($.CGEventSourceKeyState($.kCGEventSourceStateHIDSystemState, 53) || (point.x <= 2 && point.y <= 2)) throw Error('KEEPWORK_STOP');
    if (argv[0] !== 'screenshot' && !$.AXIsProcessTrusted()) throw Error('KEEPWORK_ACCESSIBILITY');
}`;

export const macClickScript = `ObjC.import('ApplicationServices'); ObjC.import('Foundation');
function run(argv) {
    var point = $.CGPointMake(Number(argv[0]), Number(argv[1]));
    var down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft);
    var up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft);
    $.CGEventPost($.kCGHIDEventTap, down);
    $.CGEventPost($.kCGHIDEventTap, up);
    $.NSThread.sleepForTimeInterval(0.35);
}`;

const keyCodes = { Enter: 36, Tab: 48, Escape: 53, Backspace: 51, Delete: 117, Up: 126, Down: 125, Left: 123, Right: 124, Home: 115, End: 119, PageUp: 116, PageDown: 121 };

export function createMacExecutor(now = Date.now) {
    const consentDurationMs = 24 * 60 * 60 * 1000;
    let consent: { owner: string; grantedAt: number } | undefined;
    return async function executeMac(args: ComputerArgs, owner: string, run: MacCommand = command): Promise<string> {
        if (args.action === 'status') throw new Error('Status must not execute desktop commands');
        if (args.action === 'scroll' || (args.action === 'click' && args.button === 'right')) {
            throw new Error('Experimental macOS desktop control does not support scrolling or right-click. Use supported navigation keys or visible controls instead.');
        }
        const geometry = JSON.parse(await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); var frame = $.NSScreen.screens.objectAtIndex(0).frame; JSON.stringify({width: frame.size.width, height: frame.size.height});']));
        const { width, height } = geometry;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 32767 || height > 32767) throw new Error('Invalid macOS primary display dimensions');
        if (args.action === 'click' && (args.x >= width || args.y >= height)) throw new Error('Coordinates outside primary screen');
        const values = args.action === 'click' ? [String(args.x), String(args.y)]
            : args.action === 'type' ? [args.text]
            : args.action === 'key' ? [args.key, String(keyCodes[args.key])] : [];
        try {
            await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', macGuardScript, '--', args.action]);
            if (!consent || consent.owner !== owner || now() - consent.grantedAt >= consentDurationMs) {
                consent = undefined;
                await run('/usr/bin/osascript', ['-e', macConsentScript]);
                consent = { owner, grantedAt: now() };
            }
            // Check again after approval, since the user may stop while the dialog closes.
            await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', macGuardScript, '--', args.action]);
            if (args.action === 'click') {
                if (args.x <= 2 && args.y <= 2) throw new Error('Top-left corner is reserved for stopping desktop control');
                await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', macClickScript, '--', ...values]);
            } else if (args.action !== 'screenshot') {
                await run('/usr/bin/osascript', ['-e', macActionScript, '--', args.action, ...values]);
            }
            const directory = await mkdtemp(join(tmpdir(), 'keepwork-desktop-'));
            const image = join(directory, 'screen.jpg');
            try {
                await run('/usr/sbin/screencapture', ['-x', '-m', '-t', 'jpg', image]);
                await run('/usr/bin/sips', ['-z', String(height), String(width), image]);
                const bytes = await readFile(image);
                if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw new Error('Desktop screenshot is empty or exceeds 3 MB');
                return JSON.stringify({ width, height, data: bytes.toString('base64') });
            } finally { await rm(directory, { recursive: true, force: true }); }
        } catch (error) {
            consent = undefined;
            throw error;
        }
    };
}

export const executeMac = createMacExecutor();
