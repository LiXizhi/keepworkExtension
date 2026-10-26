/** Capture only: no input API, control consent, or retained permission. */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const windowsCaptureScript = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type 'using System.Runtime.InteropServices; public class CaptureDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][CaptureDpi]::SetProcessDPIAware()
$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$image=New-Object System.Drawing.Bitmap($b.Width,$b.Height)
$g=[System.Drawing.Graphics]::FromImage($image)
$stream=New-Object System.IO.MemoryStream
try {
 $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)
 $image.Save($stream,[System.Drawing.Imaging.ImageFormat]::Jpeg)
 if ($stream.Length -gt 3MB) { throw 'Screenshot exceeds 3 MB' }
 @{width=$b.Width;height=$b.Height;data=[Convert]::ToBase64String($stream.ToArray())}|ConvertTo-Json -Compress
} finally { $g.Dispose();$image.Dispose();$stream.Dispose() }
`;
function run(file: string, args: string[], signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => execFile(file, args, { signal, windowsHide: true, timeout: 30000, maxBuffer: 5 * 1024 * 1024 },
        (error, stdout) => error ? reject(new Error(signal?.aborted ? 'Screenshot cancelled' : 'Screen capture failed. Check OS Screen Recording permission on macOS.')) : resolve(stdout.trim())));
}
export async function captureDesktop(signal?: AbortSignal, platform = process.platform, command = run): Promise<string> {
    signal?.throwIfAborted();
    if (platform === 'win32') return command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsCaptureScript, 'utf16le').toString('base64')], signal);
    if (platform !== 'darwin') throw Error('Screenshots support Windows and experimental macOS only');
    const geometry = JSON.parse(await command('/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); var f=$.NSScreen.screens.objectAtIndex(0).frame; JSON.stringify({width:f.size.width,height:f.size.height});'], signal));
    const { width, height } = geometry;
    if (![width,height].every(n => Number.isInteger(n) && n > 0 && n <= 32767)) throw Error('Invalid display geometry');
    const directory = await mkdtemp(join(tmpdir(), 'keepwork-capture-'));
    try {
        const file = join(directory, 'screen.jpg');
        await command('/usr/sbin/screencapture', ['-x', '-m', '-t', 'jpg', file], signal);
        await command('/usr/bin/sips', ['-z', String(height), String(width), file], signal);
        const bytes = await readFile(file);
        if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw Error('Screenshot empty or exceeds 3 MB');
        signal?.throwIfAborted();
        return JSON.stringify({ width, height, data: bytes.toString('base64') });
    } finally { await rm(directory, { recursive: true, force: true }); }
}
