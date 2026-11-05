# Universal API Framework

A standalone **local-only TypeScript API smoke scaffold** for the bounded
preparation slice of [RRDAPI-8](https://noisegatemusicstudios.atlassian.net/browse/RRDAPI-8).
This is not a customer API runner or evidence of customer API behavior.

## Setup and run

Install Node.js 22.12 or later (with npm), then run from the repository root:

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
Each configuration value is read once into a validated plain snapshot; that same
snapshot controls the byte check, parser transfer, resource flags and deadline.
Inherited/non-enumerable settings are preserved, not silently lost in IPC.
Numbers in the tests are synthetic test configuration, not approved product limits.
The allow-list recognizes 3.0.x/3.1.x version declarations only; it does not promise
schema support. Policy comes from trusted application configuration, never the
uploaded document or a customer-selected bypass.

The pinned `yaml` parser inspects one document's AST without alias expansion or
reference resolution. JSON additionally passes native JSON syntax parsing. The
preflight rejects duplicate keys, multiple documents, explicit YAML tags, anchors,
aliases, merge keys, complex/non-string keys, non-finite numbers, external `$ref`
values, and unsupported URI scope/dynamic/anchor keywords. Local JSON Pointer
references must first satisfy RFC 3986 URI-fragment syntax, then JSON Pointer
escape syntax; target resolution is not performed. The conservative check visits
all mappings, including examples/extensions; it may reject otherwise valid OpenAPI.
Imported strings are data and are never evaluated or used as instructions.

Parsing happens in a short-lived Node **child process**, not a Worker thread:
Worker startup OOM can abort its caller, even with resource limits and error
handlers ([Node documentation](https://nodejs.org/api/worker_threads.html)).
The child receives no inherited environment/preload flags, ignores stdout/stderr,
and communicates only the input and fixed result over IPC. Its exit and IPC closure
are awaited before returning, including timeout/error paths. Fatal parser V8
failures become `worker-failed` without aborting the caller's V8 process.

The existing `workerHeapMb` setting now controls the child's V8 old-space limit;
`workerStackMb` controls its V8 stack size. Conservative technical startup floors
are **32 MiB old space and 4 MiB stack**, tested with the pinned parser on Linux
Node **22.23.4 and 24.22.1**. Smaller settings fail closed before process creation;
settings must also fit V8's signed integer flags (stack converted to KiB). These
floors are implementation constraints, not product defaults or a promise that
every admitted document fits. Other OS/runtime combinations need validation.

Structure limits apply during AST inspection, after parsing; the byte limit applies
before process creation. This is still not a whole-process/host memory sandbox:
V8 limits exclude external/native allocations, and the caller holds and serializes
the input. Host-wide OOM, concurrency, OS crash dumps and other process permissions
are not controlled here. Future intake still needs approved request/concurrency
limits, process resource containment and crash-artifact handling before activation.

Results contain only a fixed status/error code and, where available, a zero-based
UTF-16 source offset. No parser messages, filenames, keys, values, source lines or
reference destinations leave the worker. Success explicitly returns
`schemaValidated: false` and `executionAuthorized: false`; it is not import approval.
No document-directed file reads, network requests or code execution are performed.

Run `npm run typecheck` and `npm test`. The synthetic suite checks policy failures,
UTF-8 boundaries, structural/reference bounds, unsafe YAML, duplicate/malformed
documents, external references, secret-safe diagnostics, worker timeout cleanup,
and zero requests to an owned loopback target. Resource regressions run in an extra
child process so a regression cannot abort the test runner. They verify rejection
below the startup floors, success at the floors, and recovery after parser heap
exhaustion. On Unix, run `ulimit -c 0` before tests to suppress OS core dumps from
the intentional synthetic exhaustion probe. Existing smoke/target-safety tests
continue unchanged. Test files run sequentially so intentional resource-exhaustion
probes do not compete with another suite's fixed deadlines; policy limits are not
increased for the tests.

Still required for RRDAPI-14: broader OpenAPI validation and resolved
source-located inventory; immutable scoped persistence, original/normalized hashes,
idempotency and version differences; authenticated access/provenance contracts;
approved encryption, retention/deletion and redaction policies; product limits and
supported-version decisions. None is inferred from preflight success. Review
approval remains separate from execution permission.

RRDAPI-13's selected Contract Intake visual remains a separate Copilot-owned gate.
Its selection does not settle the outstanding product/security policies. This
slice adds no UI and makes no visual fidelity claim.

## Offline OpenAPI 3.0 document-schema validation

`validateDocumentSchema(source, format, policy)` is a separate inactive entry point
in `src/intake/preflight.ts`. It reuses the same preflight, validated policy snapshot,
child-process lifetime and resource bounds. Existing `preflight()` results remain
unchanged and still report `schemaValidated: false`.

The new stage intersects the caller's exact version allow-list with the tested
technical capability **3.0.0, 3.0.1, 3.0.2, 3.0.3 and 3.0.4**. There is no default
version policy. Other versions, including 3.1 even when explicitly allowed by the
caller, return `schema-version-unsupported`. Swagger Parser 13 alone accepts some
invalid 3.1 Schema Objects; this implementation makes no 3.1 validation claim.

Pinned `@apidevtools/openapi-schemas` 2.1.0 and `ajv-draft-04` 1.0.0 validate
the original and resolved in-memory document against the maintained OpenAPI 3.0
schema. Original validation checks reference placement before transformation.
Local pointers must traverse exact own properties under RFC 6901, including
escaped tokens and canonical array indices; inherited properties and joined
missing tokens cannot resolve. Pinned `@apidevtools/swagger-parser` 13.0.0
performs dereferencing with the restrictions below. Its minimum
supported Node version requires the package engine floor of 22.12.0. External
references are rejected by preflight **before validator invocation**; file/HTTP
resolvers and secondary JSON/YAML/text/binary input parsers are additionally disabled.
Circular references return `circular-reference-unsupported` in this bounded stage, including
otherwise legitimate recursive schemas. The pinned resolver also rejects some
valid percent-encoded literal keys (for example `a%252Fb` targeting `a%2Fb`);
these return `document-schema-invalid`, so rejection is not proof that a document
violates OpenAPI. No declared servers are contacted.

Guards on original and resolved component maps enforce the standard's
[component-map naming rule](https://spec.openapis.org/oas/v3.0.3.html#components-object):
the maintained schema otherwise skips some invalidly named entries. This uses the
OpenAPI rule, not a new product/domain schema. The validator is not a proof of full
OpenAPI specification conformance, business correctness or execution readiness.

Success is `status: 'document-schema-passed'`, `documentSchemaValidated: true`, with
`specificationConformanceValidated`, `importApproved` and `executionAuthorized`
all explicitly **false**. Invalid documents return fixed `document-schema-invalid`
diagnostics. A UTF-16 offset is included only when a validator path maps to an
original AST node without crossing a dereferenced mapping; otherwise it is omitted.
Raw error messages, keys, values, pointers and documents are never returned.
The numeric offset can identify a containing object for errors about missing fields;
it is not a fabricated location for an absent field.

Synthetic tests cover every supported technical version, invalid Schema Objects,
caller-policy intersection, unresolved/circular pointers, original-source locations,
secret-safe diagnostics, validator non-invocation for external refs, intercepted
file/HTTP/secondary-parser hooks, process startup failure, deadline and heap-exhaustion
recovery. The same process/host memory and activation limitations described above
still apply. No hashes, normalization, version identity, inventory/diff, storage,
permissions, credentials, UI or live intake are added by this stage.
