// The app's version, as in GesProd: a number that only goes up, the count of commits of the branch, read
// from git; with the commit it was built from. Run from the repository it is asked to git each time; an
// installed app carries the ones it was built with (package.json's `version` is then 0.0.<count> and
// `appCommit` the commit, set by .github/workflows/release.yml). Without either: «dev».
const { execFileSync } = require('node:child_process');

function fromGit(cwd) {
  const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  try { return { version: run(['rev-list', '--count', 'HEAD']), commit: run(['rev-parse', '--short', 'HEAD']) }; }
  catch { return null; }
}

/** `packageJson`: the app's package.json; `git`: how to ask git (a function returning {version, commit} or null). */
function appVersion({ isPackaged, packageJson = {}, git = () => null }) {
  if (isPackaged) {
    const count = /^0\.0\.(\d+)$/.exec(String(packageJson.version || ''));
    return { version: count ? count[1] : String(packageJson.version || 'dev'), commit: typeof packageJson.appCommit === 'string' ? packageJson.appCommit : '' };
  }
  return git() || { version: 'dev', commit: '' };
}

module.exports = { appVersion, fromGit };
