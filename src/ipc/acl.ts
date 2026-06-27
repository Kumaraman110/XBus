/**
 * Cross-platform restrictive permissions for sensitive runtime artifacts.
 *
 * Unix: chmod 0700 (dir) / 0600 (file).
 * Windows: a textual 0600 is a NO-OP — files INHERIT the parent dir's ACL. We
 * must explicitly remove inheritance and grant only the current user + SYSTEM via
 * `icacls /inheritance:r /grant:r`. Verified empirically (docs/evidence/windows-acl).
 *
 * This is defense-in-depth + accident-prevention against OTHER OS users — NOT a
 * sandbox against a malicious process running as the SAME fully-privileged user.
 */
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export interface HardenResult {
  applied: boolean;
  method: 'chmod' | 'icacls' | 'skipped';
  detail: string;
}

/** Harden a directory so only the current user (+ SYSTEM on Windows) can access it. */
export function hardenDir(dir: string): HardenResult {
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, 0o700);
    return { applied: true, method: 'chmod', detail: '0700' };
  }
  return icaclsRestrict(dir);
}

/** Harden a file so only the current user (+ SYSTEM on Windows) can read/write it. */
export function hardenFile(file: string): HardenResult {
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o600);
    return { applied: true, method: 'chmod', detail: '0600' };
  }
  return icaclsRestrict(file);
}

function icaclsRestrict(target: string): HardenResult {
  const user = os.userInfo().username;
  try {
    // /inheritance:r removes inherited ACEs; /grant:r replaces grants with only
    // these two principals. No Everyone / Authenticated Users / Administrators.
    execFileSync('icacls', [target, '/inheritance:r', '/grant:r', `${user}:F`, 'SYSTEM:F'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    return { applied: true, method: 'icacls', detail: `inheritance removed; granted ${user}+SYSTEM only` };
  } catch (e) {
    // Fail-closed signal to the caller: we could NOT guarantee the restriction.
    return { applied: false, method: 'icacls', detail: `icacls failed: ${(e as Error).message.slice(0, 120)}` };
  }
}

/**
 * Verify (read-only) that a Windows path's ACL grants no broad principals.
 * Returns the principals found. On Unix returns the mode. Used by tests + doctor.
 */
export function describeAcl(target: string): { platform: string; principals?: string[]; mode?: string; broadAccess: boolean } {
  if (process.platform !== 'win32') {
    const mode = (fs.statSync(target).mode & 0o777).toString(8);
    // group/other bits set => broad
    const m = fs.statSync(target).mode & 0o777;
    return { platform: 'posix', mode, broadAccess: (m & 0o077) !== 0 };
  }
  try {
    const out = execFileSync('icacls', [target], { encoding: 'utf8', windowsHide: true });
    // icacls output: first line is "<path> PRINCIPAL:(perms)"; continuation lines
    // are "<indent>PRINCIPAL:(perms)". Parse the ACE principals only.
    const lines = out.split(/\r?\n/);
    const principals: string[] = [];
    let broad = false;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i]!;
      if (i === 0) {
        // strip the leading path token (everything up to the first principal,
        // which contains a backslash + ':')
        const m = line.match(/(\S+\\[^:]+|[A-Za-z ]+):\([^)]*\)/);
        if (!m) continue;
        line = line.slice(line.indexOf(m[0]));
      }
      const trimmed = line.trim();
      if (!trimmed || /Successfully|Failed/.test(trimmed)) continue;
      // ACE looks like  PRINCIPAL:(flags)  — principal may contain DOMAIN\name.
      const ace = trimmed.match(/^(.+?):\(/);
      if (!ace) continue;
      const principal = ace[1]!.trim();
      const shortName = principal.replace(/^.*\\/, '');
      principals.push(shortName);
      // Broad = well-known multi-user groups. Match on the SID-name precisely so
      // a username like "...Users..." path fragment can't trip it.
      if (/^(Everyone|Authenticated Users|Users|BUILTIN\\Users|NT AUTHORITY\\Authenticated Users)$/i.test(principal) ||
          /^(Everyone|Authenticated Users|Users)$/i.test(shortName)) {
        broad = true;
      }
    }
    return { platform: 'win32', principals, broadAccess: broad };
  } catch (e) {
    return { platform: 'win32', broadAccess: true, principals: [`icacls-error:${(e as Error).message.slice(0, 60)}`] };
  }
}

/** Reject a path that is a symlink/junction/reparse point (where we expect a real dir/file). */
export function assertNotReparse(target: string): void {
  const st = fs.lstatSync(target);
  if (st.isSymbolicLink()) {
    throw new Error(`refusing to use a symlink/reparse point: ${target}`);
  }
}
