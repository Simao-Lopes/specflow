// Disk store for pipelines. Each pipeline lives as a folder:
//
//   <repoRoot>/.specflow/pipelines/<slug>/
//     pipeline.json          # the pipeline STRUCT (name, description, steps
//                            #   with harness/method/iterations/verify — NO inline
//                            #   prompts here, they are separate .md files)
//     README.md              # human description
//     prompts/
//       <step-id>.md        # one editable prompt file per step (the verified
//                           #   prompt that is actually sent to the agent)
//       <step-id>--<verify-id>.md   # verify sub-agent prompts
//
// This makes pipeline structs AND prompts real files: git-versionable,
// editable in an editor, diffable. The SQLite DB stays the runtime source of
// truth; the folder is the durable, human-readable representation.

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function pipelinesRoot({ repoRoot }) {
  return resolve(repoRoot || './work', '.specflow', 'pipelines');
}

function slugify(name) {
  return String(name || 'pipeline').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'pipeline';
}

// Write one pipeline (with materialized prompts) to disk.
export function writePipelineToDisk(pipeline, { repoRoot }) {
  if (!pipeline || !pipeline.id) return;
  const dir = join(pipelinesRoot({ repoRoot }), `${pipeline.id}-${slugify(pipeline.name)}`);
  const promptsDir = join(dir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });

  // Struct WITHOUT prompts (they live in prompts/*.md). Keep steps skeleton
  // so the folder is self-describing, but trim prompts.
  const struct = {
    id: pipeline.id,
    name: pipeline.name,
    description: pipeline.description || '',
    updated_at: pipeline.updated_at,
    steps: (pipeline.steps || []).map((s) => {
      const { prompt: _p, verify: _v, ...stepOnly } = s;
      return {
        ...stepOnly,
        verify: (s.verify || []).map((v) => {
          const { prompt: _vp, ...vOnly } = v;
          return vOnly;
        }),
      };
    }),
  };
  writeFileSync(join(dir, 'pipeline.json'), JSON.stringify(struct, null, 2) + '\n');

  // One prompt .md per step (+ verify).
  for (const s of pipeline.steps || []) {
    const fname = `${s.id || s.name}.md`.replace(/[^a-zA-Z0-9._-]/g, '-');
    writeFileSync(join(promptsDir, fname), `# ${s.name || s.id} prompt\n\n${s.prompt || ''}\n`);
    for (const v of s.verify || []) {
      const vname = `${s.id || s.name}--${v.id || v.name}.md`.replace(/[^a-zA-Z0-9._-]/g, '-');
      writeFileSync(join(promptsDir, vname), `# ${s.name} / ${v.name} prompt\n\n${v.prompt || ''}\n`);
    }
  }
  return dir;
}

// Enumerate all pipeline folders on disk (id + name).
export function listPipelineFolders({ repoRoot }) {
  const root = pipelinesRoot({ repoRoot });
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ dir: join(root, d.name), name: d.name }));
  } catch { return []; }
}

// Rebuild all pipelines from disk (seed/restore). Returns array of {id,name,steps,description}
// with prompts read back from the .md files.
export function pipelinesFromDisk({ repoRoot }) {
  const out = [];
  for (const { dir } of listPipelineFolders({ repoRoot })) {
    const jsonPath = join(dir, 'pipeline.json');
    if (!existsSync(jsonPath)) continue;
    try {
      const struct = JSON.parse(readFileSync(jsonPath, 'utf8'));
      // Re-attach prompts from prompts/*.md keyed by step id (and name fallback).
      const promptsDir = join(dir, 'prompts');
      const readPrompt = (id, name) => {
        if (!existsSync(promptsDir)) return '';
        const fname = `${id || name}.md`.replace(/[^a-zA-Z0-9._-]/g, '-');
        const p = join(promptsDir, fname);
        if (!existsSync(p)) return '';
        const txt = readFileSync(p, 'utf8');
        // Strip the leading "# <name> prompt" line we added.
        return txt.replace(/^# .*?\n\n/, '').trimEnd();
      };
      const steps = (struct.steps || []).map((s) => ({
        ...s,
        prompt: readPrompt(s.id, s.name),
        verify: (s.verify || []).map((v) => ({ ...v, prompt: readPrompt(`${s.id}--${v.id}`, `${s.name}--${v.name}`) })),
      }));
      out.push({ id: struct.id, name: struct.name, description: struct.description || '', steps });
    } catch { /* skip corrupt folder */ }
  }
  return out;
}

// Delete a pipeline folder from disk.
export function deletePipelineFromDisk(pipelineId, { repoRoot }) {
  for (const { dir, name } of listPipelineFolders({ repoRoot })) {
    if (name.startsWith(`${pipelineId}-`)) rmSync(dir, { recursive: true, force: true });
  }
}