/**
 * Beta.10 (Train B) — agent-management pure logic (agents.js static asset).
 * Pins the roster filter composition (search + status + control + collection), the control-action
 * surface, and the KNOWN-3 gate on remove_record. No DOM (the browser wiring is guarded on
 * typeof window; importing under vitest exercises only the exported pure functions).
 */
import { describe, it, expect } from 'vitest';
import {
  applyRosterFilter, CONTROL_ACTIONS, AGENTS_REMOVE_RECORD_ENABLED, receiveControlLabel, describeControlResult,
  postMutationStatus, sortRoster, hasActiveFilters, ROSTER_SORTS,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — plain JS static asset, intentionally untyped
} from '../../src/broker/dashboard/static/agents.js';
import {
  emptyState, createCollection, addMember,
  filterSessionsByCollection,
  // @ts-ignore — plain JS static asset
} from '../../src/broker/dashboard/static/collections.js';

type S = { sessionId: string; name?: string | null; project?: string; label?: string; receiveControl?: string; claudeTitle?: string | null };
const sessions: S[] = [
  { sessionId: 'aaaa1', name: 'seatmap-api', project: 'seatmap', label: 'active-ready', receiveControl: 'active', claudeTitle: 'Refactor seat pricing' },
  { sessionId: 'bbbb2', name: 'billing-svc', project: 'billing', label: 'dormant', receiveControl: 'paused', claudeTitle: null },
  { sessionId: 'cccc3', name: 'infra-bot', project: 'infra', label: 'active-ready', receiveControl: 'do_not_disturb', claudeTitle: null },
];

describe('applyRosterFilter — search/status/control composition', () => {
  it('no filters returns all', () => {
    expect(applyRosterFilter(sessions, {}).map((s: S) => s.sessionId)).toEqual(['aaaa1', 'bbbb2', 'cccc3']);
  });
  it('search matches name, project, id, and claude title (case-insensitive)', () => {
    expect(applyRosterFilter(sessions, { search: 'BILLING' }).map((s: S) => s.sessionId)).toEqual(['bbbb2']);
    expect(applyRosterFilter(sessions, { search: 'seat pricing' }).map((s: S) => s.sessionId)).toEqual(['aaaa1']); // via claudeTitle
    expect(applyRosterFilter(sessions, { search: 'cccc3' }).map((s: S) => s.sessionId)).toEqual(['cccc3']);
  });
  it('status filter narrows by label', () => {
    expect(applyRosterFilter(sessions, { status: 'active-ready' }).map((s: S) => s.sessionId)).toEqual(['aaaa1', 'cccc3']);
    expect(applyRosterFilter(sessions, { status: 'dormant' }).map((s: S) => s.sessionId)).toEqual(['bbbb2']);
  });
  it('receive-control filter narrows by control mode', () => {
    expect(applyRosterFilter(sessions, { control: 'paused' }).map((s: S) => s.sessionId)).toEqual(['bbbb2']);
    expect(applyRosterFilter(sessions, { control: 'do_not_disturb' }).map((s: S) => s.sessionId)).toEqual(['cccc3']);
  });
  it('filters compose (search AND status)', () => {
    expect(applyRosterFilter(sessions, { search: 'infra', status: 'active-ready' }).map((s: S) => s.sessionId)).toEqual(['cccc3']);
    expect(applyRosterFilter(sessions, { search: 'infra', status: 'dormant' })).toEqual([]);
  });
  it('collection selector filters via the Collections module', () => {
    let { state, collection } = createCollection(emptyState(), 'Backend');
    state = addMember(state, collection.id, 'aaaa1');
    state = addMember(state, collection.id, 'bbbb2');
    const deps = { collectionsApi: { filterSessionsByCollection }, collectionsState: state, collectionSelector: collection.id };
    expect(applyRosterFilter(sessions, deps).map((s: S) => s.sessionId)).toEqual(['aaaa1', 'bbbb2']);
    // 'ungrouped' returns the non-member.
    expect(applyRosterFilter(sessions, { ...deps, collectionSelector: 'ungrouped' }).map((s: S) => s.sessionId)).toEqual(['cccc3']);
  });
});

describe('control-action surface + KNOWN-3 gate', () => {
  it('exposes the six operator actions + toggles', () => {
    for (const a of ['rename_alias', 'set_control', 'pin', 'unpin', 'archive', 'unarchive', 'stop_managed', 'remove_record']) {
      expect(CONTROL_ACTIONS[a], `missing action ${a}`).toBeTruthy();
    }
  });
  it('remove_record is GATED (disabled) pending the Train-A broker fix', () => {
    expect(AGENTS_REMOVE_RECORD_ENABLED).toBe(false);
    expect(CONTROL_ACTIONS.remove_record.gated).toBe(true);
    expect(CONTROL_ACTIONS.remove_record.destructive).toBe(true);
    expect(CONTROL_ACTIONS.remove_record.confirm).toBe(true);
  });
  it('destructive non-gated actions require confirmation', () => {
    expect(CONTROL_ACTIONS.stop_managed.confirm).toBe(true);
    expect(CONTROL_ACTIONS.stop_managed.destructive).toBe(true);
  });
  it('receiveControlLabel renders human sentences for each mode', () => {
    expect(receiveControlLabel('active')).toMatch(/Active/);
    expect(receiveControlLabel('paused')).toMatch(/queue/i);
    expect(receiveControlLabel('do_not_disturb')).toMatch(/disturb/i);
    expect(receiveControlLabel('manual_checkpoint')).toMatch(/[Mm]anual/);
  });
});

describe('describeControlResult — honest, authoritative-result wording (esp. stop_managed)', () => {
  it('a stop that signalled a live process says so + names the pid', () => {
    const msg = describeControlResult('stop_managed', { stopped: true, killed: true, pid: 4242, killable: true });
    expect(msg).toMatch(/signalled/i);
    expect(msg).toContain('4242');
  });
  it('a stop with NO live handle is HONEST — markers cleared, no false kill claim', () => {
    const msg = describeControlResult('stop_managed', { stopped: true, killed: false, pid: 4242, killable: false });
    expect(msg).toMatch(/markers cleared/i);
    expect(msg).not.toMatch(/signalled/i);      // must NOT claim a kill that did not happen
    expect(msg).toMatch(/recycled|restarted|already exited/i); // explains WHY
  });
  it('a stop that cleared markers with no process (killable unknown) never claims a kill', () => {
    const msg = describeControlResult('stop_managed', { stopped: true, killed: false });
    expect(msg).toMatch(/markers cleared/i);
    expect(msg).not.toMatch(/signalled/i);
  });
  it('other actions render their expected confirmations', () => {
    expect(describeControlResult('rename_alias', { name: 'svc-x' })).toContain('svc-x');
    expect(describeControlResult('set_control', { mode: 'paused' })).toContain('paused');
    expect(describeControlResult('pin', {})).toMatch(/pinned/i);
    expect(describeControlResult('archive', {})).toMatch(/archived/i);
    expect(describeControlResult('remove_record', {})).toMatch(/transcript preserved/i);
  });
});

describe('postMutationStatus — DASH-1: never show unqualified success over stale state', () => {
  it('refresh succeeded → GREEN success with the authoritative-result wording, no retry', () => {
    const st = postMutationStatus('pin', { pinned: true }, { ok: true });
    expect(st.cls).toBe('ok');
    expect(st.message).toMatch(/pinned/i);
    expect(st.retry).toBe(false);
  });

  it('refresh FAILED → DOWNGRADE: committed-on-broker + could-not-refresh + retry (NOT unqualified success)', () => {
    const st = postMutationStatus('pin', { pinned: true }, { ok: false, status: 503 });
    expect(st.cls).not.toBe('ok');                 // must NOT be a green success
    expect(st.message).toMatch(/committed on the broker/i);
    expect(st.message).toMatch(/could not refresh/i);
    expect(st.message).toContain('503');           // surfaces the actual HTTP status
    expect(st.message).toMatch(/retry/i);
    expect(st.retry).toBe(true);                   // caller schedules a re-fetch
  });

  it('refresh failure with no status still downgrades honestly (never claims success)', () => {
    const st = postMutationStatus('archive', { archived: true }, { ok: false });
    expect(st.cls).not.toBe('ok');
    expect(st.retry).toBe(true);
    expect(st.message).not.toMatch(/^Archived\.$/); // not the bare success string
  });
});

describe('sortRoster — stable, pure roster ordering (pinned / attention / activity)', () => {
  // delivery.failed drives per-session attention; pinned drives pin-first; lastSeenSourceAt drives activity.
  const rows = [
    { sessionId: 'a', pinned: false, delivery: { failed: 0 }, lastSeenSourceAt: '2026-07-20T10:00:00Z' },
    { sessionId: 'b', pinned: true,  delivery: { failed: 0 }, lastSeenSourceAt: '2026-07-20T09:00:00Z' },
    { sessionId: 'c', pinned: false, delivery: { failed: 3 }, lastSeenSourceAt: '2026-07-20T11:00:00Z' },
    { sessionId: 'd', pinned: true,  delivery: { failed: 2 }, lastSeenSourceAt: '2026-07-20T08:00:00Z' },
  ];
  it('default preserves the incoming order (read-model order), never mutates input', () => {
    const copy = rows.slice();
    expect(sortRoster(rows, 'default').map((r: { sessionId: string }) => r.sessionId)).toEqual(['a', 'b', 'c', 'd']);
    expect(rows).toEqual(copy); // input untouched
  });
  it("'pinned' puts pinned agents first, preserving relative order within each group (stable)", () => {
    expect(sortRoster(rows, 'pinned').map((r: { sessionId: string }) => r.sessionId)).toEqual(['b', 'd', 'a', 'c']);
  });
  it("'attention' puts agents with failed deliveries first (stable within group)", () => {
    // c (3 failed) and d (2 failed) are the attention set, in original relative order → c, d, then a, b.
    expect(sortRoster(rows, 'attention').map((r: { sessionId: string }) => r.sessionId)).toEqual(['c', 'd', 'a', 'b']);
  });
  it("'activity' sorts by most-recent lastSeenSourceAt desc (nulls last)", () => {
    const withNull = rows.concat([{ sessionId: 'e', pinned: false, delivery: { failed: 0 }, lastSeenSourceAt: null }]);
    expect(sortRoster(withNull, 'activity').map((r: { sessionId: string }) => r.sessionId)).toEqual(['c', 'a', 'b', 'd', 'e']);
  });
  it('an unknown/absent mode falls back to default order', () => {
    expect(sortRoster(rows, 'bogus').map((r: { sessionId: string }) => r.sessionId)).toEqual(['a', 'b', 'c', 'd']);
    expect(sortRoster(rows).map((r: { sessionId: string }) => r.sessionId)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('ROSTER_SORTS advertises the selectable modes', () => {
    expect(ROSTER_SORTS.map((m: { value: string }) => m.value)).toEqual(
      expect.arrayContaining(['default', 'pinned', 'attention', 'activity']),
    );
  });
});

describe('hasActiveFilters — drives the clear-all affordance + empty-state wording', () => {
  it('false for the all-default filter state', () => {
    expect(hasActiveFilters({ search: '', status: 'all', control: 'all', collectionSelector: 'all' })).toBe(false);
  });
  it('true when any dimension is narrowed', () => {
    expect(hasActiveFilters({ search: 'x', status: 'all', control: 'all', collectionSelector: 'all' })).toBe(true);
    expect(hasActiveFilters({ search: '', status: 'dormant', control: 'all', collectionSelector: 'all' })).toBe(true);
    expect(hasActiveFilters({ search: '', status: 'all', control: 'paused', collectionSelector: 'all' })).toBe(true);
    expect(hasActiveFilters({ search: '', status: 'all', control: 'all', collectionSelector: 'ungrouped' })).toBe(true);
  });
  it('treats whitespace-only search as inactive', () => {
    expect(hasActiveFilters({ search: '   ', status: 'all', control: 'all', collectionSelector: 'all' })).toBe(false);
  });
});
