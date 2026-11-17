import { describe, expect, it } from 'vitest';
// The audit CLI is build tooling; this test checks release gating without network access.
// @ts-expect-error JavaScript build scripts intentionally have no production declarations.
import { classifyFindings } from '../scripts/audit-rust.mjs';

describe('Windows Rust advisory classification', () => {
  it('blocks target vulnerabilities without hiding warnings or other-target findings', () => {
    const finding = (name: string, version = '1.0.0') => ({
      package: { name, version },
      advisory: { id: name }
    });
    const active = finding('active');
    const unusedVersion = finding('active', '0.1.0');
    const linux = finding('linux-only');
    const warning = finding('maintained-upstream');
    expect(
      classifyFindings(
        {
          vulnerabilities: { list: [active, unusedVersion, linux] },
          warnings: { unmaintained: [warning] }
        },
        'active v1.0.0\nmaintained-upstream v1.0.0\nactive v1.0.0 (*)\n'
      )
    ).toEqual({
      blocking: [active],
      warnings: [warning],
      otherTargets: [unusedVersion, linux]
    });
  });
});
