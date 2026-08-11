// Git integration layer. Clones/opens a repo, checks out a feature branch,
// commits, and opens a PR via GitHub (never auto-merges).

import simpleGit from 'simple-git';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Octokit } from 'octokit';

export function parseRepoUrl(url) {
  // Accept https://github.com/owner/repo.git, git@..., or owner/repo
  const m = url.match(/(?:github\.com[/:]|^)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  return m ? { owner: m[1], name: m[2] } : null;
}

export function ensureCheckout(repoUrl, { repoRoot }) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error(`Cannot parse repo: ${repoUrl}`);
  const checkout = resolve(repoRoot, parsed.owner, parsed.name);
  mkdirSync(checkout, { recursive: true });

  if (!existsSync(join(checkout, '.git'))) {
    const git = simpleGit();
    git.clone(repoUrl, checkout);
  }
  return checkout;
}

export async function prepareBranch({ repoUrl, branch, base = 'main', repoRoot }) {
  const checkout = ensureCheckout(repoUrl, { repoRoot });
  const git = simpleGit(checkout);
  await git.fetch(['--all']);
  await git.checkout([base]);
  await git.pull(['origin', base]).catch(() => {});
  // Recreate branch cleanly if it exists
  try { await git.branch(['-D', branch]); } catch {}
  await git.checkoutLocalBranch(branch);
  return checkout;
}

export async function commitAndPush({ checkout, branch, message, repoUrl }) {
  const git = simpleGit(checkout);
  const status = await git.status();
  if (status.files.length === 0) {
    return { changed: false, message: 'No changes to commit' };
  }
  await git.add(['-A']);
  await git.commit(message);
  await git.push(['-u', 'origin', branch]);
  return { changed: true, commit: (await git.revparse(['HEAD'])) };
}

export async function openPullRequest({ repoUrl, branch, base = 'main', title, body }) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) return null;
  const ok = getOctokit();
  if (!ok) {
    // No token configured — return the compare URL so the PR can be opened manually
    return { url: `https://github.com/${parsed.owner}/${parsed.name}/compare/${base}...${branch}`, manual: true };
  }
  const resp = await ok.rest.pulls.create({
    owner : parsed.owner,
    repo  : parsed.name,
    title,
    head  : branch,
    base,
    body  : body || `SpecFlow implementation for \`${title}\``,
  });
  return { url: resp.data.html_url, number: resp.data.number, manual: false };
}

let _octokit = null;
function getOctokit() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  if (!_octokit) _octokit = new Octokit({ auth: token });
  return _octokit;
}