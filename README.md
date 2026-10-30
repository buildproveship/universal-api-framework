# Universal API Framework

A standalone **local-only TypeScript API smoke scaffold** for the bounded
preparation slice of [RRDAPI-8](https://noisegatemusicstudios.atlassian.net/browse/RRDAPI-8).
This is not a customer API runner or evidence of customer API behavior.

## Setup and run

Install Node.js 22 or later (with npm), then run from the repository root:

```sh
npm ci
npm run typecheck
npm run test:smoke
```

Dependency installation needs access to the npm registry. After installation,
type checking and smoke execution need no remote service, credentials, environment
variables, account, Docker, or cloud infrastructure. No hosted CI is configured.

`npm test` is equivalent to `npm run test:smoke`. It compiles the TypeScript and
runs Node's built-in BDD test runner with readable Given/When/Then scenario names.
`npm run build` only compiles. Generated JavaScript lives in the ignored `dist/`
directory; the smoke command runs the explicitly named compiled test file.

## What the smoke tests prove

Each run starts its own owned synthetic HTTP API on IPv4 loopback (`127.0.0.1`)
with an OS-assigned ephemeral port, awaits readiness, and closes it after the
suite, including assertion failures. There is no configurable target URL and
redirects are rejected. Requests have a five-second timeout; the suite has a
15-second timeout. Runs use fixed fixture data and no persistent state.

| Given the local synthetic API | When | Then |
| --- | --- | --- |
| It is listening | `GET /health` | HTTP 200, JSON, exact synthetic identity |
| The fixed widget exists | `GET /widgets/widget-1` | HTTP 200, JSON, exact ID, name and active flag |
| A widget does not exist | `GET /widgets/missing` | HTTP 404, unsuccessful response and exact JSON error |
| Writes are unsupported | `POST /widgets/widget-1` | HTTP 405, unsuccessful response, `Allow: GET` and exact JSON error |

Expected HTTP errors are **passing negative scenarios**, not ignored failures.
Status, headers and body are asserted independently, so a response merely arriving
does not pass the test. Compilation errors, assertion failures and request errors
produce a nonzero command exit status with diagnostic output.

The fixture in `tests/fixtures/synthetic-api.ts` belongs only to these tests; its
routes and payloads are not a shared execution contract. Scenarios live in
`tests/smoke.test.ts`. To add a local scenario, add deterministic fixture behavior
and a named `it` assertion there, keeping all requests on the owned loopback API.
Do not introduce a customer or remote target.

## Scope and dependency boundary

This repository currently provides TypeScript setup, readable local BDD smoke
checks, meaningful positive/negative assertions, and setup documentation only.
RRDAPI-8 remains post-MVP; **the full ticket is not complete** and still depends on
[RRDSCRUM-53](https://noisegatemusicstudios.atlassian.net/browse/RRDSCRUM-53).

Shared execution contracts, the dependent execution engine, integrations,
customer execution, credentials, provisioning, cloud setup, paid services and
automatic hosted CI are deliberately excluded. Nothing here freezes or modifies
those future interfaces or advances the Jira ticket.
