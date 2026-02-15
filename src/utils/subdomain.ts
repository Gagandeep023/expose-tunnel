import crypto from 'node:crypto';

const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function generateSubdomain(): string {
  const bytes = crypto.randomBytes(8);
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += CHARS[bytes[i] % CHARS.length];
  }
  return result;
}

export function isValidSubdomain(subdomain: string): boolean {
  if (subdomain.length < 3 || subdomain.length > 63) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(subdomain);
}
