import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { RelayServer } from '../server/relay-server';
import { TunnelClient } from '../client/tunnel-client';
import { TunnelInstance } from '../types';

let RELAY_PORT = 16040;
let LOCAL_PORT = 16041;
const TEST_API_KEY = 'sk_ws_test';
const TEST_DOMAIN = 'tunnel.test.local';

interface LocalWsEvent {
  path: string;
  ws: WebSocket;
}

function waitFor<T>(emitter: WebSocket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), 5000);
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args[0] as T);
    });
    emitter.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('WebSocket passthrough', () => {
  let relayServer: RelayServer;
  let localServer: http.Server;
  let localWss: WebSocketServer;
  let client: TunnelClient;
  let tunnel: TunnelInstance;
  let localConnections: LocalWsEvent[];

  beforeEach(async () => {
    RELAY_PORT += 2;
    LOCAL_PORT += 2;
    localConnections = [];

    relayServer = new RelayServer({
      port: RELAY_PORT,
      apiKeys: [TEST_API_KEY],
      domain: TEST_DOMAIN,
      maxTunnels: 10,
    });
    await relayServer.start();

    // Local app: HTTP + a WebSocket endpoint that echoes frames back
    localServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('http ok');
    });
    localWss = new WebSocketServer({ server: localServer });
    localWss.on('connection', (ws, req) => {
      localConnections.push({ path: req.url || '/', ws });
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          ws.send(Buffer.concat([Buffer.from([0xff]), data]), { binary: true });
        } else {
          ws.send(`echo:${data.toString()}`);
        }
      });
    });

    await new Promise<void>((resolve) => localServer.listen(LOCAL_PORT, resolve));

    client = new TunnelClient({
      port: LOCAL_PORT,
      server: `ws://localhost:${RELAY_PORT}`,
      apiKey: TEST_API_KEY,
      subdomain: 'wstest',
    });
    tunnel = await client.connect();
  });

  afterEach(async () => {
    await tunnel.close();
    localWss.close();
    await new Promise<void>((resolve) => localServer.close(() => resolve()));
    await relayServer.stop();
  });

  function openExternalWs(path = '/socket', subdomain = 'wstest'): WebSocket {
    return new WebSocket(`ws://localhost:${RELAY_PORT}${path}`, {
      headers: { host: `${subdomain}.${TEST_DOMAIN}` },
    });
  }

  it('upgrades an external WebSocket and reaches the local server', async () => {
    const ws = openExternalWs('/socket.io/?EIO=4&transport=websocket');
    await waitFor(ws, 'open');

    // Give the bridge a tick to dial the local server
    await new Promise((r) => setTimeout(r, 100));
    expect(localConnections).toHaveLength(1);
    expect(localConnections[0].path).toBe('/socket.io/?EIO=4&transport=websocket');

    ws.close();
  });

  it('round-trips text frames in both directions', async () => {
    const ws = openExternalWs();
    await waitFor(ws, 'open');

    ws.send('hello');
    const reply = await waitFor<Buffer>(ws, 'message');
    expect(reply.toString()).toBe('echo:hello');

    ws.close();
  });

  it('round-trips binary frames without corruption', async () => {
    const ws = openExternalWs();
    await waitFor(ws, 'open');

    const payload = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x7f, 0x80]);
    ws.send(payload, { binary: true });
    const reply = await waitFor<Buffer>(ws, 'message');
    expect(Buffer.isBuffer(reply)).toBe(true);
    expect(reply.equals(Buffer.concat([Buffer.from([0xff]), payload]))).toBe(true);

    ws.close();
  });

  it('buffers frames sent before the local socket is open', async () => {
    const ws = openExternalWs();
    await waitFor(ws, 'open');
    // Sent immediately after the relay handshake, likely before the local dial completes
    ws.send('early');

    const reply = await waitFor<Buffer>(ws, 'message');
    expect(reply.toString()).toBe('echo:early');

    ws.close();
  });

  it('keeps concurrent sockets independent', async () => {
    const a = openExternalWs('/a');
    const b = openExternalWs('/b');
    await Promise.all([waitFor(a, 'open'), waitFor(b, 'open')]);

    a.send('from-a');
    b.send('from-b');

    const [replyA, replyB] = await Promise.all([
      waitFor<Buffer>(a, 'message'),
      waitFor<Buffer>(b, 'message'),
    ]);
    expect(replyA.toString()).toBe('echo:from-a');
    expect(replyB.toString()).toBe('echo:from-b');

    await new Promise((r) => setTimeout(r, 100));
    expect(localConnections.map((c) => c.path).sort()).toEqual(['/a', '/b']);

    a.close();
    b.close();
  });

  it('propagates close from the external socket to the local socket', async () => {
    const ws = openExternalWs();
    await waitFor(ws, 'open');
    await new Promise((r) => setTimeout(r, 100));

    const localClosed = new Promise<void>((resolve) => {
      localConnections[0].ws.once('close', () => resolve());
    });

    ws.close();
    await localClosed;
  });

  it('propagates close from the local socket to the external socket', async () => {
    const ws = openExternalWs();
    await waitFor(ws, 'open');
    await new Promise((r) => setTimeout(r, 100));

    const closed = waitFor(ws, 'close');
    localConnections[0].ws.close();
    await closed;
  });

  it('tears down external sockets when the tunnel client disconnects', async () => {
    const ws = openExternalWs();
    await waitFor(ws, 'open');
    await new Promise((r) => setTimeout(r, 100));

    const closed = waitFor(ws, 'close');
    await tunnel.close();
    await closed;
  });

  it('rejects an upgrade for an unknown subdomain', async () => {
    const ws = openExternalWs('/socket', 'nosuchtunnel');
    await expect(waitFor(ws, 'open')).rejects.toThrow();
  });

  it('leaves the HTTP request path working', async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: RELAY_PORT,
          path: '/plain',
          headers: { host: `wstest.${TEST_DOMAIN}` },
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () =>
            resolve({ status: r.statusCode || 0, body: Buffer.concat(chunks).toString() })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect(res.status).toBe(200);
    expect(res.body).toBe('http ok');
  });
});
