// Git integration layer. Each feature/job gets its OWN git worktree (an
// isolated checkout on its own branch), so concurrent jobs never clobber each
// other. Commits land on the feature branch; PRs are opened via GitHub
// (never auto-merged).

import simpleGit from 'simple-git';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Octokit } from 'octokit';

export function parseRepoUrl(url) {
  // Accept https://github.com/owner/repo.git, git@..., or owner/repo
  const m = url.match(/(?:github\.com[/:]|^)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  return m ? { owner: m[1], name: m[2] } : null;
}

// A safe filesystem slug from a branch (used to build the worktree dir).
export function slugify(s) {
  return String(s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'feature';
}

// Path of the per-branch worktree for a job. Unique per (repo, branch).
export function worktreePath(repoUrl, branch, { repoRoot }) {
  const parsed = parseRepoUrl(repoUrl);
  const slug = slugify(branch);
  const base = parsed ? `${parsed.owner}__${parsed.name}` : Buffer.from(repoUrl).toString('hex').slice(0, 12);
  return resolve(repoRoot, '_worktrees', `${base}__${slug}`);
}

// Ensure the base (shared) clone exists. Used only as the source for worktrees.
export async function ensureBaseRepo(repoUrl, { repoRoot }) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error(`Cannot parse repo: ${repoUrl}`);
  const main = resolve(repoRoot, parsed.owner, parsed.name);
  mkdirSync(main, { recursive: true });
  if (!existsSync(join(main, '.git'))) {
    await simpleGit().clone(repoUrl, main);
  }
  return main;
}

// Create (or reuse) an isolated worktree for a branch, synced to origin/base.
// Returns the worktree path. Call on a FRESH run / retry; on a gate resume you
// pass reuse=true to keep the existing worktree (don't reset away the work).
export async function prepareWorktree({ repoUrl, branch, base = 'main', repoRoot, reuse = false }) {
  const main = await ensureBaseRepo(repoUrl, { repoRoot });
  const git = simpleGit(main);
  await git.fetch(['--all']);

  const wt = worktreePath(repoUrl, branch, { repoRoot });
  const registered = existsSync(join(wt, '.git'));

  if (!registered) {
    // Add a new worktree with its own branch, based on origin/<base>.
    // simple-git has no .worktree() in v3 — use raw git.
    await git.raw(['worktree', 'add', '-b', branch, wt, `origin/${base}`]).catch(async () => {
      try {
        await git.raw(['worktree', 'add', wt, branch]); // branch may already exist
      } catch (e2) {
        try { await git.raw(['branch', '-D', branch]); } catch {}
        await git.raw(['worktree', 'add', '-b', branch, wt, `origin/${base}`]);
      }
    });
  }

  const wgit = simpleGit(wt);
  if (!reuse) {
    // Fresh run: reset to a clean base so we don't carry stale state.
    await wgit.fetch(['--all']);
    try { await wgit.reset(['--hard', `origin/${base}`]); } catch {}
    try { await wgit.clean(['-fd', '.specflow', '.specflow_prompt.md']); } catch {}
  }
  return wt;
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
