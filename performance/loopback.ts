// One way to own a loopback HTTP server, shared by the performance runner and
// the TypeScript test fixtures. No relative imports, so it runs both through
// Node type stripping and through the tsc build in dist/.
import { once } from 'node:events';
import type { Server } from 'node:http';

/** Listens on an OS-assigned IPv4 loopback port and returns the origin, e.g. `http://127.0.0.1:49152`. */
export async function listenOnLoopback(server: Server): Promise<string> {
  // once() rejects if 'error' fires before 'listening'.
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    throw new Error('The fixture did not bind to IPv4 loopback.');
  }
  return `http://127.0.0.1:${address.port}`;
}

/** Stops accepting connections, closes idle keep-alive sockets and resolves once the server has closed. */
export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeIdleConnections();
  await closed;
}
