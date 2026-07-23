/**
 * BETA.11 (ADR 0038) — RED-first unit tests for the OUTWARD routing class + sender-facing
 * delivery signal. Pins the honesty rules the operator required:
 *   #1 checkpoint-capable does NOT imply autonomously wakeable;
 *   #2 a checkpoint-only session is NOT "normal ready";
 *   #3 a stored (queued) message is NOT reported as delivered/injected;
 *   #16 sender-facing language never says injected/delivered before the body is injected.
 *
 * Pure signal→class / state→signal mappings; the SINGLE derivation both the dashboard and the
 * xbus_* tools use, so they cannot disagree (parity is a separate integration test).
 */
import { describe, it, expect } from 'vitest';
import {
  deriveRoutingClass, isAutonomouslyRoutable, deriveDeliverySignal,
  ALL_ROUTING_CLASSES, ALL_DELIVERY_SIGNALS,
  type RoutingClass,
} from '../../src/broker/routing-class.js';
import { DeliveryState } from '../../src/protocol/states.js';

const base = { receiveMode: 'hook_checkpoint', connectionState: 'connected', expired: false, autoDeliveryEnabled: true } as const;

describe('deriveRoutingClass — checkpoint-capable ≠ autonomously wakeable (honesty)', () => {
  it('#1/#2 ready_checkpoint + connected but NO proven wake → degraded_checkpoint_only (NOT ready_*)', () => {
    const rc = deriveRoutingClass({ ...base, readiness: 'ready_checkpoint' });
    expect(rc).toBe('degraded_checkpoint_only');
    expect(isAutonomouslyRoutable(rc)).toBe(false);
  });

  it('#1 ready_checkpoint becomes ready_wakeable ONLY with a PROVEN host wake probe', () => {
    const proven = deriveRoutingClass({ ...base, readiness: 'ready_checkpoint', wakeProbe: { proven: true } });
    expect(proven).toBe('ready_wakeable');
    expect(isAutonomouslyRoutable(proven)).toBe(true);
    // An explicitly-unproven probe stays degraded (honest default).
    const unproven = deriveRoutingClass({ ...base, readiness: 'ready_checkpoint', wakeProbe: { proven: false } });
    expect(unproven).toBe('degraded_checkpoint_only');
  });

  it('ready_live is autonomously routable (push transport consumes immediately)', () => {
    const rc = deriveRoutingClass({ ...base, receiveMode: 'live', readiness: 'ready_live' });
    expect(rc).toBe('ready_live');
    expect(isAutonomouslyRoutable(rc)).toBe(true);
  });

  it('initializing → pending_activation (not a failure, not routable yet)', () => {
    expect(deriveRoutingClass({ ...base, readiness: 'initializing' })).toBe('pending_activation');
  });

  it('a DISCONNECTED session is unavailable even if its stored readiness is ready_checkpoint (the live bug)', () => {
    // This is the exact defect observed live: xbus_sessions showed readiness:ready_checkpoint for a
    // disconnected, 10-day-stale session. The routing class must be honest: no live owner → unavailable.
    const rc = deriveRoutingClass({ ...base, connectionState: 'disconnected', readiness: 'ready_checkpoint', wakeProbe: { proven: true } });
    expect(rc).toBe('unavailable');
    expect(isAutonomouslyRoutable(rc)).toBe(false);
  });

  it('expired/incompatible/degraded_ack/degraded_hook all → unavailable', () => {
    expect(deriveRoutingClass({ ...base, readiness: 'ready_checkpoint', expired: true })).toBe('unavailable');
    expect(deriveRoutingClass({ ...base, readiness: 'incompatible' })).toBe('unavailable');
    expect(deriveRoutingClass({ ...base, readiness: 'degraded_ack_unavailable' })).toBe('unavailable');
    expect(deriveRoutingClass({ ...base, readiness: 'degraded_hook_unavailable' })).toBe('unavailable');
  });

  it('auto-delivery OFF: paused/DND → unavailable, but manual_checkpoint stays degraded (operator-drainable)', () => {
    // paused / DND: not auto, not manually drainable → unavailable.
    expect(deriveRoutingClass({ ...base, readiness: 'ready_checkpoint', wakeProbe: { proven: true }, autoDeliveryEnabled: false, receiveControl: 'paused' })).toBe('unavailable');
    expect(deriveRoutingClass({ ...base, readiness: 'ready_checkpoint', autoDeliveryEnabled: false, receiveControl: 'do_not_disturb' })).toBe('unavailable');
    // manual_checkpoint: auto-off but an operator can drain on demand → NOT unavailable (arch review A2).
    const manual = deriveRoutingClass({ ...base, readiness: 'ready_checkpoint', autoDeliveryEnabled: false, receiveControl: 'manual_checkpoint' });
    expect(manual).toBe('degraded_checkpoint_only');
    expect(isAutonomouslyRoutable(manual)).toBe(false); // still not AUTO-routable
  });

  it('is total over ALL_ROUTING_CLASSES and never invents a class', () => {
    const readinesses = ['initializing', 'ready_checkpoint', 'ready_live', 'degraded_ack_unavailable', 'degraded_hook_unavailable', 'incompatible', 'disconnected'] as const;
    for (const readiness of readinesses) {
      const rc = deriveRoutingClass({ ...base, readiness });
      expect(ALL_ROUTING_CLASSES).toContain(rc);
    }
  });
});

describe('deriveDeliverySignal — a stored message is never "delivered" (#3/#16)', () => {
  it('#3/#16 QUEUED (durably stored, no wake) → "queued", NOT injected/delivered', () => {
    const sig = deriveDeliverySignal(DeliveryState.QUEUED);
    expect(sig).toBe('queued');
    expect(sig).not.toBe('injected');
  });

  it('#4/#5 wake attempt surfaces before injection: requested/accepted → wake_requested; failed → wake_failed', () => {
    expect(deriveDeliverySignal(DeliveryState.QUEUED, 'requested')).toBe('wake_requested');
    expect(deriveDeliverySignal(DeliveryState.QUEUED, 'accepted')).toBe('wake_requested');
    expect(deriveDeliverySignal(DeliveryState.QUEUED, 'failed')).toBe('wake_failed');
    expect(deriveDeliverySignal(DeliveryState.RETRY_WAIT, 'failed')).toBe('wake_failed');
  });

  it('injected/acked/replied are distinguishable from each other and from queued (operator requirement)', () => {
    expect(deriveDeliverySignal(DeliveryState.TRANSPORT_WRITTEN)).toBe('injected');
    expect(deriveDeliverySignal(DeliveryState.ACCEPTED)).toBe('acknowledged');
    expect(deriveDeliverySignal(DeliveryState.COMPLETED)).toBe('replied');
    // All four are distinct — a stored/injected/acked/replied message is never conflated.
    const signals = [
      deriveDeliverySignal(DeliveryState.QUEUED),
      deriveDeliverySignal(DeliveryState.TRANSPORT_WRITTEN),
      deriveDeliverySignal(DeliveryState.ACCEPTED),
      deriveDeliverySignal(DeliveryState.COMPLETED),
    ];
    expect(new Set(signals).size).toBe(4);
  });

  it('a wake outcome NEVER regresses a post-injection state back to a wake word', () => {
    // Once injected/acked/replied, the DeliveryState is authoritative; a stale wake record cannot
    // make an already-injected message report "wake_requested".
    expect(deriveDeliverySignal(DeliveryState.TRANSPORT_WRITTEN, 'requested')).toBe('injected');
    expect(deriveDeliverySignal(DeliveryState.ACCEPTED, 'failed')).toBe('acknowledged');
    expect(deriveDeliverySignal(DeliveryState.COMPLETED, 'requested')).toBe('replied');
  });

  it('terminal failures map honestly', () => {
    expect(deriveDeliverySignal(DeliveryState.REJECTED)).toBe('failed');
    expect(deriveDeliverySignal(DeliveryState.DEAD_LETTER)).toBe('failed');
    expect(deriveDeliverySignal(DeliveryState.CANCELLED)).toBe('failed');
    expect(deriveDeliverySignal(DeliveryState.EXPIRED)).toBe('expired');
  });

  it('every DeliveryState maps into ALL_DELIVERY_SIGNALS', () => {
    for (const st of Object.values(DeliveryState)) {
      expect(ALL_DELIVERY_SIGNALS).toContain(deriveDeliverySignal(st));
    }
  });
});
