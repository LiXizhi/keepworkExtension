import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerArgs } from './computer';

export type MacCommand = (file: string, args: string[]) => Promise<string>;
const command: MacCommand = (file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) reject(new Error('macOS desktop command failed or permission was denied. Check Screen Recording, Accessibility and Automation permissions for the app launching the server. Input may already have been delivered; inspect the desktop before retrying.'));
        else resolve(stdout.trim());
    });
});

export const macActionScript = `on run argv
    set operation to item 1 of argv
    tell application "System Events" to set targetPid to unix id of first application process whose frontmost is true
    set promptText to "Experimental Keepwork desktop control requests ONE action: " & operation & ". A screenshot will be sent to your model provider. Close private windows first. No continuous control or Take Back Control panel. Cancel to deny."
    if operation is "click" then set promptText to promptText & " Location: " & item 2 of argv & ", " & item 3 of argv
    if operation is "type" then set promptText to promptText & " Text: " & item 2 of argv
    if operation is "key" then set promptText to promptText & " Key: " & item 2 of argv
    set answer to display dialog promptText with title "Keepwork desktop permission" buttons {"Cancel", "Allow Once"} default button "Cancel" cancel button "Cancel" giving up after 20
    if gave up of answer then error "Desktop approval expired"
    tell application "System Events"
        set frontmost of first application process whose unix id is targetPid to true
        delay 0.2
        if operation is "click" then
            click at {(item 2 of argv as integer), (item 3 of argv as integer)}
        else if operation is "type" then
            keystroke (item 2 of argv)
        else if operation is "key" then
            key code (item 3 of argv as integer)
        end if
    end tell
    delay 0.35
end run`;

const keyCodes = { Enter: 36, Tab: 48, Escape: 53, Backspace: 51, Delete: 117, Up: 126, Down: 125, Left: 123, Right: 124, Home: 115, End: 119, PageUp: 116, PageDown: 121 };

export async function executeMac(args: ComputerArgs, _owner: string, run: MacCommand = command): Promise<string> {
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
    await run('/usr/bin/osascript', ['-e', macActionScript, '--', args.action, ...values]);
    const directory = await mkdtemp(join(tmpdir(), 'keepwork-desktop-'));
    const image = join(directory, 'screen.jpg');
    try {
        await run('/usr/sbin/screencapture', ['-x', '-m', '-t', 'jpg', image]);
        await run('/usr/bin/sips', ['-z', String(height), String(width), image]);
        const bytes = await readFile(image);
        if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw new Error('Desktop screenshot is empty or exceeds 3 MB');
        return JSON.stringify({ width, height, data: bytes.toString('base64') });
    } finally { await rm(directory, { recursive: true, force: true }); }
}