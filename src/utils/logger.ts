const PREFIX = '[expose-tunnel]';

const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
};

export const logger = {
  info(msg: string): void {
    console.log(`${colors.cyan}${PREFIX}${colors.reset} ${msg}`);
  },

  error(msg: string): void {
    console.error(`${colors.red}${PREFIX}${colors.reset} ${msg}`);
  },

  success(msg: string): void {
    console.log(`${colors.green}${PREFIX}${colors.reset} ${msg}`);
  },

  request(method: string, path: string, status: number): void {
    const statusColor = status < 400 ? colors.green : status < 500 ? colors.yellow : colors.red;
    console.log(
      `${colors.dim}${PREFIX}${colors.reset} ${method} ${path} ${statusColor}${status}${colors.reset}`
    );
  },
};
