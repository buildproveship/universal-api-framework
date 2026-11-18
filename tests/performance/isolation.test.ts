// Test classification: integration
// Review status: Not Reviewed
// Evidence: synthetic
// Scope: k6 child-process isolation from parent environment, configuration and outputs; it does not start the Dev Platform runtime.
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  createK6Invocation,
  isolatedK6Environment,
} from "../../performance/k6-runtime.ts";
import { closeServer } from "../../performance/loopback.ts";

import { k6, root, runner } from "./support.ts";

function isolatedRun(
  t: TestContext,
  overrides: Record<string, string> = {},
  fixture = "passing",
  setup?: (home: string) => void,
) {
  const home = mkdtempSync(path.join(tmpdir(), "rrdapi-k6-isolation-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
  });
  setup?.(home);
  const environment = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    K6_NO_USAGE_REPORT: "true",
    ...overrides,
  };
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--profile",
      "direct-mock",
      "--workload",
      "smoke",
      "--fixture",
      fixture,
    ],
    { cwd: root, env: environment, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.error, undefined, result.error?.message);
  return { result, home };
}

describe("RRDAPI-10 child-process isolation", { timeout: 45_000 }, () => {
  it("disables telemetry, exports, inherited environment and the control server explicitly", () => {
    const invocation = createK6Invocation(
      { PERF_WORKLOAD: "smoke" },
      "workload.js",
      "owned.json",
    );
    assert.deepEqual(invocation.env, {});
    assert.deepEqual(isolatedK6Environment(), {});
    for (const setting of [
      "--no-usage-report",
      "--no-thresholds=false",
      "--no-summary=false",
      "--include-system-env-vars=false",
      "--traces-output=none",
      "--log-output=stderr",
      "--address=",
    ])
      assert.ok(invocation.args.includes(setting), setting);
    assert.deepEqual(invocation.args.slice(2, 4), ["--config", "owned.json"]);
    assert.throws(() =>
      createK6Invocation({ K6_OUT: "unapproved" }, "workload.js", "owned.json"),
    );
  });

  it("cannot disable failure thresholds through the parent environment", (t) => {
    const { result } = isolatedRun(t, { K6_NO_THRESHOLDS: "true" }, "failing");
    assert.notEqual(
      result.status,
      0,
      "K6_NO_THRESHOLDS must not make failed business checks green",
    );
    assert.match(result.stdout, /smoke failed with 2 requests/);
  });

  it("ignores a parent metrics-output override", (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "rrdapi-k6-output-"));
    t.after(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    const output = path.join(directory, "unapproved-metrics.json");
    const { result } = isolatedRun(t, { K6_OUT: `json=${output}` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      existsSync(output),
      false,
      "K6_OUT must not create an unapproved exporter",
    );
  });

  it("ignores a parent config-path override", (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "rrdapi-k6-config-"));
    t.after(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    const output = path.join(directory, "unapproved-config-metrics.json");
    const config = path.join(directory, "foreign-config.json");
    writeFileSync(
      config,
      JSON.stringify({ out: [`json=${output}`], noUsageReport: true }),
    );
    const { result } = isolatedRun(t, { K6_CONFIG: config });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      existsSync(output),
      false,
      "K6_CONFIG must not load caller-selected configuration",
    );
  });

  it("does not load the default user configuration", (t) => {
    const { result, home } = isolatedRun(t, {}, "passing", (directory) => {
      const output = path.join(directory, "unapproved-default-metrics.json");
      for (const config of [
        path.join(
          directory,
          "Library",
          "Application Support",
          "loadimpact",
          "k6",
          "config.json",
        ),
        path.join(directory, ".config", "loadimpact", "k6", "config.json"),
      ]) {
        mkdirSync(path.dirname(config), { recursive: true });
        writeFileSync(
          config,
          JSON.stringify({ out: [`json=${output}`], noUsageReport: true }),
        );
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      existsSync(path.join(home, "unapproved-default-metrics.json")),
      false,
      "The parent HOME must not supply a default k6 configuration",
    );
  });

  it("accepts an owned loopback port below the macOS ephemeral range without traffic", async (t) => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end();
    });
    const port = await new Promise<number>((resolve, reject) => {
      let candidate = 49151;
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code !== "EADDRINUSE" || candidate <= 49000) {
          reject(error);
          return;
        }
        server.listen(--candidate, "127.0.0.1");
      };
      server.on("error", onError);
      server.once("listening", () => {
        server.removeListener("error", onError);
        resolve((server.address() as AddressInfo).port);
      });
      server.listen(candidate, "127.0.0.1");
    });
    t.after(() => closeServer(server));
    const result = spawnSync(
      k6,
      [
        "inspect",
        "--env",
        `PERF_TARGET=http://127.0.0.1:${port}/`,
        "--env",
        `PERF_OWNED_PORT=${port}`,
        "--env",
        "PERF_WORKLOAD=smoke",
        path.join(root, "performance", "workload.js"),
      ],
      { cwd: root, env: {}, encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests, 0, "Inspection must never execute a workload");
    for (const ownedPort of ["", String(port - 1)]) {
      const rejected = spawnSync(
        k6,
        [
          "inspect",
          "--env",
          `PERF_TARGET=http://127.0.0.1:${port}/`,
          "--env",
          `PERF_OWNED_PORT=${ownedPort}`,
          "--env",
          "PERF_WORKLOAD=smoke",
          path.join(root, "performance", "workload.js"),
        ],
        { cwd: root, env: {}, encoding: "utf8", timeout: 5000 },
      );
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /not an approved owned loopback runtime/);
    }
    assert.equal(
      requests,
      0,
      "Missing or mismatched ownership must fail before traffic",
    );
  });
});
