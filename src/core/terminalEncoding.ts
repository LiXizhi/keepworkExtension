/** Runtime defaults for PowerShell sessions owned by Keepwork, never model instructions.
 * Explicit -Encoding arguments still win. Do not change file-write defaults: existing
 * files may use a different encoding. No user profile or machine setting is modified.
 */
export const POWERSHELL_UTF8_INIT = [
    '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'",
    "$PSDefaultParameterValues['Select-String:Encoding'] = 'UTF8'",
].join('; ');

/** Keep the existing cmd grammar while making its console byte stream UTF-8. */
export function cmdUtf8Command(command: string): string {
    // cmd caches its redirected-output encoding at startup. Start the actual
    // command interpreter after changing the console code page.
    return `chcp 65001 >nul && "${process.env.ComSpec || 'cmd.exe'}" /d /s /c "${command}"`;
}
