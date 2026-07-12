/**
 * Metadata-only session IMPORT (beta.5 Phase 1; ADR 0013 D5 / ADR 0020 Q1).
 *
 * On install/first-broker-start, enumerate the Claude projects transcript directory
 * (`~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`) to surface previously-existing
 * sessions as **dormant** rows — known identity (session_id, cwd-slug, last-seen from file
 * mtime), but NOT connected, NOT routable, NOT counted active.
 *
 * HONESTY CONTRACT (ADR 0020 Q1): this relies on Claude's INTERNAL, UNDOCUMENTED on-disk
 * layout, so it is explicitly non-authoritative — `identify_confidence='listing_only'`.
 * We only `stat` filenames; we NEVER open or parse a transcript body. If the layout
 * changes, import degrades to empty — it never blocks the broker and never misroutes
 * (dormant is unroutable). A dormant row becomes active only on a real SessionStart
 * `resume` signal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** One imported session candidate — metadata only, gathered WITHOUT opening the file. */
export interface ImportedSessionMeta {
  sessionId: string;      // the .jsonl filename stem (must be a UUID)
  projectSlug: string;    // the parent directory name (Claude's cwd-slug encoding)
  transcriptPath: string; // absolute path to the .jsonl (a documented SessionStart input shape)
  lastSeenMs: number;     // file mtime (ms) — last-seen proxy; we do NOT read contents
}

/** The Claude projects transcript root (`~/.claude/projects`), overridable for tests. */
export function defaultProjectsDir(): string {
  return process.env.XBUS_CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Scan the projects dir for `<slug>/<uuid>.jsonl` files, returning metadata gathered ONLY
 * from `readdirSync` + `statSync` — NO file contents are read (a spy test asserts
 * readFile/open are never called). Robust to a missing dir, permission errors, and
 * non-conforming names: it skips them and returns whatever it could list. Bounded by
 * `maxFiles` so a pathological directory can't make startup scan unboundedly.
 */
export function scanTranscripts(projectsDir: string = defaultProjectsDir(), opts: { maxFiles?: number } = {}): ImportedSessionMeta[] {
  const maxFiles = opts.maxFiles ?? 5000;
  const out: ImportedSessionMeta[] = [];
  let slugs: string[];
  try {
    slugs = fs.readdirSync(projectsDir);
  } catch {
    return out; // dir absent / unreadable → nothing to import (never throws)
  }
  for (const slug of slugs) {
    if (out.length >= maxFiles) break;
    const slugDir = path.join(projectsDir, slug);
    let entries: fs.Dirent[];
    try {
      const st = fs.statSync(slugDir);
      if (!st.isDirectory()) continue;
      entries = fs.readdirSync(slugDir, { withFileTypes: true });
    } catch {
      continue; // unreadable slug dir → skip
    }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const stem = e.name.slice(0, -'.jsonl'.length);
      if (!UUID_RE.test(stem)) continue; // only real session UUIDs
      const full = path.join(slugDir, e.name);
      let mtimeMs: number;
      try {
        // stat ONLY — filename + mtime. The body is never opened (honesty contract).
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      out.push({ sessionId: stem, projectSlug: slug, transcriptPath: full, lastSeenMs: mtimeMs });
    }
  }
  return out;
}
