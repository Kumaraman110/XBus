/* XBus dashboard — Agent management (beta.10, Train B). Vertical slice: roster filtering +
 * Collections + a detail inspector with server-authorized, audited operator actions.
 *
 * DESIGN (capability-correctness first):
 *  - Every action calls the authenticated write API via window.XBusApi.post (POST
 *    /api/session/:id/control). The BROKER authorizes + audits + returns authoritative state;
 *    the browser NEVER stamps an actor and NEVER mutates local state as if it were the source
 *    of truth. After each action we re-fetch (window.XBusApi.refresh) so what the operator sees
 *    equals what the broker committed — surviving refresh/restart (the release gate).
 *  - Every action shows pending → success/failure. A failure surfaces the broker's actionable
 *    message (status + error/message), never a generic "something went wrong".
 *  - Destructive ops (remove record) require an explicit typed confirmation.
 *  - remove_record is GATED DISABLED pending the Train-A KNOWN-3 broker fix (a remove over the
 *    current primitive orphans name_ownership + physical_session_map → state would contradict the
 *    broker after restart). The control is VISIBLE but disabled with an explicit reason — never
 *    fires the corrupting action. Flip AGENTS_REMOVE_RECORD_ENABLED to true once KNOWN-3 lands.
 *  - Collections are LOCAL, non-routable roster grouping (window.XBusCollections). No routing.
 *
 * CSP-safe (script-src 'self', no inline). ES module; pure helpers are exported for unit tests,
 * and the browser API is published on window.XBusAgents.
 */
'use strict';

/* eslint-disable no-undef */

/** KNOWN-3 gate: remove_record stays disabled until Train A ships the map-invalidation helper. */
export const AGENTS_REMOVE_RECORD_ENABLED = false;

/** The operator control actions, with UI labels + the confirm/authorization policy. Pure data so
 *  a test can assert the surface without a DOM. `state`-shaped actions are toggles (pin/archive). */
export const CONTROL_ACTIONS = Object.freeze({
  rename_alias: { label: 'Rename', needsInput: true, destructive: false },
  set_control: { label: 'Receive control', needsInput: true, destructive: false },
  pin: { label: 'Pin', destructive: false },
  unpin: { label: 'Unpin', destructive: false },
  archive: { label: 'Archive', destructive: false },
  unarchive: { label: 'Unarchive', destructive: false },
  stop_managed: { label: 'Stop session', destructive: true, confirm: true },
  remove_record: { label: 'Remove record', destructive: true, confirm: true, gated: !AGENTS_REMOVE_RECORD_ENABLED },
});

/** Human sentence for a receive-control mode (used in the inspector). */
export function receiveControlLabel(mode) {
  switch (mode) {
    case 'paused': return 'Paused (messages queue)';
    case 'do_not_disturb': return 'Do not disturb';
    case 'manual_checkpoint': return 'Manual checkpoint only';
    default: return 'Active';
  }
}

/**
 * PURE roster filter used by app.js's renderSessions. Applies (in order): a case-insensitive
 * text search over name/project/id/claudeTitle; a status filter (label); a receive-control
 * filter; and the selected Collection. Returns a NEW array; never mutates. `deps` injects the
 * current filter state + collections state so this is unit-testable with no DOM.
 */
export function applyRosterFilter(sessions, deps) {
  const list = Array.isArray(sessions) ? sessions : [];
  const q = (deps.search || '').trim().toLowerCase();
  const status = deps.status || 'all';
  const control = deps.control || 'all';
  let out = list;
  if (q) {
    out = out.filter((s) => {
      const hay = [s.name, s.project, s.sessionId, s.claudeTitle].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  if (status !== 'all') out = out.filter((s) => s.label === status);
  if (control !== 'all') out = out.filter((s) => (s.receiveControl || 'active') === control);
  // Collection filter delegates to the Collections module (LOCAL grouping).
  if (deps.collectionSelector && deps.collectionSelector !== 'all' && deps.collectionsApi) {
    out = deps.collectionsApi.filterSessionsByCollection(out, deps.collectionsState, deps.collectionSelector);
  }
  return out.slice();
}

/**
 * Human, HONEST success message for a control action's authoritative broker result. Pure +
 * exported so the stop_managed honesty is unit-testable: a stop that signalled a live process
 * says so; a stop that could only clear markers (no live handle — recycled-pid safety) says THAT
 * instead of falsely claiming a kill.
 */
export function describeControlResult(action, body) {
  const b = body || {};
  switch (action) {
    case 'rename_alias': return 'Renamed to “' + (b.name || '?') + '”.';
    case 'set_control': return 'Receive control set to ' + (b.mode || '?') + '.';
    case 'pin': return 'Pinned.';
    case 'unpin': return 'Unpinned.';
    case 'archive': return 'Archived.';
    case 'unarchive': return 'Unarchived.';
    case 'stop_managed':
      if (b.killed) return 'Managed session stopped (process signalled, pid ' + (b.pid != null ? b.pid : '?') + ').';
      // Not killed: be honest about WHY — either no live handle (markers cleared only) or a
      // successful clear with no process to signal. Never claim a kill that did not happen.
      return b.killable === false
        ? 'Managed markers cleared. No live handle to signal — the process may have already exited, or the broker restarted since launch (xbus will not signal a possibly-recycled pid).'
        : 'Managed markers cleared (no live process to stop).';
    case 'remove_record': return 'Record removed (transcript preserved).';
    default: return 'Done.';
  }
}

/**
 * DASH-1 (Adversarial MINOR, G3): compute the inspector status AFTER a mutation, given the
 * authoritative broker result AND whether the subsequent authoritative-state refresh succeeded.
 * The action already committed on the broker (the POST returned ok); the ONLY question is whether
 * the view could re-read fresh state. If the refresh succeeded → GREEN success. If it FAILED (e.g.
 * /api/sessions 503 read_unavailable off-loop, or max-streams) → DOWNGRADE: never show an
 * unqualified "Pinned."/"Archived." over stale pre-mutation state — say it committed on the broker
 * but the view could not refresh, surface the HTTP status, and signal a retry. Pure + exported.
 * `refreshResult` = { ok:boolean, status?:number }.
 */
export function postMutationStatus(action, resultBody, refreshResult) {
  const rr = refreshResult || { ok: false };
  if (rr.ok) return { message: describeControlResult(action, resultBody), cls: 'ok', retry: false };
  const httpX = rr.status ? ('HTTP ' + rr.status) : 'connection lost';
  return {
    message: describeControlResult(action, resultBody).replace(/\.$/, '')
      + ' — committed on the broker, but the view could not refresh (' + httpX + '); retrying…',
    cls: 'pending',
    retry: true,
  };
}

/* ─────────────────────────────── browser wiring ─────────────────────────────── */

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const C = window.XBusCollections; // Collections module (roster grouping)
  const filterState = { search: '', status: 'all', control: 'all', collectionSelector: 'all' };
  // Persistence backend (WS3 cutover seam): default to localStorage; AUTOMATICALLY switches to the
  // broker DB (makeServerStore) at init() the instant the capability probe finds GET/POST
  // /api/collections. No manual flip needed — the probe drives it; localStorage stays until then.
  let collectionsStore = C ? C.makeLocalStorageStore(window.localStorage) : null;
  let collectionsState = C ? C.emptyState() : null; // hydrated async at init() via the store
  let caps = window.XBusCaps ? window.XBusCaps.emptyCaps() : { health: false, redeliver: false, instances: false, collectionsServer: false };
  let inspectorSessionId = null; // the session currently open in the inspector (persist across refresh)

  // Persist through the swappable store (async). Best-effort: a failure never throws here; the
  // in-memory state stays authoritative for this tab until the next successful save/reload.
  function persistCollections() { if (collectionsStore) return collectionsStore.save(collectionsState); return Promise.resolve(false); }
  function sessions() { return window.__sessions || []; }
  function findSession(id) { return sessions().find((s) => s.sessionId === id) || null; }

  /* ---- roster filter (consumed by app.js renderSessions) ---- */
  function rosterFilter(list) {
    return applyRosterFilter(list, {
      ...filterState,
      collectionsApi: C, collectionsState,
    });
  }

  /* ---- toolbar (search + status + control + collection selector + manage collections) ---- */
  function buildToolbar() {
    const host = document.getElementById('roster-toolbar');
    if (!host) return;
    host.replaceChildren();

    const search = document.createElement('input');
    search.type = 'search'; search.id = 'roster-search'; search.className = 'roster-search';
    search.placeholder = 'Search agents…'; search.setAttribute('aria-label', 'Search agents');
    search.value = filterState.search;
    search.addEventListener('input', () => { filterState.search = search.value; window.XBusApi.rerender(); });
    host.appendChild(search);

    const statusSel = mkSelect('roster-status', 'Filter by status', [
      ['all', 'All statuses'], ['active-ready', 'Ready'], ['active-starting', 'Starting'],
      ['active-disconnected', 'Disconnected'], ['dormant', 'Dormant'], ['unmanaged', 'Unmanaged'], ['expired', 'Expired'],
    ], filterState.status, (v) => { filterState.status = v; window.XBusApi.rerender(); });
    host.appendChild(statusSel);

    const ctrlSel = mkSelect('roster-control', 'Filter by receive control', [
      ['all', 'All controls'], ['active', 'Active'], ['paused', 'Paused'], ['do_not_disturb', 'Do not disturb'], ['manual_checkpoint', 'Manual'],
    ], filterState.control, (v) => { filterState.control = v; window.XBusApi.rerender(); });
    host.appendChild(ctrlSel);

    if (C) {
      const opts = [['all', 'All collections'], ['ungrouped', 'Ungrouped']]
        .concat(collectionsState.collections.map((c) => [c.id, c.name]));
      const colSel = mkSelect('roster-collection', 'Filter by collection', opts, filterState.collectionSelector, (v) => { filterState.collectionSelector = v; window.XBusApi.rerender(); });
      host.appendChild(colSel);

      const manageBtn = el('button', 'secondary', 'Collections…');
      manageBtn.type = 'button'; manageBtn.id = 'manage-collections-btn';
      manageBtn.addEventListener('click', openCollectionsManager);
      host.appendChild(manageBtn);
    }
  }

  function mkSelect(id, aria, opts, value, onChange) {
    const sel = document.createElement('select'); sel.id = id; sel.className = 'roster-filter'; sel.setAttribute('aria-label', aria);
    for (const [v, label] of opts) { const o = document.createElement('option'); o.value = v; o.appendChild(document.createTextNode(label)); sel.appendChild(o); }
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  /* ---- Collections manager (create / rename / delete) ---- */
  function openCollectionsManager() {
    const body = el('div', 'coll-manager');
    const add = el('div', 'coll-add');
    const input = document.createElement('input'); input.type = 'text'; input.placeholder = 'New collection name'; input.setAttribute('aria-label', 'New collection name'); input.maxLength = 60;
    const addBtn = el('button', 'primary', 'Add'); addBtn.type = 'button';
    addBtn.addEventListener('click', () => {
      const r = C.createCollection(collectionsState, input.value);
      if (!r.collection) return;
      collectionsState = r.state; persistCollections(); input.value = '';
      renderCollList(); rebuildToolbarPreserving();
    });
    add.appendChild(input); add.appendChild(addBtn); body.appendChild(add);

    const listEl = el('ul', 'coll-list'); listEl.id = 'coll-list'; body.appendChild(listEl);
    function renderCollList() {
      listEl.replaceChildren();
      if (!collectionsState.collections.length) { listEl.appendChild(el('li', 'muted', 'No collections yet.')); return; }
      for (const c of collectionsState.collections) {
        const li = document.createElement('li');
        const nm = el('span', 'coll-name', c.name); li.appendChild(nm);
        const ren = el('button', 'link-btn', 'Rename'); ren.type = 'button';
        ren.addEventListener('click', () => {
          const next = window.prompt('Rename collection', c.name);
          if (next == null) return;
          collectionsState = C.renameCollection(collectionsState, c.id, next); persistCollections();
          renderCollList(); rebuildToolbarPreserving();
        });
        const del = el('button', 'link-btn danger', 'Delete'); del.type = 'button';
        del.addEventListener('click', () => {
          if (!window.confirm(`Delete collection "${c.name}"? Agents are not affected; only the grouping is removed.`)) return;
          collectionsState = C.deleteCollection(collectionsState, c.id); persistCollections();
          if (filterState.collectionSelector === c.id) filterState.collectionSelector = 'all';
          renderCollList(); rebuildToolbarPreserving(); window.XBusApi.rerender();
        });
        li.appendChild(ren); li.appendChild(del); listEl.appendChild(li);
      }
    }
    renderCollList();
    openModal('Collections', body);
  }

  function rebuildToolbarPreserving() { buildToolbar(); }

  /* ---- inspector ---- */
  function openInspector(sessionId) {
    inspectorSessionId = sessionId;
    renderInspector();
  }

  function renderInspector() {
    const panel = document.getElementById('inspector');
    if (!panel) return;
    const s = findSession(inspectorSessionId);
    if (!inspectorSessionId || !s) { panel.hidden = true; panel.replaceChildren(); return; }
    panel.hidden = false;
    panel.replaceChildren();

    // Header: name + close.
    const head = el('div', 'insp-head');
    head.appendChild(el('h3', 'insp-title', s.name || s.sessionId.slice(0, 8)));
    const close = el('button', 'link-btn insp-close', 'Close'); close.type = 'button';
    close.setAttribute('aria-label', 'Close inspector');
    close.addEventListener('click', () => { inspectorSessionId = null; renderInspector(); });
    head.appendChild(close);
    panel.appendChild(head);

    // Identity + runtime facts.
    const facts = el('div', 'insp-facts');
    const fact = (k, v) => { const d = el('div', 'insp-fact'); d.appendChild(el('span', 'insp-k', k)); d.appendChild(el('span', 'insp-v', v == null ? '—' : String(v))); facts.appendChild(d); };
    fact('Status', (window.XBusFriendlyStatus && window.XBusFriendlyStatus(s.label)) || s.label);
    fact('Session id', s.sessionId);
    fact('Logical identity', s.logicalIdentityId || s.sessionId);
    fact('Physical instances', s.physicalInstances);
    fact('Handle (xbus name)', s.name || '(unnamed)');
    fact('Claude title', s.claudeTitle || '—');
    fact('Project', s.project);
    fact('Runtime', s.connection + ' / ' + s.readiness + ' · ' + s.managementState);
    fact('Delivery capability', s.routable ? 'Routable (accepts injection)' : 'Not routable now');
    fact('Receive control', receiveControlLabel(s.receiveControl));
    fact('Lifecycle', `${s.pinned ? 'pinned' : 'not pinned'} · ${s.archived ? 'archived' : 'not archived'}${s.managed ? ' · managed by xbus' : ''}`);
    // Managed-session HONESTY: show the recorded pid so the operator knows exactly what a Stop
    // would target, and that a stale record (no live broker handle) can only clear markers.
    if (s.managed) fact('Managed process', s.managedPid != null ? ('pid ' + s.managedPid + ' (recorded)') : 'no recorded pid');
    panel.appendChild(facts);

    // Failures + pending work — PROMINENT block (not a muted fact line). Surfaces what needs
    // attention for this agent: queued (awaiting checkpoint), delivered (injected, unacked),
    // failed (delivery errors). Failed is emphasized when non-zero.
    panel.appendChild(buildWorkPanel(s));

    // #2 instance history (pre-staged, WS1): renders ONLY when the session projection carries
    // instances[] (i.e. after WS1 ships it on /api/session/:id). Pre-WS1 → empty → nothing renders.
    const instHost = buildInstanceHistory(s);
    if (instHost) panel.appendChild(instHost);

    // Collections membership (local grouping).
    if (C) panel.appendChild(buildCollectionsChips(s));

    // Actions.
    panel.appendChild(buildActions(s));

    // Action status line (pending/success/failure).
    const status = el('div', 'insp-status'); status.id = 'insp-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    panel.appendChild(status);
  }

  /**
   * Prominent work/failures panel for the inspected agent. Renders the delivery breakdown as
   * labeled tiles (queued / injected / acknowledged / replied / failed) with the FAILED tile
   * emphasized when non-zero, plus an at-a-glance "needs attention" line. Values come straight
   * from the authenticated session projection (s.delivery) — no client-invented state.
   */
  function buildWorkPanel(s) {
    const d = s.delivery || { queued: 0, delivered: 0, acknowledged: 0, replied: 0, failed: 0 };
    const wrap = el('div', 'insp-work');
    const head = el('div', 'insp-work-head');
    head.appendChild(el('span', 'insp-k', 'Work'));
    const failed = d.failed || 0;
    const pending = (d.queued || 0) + (d.delivered || 0);
    // A concise attention summary: failures first (they need action), then pending (in-flight).
    const summary = failed > 0
      ? el('span', 'insp-work-attn err', failed + (failed === 1 ? ' failed delivery' : ' failed deliveries') + ' — needs attention')
      : pending > 0
        ? el('span', 'insp-work-attn', pending + ' in flight (' + (d.queued || 0) + ' queued · ' + (d.delivered || 0) + ' unacked)')
        : el('span', 'insp-work-attn ok', 'No pending or failed work');
    head.appendChild(summary);
    wrap.appendChild(head);
    const tiles = el('div', 'insp-work-tiles');
    const tile = (label, n, state) => {
      const t = el('div', 'work-tile work-' + state + (n ? '' : ' work-zero') + (state === 'failed' && n ? ' work-alert' : ''));
      t.appendChild(el('span', 'work-n', String(n || 0)));
      t.appendChild(el('span', 'work-l', label));
      tiles.appendChild(t);
    };
    tile('Queued', d.queued, 'queued');
    tile('Injected', d.delivered, 'delivered');
    tile('Acked', d.acknowledged, 'ack');
    tile('Replied', d.replied, 'replied');
    tile('Failed', d.failed, 'failed');
    wrap.appendChild(tiles);
    return wrap;
  }

  /**
   * #2 (pre-staged, WS1): instance history for the inspected agent — current + past runtime
   * instances (role/state/pid/connected/last-seen), current-first. Returns null when the session
   * projection carries NO instances[] (pre-WS1) so nothing renders — respecting the zero-dead-control
   * gate. Physical/epoch stay diagnostics-only (not shown here). Pure render over prestage rows.
   */
  function buildInstanceHistory(s) {
    if (!window.XBusPrestage) return null;
    const rows = window.XBusPrestage.instanceHistoryRows(s);
    if (!rows.length) return null; // pre-WS1: no instances[] on the projection → render nothing
    const wrap = el('div', 'insp-instances');
    wrap.appendChild(el('span', 'insp-k', 'Instances'));
    const list = el('div', 'inst-list');
    for (const r of rows) {
      const row = el('div', 'inst-row' + (r.current ? ' inst-current' : ''));
      row.appendChild(el('span', 'inst-role', r.role));
      row.appendChild(el('span', 'inst-state state-inst-' + r.state, r.state));
      row.appendChild(el('span', 'inst-pid', r.pid != null ? ('pid ' + r.pid) : '—'));
      const when = r.current ? ('since ' + hhmmssSafe(r.connectedAt)) : (hhmmssSafe(r.connectedAt) + '–' + hhmmssSafe(r.disconnectedAt));
      const w = el('span', 'inst-when', when); if (r.lastSeenAt) w.title = 'last seen ' + r.lastSeenAt;
      row.appendChild(w);
      if (r.current) row.appendChild(el('span', 'inst-badge', 'current'));
      list.appendChild(row);
    }
    wrap.appendChild(list);
    return wrap;
  }

  /** hh:mm:ss slice of an ISO instant, or '—'. (Local mirror; app.js hhmmss isn't module-scoped here.) */
  function hhmmssSafe(iso) { return iso ? String(iso).slice(11, 19) : '—'; }

  function buildCollectionsChips(s) {
    const wrap = el('div', 'insp-collections');
    wrap.appendChild(el('span', 'insp-k', 'Collections'));
    const chips = el('div', 'chips');
    const memberOf = new Set(C.collectionsForSession(collectionsState, s.sessionId));
    if (!collectionsState.collections.length) chips.appendChild(el('span', 'muted', 'None defined — add some via “Collections…”.'));
    for (const c of collectionsState.collections) {
      const on = memberOf.has(c.id);
      const chip = el('button', 'chip chip-toggle' + (on ? ' on' : ''), (on ? '✓ ' : '+ ') + c.name);
      chip.type = 'button'; chip.setAttribute('aria-pressed', String(on));
      chip.addEventListener('click', () => {
        collectionsState = on ? C.removeMember(collectionsState, c.id, s.sessionId) : C.addMember(collectionsState, c.id, s.sessionId);
        persistCollections(); renderInspector(); window.XBusApi.rerender();
      });
      chips.appendChild(chip);
    }
    wrap.appendChild(chips);
    return wrap;
  }

  function buildActions(s) {
    const wrap = el('div', 'insp-actions');

    // Rename.
    wrap.appendChild(actionButton('Rename', false, async () => {
      const next = window.prompt('New xbus name (routable handle) for this agent', s.name || '');
      if (next == null || !next.trim()) return;
      await runControl(s.sessionId, { action: 'rename_alias', name: next.trim() }, `Renaming to “${next.trim()}”…`);
    }));

    // Receive control (pause / DND / manual / active).
    const ctrlSel = document.createElement('select'); ctrlSel.className = 'insp-control-select'; ctrlSel.setAttribute('aria-label', 'Set receive control');
    for (const [v, label] of [['active', 'Active'], ['paused', 'Pause'], ['do_not_disturb', 'Do not disturb'], ['manual_checkpoint', 'Manual checkpoint']]) {
      const o = document.createElement('option'); o.value = v; o.appendChild(document.createTextNode(label)); ctrlSel.appendChild(o);
    }
    ctrlSel.value = s.receiveControl || 'active';
    ctrlSel.addEventListener('change', () => {
      void runControl(s.sessionId, { action: 'set_control', mode: ctrlSel.value }, `Setting receive control to ${ctrlSel.value}…`);
    });
    const ctrlLabel = el('label', 'insp-control'); ctrlLabel.appendChild(el('span', null, 'Receive')); ctrlLabel.appendChild(ctrlSel);
    wrap.appendChild(ctrlLabel);

    // Pin / unpin (toggle by current state).
    wrap.appendChild(actionButton(s.pinned ? 'Unpin' : 'Pin', false, () =>
      runControl(s.sessionId, { action: s.pinned ? 'unpin' : 'pin' }, s.pinned ? 'Unpinning…' : 'Pinning…')));

    // Archive / unarchive.
    wrap.appendChild(actionButton(s.archived ? 'Unarchive' : 'Archive', false, () =>
      runControl(s.sessionId, { action: s.archived ? 'unarchive' : 'archive' }, s.archived ? 'Unarchiving…' : 'Archiving…')));

    // Stop managed session — only for a managed session; destructive → confirm. HONESTY: the
    // dashboard cannot know whether the broker still holds a LIVE in-process handle (the only
    // pid-recycling-safe kill proof lives in the daemon, not the read model), so we never promise
    // a kill. The confirm + result wording make clear a stale record only clears markers; the
    // authoritative {killed, killable} comes back from the broker and is surfaced via describeResult.
    if (s.managed) {
      const pidNote = s.managedPid != null ? ` (recorded pid ${s.managedPid})` : '';
      wrap.appendChild(actionButton('Stop session', true, async () => {
        if (!window.confirm(
          `Stop the managed session “${s.name || s.sessionId.slice(0, 8)}”${pidNote}?\n\n`
          + `If xbus still holds a live handle to the process it launched, it is signalled (SIGTERM). `
          + `If not (the broker restarted since launch, or the process already exited), this only clears `
          + `the managed markers — xbus will NOT signal a bare pid, since it may have been recycled to an `
          + `unrelated process. The result will tell you which happened.`)) return;
        await runControl(s.sessionId, { action: 'stop_managed' }, 'Stopping managed session…');
      }));
    }

    // Remove record — GATED disabled pending KNOWN-3.
    const removeBtn = actionButton('Remove record', true, async () => {
      if (!AGENTS_REMOVE_RECORD_ENABLED) return; // belt-and-suspenders: never fire while gated
      const typed = window.prompt('Type REMOVE to permanently remove this session RECORD (the Claude transcript is preserved).');
      if (typed !== 'REMOVE') { setInspStatus('Removal cancelled (confirmation not matched).', 'muted'); return; }
      await runControl(s.sessionId, { action: 'remove_record' }, 'Removing record…');
    });
    if (!AGENTS_REMOVE_RECORD_ENABLED) {
      removeBtn.disabled = true;
      removeBtn.title = 'Temporarily unavailable — pending a broker fix (KNOWN-3) so removal also invalidates name_ownership + physical_session_map. Enabling it now would corrupt broker state after restart.';
      removeBtn.setAttribute('aria-disabled', 'true');
      const note = el('span', 'gated-note', 'pending broker fix');
      removeBtn.appendChild(note);
    }
    wrap.appendChild(removeBtn);

    return wrap;
  }

  function actionButton(label, danger, onClick) {
    const b = el('button', 'insp-action' + (danger ? ' danger' : ''), label);
    b.type = 'button';
    b.addEventListener('click', () => { void onClick(); });
    return b;
  }

  function setInspStatus(msg, cls) {
    const st = document.getElementById('insp-status');
    if (!st) return;
    st.className = 'insp-status' + (cls ? ' ' + cls : '');
    st.textContent = msg || '';
  }

  /**
   * Run one operator control action against the broker, showing pending → success/failure and
   * then re-fetching authoritative state so the inspector + roster match the broker (survives
   * refresh). Disables the inspector's action buttons while in flight (no double-submit).
   */
  async function runControl(sessionId, payload, pendingMsg) {
    setInspStatus(pendingMsg || 'Working…', 'pending');
    setActionsDisabled(true);
    const r = await window.XBusApi.post('/api/session/' + encodeURIComponent(sessionId) + '/control', payload);
    setActionsDisabled(false);
    if (!r.ok) {
      const reason = (r.body && (r.body.message || r.body.error)) || ('HTTP ' + r.status);
      setInspStatus('Action failed (' + r.status + '): ' + reason, 'err');
      return false;
    }
    // The mutation committed on the broker (POST ok). Now re-read authoritative state so the UI
    // cannot drift. DASH-1: guard the refresh — a post-mutation read failure (503 read_unavailable
    // off-loop / max-streams) must NOT leave an unqualified green "Pinned." over STALE pre-mutation
    // state. On refresh failure we DOWNGRADE the status (committed-on-broker + could-not-refresh)
    // and schedule a retry; the 1s inspector-sync interval + 5s app poll are the self-heal backstop.
    const refreshOutcome = await guardedRefresh();
    const st = postMutationStatus(payload.action, r.body, refreshOutcome);
    setInspStatus(st.message, st.cls);
    if (st.retry) scheduleRefreshRetry(payload.action, r.body, sessionId);
    // If the record was removed AND the refresh saw it gone, close the inspector.
    if (payload.action === 'remove_record' && refreshOutcome.ok && !findSession(sessionId)) { inspectorSessionId = null; }
    renderInspector();
    return refreshOutcome.ok;
  }

  /** Run the authoritative-state refresh, translating a throw/HTTP-failure into {ok,status} so
   *  runControl can decide the honest status (never let a refresh error escape as an uncaught
   *  rejection that would leave a green success over stale state — the DASH-1 window). */
  async function guardedRefresh() {
    try { await window.XBusApi.refresh(); return { ok: true }; }
    catch (e) {
      // api() throws Error('request failed: <status>') on a non-ok read; extract the code if present.
      const m = /(\d{3})/.exec(String((e && e.message) || ''));
      return { ok: false, status: m ? Number(m[1]) : undefined };
    }
  }

  /** After a downgraded post-mutation refresh, retry the re-read a few times with backoff so the
   *  view converges to the broker WITHOUT waiting on the 5s poll. Idempotent per action; the last
   *  successful refresh flips the status back to a clean success. */
  let refreshRetryTimer = null;
  function scheduleRefreshRetry(action, body, sessionId, attempt = 1) {
    if (refreshRetryTimer) clearTimeout(refreshRetryTimer);
    if (attempt > 5) return; // give up after ~ (1+2+3+4+5)s; the 5s poll remains the backstop
    refreshRetryTimer = setTimeout(async () => {
      const outcome = await guardedRefresh();
      const st = postMutationStatus(action, body, outcome);
      // Only overwrite the status if the inspector is still showing THIS retry context (best-effort).
      setInspStatus(st.message, st.cls);
      if (outcome.ok) {
        if (action === 'remove_record' && !findSession(sessionId)) inspectorSessionId = null;
        renderInspector();
      } else {
        scheduleRefreshRetry(action, body, sessionId, attempt + 1);
      }
    }, attempt * 1000);
    if (refreshRetryTimer && typeof refreshRetryTimer.unref === 'function') refreshRetryTimer.unref();
  }

  function setActionsDisabled(disabled) {
    const panel = document.getElementById('inspector');
    if (!panel) return;
    for (const b of panel.querySelectorAll('.insp-action, .insp-control-select')) {
      // Never RE-ENABLE the gated remove button.
      if (b.classList && b.classList.contains('danger') && b.textContent && b.textContent.indexOf('Remove record') === 0 && !AGENTS_REMOVE_RECORD_ENABLED) { b.disabled = true; continue; }
      b.disabled = disabled;
    }
  }

  /* ---- minimal modal (CSP-safe, no inline) ---- */
  function openModal(title, bodyEl) {
    let overlay = document.getElementById('xbus-modal');
    if (overlay) overlay.remove();
    overlay = el('div', 'modal-overlay'); overlay.id = 'xbus-modal';
    const dialog = el('div', 'modal'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', title);
    const head = el('div', 'modal-head'); head.appendChild(el('h3', null, title));
    const x = el('button', 'link-btn', 'Close'); x.type = 'button'; x.addEventListener('click', () => overlay.remove());
    head.appendChild(x); dialog.appendChild(head); dialog.appendChild(bodyEl);
    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); } });
    document.body.appendChild(overlay);
  }

  /* ---- lifecycle: probe caps, pick the collections backend, hydrate, build toolbar, keep fresh ---- */
  function init() {
    buildToolbar(); // immediate (empty collections) so the roster filters render without waiting
    void bootProbeAndHydrate();
    // app.js re-renders sessions on every stream frame / poll; the interval below keeps the open
    // inspector in sync with the latest authenticated payload (survives live updates + restart).
  }

  /**
   * Capability-gated boot: probe the broker for optional endpoints (WS1 batch), then (a) switch
   * Collections onto the server store if /api/collections exists (else keep localStorage), (b)
   * hydrate Collections from the chosen store, (c) render the health panel if /api/health exists.
   * Everything is DEFENSIVE — pre-WS1 the probe finds nothing and no optional control renders.
   */
  async function bootProbeAndHydrate() {
    try {
      if (window.XBusCaps && window.XBusApi) caps = await window.XBusCaps.probeCapabilities(window.XBusApi);
    } catch { /* probe never throws, but be defensive */ }
    window.__caps = caps; // expose for diagnostics / other modules
    // Collections cutover: the instant the server endpoint exists, use it (shared across browsers);
    // otherwise stay on localStorage. One place, driven by the probe — no manual flag flip.
    if (C && caps.collectionsServer && C.makeServerStore) collectionsStore = C.makeServerStore(window.XBusApi);
    if (collectionsStore) {
      try { const st = await collectionsStore.load(); if (st) { collectionsState = st; buildToolbar(); if (window.XBusApi) window.XBusApi.rerender(); } }
      catch { /* store.load never throws */ }
    }
    // #5 health panel — renders only when /api/health exists (else stays hidden; no dead panel).
    if (caps.health) void renderHealthPanel();
  }

  /**
   * #5 — fetch + render the broker/build/runtime/ledger health panel. Capability-gated (only
   * called when caps.health). Defensive: a failed fetch or empty model hides the panel. Refreshed
   * on demand (a small refresh button) rather than polled, to stay cheap.
   */
  async function renderHealthPanel() {
    const host = document.getElementById('health-panel');
    if (!host || !window.XBusPrestage) return;
    let model = { ok: false, alert: false, rows: [] };
    try { model = window.XBusPrestage.healthPanelModel(await window.XBusApi.get('/api/health')); }
    catch { /* endpoint vanished / read failed → hide */ }
    if (!model.ok) { host.hidden = true; host.replaceChildren(); return; }
    host.hidden = false;
    host.replaceChildren();
    const head = el('div', 'sec-head');
    head.appendChild(el('h2', null, 'System health'));
    head.appendChild(el('span', 'sec-note' + (model.alert ? ' err' : ''), model.alert ? 'ledger needs attention' : 'build · runtime · ledger'));
    host.appendChild(head);
    const grid = el('div', 'health-grid');
    for (const row of model.rows) {
      const cellEl = el('div', 'health-cell');
      cellEl.appendChild(el('span', 'health-k', row.label));
      cellEl.appendChild(el('span', 'health-v' + (row.label === 'Ledger' && model.alert ? ' err' : ''), row.value));
      grid.appendChild(cellEl);
    }
    host.appendChild(grid);
  }

  window.XBusAgents = {
    rosterFilter,
    openInspector,
    describeControlResult,
    postMutationStatus,
    // exposed for tests / debugging
    _state: () => ({ filterState, collectionsState, caps }),
  };

  // Re-render the inspector whenever the sessions cache changes. app.js updates window.__sessions
  // on every render; poll it cheaply so the open inspector reflects authoritative broker state.
  let lastSig = '';
  setInterval(() => {
    const s = findSession(inspectorSessionId);
    const sig = inspectorSessionId + '|' + (s ? JSON.stringify([s.name, s.pinned, s.archived, s.receiveControl, s.label, s.managed, s.delivery]) : 'gone');
    if (sig !== lastSig) { lastSig = sig; if (inspectorSessionId) renderInspector(); }
  }, 1000);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
