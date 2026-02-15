import { describe, it, expect } from 'vitest';
import { validateApiKey } from '../server/auth';

describe('validateApiKey', () => {
  const validKeys = ['sk_abc123', 'sk_def456'];

  it('should return true for a valid API key', () => {
    expect(validateApiKey('sk_abc123', validKeys)).toBe(true);
    expect(validateApiKey('sk_def456', validKeys)).toBe(true);
  });

  it('should return false for an invalid API key', () => {
    expect(validateApiKey('sk_wrong', validKeys)).toBe(false);
    expect(validateApiKey('invalid', validKeys)).toBe(false);
  });

  it('should return false for undefined key', () => {
    expect(validateApiKey(undefined, validKeys)).toBe(false);
  });

  it('should return false for empty string key', () => {
    expect(validateApiKey('', validKeys)).toBe(false);
  });

  it('should return false when no valid keys are configured', () => {
    expect(validateApiKey('sk_abc123', [])).toBe(false);
  });
});
