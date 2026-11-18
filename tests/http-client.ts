// Test classification: integration
// Review status: Not Reviewed
// Evidence: synthetic
// Scope: test-only fetch client that reaches only one configured IPv4 loopback fixture origin; exercised by smoke.test.ts and target-safety.test.ts.
const REQUEST_TIMEOUT_MS = 5_000;

export interface LocalHttpClient {
  request(input: string | URL, init?: RequestInit): Promise<Response>;
}

export function createLocalHttpClient(configuredOrigin: string): LocalHttpClient {
  const allowedOrigin = new URL(configuredOrigin);

  if (
    allowedOrigin.protocol !== 'http:' ||
    allowedOrigin.hostname !== '127.0.0.1' ||
    allowedOrigin.port === '' ||
    allowedOrigin.username !== '' ||
    allowedOrigin.password !== '' ||
    allowedOrigin.pathname !== '/' ||
    allowedOrigin.search !== '' ||
    allowedOrigin.hash !== ''
  ) {
    throw new TypeError('The configured destination must be an HTTP IPv4 loopback fixture origin.');
  }

  return {
    request(input, init = {}) {
      const target = new URL(input, allowedOrigin);

      if (
        target.protocol !== 'http:' ||
        target.hostname !== '127.0.0.1' ||
        target.origin !== allowedOrigin.origin ||
        target.username !== '' ||
        target.password !== ''
      ) {
        throw new TypeError('Request destination is not the configured loopback fixture.');
      }

      return fetch(target, {
        ...init,
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    },
  };
}
