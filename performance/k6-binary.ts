import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/** The k6 version the harness is validated against; CI installs exactly this. */
export const pinnedK6Version = "0.54.0";

/**
 * Absolute path of the `k6` executable found on the caller's PATH, or `undefined`.
 * k6 is installed the official way (Homebrew, the Grafana package, or
 * `grafana/setup-k6-action` in CI); the harness then checks its version.
 */
export function findK6(
  searchPath = process.env.PATH ?? "",
): string | undefined {
  for (const directory of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "k6");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try the next directory */
    }
  }
  return undefined;
}
