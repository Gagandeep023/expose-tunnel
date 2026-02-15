import { Command } from 'commander';
import { exposeTunnel } from './client/tunnel-client';
import { logger } from './utils/logger';

const program = new Command();

program
  .name('expose-tunnel')
  .description('Expose local servers to the internet via your own relay server')
  .version('0.4.0')
  .requiredOption('-p, --port <number>', 'Local port to expose')
  .option('-s, --subdomain <name>', 'Request a specific subdomain')
  .option('--server <url>', 'Relay server WebSocket URL (or set EXPOSE_TUNNEL_SERVER env var)')
  .option('--api-key <key>', 'API key (or set EXPOSE_TUNNEL_API_KEY env var)')
  .option('--local-host <host>', 'Local hostname to proxy to', 'localhost')
  .action(async (opts) => {
    const server = opts.server || process.env.EXPOSE_TUNNEL_SERVER;
    if (!server) {
      logger.error('Relay server URL required. Use --server <url> or set EXPOSE_TUNNEL_SERVER env var.');
      process.exit(1);
    }

    const apiKey = opts.apiKey || process.env.EXPOSE_TUNNEL_API_KEY;
    if (!apiKey) {
      logger.error('API key required. Use --api-key or set EXPOSE_TUNNEL_API_KEY env var.');
      process.exit(1);
    }

    const port = parseInt(opts.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      logger.error('Invalid port number. Must be between 1 and 65535.');
      process.exit(1);
    }

    try {
      const tunnel = await exposeTunnel({
        port,
        subdomain: opts.subdomain,
        server,
        apiKey,
        localHost: opts.localHost,
      });

      logger.success('Tunnel established!');
      logger.info(`Public URL: ${tunnel.url}`);
      logger.info(`Forwarding to: http://${opts.localHost}:${port}`);
      logger.info('Press Ctrl+C to close the tunnel.\n');

      tunnel.on('error', (...args: unknown[]) => {
        const err = args[0] as Error;
        logger.error(err.message);
      });

      const shutdown = async (): Promise<void> => {
        logger.info('\nClosing tunnel...');
        await tunnel.close();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (err) {
      logger.error(`Failed to establish tunnel: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program.parse();
