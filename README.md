# @gagandeep023/expose-tunnel

A self-hosted tunnel to expose local servers to the internet via `*.tunnel.gagandeep023.com` subdomains. An alternative to ngrok and localtunnel that runs on your own infrastructure.

[![npm version](https://img.shields.io/npm/v/@gagandeep023/expose-tunnel.svg)](https://www.npmjs.com/package/@gagandeep023/expose-tunnel)
[![license](https://img.shields.io/npm/l/@gagandeep023/expose-tunnel.svg)](https://github.com/Gagandeep023/expose-tunnel/blob/main/LICENSE)

## How It Works

```
Your Machine                    EC2 Relay Server                Internet
+--------------+    WebSocket   +------------------------+    HTTPS    +----------+
| localhost:   | -------------> | tunnel.gagandeep023.com| <--------- | Browser  |
| 3000         | <------------- | *.tunnel.gagandeep023  | ---------> | requests |
+--------------+                +------------------------+            +----------+
```

1. The client connects to the relay server via WebSocket
2. The relay server assigns a public subdomain (e.g., `abc123.tunnel.gagandeep023.com`)
3. When external traffic hits that subdomain, the relay server pipes it through the WebSocket to your machine
4. Your client forwards the request to `localhost:<port>` and sends the response back

## Installation

```bash
npm install @gagandeep023/expose-tunnel
```

## Quick Start

### CLI

```bash
# Set your API key
export EXPOSE_TUNNEL_API_KEY=sk_your_key_here

# Expose port 3000
npx @gagandeep023/expose-tunnel --port 3000

# With a custom subdomain
npx @gagandeep023/expose-tunnel --port 3000 --subdomain myapp

# Output:
# [expose-tunnel] Tunnel established!
# [expose-tunnel] Public URL: https://myapp.tunnel.gagandeep023.com
# [expose-tunnel] Forwarding to: http://localhost:3000
# [expose-tunnel] Press Ctrl+C to close the tunnel.
```

### Programmatic API

```typescript
import { exposeTunnel } from '@gagandeep023/expose-tunnel';

const tunnel = await exposeTunnel({
  port: 3000,
  apiKey: 'sk_your_key_here',
});

console.log(`Public URL: ${tunnel.url}`);
// https://abc123.tunnel.gagandeep023.com

// Listen for events
tunnel.on('request', (method, path, status) => {
  console.log(`${method} ${path} -> ${status}`);
});

tunnel.on('error', (err) => {
  console.error(err);
});

// Close when done
await tunnel.close();
```

## CLI Reference

```
Usage: expose-tunnel [options]

Expose local servers to the internet via gagandeep023.com subdomains

Options:
  -V, --version            output version number
  -p, --port <number>      Local port to expose (required)
  -s, --subdomain <name>   Request a specific subdomain
  --server <url>           Relay server URL (default: wss://tunnel.gagandeep023.com)
  --api-key <key>          API key (or set EXPOSE_TUNNEL_API_KEY env var)
  --local-host <host>      Local hostname to proxy to (default: localhost)
  -h, --help               display help for command
```

## API Reference

### `exposeTunnel(options)`

Creates a tunnel and returns a `TunnelInstance`.

**Parameters:**

| Parameter   | Type     | Required | Default                             | Description                          |
|-------------|----------|----------|-------------------------------------|--------------------------------------|
| `port`      | `number` | Yes      |                                     | Local port to expose                 |
| `subdomain` | `string` | No       | Random 8-char                       | Requested subdomain                  |
| `server`    | `string` | No       | `wss://tunnel.gagandeep023.com`     | Relay server WebSocket URL           |
| `apiKey`    | `string` | No       | `EXPOSE_TUNNEL_API_KEY` env var     | Authentication key                   |
| `localHost` | `string` | No       | `localhost`                         | Local hostname to proxy requests to  |

**Returns:** `Promise<TunnelInstance>`

### `TunnelInstance`

| Property/Method | Type                    | Description                                      |
|-----------------|-------------------------|--------------------------------------------------|
| `url`           | `string`                | Public HTTPS URL of the tunnel                   |
| `subdomain`     | `string`                | Assigned subdomain                               |
| `close()`       | `() => Promise<void>`   | Closes the tunnel connection                     |
| `on(event, fn)` | EventEmitter            | Listen for `request`, `error`, or `close` events |

### `TunnelClient`

For more control, use the `TunnelClient` class directly:

```typescript
import { TunnelClient } from '@gagandeep023/expose-tunnel';

const client = new TunnelClient({
  port: 3000,
  apiKey: 'sk_your_key_here',
  subdomain: 'myapp',
});

const instance = await client.connect();
// ... use the tunnel
await client.close();
```

## Environment Variables

| Variable                 | Description                                |
|--------------------------|--------------------------------------------|
| `EXPOSE_TUNNEL_API_KEY`  | API key for authenticating with the relay   |

## Self-Hosting the Relay Server

The package includes a relay server you can deploy on your own infrastructure.

### Requirements

- Node.js 18+
- A domain with wildcard DNS (e.g., `*.tunnel.yourdomain.com`)
- Nginx with wildcard SSL certificate
- PM2 (recommended) for process management

### Setup

1. Install the package:

```bash
mkdir expose-tunnel-server && cd expose-tunnel-server
npm init -y
npm install @gagandeep023/expose-tunnel
```

2. Create a startup script (`start.js`):

```javascript
const fs = require('fs');
const path = require('path');

// Load .env
const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
envFile.split('\n').forEach(line => {
  const [key, ...val] = line.split('=');
  if (key && val.length) process.env[key.trim()] = val.join('=').trim();
});

require('@gagandeep023/expose-tunnel/dist/server/index.js');
```

3. Configure environment:

```bash
# .env
RELAY_PORT=4040
API_KEYS=sk_your_generated_key
TUNNEL_DOMAIN=tunnel.yourdomain.com
```

4. Generate an API key:

```bash
node -e "console.log('sk_' + require('crypto').randomBytes(24).toString('hex'))"
```

5. Start the relay server:

```bash
node start.js

# Or with PM2:
pm2 start start.js --name expose-tunnel-relay
```

6. Configure Nginx (wildcard reverse proxy):

```nginx
server {
    listen 443 ssl;
    server_name tunnel.yourdomain.com *.tunnel.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/tunnel.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tunnel.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4040;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

7. Set up wildcard SSL with Let's Encrypt:

```bash
sudo certbot certonly --manual --preferred-challenges dns \
  -d tunnel.yourdomain.com -d "*.tunnel.yourdomain.com"
```

### Health Check

```bash
curl https://tunnel.yourdomain.com/health
# { "status": "ok", "tunnels": 0 }
```

## TypeScript

Full TypeScript support with exported types:

```typescript
import type { TunnelOptions, TunnelInstance, TunnelRequest, TunnelResponse } from '@gagandeep023/expose-tunnel';
```

## License

MIT
