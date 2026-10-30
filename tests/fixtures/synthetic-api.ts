import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SyntheticApi {
  readonly origin: string;
  close(): Promise<void>;
}

export async function startSyntheticApi(): Promise<SyntheticApi> {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      response.writeHead(405);
      response.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    switch (request.url) {
      case '/health':
        response.writeHead(200);
        response.end(JSON.stringify({ status: 'ok', source: 'local-synthetic-api' }));
        return;
      case '/widgets/widget-1':
        response.writeHead(200);
        response.end(JSON.stringify({ id: 'widget-1', name: 'Synthetic widget', active: true }));
        return;
      default:
        response.writeHead(404);
        response.end(JSON.stringify({ error: 'not_found' }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}
