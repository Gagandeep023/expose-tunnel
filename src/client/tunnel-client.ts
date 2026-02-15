import WebSocket from 'ws';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { TunnelOptions, TunnelInstance, TunnelRequest, TunnelResponse, WSMessage } from '../types';
import { logger } from '../utils/logger';

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 1000;

export class TunnelClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: Required<TunnelOptions>;
  private reconnectAttempts = 0;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private closed = false;

  url = '';
  subdomain = '';

  constructor(options: TunnelOptions) {
    super();
    const server = options.server || process.env.EXPOSE_TUNNEL_SERVER;
    if (!server) {
      throw new Error('Relay server URL required. Pass server option or set EXPOSE_TUNNEL_SERVER env var.');
    }
    this.options = {
      port: options.port,
      host: options.host || 'localhost',
      subdomain: options.subdomain || '',
      server,
      apiKey: options.apiKey || process.env.EXPOSE_TUNNEL_API_KEY || '',
      localHost: options.localHost || 'localhost',
    };
  }

  connect(): Promise<TunnelInstance> {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.options.server}/tunnel`;
      const headers: Record<string, string> = {
        'x-api-key': this.options.apiKey,
      };

      if (this.options.subdomain) {
        headers['x-subdomain'] = this.options.subdomain;
      }

      this.ws = new WebSocket(wsUrl, { headers });

      const onError = (err: Error): void => {
        this.ws?.removeAllListeners();
        reject(new Error(`Failed to connect to relay server: ${err.message}`));
      };

      this.ws.once('error', onError);

      this.ws.once('open', () => {
        this.ws?.removeListener('error', onError);
        this.setupListeners(resolve);
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
    this.emit('close');
  }

  private setupListeners(resolve: (instance: TunnelInstance) => void): void {
    if (!this.ws) return;

    let assigned = false;

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as WSMessage;

        switch (message.type) {
          case 'tunnel-assigned':
            this.url = message.url;
            this.subdomain = message.subdomain;
            this.reconnectAttempts = 0;
            assigned = true;
            this.setupHeartbeat();
            resolve(this.createInstance());
            break;

          case 'tunnel-request':
            this.handleTunnelRequest(message.request);
            break;

          case 'ping':
            this.ws?.send(JSON.stringify({ type: 'pong' }));
            break;

          case 'tunnel-error':
            logger.error(`Server error: ${message.message}`);
            this.emit('error', new Error(message.message));
            break;
        }
      } catch {
        logger.error('Failed to parse server message');
      }
    });

    this.ws.on('close', () => {
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }

      if (!this.closed && assigned) {
        logger.info('Connection lost. Attempting to reconnect...');
        this.reconnect();
      }
    });

    this.ws.on('error', (err) => {
      logger.error(`WebSocket error: ${err.message}`);
      this.emit('error', err);
    });
  }

  private async handleTunnelRequest(request: TunnelRequest): Promise<void> {
    try {
      const response = await this.proxyToLocal(request);
      this.sendResponse(response);
      this.emit('request', request.method, request.path, response.status);
      logger.request(request.method, request.path, response.status);
    } catch (err) {
      const errorResponse: TunnelResponse = {
        id: request.id,
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({ error: 'Failed to reach local server', details: (err as Error).message })
        ).toString('base64'),
      };
      this.sendResponse(errorResponse);
      this.emit('request', request.method, request.path, 502);
      logger.request(request.method, request.path, 502);
    }
  }

  private proxyToLocal(request: TunnelRequest): Promise<TunnelResponse> {
    return new Promise((resolve, reject) => {
      const url = `http://${this.options.localHost}:${this.options.port}${request.path}`;
      const parsedUrl = new URL(url);

      const headers: Record<string, string> = { ...request.headers };
      // Replace host header with local host
      headers['host'] = `${this.options.localHost}:${this.options.port}`;
      // Remove connection-specific headers
      delete headers['connection'];
      delete headers['upgrade'];

      const options: http.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: request.method,
        headers,
      };

      const proxyReq = http.request(options, (proxyRes) => {
        const chunks: Buffer[] = [];

        proxyRes.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        proxyRes.on('end', () => {
          const body = Buffer.concat(chunks);
          const responseHeaders: Record<string, string> = {};

          for (const [key, value] of Object.entries(proxyRes.headers)) {
            if (value) {
              responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
            }
          }

          resolve({
            id: request.id,
            status: proxyRes.statusCode || 500,
            headers: responseHeaders,
            body: body.length > 0 ? body.toString('base64') : null,
          });
        });
      });

      proxyReq.on('error', reject);

      // Send request body
      if (request.body) {
        proxyReq.write(Buffer.from(request.body, 'base64'));
      }

      proxyReq.end();
    });
  }

  private sendResponse(response: TunnelResponse): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const message: WSMessage = { type: 'tunnel-response', response };
      this.ws.send(JSON.stringify(message));
    }
  }

  private reconnect(): void {
    if (this.closed || this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        logger.error(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
        this.emit('close');
      }
      return;
    }

    this.reconnectAttempts++;
    const delay = RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts - 1);

    logger.info(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

    setTimeout(() => {
      if (this.closed) return;

      const wsUrl = `${this.options.server}/tunnel`;
      const headers: Record<string, string> = {
        'x-api-key': this.options.apiKey,
      };

      if (this.subdomain) {
        headers['x-subdomain'] = this.subdomain;
      }

      this.ws = new WebSocket(wsUrl, { headers });

      this.ws.once('open', () => {
        logger.success('Reconnected!');
        this.setupListeners(() => {});
      });

      this.ws.once('error', () => {
        this.reconnect();
      });
    }, delay);
  }

  private setupHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    // Client doesn't need to send its own heartbeat; it responds to server pings
    // But we keep a reference for cleanup
  }

  private createInstance(): TunnelInstance {
    return {
      url: this.url,
      subdomain: this.subdomain,
      close: () => this.close(),
      on: (event: string, handler: (...args: unknown[]) => void) => {
        this.on(event, handler);
      },
    };
  }
}

export async function exposeTunnel(options: TunnelOptions): Promise<TunnelInstance> {
  const client = new TunnelClient(options);
  return client.connect();
}
