// Public display metadata only. Never return a native account object: it may
// acquire credential fields in a future provider version.
export function agentAccountDisplay(account: any) {
    if (!account || typeof account !== 'object') return undefined;
    const clean = (value: unknown) => typeof value === 'string'
        ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 254) : '';
    const email = clean(account.email);
    const username = clean(account.username);
    const name = clean(account.name);
    const type = ['apiKey', 'api_key'].includes(account.type) ? 'apiKey' : undefined;
    if (type) return { type };
    if (!email && !username && !name) return undefined;
    return { ...(email ? { email } : {}), ...(username ? { username } : {}),
        ...(name ? { name } : {}) };
}
