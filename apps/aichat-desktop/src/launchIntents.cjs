// External URLs are navigation intents only. Never pass URL data to native APIs.
const SCHEME = 'keepwork-secondbrain';
function parseLaunchUrl(value) {
  if (typeof value !== 'string') return null;
  const match = /^keepwork-secondbrain:\/\/(open|onboarding)\/?$/.exec(value);
  return match && match[0] === value ? match[1] : null;
}
class LaunchIntents {
  constructor() { this.pending = null; this.sequence = 0; }
  offer(kind) {
    if (!['onboarding', 'first-launch'].includes(kind)) return null;
    // Explicit onboarding supersedes the conditional first-launch offer.
    if (!this.pending || (kind === 'onboarding' && this.pending.kind === 'first-launch')) {
      this.pending = { id: String(++this.sequence), kind };
    }
    return this.peek();
  }
  peek() { return this.pending ? { ...this.pending } : null; }
  acknowledge(id) {
    if (typeof id !== 'string' || this.pending?.id !== id) return false;
    this.pending = null; return true;
  }
}
module.exports = { SCHEME, parseLaunchUrl, LaunchIntents };
