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
directory; the smoke command runs the compiled test files.

## What the smoke tests prove

Each run starts its own owned synthetic HTTP API on IPv4 loopback (`127.0.0.1`)
with an OS-assigned ephemeral port, awaits readiness, and closes it after the
suite, including assertion failures. The HTTP client sends requests only to the
fixture origin explicitly configured for that client. It rejects non-loopback,
different-origin and redirect destinations before they can receive a request.
Requests have a five-second timeout; the suite has a 15-second timeout. Runs
use fixed fixture data and no persistent state.

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
`tests/target-safety.test.ts` verifies that other local fixtures, redirect
destinations and unsupported loopback/address forms receive no requests. Do not
introduce a customer or remote target.

## Scope and dependency boundary

This repository currently provides TypeScript setup, readable local BDD smoke
checks, request-boundary loopback target safety, meaningful positive/negative
assertions, and setup documentation only.
RRDAPI-8 remains post-MVP; **the full ticket is not complete** and still depends on
[RRDSCRUM-53](https://noisegatemusicstudios.atlassian.net/browse/RRDSCRUM-53).

Shared execution contracts, the dependent execution engine, integrations,
customer execution, credentials, provisioning, cloud setup, paid services and
automatic hosted CI are deliberately excluded. Nothing here freezes or modifies
those future interfaces or advances the Jira ticket.

## Inactive OpenAPI intake preflight (RRDAPI-14)

`src/intake/preflight.ts` exports an in-memory preparation function for synthetic
JSON/YAML strings. It is not connected to an upload endpoint, UI, store, runner,
identity service or customer intake. RRDAPI-2/8 execution remains deferred.

The caller must supply every `PreflightPolicy` setting: UTF-8 byte limit, AST depth
and node limits, reference count limit, deadline, worker V8 heap and stack settings,
and an exact OpenAPI version allow-list. Missing/invalid settings fail closed.
Numbers in the tests are synthetic test configuration, not approved product limits.
The allow-list recognizes 3.0.x/3.1.x version declarations only; it does not promise
schema support. Policy comes from trusted application configuration, never the
uploaded document or a customer-selected bypass.

The pinned `yaml` parser inspects one document's AST without alias expansion or
reference resolution. JSON additionally passes native JSON syntax parsing. The
preflight rejects duplicate keys, multiple documents, explicit YAML tags, anchors,
aliases, merge keys, complex/non-string keys, non-finite numbers, external `$ref`
values, and unsupported URI scope/dynamic/anchor keywords. Local JSON Pointer
references are checked syntactically only. The conservative reference check visits
all mappings, including examples/extensions; it may reject otherwise valid OpenAPI.
Imported strings are data and are never evaluated or used as instructions.

Parsing happens in a worker with caller-specified V8 heap/stack limits and a
termination deadline. Structure limits apply during AST inspection, after parsing;
the byte limit applies before starting the worker. These are preparation safeguards,
not a whole-process memory sandbox: V8 limits exclude external allocations and the
caller already holds the input string. A future intake boundary still needs approved
request/concurrency limits and process-level resource containment. The worker is
terminated before the result is returned, including timeout and error paths.

Results contain only a fixed status/error code and, where available, a zero-based
UTF-16 source offset. No parser messages, filenames, keys, values, source lines or
reference destinations leave the worker. Success explicitly returns
`schemaValidated: false` and `executionAuthorized: false`; it is not import approval.
No document-directed file reads, network requests or code execution are performed.

Run `npm run typecheck` and `npm test`. The synthetic suite checks policy failures,
UTF-8 boundaries, structural/reference bounds, unsafe YAML, duplicate/malformed
documents, external references, secret-safe diagnostics, worker timeout cleanup,
and zero requests to an owned loopback target. Existing smoke/target-safety tests
continue unchanged.

Still required for RRDAPI-14: full maintained OpenAPI schema validation and resolved
source-located inventory; immutable scoped persistence, original/normalized hashes,
idempotency and version differences; authenticated access/provenance contracts;
approved encryption, retention/deletion and redaction policies; product limits and
supported-version decisions. None is inferred from preflight success. Review
approval remains separate from execution permission.

RRDAPI-13's selected Contract Intake visual remains a separate Copilot-owned gate.
Its selection does not settle the outstanding product/security policies. This
slice adds no UI and makes no visual fidelity claim.
