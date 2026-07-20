/**
 * Beta.10 (Train B) — agent-management pure logic (agents.js static asset).
 * Pins the roster filter composition (search + status + control + collection), the control-action
 * surface, and the KNOWN-3 gate on remove_record. No DOM (the browser wiring is guarded on
 * typeof window; importing under vitest exercises only the exported pure functions).
 */
import { describe, it, expect } from 'vitest';
import {
  applyRosterFilter, CONTROL_ACTIONS, AGENTS_REMOVE_RECORD_ENABLED, receiveControlLabel,
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
