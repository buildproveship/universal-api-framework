import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startSyntheticApi } from './fixtures/synthetic-api.js';
import type { SyntheticApi } from './fixtures/synthetic-api.js';
import { createLocalHttpClient } from './http-client.js';

describe('Given an owned local synthetic API', { timeout: 15_000 }, () => {
  let api: SyntheticApi;
  let client: ReturnType<typeof createLocalHttpClient>;

  before(async () => {
    api = await startSyntheticApi();
    client = createLocalHttpClient(api.origin);
  });

  after(async () => {
    await api?.close();
  });

  function request(path: string, method = 'GET'): Promise<Response> {
    return client.request(path, { method });
  }

  it('When health is requested, then it returns HTTP 200 and identifies the synthetic service', async () => {
    const response = await request('/health');

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
    assert.deepEqual(await response.json(), {
      status: 'ok',
      source: 'local-synthetic-api',
    });
  });

  it('When a known widget is requested, then it returns HTTP 200 and the exact fixture data', async () => {
    const response = await request('/widgets/widget-1');

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
    assert.deepEqual(await response.json(), {
      id: 'widget-1',
      name: 'Synthetic widget',
      active: true,
    });
  });

  it('When an unknown widget is requested, then it returns HTTP 404 and a not-found error', async () => {
    const response = await request('/widgets/missing');

    assert.equal(response.status, 404);
    assert.equal(response.ok, false);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
    assert.deepEqual(await response.json(), { error: 'not_found' });
  });

  it('When a write is attempted, then it returns HTTP 405 with the allowed method and an error', async () => {
    const response = await request('/widgets/widget-1', 'POST');

    assert.equal(response.status, 405);
    assert.equal(response.ok, false);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
    assert.deepEqual(await response.json(), { error: 'method_not_allowed' });
  });
});
