# Local k6 performance harness (RRDAPI-10)

This harness pins the open-source k6 v0.54.0 release and its SHA-256 checksums.
It does not use Grafana Cloud, paid services, CI, hosted k6, or deployment.
The only executable profile is **direct mock-only**: each run starts a disposable
synthetic API fixture owned by this harness on `127.0.0.1` and an OS-assigned
port, then tears it down. It is not the ReleaseReady Dev application.

## Setup and reproducible commands

From a clean checkout with Node.js 22.12+ and npm:

```sh
npm ci
npm run perf:install-k6
npm run perf:smoke
npm run test:performance
```

The installer selects a pinned macOS/Linux x64 or arm64 archive, verifies its
committed SHA-256 before extraction, and installs it under the ignored
`.tools/k6/` directory. It does not install a global k6 executable. The regular
`npm test` suite is separate and does not need k6.

`npm run perf:smoke` uses the 1 VU, 1 request/second, 2-second workload. The
focused harness test runs a passing fixture, a deliberately failing
business-check fixture, and a redirect check at the same limits. The failing
fixtures must exit nonzero because the k6 `checks` threshold requires a 100%
pass rate; the redirect destination is another owned loopback fixture and must
receive zero requests. `npm run perf:fixture-fail` repeats only the bounded
business-check failure demonstration. The `baseline` profile is
versioned and capped at 2 VUs, 2 requests/second, 10 seconds, a 1-second
request timeout, and at most 20 requests; do not treat it as capacity evidence.
No baseline workload was run for this change.

There is no public `--target` option or arbitrary-host option. The runner
rejects unknown options, starts its own fixture before invoking k6, and supplies
the fixture URL through an internal child-process setting. The k6 script independently
rejects non-HTTP, non-`127.0.0.1`, missing-port, credentialed, path/query, and
fragment targets before it can send a request. Each request disables redirects.
The configured profile/workload values and hard ceilings are in
[`config/profiles.json`](config/profiles.json).

## Profiles and current Dev limitation

The `direct-mock` profile checks a fixed synthetic widget response only. It
does not use Platform WireMock mappings, external dependencies, login, tenant
data, or the real application. Its results must be labelled as direct mock-only.

The `dev` profile is deliberately disabled and
`npm run perf:dev` fails before starting a fixture or sending traffic. RRDAPI-10
AC2 remains incomplete: Platform documentation describes a separate local Dev
application with shared WireMock/stubs and synthetic data, but this repository
does not contain or expose an approved harness-consumable local entry point or
the mappings. This harness does not create another mock platform, copy
mappings, or claim that its direct fixture satisfies the Dev-profile criterion.
Enablement requires the Platform-owned application and its existing mappings to
be consumable through a documented, isolated local interface.

## Checks, metrics, summaries, and safety

The workload checks HTTP status, JSON content type, and the synthetic widget's
exact identity and active business flag. A redirect is not followed; any HTTP
failure or failed check makes k6 exit nonzero. Hard ceilings are validated
before the fixture is started and repeated in the k6 script.

Each run writes a sanitized JSON summary under the ignored
`.performance-results/` directory. It contains only the full source revision,
whether the worktree was dirty, pinned k6 version, environment/profile,
workload, mock boundary, request count, achieved throughput, error/check rates,
dropped iterations, and p50/p90/p95/p99 latency. It does not contain request or
response bodies, fixture names, credentials, headers, or customer data. It also
records the run status and k6 exit code.

The fixture uses fixed in-memory synthetic data and a random port; it writes no
application state. Setup is automatic and teardown runs after success, failed
checks, or cancellation. Press Ctrl-C to cancel; the runner forwards the signal
to k6 and closes the fixture. The summary file is retained locally for review;
remove an individual summary when no longer needed. No Dev, UAT, Production,
manual instance, or non-fixture target is used by these commands.

Mock/Dev results do not prove UAT or Production capacity. This change did not
run any load test against Dev, UAT, Production, or a manual Dev instance.
