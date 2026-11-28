/** Restores Dev/UAT test data to the seeded baseline after a test, and clears the Mailpit mailbox.
 * Production is refused. The app-side route (POST /api/dev/test-data/restore) owns what "baseline" means;
 * this client only calls it, so every framework (Playwright first) shares one implementation.
 */
export const RESTORABLE_ENVIRONMENTS = ["dev", "uat"] as const;
export type RestorableEnvironment = (typeof RESTORABLE_ENVIRONMENTS)[number];

export const RESTORE_SCOPES = ["baseline", "mailbox"] as const;
export type RestoreScope = (typeof RESTORE_SCOPES)[number];

export interface RestoreClientOptions {
  /** Environment name; anything other than dev or uat (including production) is refused. */
  readonly environment: string;
  /** Base URL of the app that serves POST /api/dev/test-data/restore. */
  readonly baseUrl: string;
  /** Bearer token for the protected restore route. */
  readonly token: string;
  /** Mailpit base URL (Dev and UAT catch all email there). Omit to skip mailbox calls. */
  readonly mailpitUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface RestoreClient {
  /** Puts app data back to the seeded baseline. Throws unless the app confirms it. */
  restore(scope?: RestoreScope): Promise<void>;
  /** Deletes every message in Mailpit. */
  purgeMailbox(): Promise<void>;
  /** Restores baseline data and clears the mailbox: the one call a test hook makes. */
  restoreAll(): Promise<void>;
  /** The newest six-digit code mailed to `email`, or undefined when none has arrived. */
  latestCode(email: string): Promise<string | undefined>;
}

export function assertRestorableEnvironment(
  environment: string,
): RestorableEnvironment {
  const name = environment.trim().toLowerCase();
  if (!(RESTORABLE_ENVIRONMENTS as readonly string[]).includes(name)) {
    throw new Error(
      `Test data restore is only allowed in ${RESTORABLE_ENVIRONMENTS.join(" and ")}; refused for "${environment}"`,
    );
  }
  return name as RestorableEnvironment;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/u, "")}${path}`;
}

export function createRestoreClient(
  options: RestoreClientOptions,
): RestoreClient {
  assertRestorableEnvironment(options.environment);
  if (!options.token) {
    throw new Error("Test data restore needs a token");
  }
  const doFetch = options.fetchImpl ?? fetch;

  async function call(url: string, init: RequestInit): Promise<Response> {
    const response = await doFetch(url, init);
    if (!response.ok) {
      throw new Error(
        `${init.method ?? "GET"} ${url} failed: ${response.status}`,
      );
    }
    return response;
  }

  function mailpit(): string {
    if (!options.mailpitUrl) {
      throw new Error("Mailpit URL is not configured");
    }
    return options.mailpitUrl;
  }

  const client: RestoreClient = {
    async restore(scope = "baseline") {
      const response = await call(
        joinUrl(options.baseUrl, "/api/dev/test-data/restore"),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ scope }),
        },
      );
      const body: unknown = await response.json();
      if (
        typeof body !== "object" ||
        body === null ||
        (body as { restored?: unknown }).restored !== true
      ) {
        throw new Error("Restore was not confirmed by the app");
      }
    },
    async purgeMailbox() {
      await call(joinUrl(mailpit(), "/api/v1/messages"), { method: "DELETE" });
    },
    async restoreAll() {
      await client.restore("baseline");
      if (options.mailpitUrl) await client.purgeMailbox();
    },
    async latestCode(email) {
      const search = await call(
        joinUrl(
          mailpit(),
          `/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=1`,
        ),
        { method: "GET" },
      );
      const found = (await search.json()) as {
        messages?: { ID: string }[];
      };
      const id = found.messages?.[0]?.ID;
      if (!id) return undefined;
      const message = await call(
        joinUrl(mailpit(), `/api/v1/message/${encodeURIComponent(id)}`),
        { method: "GET" },
      );
      const text = ((await message.json()) as { Text?: string }).Text ?? "";
      return /\b\d{6}\b/u.exec(text)?.[0];
    },
  };
  return client;
}
