export interface TunnelOptions {
  port: number;
  host?: string;
  subdomain?: string;
  server?: string;
  apiKey?: string;
  localHost?: string;
}

export interface TunnelInstance {
  url: string;
  subdomain: string;
  close: () => Promise<void>;
  on: (event: 'request' | 'error' | 'close', handler: (...args: unknown[]) => void) => void;
}

export interface TunnelRequest {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface TunnelResponse {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

export interface RelayServerConfig {
  port: number;
  apiKeys: string[];
  domain: string;
  maxTunnels: number;
}

export type WSMessage =
  | { type: 'tunnel-assigned'; subdomain: string; url: string }
  | { type: 'tunnel-request'; request: TunnelRequest }
  | { type: 'tunnel-response'; response: TunnelResponse }
  | { type: 'tunnel-error'; message: string }
  | { type: 'ping' }
  | { type: 'pong' };
