import { spawn } from 'node:child_process';
import * as path from 'node:path';

/** Open the directory itself, or select the file in its parent where supported. */
export async function revealInOs(abs: string, folder: boolean): Promise<void> {
    let command: string;
    let args: string[];
    if (process.platform === 'win32') {
        command = 'explorer.exe';
        args = folder ? [abs] : [`/select,${abs}`];
    } else if (process.platform === 'darwin') {
        command = 'open';
        args = folder ? [abs] : ['-R', abs];
    } else {
        command = 'xdg-open';
        args = [folder ? abs : path.dirname(abs)];
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', resolve);
    });
    child.unref();
}
