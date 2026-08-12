import * as path from 'node:path';

export interface KeepworkRepoRef {
    owner: string;
    repo: string;
    gitUrl: string;
}

export function parseKeepworkCloneUrl(keepworkUrl: string): KeepworkRepoRef {
    if (!keepworkUrl.startsWith('https://keepwork.com/')) {
        throw new Error('URL must start with https://keepwork.com/');
    }
    const url = new URL(keepworkUrl);
    const pathParts = url.pathname.split('/').filter(part => part.length > 0);
    if (pathParts.length < 2) {
        throw new Error('Invalid Keepwork URL. Expected format: https://keepwork.com/{owner}/{repo}/...');
    }
    const owner = pathParts[0];
    const repo = pathParts[1];
    return {
        owner,
        repo,
        gitUrl: `https://git.keepwork.com/${owner}/${repo}`,
    };
}

/** Build a keepwork.com URL from a workspace-relative path `{owner}/{repo}/...`. */
export function buildKeepworkOpenUrl(relativePath: string): string {
    const pathParts = relativePath.split(/[/\\]/).filter(Boolean);
    if (pathParts.length < 2) {
        throw new Error('Invalid path structure. Expected: {owner}/{repo}/...');
    }
    const owner = pathParts[0];
    const repo = pathParts[1];
    const filePath = pathParts.slice(2).join('/');
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.md') {
        const filePathWithoutExt = filePath.replace(/\.md$/i, '');
        return `https://keepwork.com/${owner}/${repo}/${filePathWithoutExt}`;
    }
    return `https://keepwork.com/api/raw/${owner}/${repo}/${filePath}`;
}
