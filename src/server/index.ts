import { RelayServer } from './relay-server';
import { logger } from '../utils/logger';

const port = parseInt(process.env.RELAY_PORT || '4040');
const apiKeys = (process.env.API_KEYS || '').split(',').filter(Boolean);
const domain = process.env.TUNNEL_DOMAIN || 'tunnel.gagandeep023.com';
const maxTunnels = parseInt(process.env.MAX_TUNNELS || '10');

if (apiKeys.length === 0) {
  logger.error('No API keys configured. Set API_KEYS environment variable (comma-separated).');
  process.exit(1);
}

const server = new RelayServer({ port, apiKeys, domain, maxTunnels });

server.start().catch((err) => {
  logger.error(`Failed to start relay server: ${err.message}`);
  process.exit(1);
});

process.on('SIGINT', async () => {
  logger.info('Shutting down relay server...');
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down relay server...');
  await server.stop();
  process.exit(0);
});
