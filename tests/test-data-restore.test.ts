// Test classification: unit
// Review status: Not Reviewed
// Evidence: synthetic
// Scope: Checks the restore client against a fake fetch (environment guard, route, mailbox calls); it calls no real app or Mailpit.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRestorableEnvironment,
  createRestoreClient,
} from "../src/test-data-restore/index.js";

interface Call {
  url: string;
  method: string;
  body?: string | undefined;
  auth?: string | undefined;
}

function fakeFetch(respond: (c: Call) => { status?: number; json?: unknown }): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url,
      method: init.method ?? "GET",
      body: init.body as string | undefined,
      auth: headers.authorization,
    };
    calls.push(call);
    const r = respond(call);
    return Promise.resolve(
      new Response(JSON.stringify(r.json ?? {}), {
        status: r.status ?? 200,
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const base = {
  baseUrl: "http://app.test/",
  token: "t",
  mailpitUrl: "http://mail.test",
};

test("production and unknown environments are refused", () => {
  for (const environment of ["prod", "production", "", "staging"]) {
    assert.throws(() => assertRestorableEnvironment(environment));
    assert.throws(() => createRestoreClient({ ...base, environment }));
  }
  assert.equal(assertRestorableEnvironment(" UAT "), "uat");
});

test("restoreAll posts the baseline restore then clears the mailbox", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ json: { restored: true } }));
  await createRestoreClient({
    ...base,
    environment: "dev",
    fetchImpl,
  }).restoreAll();
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [
      "POST http://app.test/api/dev/test-data/restore",
      "DELETE http://mail.test/api/v1/messages",
    ],
  );
  const first = calls[0];
  assert.ok(first);
  assert.equal(first.auth, "Bearer t");
  assert.equal(first.body, '{"scope":"baseline"}');
});

test("an unconfirmed or failed restore throws and the mailbox is left alone", async () => {
  for (const reply of [{ json: { restored: false } }, { status: 500 }]) {
    const { fetchImpl, calls } = fakeFetch(() => reply);
    await assert.rejects(
      createRestoreClient({
        ...base,
        environment: "dev",
        fetchImpl,
      }).restoreAll(),
    );
    assert.equal(calls.length, 1);
  }
});

test("latestCode reads the six-digit code from the newest message to that address", async () => {
  const { fetchImpl } = fakeFetch((c) =>
    c.url.includes("/search")
      ? { json: { messages: [{ ID: "m1" }] } }
      : { json: { Text: "Your code is 482913. Thanks" } },
  );
  const client = createRestoreClient({
    ...base,
    environment: "uat",
    fetchImpl,
  });
  assert.equal(await client.latestCode("a@synthetic.test"), "482913");
});
