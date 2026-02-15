import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { RelayServerConfig, TunnelRequest, TunnelResponse, WSMessage } from '../types';
import { generateSubdomain, isValidSubdomain } from '../utils/subdomain';
import { validateApiKey } from './auth';
import { logger } from '../utils/logger';
import crypto from 'node:crypto';

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
const REQUEST_TIMEOUT = 30_000; // 30 seconds
const HEARTBEAT_INTERVAL = 30_000; // 30 seconds

interface PendingRequest {
  res: http.ServerResponse;
  timeout: NodeJS.Timeout;
}

interface TunnelConnection {
  ws: WebSocket;
  subdomain: string;
  heartbeat: NodeJS.Timeout;
  alive: boolean;
}

export class RelayServer {
  private tunnels: Map<string, TunnelConnection> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private server: http.Server;
  private wss: WebSocketServer;
  private config: RelayServerConfig;

  constructor(config: RelayServerConfig) {
    this.config = config;

    this.server = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      if (url.pathname !== '/tunnel') {
        socket.destroy();
        return;
      }

      const apiKey = req.headers['x-api-key'] as string | undefined;
      if (!validateApiKey(apiKey, this.config.apiKeys)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      if (this.tunnels.size >= this.config.maxTunnels) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n\r\n' +
          JSON.stringify({ error: 'Max tunnel limit reached', limit: this.config.maxTunnels }));
        socket.destroy();
        logger.info(`Connection rejected: max tunnel limit (${this.config.maxTunnels}) reached`);
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleWebSocketConnection(ws, req);
      });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.config.port, () => {
        logger.success(`Relay server listening on port ${this.config.port}`);
        logger.info(`Domain: ${this.config.domain}`);
        logger.info(`Max tunnels: ${this.config.maxTunnels}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Close all tunnel connections
    for (const [, conn] of this.tunnels) {
      clearInterval(conn.heartbeat);
      conn.ws.close();
    }
    this.tunnels.clear();

    // Clear pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      if (!pending.res.writableEnded) {
        pending.res.writeHead(503);
        pending.res.end('Server shutting down');
      }
    }
    this.pendingRequests.clear();

    return new Promise((resolve) => {
      this.wss.close(() => {
        this.server.close(() => {
          resolve();
        });
      });
    });
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const host = req.headers.host || '';
    const subdomain = this.extractSubdomain(host);

    // Health endpoint on the base domain
    if (!subdomain || subdomain === 'tunnel') {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', tunnels: this.tunnels.size, maxTunnels: this.config.maxTunnels }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('@gagandeep023/expose-tunnel relay server');
      return;
    }

    // Look up tunnel
    const tunnel = this.tunnels.get(subdomain);
    if (!tunnel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Tunnel not found', subdomain }));
      return;
    }

    if (tunnel.ws.readyState !== WebSocket.OPEN) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Tunnel client disconnected' }));
      this.removeTunnel(subdomain);
      return;
    }

    // Read request body
    const chunks: Buffer[] = [];
    let bodySize = 0;

    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (res.writableEnded) return;

      const body = Buffer.concat(chunks);
      const tunnelRequest = this.serializeRequest(req, body);
      const requestId = tunnelRequest.id;

      // Set up timeout
      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(requestId);
        if (pending && !pending.res.writableEnded) {
          pending.res.writeHead(504, { 'Content-Type': 'application/json' });
          pending.res.end(JSON.stringify({ error: 'Tunnel request timed out' }));
        }
        this.pendingRequests.delete(requestId);
      }, REQUEST_TIMEOUT);

      // Store pending request
      this.pendingRequests.set(requestId, { res, timeout });

      // Send to tunnel client
      const message: WSMessage = { type: 'tunnel-request', request: tunnelRequest };
      tunnel.ws.send(JSON.stringify(message));
    });

    req.on('error', () => {
      if (!res.writableEnded) {
        res.writeHead(500);
        res.end('Request error');
      }
    });
  }

  private handleWebSocketConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const requestedSubdomain = req.headers['x-subdomain'] as string | undefined;
    let subdomain: string;

    if (requestedSubdomain && isValidSubdomain(requestedSubdomain) && !this.tunnels.has(requestedSubdomain)) {
      subdomain = requestedSubdomain;
    } else {
      // Generate unique subdomain
      do {
        subdomain = generateSubdomain();
      } while (this.tunnels.has(subdomain));
    }

    const url = `https://${subdomain}.${this.config.domain}`;

    // Setup heartbeat
    const conn: TunnelConnection = {
      ws,
      subdomain,
      alive: true,
      heartbeat: setInterval(() => {
        if (!conn.alive) {
          logger.info(`Tunnel ${subdomain} failed heartbeat, disconnecting`);
          clearInterval(conn.heartbeat);
          ws.terminate();
          return;
        }
        conn.alive = false;
        ws.send(JSON.stringify({ type: 'ping' }));
      }, HEARTBEAT_INTERVAL),
    };

    this.tunnels.set(subdomain, conn);
    logger.success(`Tunnel created: ${subdomain} -> ${url}`);

    // Send assignment
    const assignMessage: WSMessage = { type: 'tunnel-assigned', subdomain, url };
    ws.send(JSON.stringify(assignMessage));

    // Handle messages from client
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as WSMessage;

        if (message.type === 'pong') {
          conn.alive = true;
          return;
        }

        if (message.type === 'tunnel-response') {
          this.handleTunnelResponse(message.response);
        }
      } catch {
        logger.error(`Invalid message from tunnel ${subdomain}`);
      }
    });

    ws.on('close', () => {
      this.removeTunnel(subdomain);
      logger.info(`Tunnel closed: ${subdomain}`);
    });

    ws.on('error', (err) => {
      logger.error(`Tunnel ${subdomain} error: ${err.message}`);
      this.removeTunnel(subdomain);
    });
  }

  private handleTunnelResponse(response: TunnelResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    if (pending.res.writableEnded) return;

    // Write response headers
    const headers: Record<string, string> = { ...response.headers };
    delete headers['transfer-encoding']; // Let Node handle this

    pending.res.writeHead(response.status, headers);

    // Write response body
    if (response.body) {
      const bodyBuffer = Buffer.from(response.body, 'base64');
      pending.res.end(bodyBuffer);
    } else {
      pending.res.end();
    }
  }

  private removeTunnel(subdomain: string): void {
    const conn = this.tunnels.get(subdomain);
    if (conn) {
      clearInterval(conn.heartbeat);
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close();
      }
      this.tunnels.delete(subdomain);
    }
  }

  private extractSubdomain(host: string): string | null {
    // Remove port if present
    const hostname = host.split(':')[0];
    const domain = this.config.domain;

    if (hostname === domain) return null;

    if (hostname.endsWith(`.${domain}`)) {
      return hostname.slice(0, -(domain.length + 1));
    }

    return null;
  }

  private serializeRequest(req: http.IncomingMessage, body: Buffer): TunnelRequest {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) {
        headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }
    }

    return {
      id: crypto.randomUUID(),
      method: req.method || 'GET',
      path: req.url || '/',
      headers,
      body: body.length > 0 ? body.toString('base64') : null,
    };
  }
}
