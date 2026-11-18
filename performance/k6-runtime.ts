// k6 normally reads ambient options, user configuration and remote outputs.
// Only this harness supplies its runtime settings. No parent credentials,
// proxy, telemetry, exporter or K6_* settings are inherited.
export function isolatedK6Environment(): NodeJS.ProcessEnv {
  return {};
}

export function createK6Invocation(
  environment: Record<string, string>,
  workloadPath: string,
  configPath: string,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const allowed = new Set([
    "PERF_TARGET",
    "PERF_OWNED_PORT",
    "PERF_WORKLOAD",
    "PERF_REVISION",
    "PERF_WORKTREE_DIRTY",
    "PERF_K6_VERSION",
    "PERF_SUMMARY_PATH",
    "PERF_PROFILE",
    "PERF_EXPECT_FAILURE",
  ]);
  const environmentArguments = Object.entries(environment).flatMap(
    ([key, value]) => {
      if (!allowed.has(key))
        throw new Error("Unsupported internal k6 runtime setting.");
      return ["--env", `${key}=${value}`];
    },
  );
  return {
    args: [
      "run",
      "--quiet",
      "--config",
      configPath,
      "--no-usage-report",
      "--no-thresholds=false",
      "--no-summary=false",
      "--include-system-env-vars=false",
      "--traces-output=none",
      "--log-output=stderr",
      "--address=",
      ...environmentArguments,
      workloadPath,
    ],
    env: isolatedK6Environment(),
  };
}
