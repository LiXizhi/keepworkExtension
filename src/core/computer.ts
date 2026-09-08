import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { computerOverlay } from './computerOverlay';
import { executeMac } from './computerMac';

export const computerSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('status') }).strict(),
    z.object({ action: z.literal('screenshot') }).strict(),
    z.object({ action: z.literal('click'), x: z.number().int().min(0).max(32767), y: z.number().int().min(0).max(32767), button: z.enum(['left', 'right']).default('left') }).strict(),
    z.object({ action: z.literal('type'), text: z.string().min(1).max(1000) }).strict(),
    z.object({ action: z.literal('key'), key: z.enum(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown']) }).strict(),
    z.object({ action: z.literal('scroll'), delta: z.number().int().min(-1200).max(1200) }).strict(),
]);
export type ComputerArgs = z.infer<typeof computerSchema>;

const helper = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing @'
${computerOverlay}
'@
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class DesktopInput {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, int data, UIntPtr extra);
}
'@
[void][DesktopInput]::SetProcessDPIAware()
$shell = New-Object -ComObject WScript.Shell
function Invoke-DesktopAction($request) {
[ControlOverlay]::Check()
$detail = $request | ConvertTo-Json -Compress
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
switch ($request.action) {
    'screenshot' {
        $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $stream = New-Object System.IO.MemoryStream
        try {
            [ControlOverlay]::PrepareCapture()
            $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
            $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Jpeg)
            if ($stream.Length -gt 3MB) { throw 'Desktop screenshot exceeds 3 MB' }
            @{ width=$bounds.Width; height=$bounds.Height; data=[Convert]::ToBase64String($stream.ToArray()) } | ConvertTo-Json -Compress
        } finally { $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose() }
    }
    'click' {
        if ($request.x -ge $bounds.Width -or $request.y -ge $bounds.Height) { throw 'Coordinates outside primary screen' }
        if ([ControlOverlay]::IntersectsPanel($request.x + $bounds.X, $request.y + $bounds.Y)) { throw 'Control panel covers this point; reclaim control and move the target before retrying' }
        [void][DesktopInput]::SetCursorPos($request.x + $bounds.X, $request.y + $bounds.Y)
        $down = 2; $up = 4
        if ($request.button -eq 'right') { $down = 8; $up = 16 }
        [DesktopInput]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
        [DesktopInput]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    }
    'type' {
        foreach ($character in $request.text.ToCharArray()) {
            [ControlOverlay]::Check()
            $value = [string]$character
            if ('+^%~(){}[]'.Contains($value)) { $value = '{' + $value + '}' }
            if ($character -eq [char]10) { $value = '{ENTER}' }
            if ($character -eq [char]13) { continue }
            $shell.SendKeys($value, $true)
        }
    }
    'key' {
        $keys = @{ Enter='{ENTER}'; Tab='{TAB}'; Escape='{ESC}'; Backspace='{BACKSPACE}'; Delete='{DELETE}'; Up='{UP}'; Down='{DOWN}'; Left='{LEFT}'; Right='{RIGHT}'; Home='{HOME}'; End='{END}'; PageUp='{PGUP}'; PageDown='{PGDN}' }
        $shell.SendKeys($keys[$request.key], $true)
    }
    'scroll' {
        $cursor = [System.Windows.Forms.Cursor]::Position
        if ([ControlOverlay]::IntersectsPanel($cursor.X, $cursor.Y)) { throw 'Control panel covers the scroll target' }
        [DesktopInput]::mouse_event(2048, 0, 0, $request.delta, [UIntPtr]::Zero)
    }
}
if ($request.action -ne 'screenshot') {
    $settleUntil = [DateTime]::UtcNow.AddMilliseconds(350)
    while ([DateTime]::UtcNow -lt $settleUntil) {
        [System.Windows.Forms.Application]::DoEvents()
        [ControlOverlay]::Check()
        [System.Threading.Thread]::Sleep(10)
    }
    Invoke-DesktopAction ([pscustomobject]@{ action='screenshot' })
}
}
$owner = ''
$reader = [ControlOverlay]::ReadRequest()
try {
    while ($true) {
        [System.Windows.Forms.Application]::DoEvents()
        if ([ControlOverlay]::Granted -and ([DateTime]::UtcNow - [ControlOverlay]::LastAction).TotalMinutes -ge 2) { [ControlOverlay]::Revoke() }
        if (!$reader.IsCompleted) { [System.Threading.Thread]::Sleep(10); continue }
        $line = $reader.GetAwaiter().GetResult()
        if ($null -eq $line) { break }
        try {
            $envelope = $line | ConvertFrom-Json
            if ($owner -ne $envelope.owner) { [ControlOverlay]::Revoke(); $owner = $envelope.owner }
            if (![ControlOverlay]::Granted) {
                $answer = $shell.Popup('AIChat requests control of your primary screen. Screenshots will be shared with its model provider. Close private windows first. Use Take Back Control to stop. Permission expires after 2 idle minutes.', 20, 'Keepwork desktop permission', 1 + 48 + 4096)
                if ($answer -ne 1) { throw 'Desktop control denied' }
                [ControlOverlay]::Grant()
            }
            [ControlOverlay]::LastAction = [DateTime]::UtcNow
            $output = Invoke-DesktopAction $envelope.args
            [ControlOverlay]::Check()
            @{ ok=$true; output=[string]$output } | ConvertTo-Json -Compress | Write-Output
        } catch {
            [ControlOverlay]::Revoke()
            @{ ok=$false } | ConvertTo-Json -Compress | Write-Output
        }
        $reader = [ControlOverlay]::ReadRequest()
    }
} finally { [ControlOverlay]::Revoke() }
`;

export class ComputerController {
    private busy = false;
    constructor(private platform = process.platform, private execute = platform === 'darwin' ? executeMac : executeWindows) {}

    async run(input: unknown, owner = 'local') {
        const args = computerSchema.parse(input);
        if (args.action === 'status') return { content: [{ type: 'text' as const, text: JSON.stringify({ supported: this.platform === 'win32' || this.platform === 'darwin', platform: this.platform, experimental: this.platform === 'darwin', scope: 'primary-screen', permission: this.platform === 'darwin' ? 'native approval for EVERY action; no retained consent or reclaim panel; requires macOS Screen Recording, Accessibility and Automation permissions' : 'revocable native session consent; expires after 2 idle minutes', limitations: this.platform === 'darwin' ? ['no scroll or right-click', 'accessibility-based clicks may fail on custom UI', 'typing depends on application and keyboard support', 'screenshots normalized to screen points'] : [], unattended: false }) }] };
        if (this.platform !== 'win32' && this.platform !== 'darwin') throw new Error('Desktop control supports Windows and experimental macOS only');
        if (this.busy) throw new Error('Desktop is busy; no actions are queued');
        this.busy = true;
        try {
            const output = await this.execute(args, owner);
            if (output) {
                const shot = JSON.parse(output);
                return { content: [
                    { type: 'text' as const, text: JSON.stringify({ action: args.action, inputSent: args.action !== 'screenshot', width: shot.width, height: shot.height, capturedAt: new Date().toISOString(), warning: 'Unmasked primary desktop screenshot. Click coordinates use this image pixel grid, not normalized coordinates. If the image is displayed resized, scale coordinates to width/height. Input sent does not prove the intended UI action succeeded: inspect this image before the next action. If the UI is still loading, request another screenshot. Do not repeat ineffective clicks.' }) },
                    { type: 'image' as const, mimeType: 'image/jpeg', data: String(shot.data) },
                ] };
            }
            throw new Error('Desktop observation missing after action; inspect desktop before retrying');
        } finally { this.busy = false; }
    }
}

let desktopProcess: ChildProcessWithoutNullStreams | undefined;
let pending: { resolve: (output: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined;

function stopDesktop() {
    const child = desktopProcess;
    desktopProcess = undefined;
    child?.kill();
    if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Desktop action cancelled, timed out, or failed. Inspect the desktop before retrying.'));
        pending = undefined;
    }
}
process.once('exit', stopDesktop);

function executeWindows(args: ComputerArgs, owner: string): Promise<string> {
    return new Promise((resolve, reject) => {
        if (!desktopProcess) {
            const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', Buffer.from(helper, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' });
            desktopProcess = child;
            const fail = () => { if (desktopProcess === child) stopDesktop(); };
            child.on('error', fail);
            child.on('exit', fail);
            child.stdin.on('error', fail);
            child.stderr.on('data', fail);
            createInterface({ input: child.stdout }).on('line', line => {
                if (desktopProcess !== child || !pending) return;
                try {
                    if (line.length > 5 * 1024 * 1024) throw new Error('Oversized result');
                    const result = JSON.parse(line);
                    const action = pending;
                    clearTimeout(action.timer);
                    pending = undefined;
                    if (result.ok) action.resolve(result.output);
                    else action.reject(new Error('Desktop control denied or revoked; request permission again.'));
                } catch { fail(); }
            });
        }
        pending = { resolve, reject, timer: setTimeout(stopDesktop, 30000) };
        desktopProcess.stdin.write(JSON.stringify({ args, owner }) + '\n');
    });
}

export const computerController = new ComputerController();