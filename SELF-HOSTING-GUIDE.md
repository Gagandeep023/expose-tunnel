# Self-Hosting Guide: @gagandeep023/expose-tunnel

Complete step-by-step guide to deploy the expose-tunnel relay server on a fresh VPS or EC2 instance.

## Prerequisites

- A VPS or EC2 instance (Ubuntu 22.04+ recommended) with a public IP
- A domain name with DNS access (e.g., GoDaddy, Cloudflare, Route53)
- SSH access to the server
- Node.js 20+ and npm

---

## Step 1: DNS Configuration

You need two DNS records pointing to your server's public IP. Replace `YOUR_SERVER_IP` with your actual server IP.

### GoDaddy / Any DNS Provider

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | tunnel | YOUR_SERVER_IP | 600 |
| A | *.tunnel | YOUR_SERVER_IP | 600 |

The first record handles the base domain (`tunnel.yourdomain.com`).
The second is a wildcard that catches all subdomains (`*.tunnel.yourdomain.com`).

### Verify DNS propagation

```bash
# From your local machine
dig +short tunnel.yourdomain.com
dig +short anything.tunnel.yourdomain.com
```

Both should return your server IP. DNS propagation can take 5-30 minutes.

---

## Step 2: Server Setup (SSH into your server)

### 2a. Install Node.js 20+

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v  # Should show v20.x.x
npm -v
```

### 2b. Install PM2 (Process Manager)

```bash
sudo npm install -g pm2
```

### 2c. Install Nginx

```bash
sudo apt-get update
sudo apt-get install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

### 2d. Install Certbot (for SSL)

```bash
sudo apt-get install -y certbot
```

---

## Step 3: Install the Tunnel Package

```bash
# Create the application directory
sudo mkdir -p /root/apps/expose-tunnel
cd /root/apps/expose-tunnel

# Install the package from npm
npm init -y
npm install @gagandeep023/expose-tunnel
```

---

## Step 4: Generate an API Key

```bash
node -e "console.log('sk_' + require('crypto').randomBytes(32).toString('hex'))"
```

Save this key. You will need it for:
- The server `.env` file
- Every client that connects

---

## Step 5: Create the Server Entry File

Create `/root/apps/expose-tunnel/start.js`:

```javascript
const { readFileSync } = require('fs');
const { join } = require('path');

// Load environment variables from .env
const envPath = join(__dirname, '.env');
const envContent = readFileSync(envPath, 'utf-8');
envContent.split('\n').forEach(line => {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) {
    process.env[key.trim()] = rest.join('=').trim();
  }
});

// Start the relay server
require('./node_modules/@gagandeep023/expose-tunnel/dist/server/index.js');
```

---

## Step 6: Create the Environment File

Create `/root/apps/expose-tunnel/.env`:

```env
RELAY_PORT=4040
API_KEYS=sk_YOUR_GENERATED_KEY_HERE
TUNNEL_DOMAIN=tunnel.yourdomain.com
```

Notes:
- `RELAY_PORT`: The internal port the relay server listens on (Nginx proxies to this)
- `API_KEYS`: Comma-separated list if you want multiple keys
- `TUNNEL_DOMAIN`: Must match your DNS setup

---

## Step 7: Start with PM2

```bash
cd /root/apps/expose-tunnel

# Start the process
pm2 start start.js --name expose-tunnel

# Verify it is running
pm2 status
pm2 logs expose-tunnel --lines 20

# Save PM2 process list (survives reboots)
pm2 save
pm2 startup
```

### Verify the server is listening

```bash
curl http://localhost:4040/health
# Expected: {"status":"ok","tunnels":0}
```

---

## Step 8: Configure Nginx (Reverse Proxy + WebSocket)

Create `/etc/nginx/sites-available/tunnel.yourdomain.com`:

```nginx
server {
    listen 80;
    server_name tunnel.yourdomain.com *.tunnel.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:4040;
        proxy_http_version 1.1;

        # WebSocket support (required for tunnel connections)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Forward real client info
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout settings for long-lived WebSocket connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/tunnel.yourdomain.com /etc/nginx/sites-enabled/
sudo nginx -t          # Test configuration
sudo systemctl reload nginx
```

### Verify HTTP is working

```bash
curl http://tunnel.yourdomain.com/health
# Expected: {"status":"ok","tunnels":0}
```

---

## Step 9: SSL Certificate (Let's Encrypt Wildcard)

Wildcard certificates require DNS-01 challenge. This means certbot will give you a TXT record value that you must add to your DNS.

### 9a. Start the certificate request

```bash
sudo certbot certonly \
  --manual \
  --preferred-challenges dns \
  -d "tunnel.yourdomain.com" \
  -d "*.tunnel.yourdomain.com"
```

### 9b. Add the DNS TXT record

Certbot will display something like:

```
Please deploy a DNS TXT record under the name:
_acme-challenge.tunnel.yourdomain.com
with the following value:
xYz123AbCdEfGhIjKlMnOpQrStUvWx...
```

Go to your DNS provider and add:

| Type | Name | Value |
|------|------|-------|
| TXT | _acme-challenge.tunnel | xYz123AbCdEfGhIjKlMnOpQrStUvWx... |

**Important**: If certbot asks for TWO challenges (one per domain), you need both TXT records. Some providers let you add two TXT records with the same name. Others require you to combine them.

### 9c. Wait for DNS propagation

Before pressing Enter in certbot, verify the TXT record is visible:

```bash
# Check from multiple resolvers
dig +short TXT _acme-challenge.tunnel.yourdomain.com @8.8.8.8
dig +short TXT _acme-challenge.tunnel.yourdomain.com @1.1.1.1
```

Wait until both return the expected value. This typically takes 1-2 minutes but can take up to 5 minutes.

### 9d. Complete the challenge

Press Enter in certbot. If successful, you will see:

```
Successfully received certificate.
Certificate is saved at: /etc/letsencrypt/live/tunnel.yourdomain.com/fullchain.pem
Key is saved at:         /etc/letsencrypt/live/tunnel.yourdomain.com/privkey.pem
```

---

## Step 10: Update Nginx for HTTPS

Replace your Nginx config with the SSL version:

```nginx
# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name tunnel.yourdomain.com *.tunnel.yourdomain.com;
    return 301 https://$host$request_uri;
}

# HTTPS server
server {
    listen 443 ssl;
    server_name tunnel.yourdomain.com *.tunnel.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/tunnel.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tunnel.yourdomain.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    location / {
        proxy_pass http://127.0.0.1:4040;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Forward real client info
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Long-lived connection timeout for WebSockets
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

Reload Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### Verify HTTPS

```bash
curl https://tunnel.yourdomain.com/health
# Expected: {"status":"ok","tunnels":0}
```

---

## Step 11: Set Up Auto-Renewal

Let's Encrypt certificates expire every 90 days. The DNS challenge cannot be auto-renewed without a DNS plugin, so set a reminder or use a DNS provider plugin:

### Option A: Manual renewal (every ~60 days)

```bash
sudo certbot renew --manual
```

### Option B: Automated with DNS plugin (Cloudflare example)

```bash
sudo apt-get install python3-certbot-dns-cloudflare

# Create /root/.cloudflare.ini with your API token
# dns_cloudflare_api_token = YOUR_TOKEN

sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /root/.cloudflare.ini \
  -d "tunnel.yourdomain.com" \
  -d "*.tunnel.yourdomain.com"

# Auto-renewal will work via cron:
sudo certbot renew --dry-run
```

---

## Step 12: End-to-End Test

### From your local machine:

```bash
# Start a simple test server
node -e "require('http').createServer((q,s) => { s.end('Tunnel works!') }).listen(8080, () => console.log('Listening on 8080'))"
```

### In another terminal:

```bash
npx @gagandeep023/expose-tunnel \
  --port 8080 \
  --api-key sk_YOUR_GENERATED_KEY_HERE \
  --server wss://tunnel.yourdomain.com
```

You should see output like:

```
[expose-tunnel] Connected! Your tunnel is live:
[expose-tunnel] https://a1b2c3d4.tunnel.yourdomain.com
```

### Verify from anywhere:

```bash
curl https://a1b2c3d4.tunnel.yourdomain.com/
# Expected: Tunnel works!
```

---

## Troubleshooting

### "Tunnel not found" error
The tunnel only exists while the CLI client is running. If you stop the CLI, the subdomain becomes unavailable immediately.

### WebSocket connection fails
- Check Nginx has `proxy_set_header Upgrade` and `Connection "upgrade"` directives
- Verify the relay server is running: `pm2 status` and `curl localhost:4040/health`
- Check firewall allows ports 80 and 443: `sudo ufw status`

### SSL certificate issues
- Verify DNS TXT records are propagated before completing the certbot challenge
- Let's Encrypt has rate limits: 5 failed validations per hour, 50 certificates per domain per week
- Use `--staging` flag for testing to avoid rate limits

### "Connection refused" on the tunneled URL
- The local server on your machine must be running on the specified port
- Check that `--local-host` matches where your server is listening (default: `localhost`)

### PM2 process keeps crashing
- Check logs: `pm2 logs expose-tunnel --lines 50`
- Verify `.env` file has correct values
- Ensure `API_KEYS` is not empty (server exits if no keys configured)

---

## Architecture Reference

```
Internet User
    |
    | HTTPS request to abc123.tunnel.yourdomain.com
    v
+-----------+
|  Nginx    |  Port 443 (SSL termination)
|  Reverse  |  Wildcard cert: *.tunnel.yourdomain.com
|  Proxy    |
+-----------+
    |
    | proxy_pass to localhost:4040
    v
+-----------+
|  Relay    |  Node.js process (PM2 managed)
|  Server   |  Routes requests by subdomain
|           |  Manages WebSocket tunnel connections
+-----------+
    |
    | WebSocket (persistent connection)
    v
+-----------+
|  Tunnel   |  CLI or SDK on your local machine
|  Client   |  Forwards requests to localhost:PORT
+-----------+
    |
    | HTTP request to localhost:PORT
    v
+-----------+
|  Your     |  Any local server (React, Express, etc.)
|  Local    |
|  Server   |
+-----------+
```

---

## Security Considerations

- **API keys**: Generate strong keys and never commit them to version control
- **Firewall**: Only expose ports 80 and 443. The relay port (4040) should only be accessible from localhost
- **Rate limiting**: Consider adding Nginx rate limiting for production use
- **Key rotation**: Generate new API keys periodically and update both server and client configs
