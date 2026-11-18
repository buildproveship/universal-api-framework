// Test classification: integration
// Review status: Not Reviewed
// Evidence: synthetic
// Scope: test-only synthetic HTTP API on IPv4 loopback used by the smoke, target-safety and intake suites.
import { createServer } from "node:http";
import { closeServer, listenOnLoopback } from "../../performance/loopback.js";

export interface SyntheticApi {
  readonly origin: string;
  readonly requestCount: number;
  close(): Promise<void>;
}

export async function startSyntheticApi(
  options: { redirectTarget?: string } = {},
): Promise<SyntheticApi> {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    response.setHeader("Content-Type", "application/json; charset=utf-8");

    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      response.writeHead(405);
      response.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    switch (request.url) {
      case "/health":
        response.writeHead(200);
        response.end(
          JSON.stringify({ status: "ok", source: "local-synthetic-api" }),
        );
        return;
      case "/widgets/widget-1":
        response.writeHead(200);
        response.end(
          JSON.stringify({
            id: "widget-1",
            name: "Synthetic widget",
            active: true,
          }),
        );
        return;
      case "/redirect":
        if (options.redirectTarget) {
          response.writeHead(302, { Location: options.redirectTarget });
          response.end();
          return;
        }
        break;
      default:
        break;
    }

    response.writeHead(404);
    response.end(JSON.stringify({ error: "not_found" }));
  });

  const origin = await listenOnLoopback(server);

  return {
    origin,
    get requestCount() {
      return requestCount;
    },
    close: () => closeServer(server),
  };
}
