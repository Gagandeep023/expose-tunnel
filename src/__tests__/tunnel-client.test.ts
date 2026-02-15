import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { RelayServer } from '../server/relay-server';
import { TunnelClient } from '../client/tunnel-client';

let RELAY_PORT = 15040;
let LOCAL_PORT = 15041;
const TEST_API_KEY = 'sk_integration_test';
const TEST_DOMAIN = 'tunnel.test.local';

describe('TunnelClient integration', () => {
  let relayServer: RelayServer;
  let localServer: http.Server;

  beforeEach(async () => {
    RELAY_PORT += 2;
    LOCAL_PORT += 2;
    // Start relay server
    relayServer = new RelayServer({
      port: RELAY_PORT,
      apiKeys: [TEST_API_KEY],
      domain: TEST_DOMAIN,
    });
    await relayServer.start();

    // Start a simple local HTTP server
    localServer = http.createServer((req, res) => {
      if (req.url === '/hello') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('Hello from local!');
      } else if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'local json' }));
      } else if (req.method === 'POST' && req.url === '/echo') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': req.headers['content-type'] || 'text/plain' });
          res.end(Buffer.concat(chunks));
        });
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>((resolve) => {
      localServer.listen(LOCAL_PORT, resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      localServer.close(() => resolve());
    });
    await relayServer.stop();
  });

  it('should connect and receive a tunnel URL', async () => {
    const client = new TunnelClient({
      port: LOCAL_PORT,
      server: `ws://localhost:${RELAY_PORT}`,
      apiKey: TEST_API_KEY,
    });

    const instance = await client.connect();
    expect(instance.url).toContain(TEST_DOMAIN);
    expect(instance.subdomain).toHaveLength(8);
    await instance.close();
  });

  it('should connect with a requested subdomain', async () => {
    const client = new TunnelClient({
      port: LOCAL_PORT,
      server: `ws://localhost:${RELAY_PORT}`,
      apiKey: TEST_API_KEY,
      subdomain: 'mytest',
    });

    const instance = await client.connect();
    expect(instance.subdomain).toBe('mytest');
    expect(instance.url).toBe(`https://mytest.${TEST_DOMAIN}`);
    await instance.close();
  });

  it('should proxy GET requests to local server', async () => {
    const client = new TunnelClient({
      port: LOCAL_PORT,
      server: `ws://localhost:${RELAY_PORT}`,
      apiKey: TEST_API_KEY,
      subdomain: 'gettest',
    });

    const instance = await client.connect();

    // Make request through the tunnel
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: RELAY_PORT,
          path: '/hello',
          headers: { host: `gettest.${TEST_DOMAIN}` },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            resolve({ status: res.statusCode || 500, body: Buffer.concat(chunks).toString() });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect(res.status).toBe(200);
    expect(res.body).toBe('Hello from local!');
    await instance.close();
  });

  it('should proxy POST requests with body', async () => {
    const client = new TunnelClient({
      port: LOCAL_PORT,
      server: `ws://localhost:${RELAY_PORT}`,
      apiKey: TEST_API_KEY,
      subdomain: 'posttest',
    });

    const instance = await client.connect();
    const postBody = JSON.stringify({ test: 'data' });

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: RELAY_PORT,
          path: '/echo',
          method: 'POST',
          headers: {
            host: `posttest.${TEST_DOMAIN}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(postBody).toString(),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            resolve({ status: res.statusCode || 500, body: Buffer.concat(chunks).toString() });
          });
        }
      );
      req.on('error', reject);
      req.write(postBody);
      req.end();
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ test: 'data' });
    await instance.close();
  });

  it('should return 502 when local server is not reachable', async () => {
    // Connect to a port where nothing is running
    const client = new TunnelClient({
      port: 19999,
      server: `ws://localhost:${RELAY_PORT}`,
      apiKey: TEST_API_KEY,
      subdomain: 'deadport',
    });

    const instance = await client.connect();

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: RELAY_PORT,
          path: '/anything',
          headers: { host: `deadport.${TEST_DOMAIN}` },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            resolve({ status: res.statusCode || 500, body: Buffer.concat(chunks).toString() });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect(res.status).toBe(502);
    await instance.close();
  });

  it('should fail to connect with invalid API key', async () => {
    const client = new TunnelClient({
      port: LOCAL_PORT,
      server: `ws://localhost:${RELAY_PORT}`,
      apiKey: 'wrong_key',
    });

    await expect(client.connect()).rejects.toThrow();
  });

  it('should gracefully close the tunnel', async () => {
    const client = new TunnelClient({
      port: LOCAL_PORT,
      server: `ws://localhost:${RELAY_PORT}`,
      apiKey: TEST_API_KEY,
      subdomain: 'closetest',
    });

    const instance = await client.connect();
    await instance.close();

    // After closing, requests should return 404
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: RELAY_PORT,
          path: '/',
          headers: { host: `closetest.${TEST_DOMAIN}` },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve({ status: res.statusCode || 500 }));
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect(res.status).toBe(404);
  });
});
