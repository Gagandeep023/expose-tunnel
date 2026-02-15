# @gagandeep023/expose-tunnel

A self-hosted tunnel to expose local servers to the internet. An alternative to ngrok and localtunnel that runs on your own infrastructure.

[![npm version](https://img.shields.io/npm/v/@gagandeep023/expose-tunnel.svg)](https://www.npmjs.com/package/@gagandeep023/expose-tunnel)
[![license](https://img.shields.io/npm/l/@gagandeep023/expose-tunnel.svg)](https://github.com/Gagandeep023/expose-tunnel/blob/main/LICENSE)

## How It Works

```
Your Machine                    Your Relay Server                Internet
+--------------+    WebSocket   +------------------------+    HTTPS    +----------+
| localhost:   | -------------> | tunnel.yourdomain.com  | <--------- | Browser  |
| 3000         | <------------- | *.tunnel.yourdomain    | ---------> | requests |
+--------------+                +------------------------+            +----------+
```

1. The client connects to your relay server via WebSocket
2. The relay server assigns a public subdomain (e.g., `abc123.tunnel.yourdomain.com`)
3. When external traffic hits that subdomain, the relay server pipes it through the WebSocket to your machine
4. Your client forwards the request to `localhost:<port>` and sends the response back

## Installation

```bash
npm install @gagandeep023/expose-tunnel
```

Or run directly with npx (no install needed):

```bash
npx @gagandeep023/expose-tunnel --port 3000 --server wss://tunnel.yourdomain.com --api-key sk_your_key
```

## Quick Start

### 1. Set environment variables (recommended)

```bash
export EXPOSE_TUNNEL_SERVER=wss://tunnel.yourdomain.com
export EXPOSE_TUNNEL_API_KEY=sk_your_key_here
```

### 2. Expose a local port

```bash
npx @gagandeep023/expose-tunnel --port 3000
```

Output:

```
[expose-tunnel] Tunnel established!
[expose-tunnel] Public URL: https://abc123.tunnel.yourdomain.com
[expose-tunnel] Forwarding to: http://localhost:3000
[expose-tunnel] Press Ctrl+C to close the tunnel.
```

## CLI Usage Examples

### Basic: expose a port (env vars set)

```bash
# Requires EXPOSE_TUNNEL_SERVER and EXPOSE_TUNNEL_API_KEY env vars
npx @gagandeep023/expose-tunnel --port 3000
```

### With a custom subdomain

```bash
npx @gagandeep023/expose-tunnel --port 3000 --subdomain myapp
# -> https://myapp.tunnel.yourdomain.com
```

### Without a subdomain (random assigned)

```bash
npx @gagandeep023/expose-tunnel --port 3000
# -> https://a1b2c3d4.tunnel.yourdomain.com
```

### With --server flag (no env var needed)

```bash
npx @gagandeep023/expose-tunnel --port 3000 --server wss://tunnel.yourdomain.com
```

### With --server and --subdomain

```bash
npx @gagandeep023/expose-tunnel --port 3000 --server wss://tunnel.yourdomain.com --subdomain myapp
```

### With --api-key flag (no env var needed)

```bash
npx @gagandeep023/expose-tunnel --port 3000 --server wss://tunnel.yourdomain.com --api-key sk_your_key
```

### All flags, no env vars

```bash
npx @gagandeep023/expose-tunnel \
  --port 3000 \
  --server wss://tunnel.yourdomain.com \
  --subdomain myapp \
  --api-key sk_your_key_here
```

### Custom local host

```bash
# Forward to a different local hostname (default: localhost)
npx @gagandeep023/expose-tunnel --port 3000 --local-host 0.0.0.0
```

### Expose different ports

```bash
# Expose a React dev server
npx @gagandeep023/expose-tunnel --port 5173 --subdomain react-app

# Expose an Express backend
npx @gagandeep023/expose-tunnel --port 3001 --subdomain api

# Expose a database admin panel
npx @gagandeep023/expose-tunnel --port 8080 --subdomain admin
```

## CLI Reference

```
Usage: expose-tunnel [options]

Expose local servers to the internet via your own relay server

Options:
  -V, --version            output version number
  -p, --port <number>      Local port to expose (required)
  -s, --subdomain <name>   Request a specific subdomain
  --server <url>           Relay server WebSocket URL (or set EXPOSE_TUNNEL_SERVER env var)
  --api-key <key>          API key (or set EXPOSE_TUNNEL_API_KEY env var)
  --local-host <host>      Local hostname to proxy to (default: localhost)
  -h, --help               display help for command
```

## Programmatic API

### Basic usage

```typescript
import { exposeTunnel } from '@gagandeep023/expose-tunnel';

const tunnel = await exposeTunnel({
  port: 3000,
  server: 'wss://tunnel.yourdomain.com',
  apiKey: 'sk_your_key_here',
});

console.log(`Public URL: ${tunnel.url}`);

// Close when done
await tunnel.close();
```

### With subdomain

```typescript
const tunnel = await exposeTunnel({
  port: 3000,
  server: 'wss://tunnel.yourdomain.com',
  apiKey: 'sk_your_key_here',
  subdomain: 'myapp',
});

console.log(tunnel.url);
// -> https://myapp.tunnel.yourdomain.com
```

### Without subdomain (random)

```typescript
const tunnel = await exposeTunnel({
  port: 3000,
  server: 'wss://tunnel.yourdomain.com',
  apiKey: 'sk_your_key_here',
});

console.log(tunnel.url);
// -> https://a1b2c3d4.tunnel.yourdomain.com
```

### Using env vars (no server/apiKey in code)

```typescript
// Set EXPOSE_TUNNEL_SERVER and EXPOSE_TUNNEL_API_KEY env vars first
const tunnel = await exposeTunnel({ port: 3000 });
```

### Event listeners

```typescript
const tunnel = await exposeTunnel({
  port: 3000,
  server: 'wss://tunnel.yourdomain.com',
  apiKey: 'sk_your_key_here',
});

// Log incoming requests
tunnel.on('request', (method, path, status) => {
  console.log(`${method} ${path} -> ${status}`);
});

// Handle errors
tunnel.on('error', (err) => {
  console.error(err);
});

// Handle tunnel close
tunnel.on('close', () => {
  console.log('Tunnel closed');
});

await tunnel.close();
```

### TunnelClient class (advanced)

```typescript
import { TunnelClient } from '@gagandeep023/expose-tunnel';

const client = new TunnelClient({
  port: 3000,
  server: 'wss://tunnel.yourdomain.com',
  apiKey: 'sk_your_key_here',
  subdomain: 'myapp',
});

const instance = await client.connect();
console.log(instance.url);

// ... use the tunnel

await client.close();
```

## API Reference

### `exposeTunnel(options)`

Creates a tunnel and returns a `TunnelInstance`.

**Parameters:**

| Parameter   | Type     | Required | Default                           | Description                          |
|-------------|----------|----------|-----------------------------------|--------------------------------------|
| `port`      | `number` | Yes      |                                   | Local port to expose                 |
| `server`    | `string` | Yes*     | `EXPOSE_TUNNEL_SERVER` env var    | Relay server WebSocket URL           |
| `apiKey`    | `string` | Yes*     | `EXPOSE_TUNNEL_API_KEY` env var   | Authentication key                   |
| `subdomain` | `string` | No       | Random 8-char                     | Requested subdomain                  |
| `localHost` | `string` | No       | `localhost`                       | Local hostname to proxy requests to  |

*Can be provided via env var instead.

**Returns:** `Promise<TunnelInstance>`

### `TunnelInstance`

| Property/Method | Type                    | Description                                      |
|-----------------|-------------------------|--------------------------------------------------|
| `url`           | `string`                | Public HTTPS URL of the tunnel                   |
| `subdomain`     | `string`                | Assigned subdomain                               |
| `close()`       | `() => Promise<void>`   | Closes the tunnel connection                     |
| `on(event, fn)` | EventEmitter            | Listen for `request`, `error`, or `close` events |

## Environment Variables

### Client

| Variable                 | Description                                      |
|--------------------------|--------------------------------------------------|
| `EXPOSE_TUNNEL_SERVER`   | Relay server WebSocket URL (e.g., `wss://tunnel.yourdomain.com`) |
| `EXPOSE_TUNNEL_API_KEY`  | API key for authenticating with the relay server |

### Relay Server

| Variable          | Description                                              | Default                    |
|-------------------|----------------------------------------------------------|----------------------------|
| `RELAY_PORT`      | Port the relay server listens on                         | `4040`                     |
| `API_KEYS`        | Comma-separated list of valid API keys                   | (required)                 |
| `TUNNEL_DOMAIN`   | Base domain for tunnel subdomains                        | `tunnel.gagandeep023.com`  |
| `MAX_TUNNELS`     | Maximum number of concurrent tunnel connections allowed  | `10`                       |

## Self-Hosting the Relay Server

The package includes a relay server you can deploy on your own infrastructure. See [SELF-HOSTING-GUIDE.md](./SELF-HOSTING-GUIDE.md) for the full step-by-step deployment guide.

### Quick overview

1. Deploy on any VPS (EC2, DigitalOcean, etc.)
2. Set up wildcard DNS (`*.tunnel.yourdomain.com` -> your server IP)
3. Configure Nginx with wildcard SSL
4. Start the relay server with PM2

### Requirements

- Node.js 18+
- A domain with wildcard DNS (e.g., `*.tunnel.yourdomain.com`)
- Nginx with wildcard SSL certificate
- PM2 (recommended) for process management

### Quick Setup

```bash
mkdir expose-tunnel-server && cd expose-tunnel-server
npm init -y
npm install @gagandeep023/expose-tunnel
```

Create `.env`:

```bash
RELAY_PORT=4040
API_KEYS=sk_your_generated_key
TUNNEL_DOMAIN=tunnel.yourdomain.com
MAX_TUNNELS=10
```

Generate an API key:

```bash
node -e "console.log('sk_' + require('crypto').randomBytes(24).toString('hex'))"
```

Create `start.js`:

```javascript
const fs = require('fs');
const path = require('path');

const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
envFile.split('\n').forEach(line => {
  const [key, ...val] = line.split('=');
  if (key && val.length) process.env[key.trim()] = val.join('=').trim();
});

require('@gagandeep023/expose-tunnel/dist/server/index.js');
```

Start it:

```bash
pm2 start start.js --name expose-tunnel-relay
```

### Health Check

```bash
curl https://tunnel.yourdomain.com/health
# { "status": "ok", "tunnels": 0, "maxTunnels": 10 }
```

## TypeScript

Full TypeScript support with exported types:

```typescript
import type { TunnelOptions, TunnelInstance, TunnelRequest, TunnelResponse } from '@gagandeep023/expose-tunnel';
```

## License

MIT
