# PonsMCP — Testing Guide

## Quick Start

```bash
npm run build          # compile TypeScript
npm run test:all       # run all suites (unit + security + serial)
```

## Test Suites

| Suite | Command | What it covers | Runtime |
|---|---|---|---|
| **Unit** | `npm run test:unit` | chain, erc20, curve, stocks modules — pure logic, no network | ~200ms |
| **Security** | `npm run test:security` | PolicyEngine caps, waitMs clamp, amount regex validation | ~100ms |
| **Serial** | `npm run test:serial` | All 23+ MCP tools end-to-end via stdio (needs network + Alchemy key) | ~40s |
| **Coverage** | `npm run test:coverage` | Unit + security with c8 lcov/text report | ~1s |

## CI/CD

GitHub Actions workflow at `.github/workflows/ci.yml`:
- Triggers: push/PR to `main`
- Steps: `npm ci` → `npm run build` → `test:unit` → `test:security` → `test:coverage`
- Node 20, npm cache enabled

## Current Coverage

```
policy.js  |  100% statements
stocks.js  |  88% statements
curve.js   |  74% statements
chain.js   |  45% statements (RPC network functions — covered by serial suite)
```

Note: `chain.js` RPC functions are network-dependent and covered by the serial suite, not unit tests. Unit coverage focuses on pure logic (encoding, math, validation).

## Writing Tests

- Unit tests live in `test/units/units.test.mjs` — use `node:test` + `node:assert/strict`
- Import compiled output: `await import('../../dist/<module>.js')`
- Security regression tests in `test/security.test.mjs` — every security fix gets a test so it can't regress
- Serial tests in `test/serial_suite.mjs` — spawn `dist/mcp.js` as child process, send JSON-RPC over stdin

## Conventions

1. **No network in unit tests** — mock or test pure functions only
2. **Every security fix needs a regression test** — see security.test.mjs for examples
3. **English only** in all test names and assertions
4. **BigInt comparisons** — use `assert.equal(x, 10n ** 18n)` style, not Number()
