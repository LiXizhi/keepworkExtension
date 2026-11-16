// Read-only second phase. This never focuses, inserts, clears, or retries an edit.
((request) => {
  const operations = window.__keepworkComposerDeliveryV1;
  if (!(operations instanceof Map)) return -1;
  const record = operations.get(request.id);
  if (!record) return -1;
  if (!record.done) {
    record.accepted = window === window.top && document.hasFocus() && location.href === request.page &&
      Date.now() <= request.expires && typeof record.check === 'function' && record.check();
    record.done = true;
    delete record.check;
  }
  return record.accepted ? 1 : -1;
})
