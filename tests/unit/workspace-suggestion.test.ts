/**
 * deriveWorkspaceSuggestion(cwd) — turns a real working directory into the inputs
 * for suggestSessionName (beta.4, ADR 0012 Decision 3). Uses the git repo root
 * basename (if any) + the directory basename. Filesystem-touching but deterministic
 * against a temp dir.
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { deriveWorkspaceSuggestion } from '../../src/identity/project.js';
import { suggestSessionName } from '../../src/identity/session-name.js';

const dirs: string[] = [];
function tmp(prefix = 'xbus-ws-'): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } dirs.length = 0; });

describe('deriveWorkspaceSuggestion', () => {
  it('uses the git repo root basename when a .git dir is present', () => {
    const root = tmp();
    const repo = path.join(root, 'SeatMap-API');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const sub = path.join(repo, 'src', 'broker');
    fs.mkdirSync(sub, { recursive: true });
    const inp = deriveWorkspaceSuggestion(sub, { agentType: 'claude' });
    expect(inp.gitRepo).toBe('SeatMap-API');
    expect(inp.dirName).toBe('broker'); // the cwd basename
    expect(inp.agentType).toBe('claude');
    // and it yields a sensible suggestion (git repo wins)
    expect(suggestSessionName(inp)).toBe('seatmap-api');
  });

  it('falls back to the directory basename when there is no git repo', () => {
    const root = tmp();
    const proj = path.join(root, 'Payments Service');
    fs.mkdirSync(proj, { recursive: true });
    const inp = deriveWorkspaceSuggestion(proj, { agentType: 'claude' });
    expect(inp.gitRepo).toBeUndefined();
    expect(inp.dirName).toBe('Payments Service');
    expect(suggestSessionName(inp)).toBe('payments-service');
  });

  it('passes agentType + projectId through for the last-resort fallback', () => {
    const root = tmp();
    const weird = path.join(root, '@@@'); // dir basename sanitizes to nothing usable
    fs.mkdirSync(weird, { recursive: true });
    const inp = deriveWorkspaceSuggestion(weird, { agentType: 'codex', projectId: 'p1' });
    expect(inp.agentType).toBe('codex');
    expect(inp.projectId).toBe('p1');
    // git/dir unusable -> agentType-projectId fallback
    expect(suggestSessionName(inp)).toBe('codex-p1');
  });
});
