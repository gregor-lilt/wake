// Runtime adapter: one HTTP + WebSocket server API, two backends.
//
//   Bun   -> Bun.serve with its native WebSocket upgrade
//   Node  -> node:http plus the `ws` package, wrapped in web-standard
//            Request/Response so the application code never sees the
//            difference.
//
// The application hands over a `fetch(Request) -> Response | Promise<Response>`
// and WebSocket callbacks. A hook handler that holds a PermissionRequest open
// simply returns a Response promise that resolves later; both backends wait.

export interface WsClient {
  send(text: string): void;
  close(): void;
}

export interface ServerHandlers {
  fetch(req: Request): Response | Promise<Response>;
  /** Pathname that upgrades to WebSocket. Everything else is HTTP. */
  wsPath: string;
  ws: {
    open(client: WsClient): void;
    message(client: WsClient, text: string): void;
    close(client: WsClient): void;
  };
}

export interface RunningServer {
  readonly runtime: 'bun' | 'node';
  readonly port: number;
  stop(): Promise<void>;
}

interface BunWebSocket {
  send(data: string): number;
  close(): void;
  data: { client?: WsClient };
}

interface BunServeOptions {
  port: number;
  hostname: string;
  fetch(req: Request, server: BunServer): Response | Promise<Response> | undefined;
  websocket: {
    open(ws: BunWebSocket): void;
    message(ws: BunWebSocket, message: string | ArrayBuffer | Uint8Array): void;
    close(ws: BunWebSocket): void;
  };
}

interface BunServer {
  port: number;
  upgrade(req: Request, opts?: { data?: unknown }): boolean;
  stop(closeActive?: boolean): void | Promise<void>;
}

interface BunGlobal {
  serve(opts: BunServeOptions): BunServer;
}

export function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

export async function startServer(
  host: string,
  port: number,
  handlers: ServerHandlers,
): Promise<RunningServer> {
  return isBun() ? startBun(host, port, handlers) : startNode(host, port, handlers);
}

// ---------------------------------------------------------------- Bun

function startBun(host: string, port: number, handlers: ServerHandlers): RunningServer {
  const bun = (globalThis as unknown as { Bun: BunGlobal }).Bun;
  const server = bun.serve({
    port,
    hostname: host,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === handlers.wsPath) {
        if (srv.upgrade(req, { data: {} })) return undefined;
        return new Response('websocket upgrade failed', { status: 400 });
      }
      return handlers.fetch(req);
    },
    websocket: {
      open(ws) {
        const client: WsClient = {
          send: (text) => {
            ws.send(text);
          },
          close: () => ws.close(),
        };
        ws.data.client = client;
        handlers.ws.open(client);
      },
      message(ws, message) {
        const client = ws.data.client;
        if (!client) return;
        const text =
          typeof message === 'string' ? message : new TextDecoder().decode(message as ArrayBuffer);
        handlers.ws.message(client, text);
      },
      close(ws) {
        const client = ws.data.client;
        if (client) handlers.ws.close(client);
      },
    },
  });
  return {
    runtime: 'bun',
    port: server.port,
    stop: async () => {
      await server.stop(true);
    },
  };
}

// ---------------------------------------------------------------- Node

async function startNode(host: string, port: number, handlers: ServerHandlers): Promise<RunningServer> {
  const http = await import('node:http');
  const { WebSocketServer } = await import('ws');

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const method = req.method ?? 'GET';
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) for (const item of v) headers.append(k, item);
      }
      const body = method === 'GET' || method === 'HEAD' ? null : new Uint8Array(Buffer.concat(chunks));
      const request = new Request(`http://${host}:${port}${req.url ?? '/'}`, { method, headers, body });
      Promise.resolve(handlers.fetch(request))
        .then(async (response) => {
          const out: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            out[key] = value;
          });
          const buf = Buffer.from(await response.arrayBuffer());
          out['content-length'] = String(buf.byteLength);
          res.writeHead(response.status, out);
          res.end(buf);
        })
        .catch((err: unknown) => {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(String(err));
        });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    if (url.pathname !== handlers.wsPath) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: WsClient = {
        send: (text) => ws.send(text),
        close: () => ws.close(),
      };
      handlers.ws.open(client);
      ws.on('message', (data) => handlers.ws.message(client, data.toString()));
      ws.on('close', () => handlers.ws.close(client));
    });
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => ok());
  });
  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : port;
  return {
    runtime: 'node',
    port: bound,
    stop: () =>
      new Promise<void>((ok) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => ok());
      }),
  };
}
