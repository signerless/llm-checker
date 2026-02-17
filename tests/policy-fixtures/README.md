# Policy Fixture Strategy

This folder keeps deterministic policy fixtures for enterprise policy regression tests.

## Fixtures

- `policy-valid-compliant.yaml`
  - Enforce mode, permissive rules.
  - Used to verify compliant policy flows return exit code `0`.
- `policy-valid-audit.yaml`
  - Audit mode, permissive rules.
  - Used to verify multi-format audit exports in non-blocking mode.
- `policy-valid-violations.yaml`
  - Enforce mode, intentionally impossible allowlist.
  - Used to verify violations produce non-zero exits and findings.
- `policy-exception-override.yaml`
  - Same impossible allowlist, but with a blanket exception.
  - Used to verify suppressed violations and exception handling.
- `policy-invalid-schema.yaml`
  - Intentionally invalid schema.
  - Used to verify `policy validate` error handling.

## Maintenance Rules

- Keep fixtures small and explicit.
- Prefer changing fixtures over embedding inline YAML in tests.
- Add one fixture per policy scenario instead of mutating a single file in many ways.
