# Local k6 performance harness (RRDAPI-10)

This harness uses checksum-pinned open-source k6 v0.54.0. It has two distinct
local profiles and uses no Grafana Cloud subscription, hosted test runner or
live provider credentials:

- `direct-mock`: a disposable synthetic widget fixture owned by this harness.
  This checks the harness, not the ReleaseReady application.
- `dev`: the real pinned Platform application and actual pinned WireMock,
  using Platform's unchanged Compose file and existing mapping files. Each run
  creates its own synthetic store, isolated networks and random loopback port.

Dev/mocked results do not establish UAT or Production capacity. No baseline
workload is required for the smoke checks below.

## Direct fixture setup

Use Node.js 22.12+ and npm in a clean API checkout:

```sh
npm ci
npm run perf:install-k6
npm run perf:smoke
npm run perf:fixture-fail  # expected nonzero exit
npm run test:performance
npm test
npm run typecheck
```

The installer supports macOS/Linux x64 and arm64, verifies the committed archive
SHA-256, and writes only `.tools/k6/`. It does not install a global executable.
The regular `npm test` suite does not require k6 or Docker. The performance
suite uses direct fixtures and traffic-free/mocked runtime-policy tests; it does
not start Platform containers automatically.

Direct smoke is 1 VU, 1 request/second for 2 seconds, with a 1-second timeout.
The deliberately wrong business fixture and redirect fixture must fail. The
redirect destination is another owned fixture and must receive zero requests.
`npm run perf:baseline` is separately available at 2 VUs, 2 requests/second,
10 seconds and at most 20 requests. Do not treat this mock baseline as capacity
acceptance.

## Prepare the pinned Platform image

Use a separate disposable Platform checkout, supported Node 24 LTS for package
preparation, and Docker/Compose with a local Unix-socket context. Compose must
support `!override` tags. Do not build in a shared preview checkout.

The exact source revision, source tree, dependency-lock digest and WireMock image
are versioned in [`config/platform-runtime.json`](config/platform-runtime.json).
The runtime never pulls images, builds software, changes Docker settings or
accepts a remote Docker context. Cache the official prerequisites while online:

```sh
docker pull wiremock/wiremock:3.13.2@sha256:0d4ecb3e4dc8213fd7a4d37d6a78f6e6b553a6d2e15bd51b0999781282ac61b3
docker pull mcr.microsoft.com/playwright:v1.55.1-noble@sha256:2f29369043d81d6d69a815ceb80760f55e85f5020371ad06a4d996f18503ad1c
docker pull mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
```

Prepare exact dependencies on the host using existing authorized Git access.
Do not copy authentication files or credentials into a container or image.
The following build was verified on Linux/arm64 inside Docker on macOS; use
`--cpu=x64` when preparing an amd64 image. Cross-architecture builds require
separate validation.

```sh
BUILD=$(mktemp -d "${TMPDIR:-/tmp}/rrdapi-platform.XXXXXX")
PLATFORM_ROOT="$BUILD/source"
git init -q "$PLATFORM_ROOT"
git -C "$PLATFORM_ROOT" fetch --depth=1 \
  https://github.com/releaseready/ReleaseReady.git \
  2d6b7f048a3be2bc4df3347901f9a1439779ee91
git -C "$PLATFORM_ROOT" checkout --detach FETCH_HEAD
cd "$PLATFORM_ROOT"
npm ci --ignore-scripts --os=linux --cpu=arm64 \
  --cache "$BUILD/npm-cache" --no-audit --no-fund

docker run --rm --network none --cap-drop ALL \
  --security-opt no-new-privileges --memory 4g --cpus 2 --pids-limit 256 \
  --user 1000:1000 --mount "type=bind,src=$PLATFORM_ROOT,dst=/workspace" \
  --workdir /workspace --env HOME=/tmp --entrypoint /bin/bash \
  mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea \
  -lc 'node --version; npm --version; npm run build'

git diff --exit-code
# Expected lock SHA-256: ce3a0effd7240b122241bb3e11094df93aeaddc0e45b7d2c6384007584ec8e7d
shasum -a 256 package-lock.json

docker build --pull=false --network=none \
  --build-arg SOURCE_REVISION=2d6b7f048a3be2bc4df3347901f9a1439779ee91 \
  --label releaseready.source.revision=2d6b7f048a3be2bc4df3347901f9a1439779ee91 \
  --label releaseready.source.tree=3c1cc94c954d37dd4639bd14f0e665e8b1a317d8 \
  --label releaseready.package-lock.sha256=ce3a0effd7240b122241bb3e11094df93aeaddc0e45b7d2c6384007584ec8e7d \
  --iidfile "$BUILD/image-id.txt" -f ops/dev/Dockerfile .
PLATFORM_IMAGE=$(cat "$BUILD/image-id.txt")
```

The build container must have write access to this owned disposable checkout.
The npm cache remains outside its image build context. Preserve build logs and
verify the image's embedded `.git/HEAD`, lockfile checksum and dependency pins.
The harness checks an immutable image ID and source labels; labels alone are
not a build-content attestation. Supply only an image produced and verified
from the exact source above, not an arbitrary relabelled image.

## Run the real Dev application and shared WireMock

Return to the API checkout and pass the prepared absolute source path and
immutable image ID. Neither argument is an application URL.

```sh
npm run perf:dev -- --platform-root "$PLATFORM_ROOT" --platform-image "$PLATFORM_IMAGE"
npm run perf:dev:fixture-fail -- --platform-root "$PLATFORM_ROOT" --platform-image "$PLATFORM_IMAGE"
```

The second command deliberately expects the wrong project identity and must
exit nonzero while still proving actual mocked login, network isolation and
successful cleanup. The real response and Platform mappings are unchanged.

Dev smoke performs 2 protected configuration reads, plus one login and one
logout: at most **4 k6 HTTP requests**, 1 VU, a 2-second workload and 1-second
request timeouts. `npm run perf:dev:baseline -- ...` is separately available at
2 VUs and 2 reads/second for 9 seconds: 18 reads plus login/logout, at most 20
requests. Configuration and script validation both enforce the absolute limits.

The HTTP request ceiling covers k6 login/logout and measured application
requests. It excludes separately bounded container health/readiness probes and
WireMock administrative evidence reads. Startup is capped at 120 seconds;
container healthchecks use the pinned Compose intervals/retry limits. No
external probe is sent to test isolation.

The runner verifies the clean source revision, tree, lock digest and exact
mapping/Compose bytes. It reuses the pinned Compose file with a generated
private overlay:

- A unique `rrk6-...` project and owner labels isolate all containers, networks
  and the disposable synthetic data volume.
- Only ingress is host-published, on a random `127.0.0.1` port. Existing host
  ports 33336/38089 and existing previews are never reused or stopped.
- The application and WireMock share the private gateway namespace on the
  internal network. Actual container/image/mount/network state and absence of
  a default route are checked, not just the planned configuration.
- The overlay sets only explicit Dev settings. It omits the original
  `RR_FEATURE_TEST_PLANS=false` variable because this pinned version's
  `requireDevEnvironment` rejects that setting. The app itself already defaults
  the feature to false. The original startup failure is retained as evidence;
  Platform source and production settings are not changed.
- The unchanged TCP relay preserves the application's container authority.
  Dev requests therefore use fixed `Host: 127.0.0.1:33336`, while the connection
  URL remains the verified random host port. The app's authority and server-side
  authorization checks remain intact; no connection goes to host port 33336.

The workload signs in as the predefined synthetic `developer-a`, reads its
owned project configuration, checks the project/tenant/environment identities,
and logs out. Actual WireMock must record the existing
`GET /dev/identity/developer-a` mapping and zero unmatched requests. There are
no copied mappings, live login providers, customer data or arbitrary targets.

## Safety, summaries and teardown

Unknown profiles/options, arbitrary target URLs, redirects, non-loopback
addresses and missing/mismatched owned ports fail closed. k6 uses an empty child
environment and a dedicated configuration. Parent `K6_*`, proxy, exporter,
credential and user-config settings cannot change the run. Usage reporting,
tracing, control-server exposure and threshold suppression are disabled.

Sanitized summaries in `.performance-results/` contain source revision/dirty
state, k6 version, profile/workload, mock boundaries, request counts, throughput,
error/check rates, dropped iterations and p50/p90/p95/p99 latency. Dev summaries
also include verified Platform/WireMock/mapping identities, aggregate matching
and isolation evidence, and cleanup settlement. Startup/cancellation failures also
retain a sanitized receipt with available project/resource ownership and creation
uncertainty; unavailable execution metrics are not invented. They exclude tokens, headers,
request/response bodies, child diagnostics and customer data. Dev latency and
throughput include its login/logout lifecycle requests; application read counts
are recorded separately.

Each Dev invocation owns a fresh synthetic store. Success, failed assertions
and cancellation all run owned-resource cleanup. Press Ctrl-C once and allow
bounded cleanup to finish. Healthy central shutdown must exit successfully and
write the existing Platform `runtime-stop.json` report with state `stopped`.
Only resources whose ownership is freshly verified may be removed. Cleanup
uses bounded retries and fresh inventories, with a 180-second shared deadline.
Unsettled cleanup, uncertain creation or failed graceful-stop proof fail the run;
successful bounded retries remain visible in the receipt. A startup command
timeout cannot be declared settled just from an empty resource snapshot. Never
use broad Docker prune/reset
commands or modify another preview to recover a failed test.

The prepared image, source checkout, dependency cache and summary artifacts are
retained for repeatable review. They are separate from the temporary runtime's
containers, networks and synthetic volume. Remove only your own retained
artifacts when no longer needed.
