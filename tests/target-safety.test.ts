// Test classification: integration
// Review status: Not Reviewed
// Evidence: synthetic
// Scope: the loopback-only client guard rejects other origins, redirects and address forms before any request; it does not test real network egress controls.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startSyntheticApi } from './fixtures/synthetic-api.js';
import type { SyntheticApi } from './fixtures/synthetic-api.js';
import { createLocalHttpClient } from './http-client.js';

describe('Given a client configured for one owned loopback fixture', { timeout: 15_000 }, () => {
  let fixture: SyntheticApi | undefined;
  let unconfiguredFixture: SyntheticApi | undefined;
  let client: ReturnType<typeof createLocalHttpClient>;

  before(async () => {
    unconfiguredFixture = await startSyntheticApi();
    fixture = await startSyntheticApi({ redirectTarget: `${unconfiguredFixture.origin}/health` });
    client = createLocalHttpClient(fixture.origin);
  });

  after(async () => {
    await Promise.all([fixture?.close(), unconfiguredFixture?.close()]);
  });

  it('When the configured fixture is requested, then its response succeeds', async () => {
    const response = await client.request('/health');

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ok',
      source: 'local-synthetic-api',
    });
  });

  it('When another local fixture origin is requested, then it is rejected before receiving a request', async () => {
    const requestCountBefore = unconfiguredFixture?.requestCount;

    assert.throws(
      () => client.request(`${unconfiguredFixture?.origin}/health`),
      /not the configured loopback fixture/,
    );

    assert.equal(unconfiguredFixture?.requestCount, requestCountBefore);
    assert.equal(unconfiguredFixture?.requestCount, 0);
  });

  it('When a response redirects to another fixture, then the redirect is rejected without contacting it', async () => {
    const requestCountBefore = unconfiguredFixture?.requestCount;

    await assert.rejects(client.request('/redirect', { redirect: 'follow' }));

    assert.equal(unconfiguredFixture?.requestCount, requestCountBefore);
    assert.equal(unconfiguredFixture?.requestCount, 0);
  });

  it('When a destination uses another host, address, or scheme, then it is rejected before any request', async () => {
    const port = new URL(fixture?.origin ?? 'http://127.0.0.1').port;
    const rejectedDestinations = [
      `http://localhost:${port}/health`,
      `http://127.0.0.2:${port}/health`,
      `http://[::1]:${port}/health`,
      `https://127.0.0.1:${port}/health`,
      'http://192.0.2.1/health',
      'https://example.invalid/health',
    ];
    const fixtureRequestCountBefore = fixture?.requestCount;

    for (const destination of rejectedDestinations) {
      assert.throws(
        () => client.request(destination),
        /not the configured loopback fixture/,
        destination,
      );
    }

    assert.equal(fixture?.requestCount, fixtureRequestCountBefore);
    assert.equal(unconfiguredFixture?.requestCount, 0);
  });

  it('When the configured origin is not an explicit HTTP IPv4 loopback fixture, then client creation is rejected', () => {
    assert.throws(() => createLocalHttpClient('http://localhost:12345'));
    assert.throws(() => createLocalHttpClient('http://127.0.0.1'));
    assert.throws(() => createLocalHttpClient('https://127.0.0.1:12345'));
    assert.throws(() => createLocalHttpClient('http://192.0.2.1:12345'));
  });
});
