import {
  execFile,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as pause } from "node:timers/promises";
import {
  readFile,
  writeFile,
  mkdtemp,
  rm,
  realpath,
  lstat,
  readdir,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
const execute = promisify(execFile);

interface RuntimeConfig {
  revision: string;
  tree: string;
  lockSha256: string;
  wiremockImage: string;
  startupSeconds: number;
  lifetimeSeconds: number;
}
type Labels = Record<string, string>;
/** Fields this module reads from untrusted `docker inspect` output. */
export interface DockerResource {
  Id?: string;
  Name?: string;
  Labels?: Labels;
  Config?: { Labels?: Labels };
}
interface PortBinding {
  HostIp: string;
  HostPort: string;
}
interface DockerContainer extends DockerResource {
  Id: string;
  Image: string;
  Config: { Labels: Labels };
  State: { Running: boolean; ExitCode: number };
  NetworkSettings: {
    Ports?: Record<string, PortBinding[] | null>;
    Networks: Record<string, unknown>;
  };
  HostConfig: { NetworkMode: string };
  Mounts: { Destination: string; Source: string; RW?: boolean }[];
}
interface DockerNetwork extends DockerResource {
  Name: string;
  Labels: Labels;
  Internal: boolean;
  Driver: string;
}
interface OwnedResources {
  container: DockerContainer[];
  network: DockerNetwork[];
  volume: DockerResource[];
}
type ResourceKind = keyof OwnedResources;
const RESOURCE_KINDS: readonly ResourceKind[] = [
  "container",
  "network",
  "volume",
];
/** Fields this module reads from untrusted `docker compose config --format json` output. */
interface ComposeService {
  labels?: Labels;
  pull_policy?: string;
  image?: string;
  read_only?: boolean;
  privileged?: boolean;
  build?: unknown;
  devices?: unknown[];
  cap_add?: unknown[];
  cap_drop?: string[];
  security_opt?: string[];
  env_file?: unknown;
  secrets?: unknown[];
  external_links?: unknown[];
  environment?: Record<string, string>;
  network_mode?: string;
  networks?: Record<string, unknown>;
  ports?: { host_ip?: string; published?: string | number; target?: number }[];
  volumes?: {
    type?: string;
    source?: string;
    target?: string;
    read_only?: boolean;
  }[];
}
export interface ComposeModel {
  services?: Record<string, ComposeService>;
  networks?: Record<
    string,
    { labels?: Labels; external?: boolean; internal?: boolean }
  >;
  volumes?: Record<string, { labels?: Labels; external?: boolean }>;
}
type DockerRun = (args: string[], timeout?: number) => Promise<string>;
type DockerJson = <T = unknown>(args: string[]) => Promise<T>;
import {
  settlementOf,
  withSettlement,
  type CleanupFailure,
  type Settlement,
} from "./settlement.ts";
export type { Settlement, SettlementError } from "./settlement.ts";

export const runtimeConfig: Readonly<RuntimeConfig> = Object.freeze(
  JSON.parse(
    await readFile(
      new URL("./config/platform-runtime.json", import.meta.url),
      "utf8",
    ),
  ) as RuntimeConfig,
);
const OWNER = "releaseready.performance.owner";
const PROJECT = "com.docker.compose.project";
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
check(
  Number.isInteger(runtimeConfig.startupSeconds) &&
    runtimeConfig.startupSeconds > 0 &&
    runtimeConfig.startupSeconds <= 120,
  "Invalid startup bound",
);
check(
  Number.isInteger(runtimeConfig.lifetimeSeconds) &&
    runtimeConfig.lifetimeSeconds > runtimeConfig.startupSeconds &&
    runtimeConfig.lifetimeSeconds <= 600,
  "Invalid lifetime bound",
);
const same = (a: object, b: object) =>
  JSON.stringify(Object.entries(a).sort()) ===
  JSON.stringify(Object.entries(b).sort());
export function assertImageId(image: unknown): asserts image is string {
  check(
    typeof image === "string" && /^sha256:[a-f0-9]{64}$/.test(image),
    "An immutable local image ID is required",
  );
}
export function assertLocalContext(
  context: { Endpoints?: { docker?: { Host?: unknown } } } | undefined,
): string {
  const host = context?.Endpoints?.docker?.Host;
  check(
    typeof host === "string" &&
      host.startsWith("unix:///") &&
      !host.includes("\n"),
    "Only a local Unix Docker context is permitted",
  );
  return host;
}
export function assertOwned(
  resource: DockerResource | undefined,
  project: string,
  owner: string,
): void {
  const labels = resource?.Config?.Labels ?? resource?.Labels ?? {};
  check(
    labels[OWNER] === owner && labels[PROJECT] === project,
    "Refusing a foreign Docker resource",
  );
}
export function makeOverlay(owner: string): string {
  check(/^[a-zA-Z0-9-]+$/.test(owner), "Invalid owner");
  const labels = `labels: { ${OWNER}: ${owner} }`;
  return `services:\n  gateway:\n    ${labels}\n  ingress:\n    ${labels}\n    ports: !override ["127.0.0.1:0:33336"]\n  wiremock:\n    ${labels}\n  central:\n    ${labels}\n    environment: !override\n      NODE_ENV: development\n      RR_ENVIRONMENT: dev\n      PLAYWRIGHT_BROWSERS_PATH: /ms-playwright\nnetworks:\n  dev:\n    ${labels}\n  ingress:\n    ${labels}\nvolumes:\n  data:\n    ${labels}\n`;
}
export function validateModel(
  model: ComposeModel,
  {
    image,
    owner,
    platformRoot,
  }: { image: string; owner: string; platformRoot: string },
): void {
  const services = model.services ?? {};
  const networks = model.networks ?? {};
  const volumes = model.volumes ?? {};
  check(
    Object.keys(services).sort().join(",") ===
      "central,gateway,ingress,wiremock",
    "Unexpected services",
  );
  check(
    Object.keys(networks).sort().join(",") === "dev,ingress" &&
      Object.keys(volumes).join(",") === "data",
    "Unexpected resources",
  );
  for (const [name, service] of Object.entries(services)) {
    check(
      service.labels?.[OWNER] === owner && service.pull_policy === "never",
      "Unowned service or image pull",
    );
    check(
      service.image ===
        (name === "wiremock" ? runtimeConfig.wiremockImage : image),
      "Unexpected image",
    );
    check(
      service.read_only &&
        !service.privileged &&
        !service.build &&
        !service.devices?.length &&
        !service.cap_add?.length &&
        service.cap_drop?.includes("ALL") &&
        service.security_opt?.includes("no-new-privileges:true"),
      "Unsafe service privileges",
    );
    check(
      !service.env_file &&
        !service.secrets?.length &&
        !service.external_links?.length,
      "Unexpected external configuration",
    );
    if (name !== "central")
      check(
        !Object.keys(service.environment ?? {}).length,
        "Unexpected service environment",
      );
    if (name !== "ingress")
      check(!service.ports?.length, "Unexpected host publication");
    if (["central", "wiremock"].includes(name))
      check(
        service.network_mode === "service:gateway" && !service.networks,
        "App namespace is not private",
      );
    else
      check(
        !service.network_mode &&
          Object.keys(service.networks ?? {})
            .sort()
            .join(",") === (name === "gateway" ? "dev" : "dev,ingress"),
        "Unexpected service networks",
      );
    if (["gateway", "ingress"].includes(name))
      check(!service.volumes?.length, "Unexpected bind mounts");
  }
  const { ingress, central, wiremock } = services;
  check(ingress && central && wiremock && networks.dev, "Unexpected services");
  const ports = ingress.ports;
  check(
    ports?.length === 1 &&
      ports[0]?.host_ip === "127.0.0.1" &&
      String(ports[0].published) === "0" &&
      ports[0].target === 33336,
    "Publication must use a random loopback port",
  );
  check(
    same(central.environment ?? {}, {
      NODE_ENV: "development",
      RR_ENVIRONMENT: "dev",
      PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
    }),
    "Central environment was not replaced",
  );
  const mounts = wiremock.volumes;
  check(
    mounts?.length === 1 &&
      mounts[0]?.type === "bind" &&
      mounts[0].source === join(platformRoot, "ops/dev/wiremock/mappings") &&
      mounts[0].target === "/home/wiremock/mappings" &&
      mounts[0].read_only,
    "Unexpected mapping mount",
  );
  const data = central.volumes;
  check(
    data?.length === 2 &&
      data.some(
        (v) =>
          v.type === "volume" && v.source === "data" && v.target === "/data",
      ) &&
      data.some(
        (v) =>
          v.type === "bind" &&
          v.source === "/dev/null" &&
          v.target === "/etc/code-quality/config.json" &&
          v.read_only,
      ),
    "Unexpected data mount",
  );
  for (const resource of [
    ...Object.values(networks),
    ...Object.values(volumes),
  ])
    check(
      resource.labels?.[OWNER] === owner && !resource.external,
      "Foreign resource reference",
    );
  check(networks.dev.internal === true, "Dev network must be internal");
}

/** No inherited proxy, Compose overrides, token, or application environment. */
function childEnvironment(image: string): NodeJS.ProcessEnv {
  return {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: homedir(),
    LANG: "C",
    RR_DEV_IMAGE: image,
    DOCKER_CLI_HINTS: "false",
  };
}
async function executable(name: string): Promise<string> {
  for (const directory of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) {
    try {
      const path = await realpath(join(directory, name));
      if ((await lstat(path)).isFile()) return path;
    } catch {
      /* try next trusted location */
    }
  }
  throw new Error(`Required executable unavailable: ${name}`);
}
async function verifySource(
  root: string,
  git: string,
  env: NodeJS.ProcessEnv,
): Promise<{ path: string; sha256: string }[]> {
  const run = async (args: string[]) =>
    (
      await execute(git, ["-C", root, ...args], {
        env,
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "buffer",
      })
    ).stdout;
  check(
    (await run(["rev-parse", "HEAD"])).toString().trim() ===
      runtimeConfig.revision,
    "Platform revision mismatch",
  );
  check(
    (await run(["rev-parse", "HEAD^{tree}"])).toString().trim() ===
      runtimeConfig.tree,
    "Platform tree mismatch",
  );
  check(
    !(await run(["status", "--porcelain", "--untracked-files=all"])).length,
    "Platform source must be clean",
  );
  check(
    sha256(await readFile(join(root, "package-lock.json"))) ===
      runtimeConfig.lockSha256,
    "Platform lock mismatch",
  );
  const files = (
    await run([
      "ls-files",
      "-z",
      "ops/dev/compose.yaml",
      "ops/dev/wiremock/mappings",
    ])
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  check(files.length > 1, "Missing committed mappings");
  const identities = [];
  for (const path of files) {
    const full = join(root, path);
    check(
      (await lstat(full)).isFile() && (await realpath(full)) === full,
      "Mapping or compose path is not a regular canonical file",
    );
    const bytes = await readFile(full);
    check(
      bytes.equals(await run(["show", `${runtimeConfig.revision}:${path}`])),
      "Platform mapping or compose differs from committed blob",
    );
    identities.push({ path, sha256: sha256(bytes) });
  }
  const directory = join(root, "ops/dev/wiremock/mappings");
  check(
    (await readdir(directory)).length === files.length - 1,
    "Unexpected mapping files",
  );
  return identities;
}

/** Verify ownership before deleting anything, and recheck each resource immediately before removal. */
/** The container fields cleanup reads: ownership labels, the service label and the stop state. */
interface CleanupContainer extends DockerResource {
  Id: string;
  Config: { Labels: Labels };
  State?: { Running: boolean; ExitCode?: number };
}
interface CleanupInventory {
  container: CleanupContainer[];
  network: DockerResource[];
  volume: DockerResource[];
}
export interface CleanupOptions {
  resources: () => Promise<CleanupInventory>;
  json: (args: string[]) => Promise<unknown[]>;
  run: (args: string[], timeout?: number) => Promise<unknown>;
  project: string;
  owner: string;
  requireGraceful?: boolean;
  readStopState?: (id: string) => Promise<unknown>;
  creationOutcomeUncertain?: boolean;
  settleDelay?: () => Promise<unknown>;
}
export async function cleanupOwnedResources({
  resources,
  json,
  run,
  project,
  owner,
  requireGraceful = false,
  readStopState,
  creationOutcomeUncertain = false,
  settleDelay = () => pause(250),
}: CleanupOptions): Promise<Settlement> {
  const deadline = Date.now() + 180000;
  const failures: CleanupFailure[] = [];
  let gracefulStopVerified = false;
  const attempt = async <T>(
    operation: string,
    action: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (Date.now() >= deadline) {
      failures.push({ operation, reason: "cleanup deadline exceeded" });
      return undefined;
    }
    try {
      return await action();
    } catch {
      failures.push({
        operation,
        reason: "operation failed or ownership could not be verified",
      });
      return undefined;
    }
  };
  const validateAll = (found: CleanupInventory) => {
    for (const kind of RESOURCE_KINDS)
      for (const resource of found[kind]) assertOwned(resource, project, owner);
    return found;
  };
  let owned = validateAll(await resources());
  const central = owned.container.find(
    (c) => c.Config.Labels["com.docker.compose.service"] === "central",
  );
  if (central) {
    const verified = await attempt("graceful central stop", async () => {
      assertOwned(
        (await json(["container", "inspect", central.Id]))[0] as
          CleanupContainer | undefined,
        project,
        owner,
      );
      await run(["container", "stop", "--time", "45", central.Id], 55000);
      const stopped = (await json(["container", "inspect", central.Id]))[0] as
        CleanupContainer | undefined;
      assertOwned(stopped, project, owner);
      check(stopped?.State && !stopped.State.Running, "Central did not stop");
      return (
        requireGraceful &&
        stopped.State.ExitCode === 0 &&
        (await readStopState?.(central.Id)) === "stopped"
      );
    });
    gracefulStopVerified = verified === true;
  }
  // Every removal is independently re-inspected. A failed stop never prevents
  // disposing other owned resources, and forced cleanup cannot prove gracefulness.
  let stableEmptyObservations = 0;
  for (let pass = 0; pass < 5 && Date.now() < deadline; pass++) {
    for (const kind of RESOURCE_KINDS) {
      for (const resource of owned[kind]) {
        const id = resource.Id ?? resource.Name;
        if (id === undefined) {
          failures.push({
            operation: `${kind} removal`,
            reason: "operation failed or ownership could not be verified",
          });
          continue;
        }
        await attempt(`${kind} removal`, async () => {
          assertOwned(
            (await json([kind, "inspect", id]))[0] as
              DockerResource | undefined,
            project,
            owner,
          );
          await run(
            kind === "container" ? [kind, "rm", "-f", id] : [kind, "rm", id],
          );
        });
      }
    }
    const next = await attempt("resource settlement inspection", async () =>
      validateAll(await resources()),
    );
    if (next) owned = next;
    stableEmptyObservations =
      next && RESOURCE_KINDS.every((kind) => !next[kind].length)
        ? stableEmptyObservations + 1
        : 0;
    if (stableEmptyObservations >= 3 && !creationOutcomeUncertain) {
      return {
        settled: true,
        gracefulStopVerified,
        project,
        cleanupFailures: failures,
        remainingOwnedResources: [],
        creationOutcomeUncertain: false,
      };
    }
    await settleDelay();
  }
  const remainingOwnedResources = RESOURCE_KINDS.flatMap((kind) =>
    owned[kind].map((resource: DockerResource) => ({
      kind,
      id: resource.Id ?? resource.Name,
    })),
  );
  const error = new AggregateError(
    failures.map(
      (failure) => new Error(`${failure.operation}: ${failure.reason}`),
    ),
    "Bounded cleanup could not verify resource settlement",
  );
  throw withSettlement(error, {
    settled: false,
    gracefulStopVerified,
    project,
    cleanupFailures: failures,
    remainingOwnedResources,
    remainingResourcesMayBeStale: true,
    creationOutcomeUncertain,
    stableEmptyObservations,
  });
}

/** Preserve cleanup evidence when startup fails before returning a runtime handle. */
export async function failStartupWithSettlement(
  error: unknown,
  close: () => Promise<Partial<Settlement> | undefined>,
  fallback: {
    project?: string;
    owner?: string;
    creationOutcomeUncertain?: boolean;
  },
): Promise<never> {
  let result: Partial<Settlement> | undefined, cleanupError: unknown;
  try {
    result = await close();
  } catch (failure) {
    cleanupError = failure;
    result = settlementOf(failure);
  }
  const input: Partial<Settlement> = result ?? {};
  const identifier = (value: unknown) =>
    typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value)
      ? value
      : undefined;
  const settlement: Settlement = {
    settled: input.settled === true,
    gracefulStopVerified: input.gracefulStopVerified === true,
    project: identifier(input.project) ?? identifier(fallback.project),
    owner: identifier(fallback.owner),
    creationOutcomeUncertain:
      input.creationOutcomeUncertain === true ||
      fallback.creationOutcomeUncertain === true,
    remainingOwnedResources: Array.isArray(input.remainingOwnedResources)
      ? input.remainingOwnedResources
          .filter(
            (r) =>
              ["container", "network", "volume"].includes(r.kind) &&
              identifier(r.id),
          )
          .map((r) => ({ kind: r.kind, id: r.id }))
      : [],
    remainingResourcesMayBeStale:
      !result || input.remainingResourcesMayBeStale === true,
    remainingResourcesKnown:
      !!result && Array.isArray(input.remainingOwnedResources),
  };
  const observations = input.stableEmptyObservations;
  if (typeof observations === "number" && Number.isInteger(observations))
    settlement.stableEmptyObservations = observations;
  if (Array.isArray(input.cleanupFailures))
    settlement.cleanupFailureCount = input.cleanupFailures.length;
  if (cleanupError) {
    throw withSettlement(
      new AggregateError(
        [error, cleanupError],
        "Runtime failed and cleanup could not be verified",
      ),
      settlement,
    );
  }
  throw withSettlement(
    error instanceof Error ? error : new Error("Runtime startup failed"),
    settlement,
  );
}

export interface PlatformRuntime {
  baseUrl: string;
  evidence: () => Promise<PlatformEvidence>;
  close: () => Promise<Settlement>;
}
interface PlatformEvidence {
  project: string;
  baseUrl: string;
  image: string;
  wiremockImage: string;
  wiremockImageId: string;
  source: { revision: string; tree: string; lockSha256: string };
  mappings: { path: string; sha256: string }[];
  noDefaultRoute: boolean;
  matchedLoginRequests: number;
  unmatchedRequests: number;
}
export async function startPlatformRuntime({
  platformRoot,
  image,
  signal,
}: {
  platformRoot?: unknown;
  image?: unknown;
  signal?: AbortSignal;
} = {}): Promise<PlatformRuntime> {
  assertImageId(image);
  check(
    typeof platformRoot === "string" && isAbsolute(platformRoot),
    "An absolute Platform source path is required",
  );
  check(!signal?.aborted, "Runtime start aborted");
  const root = await realpath(resolve(platformRoot));
  const env = childEnvironment(image);
  const [docker, git] = await Promise.all([
    executable("docker"),
    executable("git"),
  ]);
  let cleanupDeadline: number | undefined,
    creationOutcomeUncertain = false;
  const raw = async (args: string[], timeout = 20000): Promise<string> => {
    if (cleanupDeadline !== undefined) {
      check(Date.now() < cleanupDeadline, "Cleanup deadline exceeded");
      timeout = Math.min(timeout, Math.max(1, cleanupDeadline - Date.now()));
    }
    try {
      return await new Promise<string>((resolveOutput, reject) => {
        let timedOut = false,
          groupKillSent = false;
        // execFile passes options through to spawn, so `detached` takes effect even
        // though @types/node omits it from ExecFileOptions.
        const options: ExecFileOptionsWithStringEncoding & {
          detached: boolean;
        } = {
          env,
          detached: true,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8",
        };
        const child = execFile(docker, args, options, (error, stdout) => {
          clearTimeout(timeoutHandle);
          if (error || timedOut) {
            if (error?.killed || error?.signal) {
              if (args.includes("compose") && args.includes("up"))
                creationOutcomeUncertain = true;
              if (child.pid && !groupKillSent) {
                groupKillSent = true;
                try {
                  process.kill(-child.pid, "SIGKILL");
                } catch {
                  /* already exited */
                }
              }
            }
            reject(new Error("Docker command failed"));
          } else resolveOutput(stdout.trim());
        });
        // Detached children have their own process group. Never signal the parent
        // or unrelated Docker commands; kill only this exact invocation's group.
        const timeoutHandle = setTimeout(() => {
          timedOut = true;
          if (args.includes("compose") && args.includes("up"))
            creationOutcomeUncertain = true;
          if (child.pid && !groupKillSent) {
            groupKillSent = true;
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* already exited */
            }
          }
          reject(new Error("Docker command timed out"));
        }, timeout);
      });
    } catch {
      throw new Error(`Docker operation failed: ${String(args[0])}`);
    }
  };
  const contextName = await raw(["context", "show"]);
  const host = assertLocalContext(
    (
      JSON.parse(await raw(["context", "inspect", contextName])) as Parameters<
        typeof assertLocalContext
      >[0][]
    )[0],
  );
  check(
    (await lstat(host.slice("unix://".length))).isSocket(),
    "Docker endpoint is not a local socket",
  );
  // Freeze the selected endpoint; later context changes cannot redirect commands.
  const run: DockerRun = (args, timeout) =>
    raw(["--host", host, ...args], timeout);
  const json: DockerJson = async <T>(args: string[]) =>
    JSON.parse(await run(args)) as T;
  interface ImageInspect {
    Id: string;
    RepoDigests?: string[];
    Config?: { Labels?: Labels };
  }
  const identities = await verifySource(root, git, env);
  const appImage = (await json<ImageInspect[]>(["image", "inspect", image]))[0];
  check(appImage?.Id === image, "Application image mismatch");
  const labels = appImage.Config?.Labels ?? {};
  check(
    labels["releaseready.source.revision"] === runtimeConfig.revision &&
      labels["releaseready.source.tree"] === runtimeConfig.tree &&
      labels["releaseready.package-lock.sha256"] === runtimeConfig.lockSha256,
    "Image source identity labels do not match",
  );
  const mockImage = (
    await json<ImageInspect[]>([
      "image",
      "inspect",
      runtimeConfig.wiremockImage,
    ])
  )[0];
  check(mockImage, "WireMock digest is unavailable locally");
  check(
    mockImage.RepoDigests?.includes(
      runtimeConfig.wiremockImage.replace(":3.13.2@", "@"),
    ),
    "WireMock digest is unavailable locally",
  );
  const owner = randomUUID(),
    project = `rrk6-${owner}`;
  const temporary = await mkdtemp(join(tmpdir(), "rrk6-runtime-"));
  const overlay = join(temporary, "overlay.yaml");
  let began = false,
    healthy = false,
    gracefulStopFailed = false,
    starting = true,
    closed = false;
  let closing: Promise<Settlement> | undefined,
    timer: NodeJS.Timeout | undefined,
    shutdownError: unknown;
  const compose = [
    "compose",
    "--project-name",
    project,
    "--project-directory",
    join(root, "ops/dev"),
    "--env-file",
    "/dev/null",
    "-f",
    join(root, "ops/dev/compose.yaml"),
    "-f",
    overlay,
  ];
  const resources = async (): Promise<OwnedResources> => {
    const found: OwnedResources = { container: [], network: [], volume: [] };
    for (const kind of RESOURCE_KINDS) {
      const args =
        kind === "container" ? ["container", "ls", "-aq"] : [kind, "ls", "-q"];
      const ids = (
        await run([...args, "--filter", `label=${PROJECT}=${project}`])
      )
        .split("\n")
        .filter(Boolean);
      const inspected = ids.length
        ? await json<DockerResource[]>([kind, "inspect", ...ids])
        : [];
      for (const resource of inspected) assertOwned(resource, project, owner);
      (found[kind] as DockerResource[]) = inspected;
    }
    return found;
  };
  const close = (): Promise<Settlement> =>
    (closing ??= (async () => {
      cleanupDeadline = Date.now() + 180000;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      process.removeListener("SIGINT", onAbort);
      process.removeListener("SIGTERM", onAbort);
      let result: Settlement = {
        settled: true,
        gracefulStopVerified: false,
        project,
        remainingOwnedResources: [],
        creationOutcomeUncertain: false,
      };
      if (began) {
        const readStopState = async (id: string) => {
          const path = join(temporary, "runtime-stop.json");
          await run(["container", "cp", `${id}:/data/runtime-stop.json`, path]);
          const bytes = await readFile(path);
          check(bytes.length <= 65536, "Stop report exceeds bound");
          return (JSON.parse(bytes.toString()) as { state?: unknown }).state;
        };
        result = await cleanupOwnedResources({
          resources,
          json,
          run,
          project,
          owner,
          requireGraceful: healthy,
          readStopState,
          creationOutcomeUncertain,
        });
      }
      if (gracefulStopFailed) result.gracefulStopVerified = false;
      await rm(temporary, { recursive: true, force: true });
      closed = true;
      if (healthy && !result.gracefulStopVerified) {
        throw withSettlement(
          new Error(
            "Owned resources removed, but graceful central exit and stopped report were not proved",
          ),
          result,
        );
      }
      return result;
    })().catch((error: unknown) => {
      // Keep an unsettled runtime retryable instead of caching a rejected close forever.
      if (healthy && !settlementOf(error)?.gracefulStopVerified)
        gracefulStopFailed = true;
      if (!closed) closing = undefined;
      throw error;
    }));
  function onAbort() {
    shutdownError = new Error("Runtime interrupted or lifetime exceeded");
    // Await the bounded Compose creation before enumerating resources for cleanup.
    if (!starting)
      void close().catch((error: unknown) => {
        shutdownError = error;
      });
  }
  try {
    await writeFile(overlay, makeOverlay(owner), { mode: 0o600 });
    validateModel(
      await json<ComposeModel>([...compose, "config", "--format", "json"]),
      {
        image,
        owner,
        platformRoot: root,
      },
    );
    check(!signal?.aborted, "Runtime start aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    process.once("SIGINT", onAbort);
    process.once("SIGTERM", onAbort);
    timer = setTimeout(onAbort, runtimeConfig.lifetimeSeconds * 1000);
    timer.unref();
    const existing = await resources();
    check(
      RESOURCE_KINDS.every((kind) => !existing[kind].length),
      "Runtime project already exists",
    );
    // Compose start is bounded. Do not start cleanup concurrently with an in-flight creation.
    began = true;
    await run(
      [
        ...compose,
        "up",
        "--detach",
        "--no-build",
        "--pull",
        "never",
        "--wait",
        "--wait-timeout",
        String(runtimeConfig.startupSeconds),
      ],
      (runtimeConfig.startupSeconds + 15) * 1000,
    );
    healthy = true;
    starting = false;
    healthy = true; // Compose --wait completed; even a pending cancellation requires graceful proof.
    check(
      !shutdownError && !signal?.aborted,
      "Runtime interrupted during startup",
    );
    const owned = await resources();
    const ingress = owned.container.find(
      (c) => c.Config.Labels["com.docker.compose.service"] === "ingress",
    );
    const publications = ingress?.NetworkSettings.Ports?.["33336/tcp"];
    const publication =
      publications?.length === 1 ? publications[0] : undefined;
    check(
      publication?.HostIp === "127.0.0.1",
      "Unsafe actual ingress publication",
    );
    const port = Number(publication.HostPort);
    check(
      Number.isInteger(port) &&
        port > 1024 &&
        port <= 65535 &&
        ![33336, 38089].includes(port),
      "Unsafe actual ingress port",
    );
    const baseUrl = `http://127.0.0.1:${port}`;
    const evidence = async (): Promise<PlatformEvidence> => {
      check(
        !closed && !shutdownError && !closing,
        "Runtime is no longer available",
      );
      const actual = await resources();
      check(
        actual.container.length === 4 &&
          actual.network.length === 2 &&
          actual.volume.length === 1,
        "Incomplete runtime resources",
      );
      const services: Partial<Record<string, DockerContainer>> =
        Object.fromEntries(
          actual.container.map((c) => [
            c.Config.Labels["com.docker.compose.service"] ?? "",
            c,
          ]),
        );
      const { ingress: ingressService, central, wiremock, gateway } = services;
      check(
        ingressService && central && wiremock && gateway,
        "Incomplete runtime resources",
      );
      for (const [name, c] of Object.entries(services))
        check(
          c?.State.Running &&
            c.Image === (name === "wiremock" ? mockImage.Id : image),
          "Actual image or running state mismatch",
        );
      const currentPorts = ingressService.NetworkSettings.Ports?.["33336/tcp"];
      check(
        currentPorts?.length === 1 &&
          currentPorts[0]?.HostIp === "127.0.0.1" &&
          Number(currentPorts[0].HostPort) === port,
        "Actual endpoint changed",
      );
      for (const service of [central, wiremock, gateway])
        check(
          !Object.values(service.NetworkSettings.Ports ?? {}).some(
            (bindings) => bindings?.length,
          ),
          "Unexpected actual publication",
        );
      const dev = actual.network.find(
        (n) => n.Labels["com.docker.compose.network"] === "dev",
      );
      check(
        dev?.Internal === true && dev.Driver === "bridge",
        "Actual Dev network is not internal",
      );
      for (const service of [central, wiremock])
        check(
          service.HostConfig.NetworkMode === `container:${gateway.Id}`,
          "Actual namespace is not isolated",
        );
      check(
        Object.keys(gateway.NetworkSettings.Networks).length === 1 &&
          gateway.NetworkSettings.Networks[dev.Name],
        "Gateway attached to unexpected networks",
      );
      const mapping = wiremock.Mounts.filter(
        (m) => m.Destination === "/home/wiremock/mappings",
      );
      check(
        mapping.length === 1 &&
          mapping[0]?.Source === join(root, "ops/dev/wiremock/mappings") &&
          mapping[0].RW === false,
        "Actual mapping mount mismatch",
      );
      const script = `const fs=require('node:fs');(async()=>{const routes=fs.readFileSync('/proc/net/route','utf8').trim().split('\\n').slice(1);const noDefaultRoute=!routes.some(l=>l.trim().split(/\\s+/)[1]==='00000000');const count=await fetch('http://127.0.0.1:38089/__admin/requests/count',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'GET',url:'/dev/identity/developer-a'})}).then(r=>{if(!r.ok)throw Error();return r.json()});const unmatched=await fetch('http://127.0.0.1:38089/__admin/requests/unmatched').then(r=>{if(!r.ok)throw Error();return r.json()});console.log(JSON.stringify({noDefaultRoute,matchedLoginRequests:count.count,unmatchedRequests:unmatched.requests.length}));})().catch(()=>process.exitCode=1)`;
      const aggregates = JSON.parse(
        await run(["exec", central.Id, "node", "-e", script]),
      ) as Pick<
        PlatformEvidence,
        "noDefaultRoute" | "matchedLoginRequests" | "unmatchedRequests"
      >;
      check(
        aggregates.noDefaultRoute &&
          Number.isInteger(aggregates.matchedLoginRequests) &&
          aggregates.unmatchedRequests === 0,
        "Runtime isolation or mock matching failed",
      );
      return {
        project,
        baseUrl,
        image,
        source: {
          revision: runtimeConfig.revision,
          tree: runtimeConfig.tree,
          lockSha256: runtimeConfig.lockSha256,
        },
        wiremockImage: runtimeConfig.wiremockImage,
        wiremockImageId: mockImage.Id,
        mappings: identities,
        ...aggregates,
      };
    };
    // Startup may have no login requests yet; the caller must require a positive count after workload.
    await evidence();
    return { baseUrl, evidence, close };
  } catch (error) {
    starting = false;
    return failStartupWithSettlement(error, close, {
      project,
      owner,
      creationOutcomeUncertain,
    });
  }
}
