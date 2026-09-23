# WebSocket passthrough design notes (implemented in v0.5.0)

> **Status: shipped.** WebSocket passthrough landed in **v0.5.0** and is live on the relay.
> This file is kept as the design record for how it works; it is no longer a to-do list.
> Sections written in the future tense describe the change as it was planned. Section 1
> describes the pre-0.5.0 behaviour and is kept for context.
>
> The tunnel forwards **WebSocket upgrades** (Socket.IO, raw `ws`) end-to-end, so
> `wss://<sub>.tunnel.gagandeep023.com` works alongside plain HTTP.
> Written against the source in this repo: `src/types.ts`,
> `src/server/relay-server.ts`, `src/client/tunnel-client.ts`.
> User-facing docs live in `README.md` ("WebSocket Support"); relay/nginx setup lives in
> `SELF-HOSTING-GUIDE.md`.

---

## 1. Why it failed before 0.5.0 (exact line)

The tunnel is a pure HTTP request/response proxy. In **`src/server/relay-server.ts`**, the upgrade handler
only accepts the tunnel client's own control connection and **destroys every other upgrade**:

```ts
this.server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname !== '/tunnel') {
    socket.destroy();          // ← every external WS upgrade dies here → nginx returns 502
    return;
  }
  // ... api-key check, maxTunnels, this.wss.handleUpgrade(...) for the CONTROL ws ...
});
```

So when a browser/app does `Upgrade: websocket` to `wss://<sub>.tunnel.gagandeep023.com` (path `/socket.io/…`,
not `/tunnel`), the socket is destroyed, and nginx surfaces **`502 Bad Gateway`**. HTTP **polling** works
because it's a normal `GET`/`POST` handled by `handleHttpRequest` → `tunnel-request`/`tunnel-response`.

**Fix = multiplex external WebSocket connections over the existing control WS**, exactly like the current
request/response path, but with a per-connection id and frame messages.

---

## 2. `src/types.ts` — extend the wire protocol

Your protocol today:

```ts
export type WSMessage =
  | { type: 'tunnel-assigned'; subdomain: string; url: string }
  | { type: 'tunnel-request'; request: TunnelRequest }
  | { type: 'tunnel-response'; response: TunnelResponse }
  | { type: 'tunnel-error'; message: string }
  | { type: 'ping' }
  | { type: 'pong' };
```

Add four WS message kinds (keep the `tunnel-` prefix convention):

```ts
export interface TunnelWsFrame {
  connId: string;                 // unique per external ws connection
  binary: boolean;                // true => data is base64(Buffer); false => utf8 text
  data: string;
}

export type WSMessage =
  | { type: 'tunnel-assigned'; subdomain: string; url: string }
  | { type: 'tunnel-request'; request: TunnelRequest }
  | { type: 'tunnel-response'; response: TunnelResponse }
  | { type: 'tunnel-error'; message: string }
  // NEW ↓ (relay -> client to open; both directions for data/close; client -> relay for error)
  | { type: 'tunnel-ws-open'; connId: string; path: string; headers: Record<string, string> }
  | { type: 'tunnel-ws-data'; frame: TunnelWsFrame }
  | { type: 'tunnel-ws-close'; connId: string; code?: number; reason?: string }
  | { type: 'tunnel-ws-error'; connId: string; message: string }
  | { type: 'ping' }
  | { type: 'pong' };
```

---

## 3. `src/server/relay-server.ts`

### 3a. `TunnelConnection` — track this client's live external sockets

```ts
import { WebSocketServer, WebSocket } from 'ws';

interface TunnelConnection {
  ws: WebSocket;
  subdomain: string;
  heartbeat: NodeJS.Timeout;
  alive: boolean;
  wsConns: Map<string, WebSocket>;   // ← NEW: connId -> browser-facing ws
}
```

Add a second `noServer` WS server in the constructor (next to `this.wss`):

```ts
private wss: WebSocketServer;          // existing (control)
private externalWss: WebSocketServer;  // NEW (browser-facing)

constructor(config: RelayServerConfig) {
  // ...
  this.wss = new WebSocketServer({ noServer: true });
  this.externalWss = new WebSocketServer({ noServer: true });   // NEW
  // ...
}
```

When you create the `TunnelConnection` in `handleWebSocketConnection`, initialize `wsConns: new Map()`.

### 3b. Route the `upgrade` event by path

Replace the `if (url.pathname !== '/tunnel') { socket.destroy(); }` guard so non-`/tunnel` upgrades are
**forwarded** instead of dropped:

```ts
this.server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  // (1) control connection — UNCHANGED (keep your api-key + maxTunnels checks + this.wss.handleUpgrade)
  if (url.pathname === '/tunnel') {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (!validateApiKey(apiKey, this.config.apiKeys)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
    }
    if (this.tunnels.size >= this.config.maxTunnels) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.handleWebSocketConnection(ws, req));
    return;
  }

  // (2) NEW: external browser WS → forward to the subdomain's tunnel client
  const subdomain = this.extractSubdomain(req.headers.host || '');
  const conn = subdomain ? this.tunnels.get(subdomain) : undefined;
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) { socket.destroy(); return; }

  this.externalWss.handleUpgrade(req, socket, head, (browserWs) => {
    this.bridgeExternalWs(conn, browserWs, req);
  });
});
```

### 3c. Bridge a browser WS over the control channel

```ts
private bridgeExternalWs(conn: TunnelConnection, browserWs: WebSocket, req: http.IncomingMessage): void {
  const connId = crypto.randomUUID();
  conn.wsConns.set(connId, browserWs);

  // flatten headers like serializeRequest does
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v) headers[k] = Array.isArray(v) ? v.join(', ') : v;

  const send = (m: WSMessage): void => { if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(m)); };

  send({ type: 'tunnel-ws-open', connId, path: req.url || '/', headers });

  browserWs.on('message', (data: Buffer, isBinary: boolean) => {
    send({ type: 'tunnel-ws-data', frame: {
      connId, binary: isBinary,
      data: isBinary ? data.toString('base64') : data.toString('utf8'),
    }});
  });
  browserWs.on('close', (code, reason) => {
    send({ type: 'tunnel-ws-close', connId, code, reason: reason.toString() });
    conn.wsConns.delete(connId);
  });
  browserWs.on('error', () => { try { browserWs.close(); } catch {} conn.wsConns.delete(connId); });
}
```

### 3d. Handle the client's inbound `tunnel-ws-*` messages

In `handleWebSocketConnection`'s `ws.on('message', …)`, after the `pong` / `tunnel-response` cases add:

```ts
if (message.type === 'tunnel-ws-data') {
  const bws = conn.wsConns.get(message.frame.connId);
  if (bws && bws.readyState === WebSocket.OPEN) {
    bws.send(message.frame.binary ? Buffer.from(message.frame.data, 'base64') : message.frame.data);
  }
  return;
}
if (message.type === 'tunnel-ws-close' || message.type === 'tunnel-ws-error') {
  const bws = conn.wsConns.get(message.connId);
  if (bws) { try { bws.close(); } catch {} conn.wsConns.delete(message.connId); }
  return;
}
```

### 3e. Clean up on tunnel teardown

In `removeTunnel` (and `stop`), close the browser sockets too:

```ts
private removeTunnel(subdomain: string): void {
  const conn = this.tunnels.get(subdomain);
  if (conn) {
    clearInterval(conn.heartbeat);
    for (const bws of conn.wsConns.values()) { try { bws.close(1001, 'tunnel closed'); } catch {} }
    conn.wsConns.clear();
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.close();
    this.tunnels.delete(subdomain);
  }
}
```

---

## 4. `src/client/tunnel-client.ts`

Add a `connId -> local ws` map and handle the new messages in the `setupListeners` switch (alongside
`tunnel-request`).

```ts
import WebSocket from 'ws';
private localWs = new Map<string, WebSocket>();
private localWsBuffer = new Map<string, Array<{ binary: boolean; data: string }>>(); // pre-open frames

// in setupListeners' switch (message.type):
case 'tunnel-ws-open':
  this.openLocalWs(message.connId, message.path, message.headers);
  break;
case 'tunnel-ws-data': {
  const lws = this.localWs.get(message.frame.connId);
  const payload = message.frame.binary ? Buffer.from(message.frame.data, 'base64') : message.frame.data;
  if (lws && lws.readyState === WebSocket.OPEN) lws.send(payload);
  else (this.localWsBuffer.get(message.frame.connId) ?? []).push({ binary: message.frame.binary, data: message.frame.data });
  break;
}
case 'tunnel-ws-close': {
  const lws = this.localWs.get(message.connId);
  if (lws) { try { lws.close(message.code, message.reason); } catch {} this.localWs.delete(message.connId); }
  break;
}
```

```ts
private openLocalWs(connId: string, path: string, reqHeaders: Record<string, string>): void {
  const headers: Record<string, string> = { ...reqHeaders };
  // let the ws client set its own handshake; keep origin/cookie/authorization/sec-websocket-protocol
  for (const h of ['sec-websocket-key','sec-websocket-version','sec-websocket-accept','upgrade','connection','host']) delete headers[h];

  const target = `ws://${this.options.localHost}:${this.options.port}${path}`;
  const lws = new WebSocket(target, { headers });
  this.localWs.set(connId, lws);
  this.localWsBuffer.set(connId, []);

  const send = (m: WSMessage): void => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); };

  lws.on('open', () => {
    for (const f of this.localWsBuffer.get(connId) ?? []) lws.send(f.binary ? Buffer.from(f.data, 'base64') : f.data);
    this.localWsBuffer.delete(connId);
  });
  lws.on('message', (data: Buffer, isBinary: boolean) => {
    send({ type: 'tunnel-ws-data', frame: { connId, binary: isBinary, data: isBinary ? data.toString('base64') : data.toString('utf8') } });
  });
  lws.on('close', (code, reason) => {
    send({ type: 'tunnel-ws-close', connId, code, reason: reason.toString() });
    this.localWs.delete(connId);
  });
  lws.on('error', (err) => {
    send({ type: 'tunnel-ws-error', connId, message: String(err?.message || err) });
    this.localWs.delete(connId);
  });
}
```

On client `close`/`reconnect`, close all `localWs` and clear the maps.

---

## 5. nginx (`*.tunnel.gagandeep023.com` vhost)

The control WS already works, so upgrade headers are probably present — but verify, and **bump timeouts**
for long-lived sockets. Edit the **sites-enabled** file (it's a real file, not a symlink); `nginx -T` to check.

```nginx
# http {} scope, once:
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

# inside location / { } of the tunnel vhost:
proxy_http_version 1.1;
proxy_set_header   Upgrade $http_upgrade;
proxy_set_header   Connection $connection_upgrade;
proxy_set_header   Host $host;
proxy_pass         http://127.0.0.1:4040;
proxy_read_timeout 3600s;   # don't cut idle sockets
proxy_send_timeout 3600s;
```
`sudo nginx -t && sudo systemctl reload nginx`.

---

## 6. Build, publish, deploy

```bash
# repo
npm test                 # add tests for the new frames if you can (see __tests__/tunnel-client.test.ts)
npm version minor        # 0.4.x -> 0.5.0
npm run build            # tsup -> dist (client + dist/server relay)
npm publish --access public

# EC2 relay
ssh -i /Users/gaganpulse/Documents/coffee-project/aws/gagandeep-personal-aws.pem ubuntu@gagandeep023.com
sudo -i && cd /root/apps/expose-tunnel
git pull && npm run build         # (or npm i @gagandeep023/expose-tunnel@0.5.0 if it runs the published server)
pm2 restart expose-tunnel-relay && pm2 logs expose-tunnel-relay --lines 30
```
Dev machine: the `start-expose` alias runs `npx @gagandeep023/expose-tunnel …` — pin `@0.5.0` (or clear
`~/.npm/_npx`) so it pulls the new client. **Both relay and client must be on 0.5.0** (the new message types
are a matched pair).

---

## 7. Test (must be `101`, not `502`)

```bash
# raw WS upgrade through the tunnel
curl -s -i -N --max-time 8 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://adani-alpha-socket.tunnel.gagandeep023.com/socket.io/?EIO=4&transport=websocket" | head -5
# expect: HTTP/1.1 101 Switching Protocols

# Socket.IO end-to-end over WS
node -e 'const {io}=require("socket.io-client");const s=io("https://adani-alpha-socket.tunnel.gagandeep023.com",{transports:["websocket"]});s.on("connect",()=>{console.log("WS connect ok",s.id);process.exit(0)});s.on("connect_error",e=>{console.log("err",e.message);process.exit(1)});setTimeout(()=>process.exit(1),8000);'
```

---

## 8. Correctness checklist

- **Binary frames:** engine.io sends binary — always honor `binary` + base64. Never `JSON.stringify` a Buffer.
- **Header hygiene on local dial:** strip `sec-websocket-*`, `upgrade`, `connection`, `host`; keep
  `origin`, `cookie`, `authorization`, `sec-websocket-protocol`.
- **Pre-open buffering:** `tunnel-ws-data` can arrive before the local socket opens — buffer then flush
  (shown above).
- **Close both ways + teardown:** browser close → local close, local close → browser close, and on
  control-WS drop close all `wsConns`/`localWs`.
- **Reconnect:** the client already auto-reconnects; external WS bridges don't survive a control reconnect
  (the browser's Socket.IO will re-handshake, which is fine — just make sure you clear stale maps).
- **Timeouts:** `REQUEST_TIMEOUT` (30s) only applies to `pendingRequests` (HTTP) — do **not** apply it to
  WS bridges. nginx `proxy_read_timeout` must be long.
- **Scope:** HTTP-embedded WS only (Socket.IO / `ws`) — matches the package's non-goals (no raw TCP/TLS).

---

## 9. Shipped

v0.5.0 is published to npm and deployed to the relay, so no third-party workaround is needed any more.
The earlier interim advice (running `cloudflared` for the socket port) no longer applies.

Both ends must be on 0.5.0 or later — the new message types are a matched pair. If a client still
falls back to HTTP polling, it is running an older build: clear the npx cache (`rm -rf ~/.npm/_npx`)
or pin the version explicitly.
