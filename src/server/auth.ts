export function validateApiKey(key: string | undefined, validKeys: string[]): boolean {
  if (!key || validKeys.length === 0) return false;
  return validKeys.includes(key);
}
