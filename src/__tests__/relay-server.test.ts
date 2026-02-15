import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import { RelayServer } from '../server/relay-server';
import { WSMessage } from '../types';

let TEST_PORT = 14040;
const TEST_API_KEY = 'sk_test_key_123';
const TEST_DOMAIN = 'tunnel.test.local';

function makeRequest(
  options: { hostname: string; port: number; path: string; method?: string; headers?: Record<string, string> },
  body?: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const reqOptions: http.RequestOptions = {
      hostname: options.hostname,
      port: options.port,
      path: options.path,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = http.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 500,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function connectTunnel(apiKey: string, subdomain?: string): Promise<{ ws: WebSocket; message: WSMessage }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'x-api-key': apiKey };
    if (subdomain) headers['x-subdomain'] = subdomain;

    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/tunnel`, { headers });

    ws.once('error', reject);
    ws.once('message', (data) => {
      const message = JSON.parse(data.toString()) as WSMessage;
      resolve({ ws, message });
    });
  });
}

describe('RelayServer', () => {
  let server: RelayServer;

  beforeEach(async () => {
    TEST_PORT++;
    server = new RelayServer({
      port: TEST_PORT,
      apiKeys: [TEST_API_KEY],
      domain: TEST_DOMAIN,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('health endpoint', () => {
    it('should return health status on base domain', async () => {
      const res = await makeRequest({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/health',
        headers: { host: TEST_DOMAIN },
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('ok');
      expect(body.tunnels).toBe(0);
    });

    it('should return welcome message on base domain root', async () => {
      const res = await makeRequest({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/',
        headers: { host: TEST_DOMAIN },
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('relay server');
    });
  });

  describe('WebSocket tunnel connection', () => {
    it('should reject connection without API key', async () => {
      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://localhost:${TEST_PORT}/tunnel`);
          ws.once('error', reject);
          ws.once('unexpected-response', (_req, res) => {
            reject(new Error(`Status: ${res.statusCode}`));
          });
          ws.once('open', resolve);
        })
      ).rejects.toThrow();
    });

    it('should reject connection with invalid API key', async () => {
      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://localhost:${TEST_PORT}/tunnel`, {
            headers: { 'x-api-key': 'wrong_key' },
          });
          ws.once('error', reject);
          ws.once('unexpected-response', (_req, res) => {
            reject(new Error(`Status: ${res.statusCode}`));
          });
          ws.once('open', resolve);
        })
      ).rejects.toThrow();
    });

    it('should accept connection with valid API key and assign subdomain', async () => {
      const { ws, message } = await connectTunnel(TEST_API_KEY);
      expect(message.type).toBe('tunnel-assigned');
      if (message.type === 'tunnel-assigned') {
        expect(message.subdomain).toHaveLength(8);
        expect(message.url).toContain(TEST_DOMAIN);
      }
      ws.close();
    });

    it('should assign requested subdomain when available', async () => {
      const { ws, message } = await connectTunnel(TEST_API_KEY, 'myapp');
      expect(message.type).toBe('tunnel-assigned');
      if (message.type === 'tunnel-assigned') {
        expect(message.subdomain).toBe('myapp');
        expect(message.url).toBe(`https://myapp.${TEST_DOMAIN}`);
      }
      ws.close();
    });

    it('should update health tunnel count', async () => {
      const { ws } = await connectTunnel(TEST_API_KEY);

      const res = await makeRequest({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/health',
        headers: { host: TEST_DOMAIN },
      });
      const body = JSON.parse(res.body);
      expect(body.tunnels).toBe(1);

      ws.close();
    });
  });

  describe('HTTP request routing', () => {
    it('should return 404 for unknown subdomain', async () => {
      const res = await makeRequest({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/test',
        headers: { host: `unknown.${TEST_DOMAIN}` },
      });
      expect(res.status).toBe(404);
    });

    it('should route request to correct tunnel and return response', async () => {
      const { ws, message } = await connectTunnel(TEST_API_KEY, 'testapp');
      if (message.type !== 'tunnel-assigned') throw new Error('Expected tunnel-assigned');

      // Set up message handler on the tunnel client side
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as WSMessage;
        if (msg.type === 'tunnel-request') {
          // Simulate local server response
          const response: WSMessage = {
            type: 'tunnel-response',
            response: {
              id: msg.request.id,
              status: 200,
              headers: { 'content-type': 'text/plain' },
              body: Buffer.from('Hello from tunnel!').toString('base64'),
            },
          };
          ws.send(JSON.stringify(response));
        }
      });

      // Make HTTP request to the tunnel subdomain
      const res = await makeRequest({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/api/hello',
        headers: { host: `testapp.${TEST_DOMAIN}` },
      });

      expect(res.status).toBe(200);
      expect(res.body).toBe('Hello from tunnel!');

      ws.close();
    });

    it('should handle POST requests with body', async () => {
      const { ws, message } = await connectTunnel(TEST_API_KEY, 'posttest');
      if (message.type !== 'tunnel-assigned') throw new Error('Expected tunnel-assigned');

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as WSMessage;
        if (msg.type === 'tunnel-request') {
          // Echo back the request body
          const response: WSMessage = {
            type: 'tunnel-response',
            response: {
              id: msg.request.id,
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: msg.request.body, // Echo the base64 body back
            },
          };
          ws.send(JSON.stringify(response));
        }
      });

      const requestBody = JSON.stringify({ hello: 'world' });
      const res = await makeRequest(
        {
          hostname: 'localhost',
          port: TEST_PORT,
          path: '/api/data',
          method: 'POST',
          headers: {
            host: `posttest.${TEST_DOMAIN}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(requestBody).toString(),
          },
        },
        requestBody
      );

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ hello: 'world' });

      ws.close();
    });
  });
});
