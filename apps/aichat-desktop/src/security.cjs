const ENTRY = 'https://keepwork.com/chat';
function trustedPage(value, developmentUrl = '') {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    const expected = new URL(developmentUrl || ENTRY);
    return url.origin === expected.origin && url.pathname === expected.pathname;
  } catch { return false; }
}
function assertSender(event, contents, developmentUrl = '') {
  if (!contents || contents.isDestroyed() || event.sender !== contents
      || event.senderFrame !== contents.mainFrame
      || !trustedPage(event.senderFrame?.url, developmentUrl)) {
    throw new Error('Untrusted desktop bridge caller');
  }
}
function externalUrl(value) {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
}
module.exports = { ENTRY, trustedPage, assertSender, externalUrl };
