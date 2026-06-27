/**
 * §6 dogfood — a REAL OpenAPI breaking-change analyzer. This is the substantive
 * work the "reviewer" Claude session performs on the contract it receives over
 * XBus (NOT a nonce echo). Deterministic, pure, no I/O — so the dogfood scenario
 * is reproducible and the findings are checkable.
 *
 * It detects the breaking-change classes that actually bite API consumers:
 *  - a previously-optional request field becoming required
 *  - a removed / renamed response field
 *  - a restructured field (scalar -> object)
 *  - a renamed enum value (removing an accepted value)
 *  - a renamed response schema / wrapper shape change
 */

interface Schema { type?: string; required?: string[]; properties?: Record<string, Schema>; enum?: string[]; items?: Schema; $ref?: string; }
interface OpenApi { info: { version: string }; paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, Schema> }; }

export interface Finding {
  severity: 'breaking' | 'warning' | 'info';
  path: string;
  kind: string;
  detail: string;
}

function props(s: Schema | undefined): Record<string, Schema> { return s?.properties ?? {}; }
function req(s: Schema | undefined): Set<string> { return new Set(s?.required ?? []); }

/** Compare two OpenAPI documents and return breaking/warning findings. */
export function diffContracts(v1: OpenApi, v2: OpenApi): Finding[] {
  const findings: Finding[] = [];
  const s1 = v1.components.schemas;
  const s2 = v2.components.schemas;

  // 1) Request-body schemas: an optional field becoming required is breaking for clients.
  for (const name of Object.keys(s1)) {
    const a = s1[name];
    const b = s2[name];
    if (!b) {
      findings.push({ severity: 'breaking', path: `components.schemas.${name}`, kind: 'schema_removed', detail: `schema "${name}" was removed or renamed; clients referencing it break` });
      continue;
    }
    const aReq = req(a), bReq = req(b);
    for (const f of bReq) {
      if (!aReq.has(f)) {
        const wasOptional = f in props(a);
        findings.push({
          severity: 'breaking',
          path: `components.schemas.${name}.${f}`,
          kind: wasOptional ? 'optional_became_required' : 'new_required_field',
          detail: wasOptional
            ? `field "${f}" was optional in v${v1.info.version} and is now required; existing callers omitting it break`
            : `new required field "${f}"; existing callers that don't send it break`,
        });
      }
    }
    // 2) Removed/renamed response fields + scalar->object restructures.
    for (const f of Object.keys(props(a))) {
      const pa = props(a)[f];
      const pb = props(b)[f];
      if (!pb) {
        findings.push({ severity: 'breaking', path: `components.schemas.${name}.${f}`, kind: 'field_removed', detail: `field "${f}" was removed/renamed; consumers reading it break` });
        continue;
      }
      if (pa?.type && pb?.type && pa.type !== pb.type) {
        findings.push({ severity: 'breaking', path: `components.schemas.${name}.${f}`, kind: 'type_changed', detail: `field "${f}" changed type ${pa.type} -> ${pb.type}; deserialization breaks` });
      }
      // 3) Enum value removed (a value the client may send/expect is gone).
      if (pa?.enum && pb?.enum) {
        for (const v of pa.enum) if (!pb.enum.includes(v)) {
          findings.push({ severity: 'breaking', path: `components.schemas.${name}.${f}`, kind: 'enum_value_removed', detail: `enum value "${v}" removed from "${f}"; clients sending/handling it break` });
        }
        for (const v of pb.enum) if (!pa.enum.includes(v)) {
          findings.push({ severity: 'info', path: `components.schemas.${name}.${f}`, kind: 'enum_value_added', detail: `new enum value "${v}" added to "${f}" (additive)` });
        }
      }
    }
  }

  // 4) Query parameters: optional -> required is breaking.
  for (const route of Object.keys(v1.paths)) {
    const m1 = v1.paths[route] as Record<string, { parameters?: Array<{ name: string; required?: boolean; in: string }> }>;
    const m2 = (v2.paths[route] ?? {}) as Record<string, { parameters?: Array<{ name: string; required?: boolean; in: string }> }>;
    for (const verb of Object.keys(m1)) {
      const p1 = m1[verb]?.parameters ?? [];
      const p2 = m2[verb]?.parameters ?? [];
      for (const param of p2) {
        const before = p1.find((x) => x.name === param.name && x.in === param.in);
        if (before && !before.required && param.required) {
          findings.push({ severity: 'breaking', path: `${verb.toUpperCase()} ${route}?${param.name}`, kind: 'param_became_required', detail: `query param "${param.name}" became required; callers omitting it break` });
        }
      }
    }
  }

  return findings;
}

export function summarize(findings: Finding[]): { breaking: number; warning: number; info: number; verdict: 'block' | 'review' | 'safe' } {
  const breaking = findings.filter((f) => f.severity === 'breaking').length;
  const warning = findings.filter((f) => f.severity === 'warning').length;
  const info = findings.filter((f) => f.severity === 'info').length;
  const verdict = breaking > 0 ? 'block' : warning > 0 ? 'review' : 'safe';
  return { breaking, warning, info, verdict };
}
