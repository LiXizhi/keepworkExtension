const { execFileSync } = require('node:child_process');
function git(source, args) {
  try {
    return execFileSync('git', ['-C', source, ...args], {
      encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch { throw Error(`Cannot verify AIChat freshness (git ${args[0]} failed). Packaged runtime left unchanged.`); }
}
function sourceRevision(source) {
  return {
    commit: git(source, ['rev-parse', 'HEAD']),
    dirty: !!git(source, ['status', '--porcelain', '--untracked-files=all', '--', '.']),
  };
}
function assertAncestor(source, older, newer, label) {
  try { git(source, ['merge-base', '--is-ancestor', older, newer]); }
  catch { throw Error(`${label}. Update AIChat safely before syncing; packaged runtime left unchanged.`); }
}
function verifyFreshness({ source, previous, changed }) {
  const revision = sourceRevision(source);
  // Identical bytes cannot downgrade the copy. Record provenance without requiring
  // network access for every watch rebuild or offline build of unchanged code.
  if (!changed) {
    // Equal bytes never erase a known committed baseline, even on an older branch.
    if (previous?.sourceRevision && !previous.sourceRevision.dirty) return previous.sourceRevision;
    return revision;
  }
  if (revision.dirty) throw Error('AIChat runtime has uncommitted changes. Commit the reviewed runtime before replacing the packaged copy.');
  if (previous && (!previous.sourceRevision || previous.sourceRevision.dirty)) {
    throw Error('Packaged runtime has no committed source provenance. Restore matching AIChat bytes and sync after committing them before replacing this copy.');
  }
  const branch = git(source, ['symbolic-ref', '--short', 'HEAD']);
  const remote = git(source, ['config', '--get', `branch.${branch}.remote`]);
  const merge = git(source, ['config', '--get', `branch.${branch}.merge`]);
  if (!remote || remote === '.' || !merge.startsWith('refs/heads/')) throw Error('AIChat needs a remote tracking branch before runtime replacement.');
  // Fetch only; never reset, checkout, merge, stash or modify the source worktree.
  git(source, ['fetch', '--no-tags', remote, merge]);
  const upstream = git(source, ['rev-parse', 'FETCH_HEAD']);
  assertAncestor(source, upstream, revision.commit, 'AIChat is behind or diverged from its freshly fetched upstream');
  if (previous) assertAncestor(source, previous.sourceRevision.commit, revision.commit, 'AIChat predates or diverges from the packaged source revision');
  const after = sourceRevision(source);
  if (after.commit !== revision.commit || after.dirty) throw Error('AIChat changed during freshness verification; retry sync.');
  return revision;
}
module.exports = { verifyFreshness };
