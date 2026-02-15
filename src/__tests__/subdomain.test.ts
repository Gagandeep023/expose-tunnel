import { describe, it, expect } from 'vitest';
import { generateSubdomain, isValidSubdomain } from '../utils/subdomain';

describe('generateSubdomain', () => {
  it('should return an 8-character string', () => {
    const sub = generateSubdomain();
    expect(sub).toHaveLength(8);
  });

  it('should only contain lowercase alphanumeric characters', () => {
    for (let i = 0; i < 100; i++) {
      const sub = generateSubdomain();
      expect(sub).toMatch(/^[a-z0-9]+$/);
    }
  });

  it('should generate unique subdomains', () => {
    const subs = new Set<string>();
    for (let i = 0; i < 100; i++) {
      subs.add(generateSubdomain());
    }
    // With 8 chars from 36 possible, collisions in 100 samples are extremely unlikely
    expect(subs.size).toBe(100);
  });
});

describe('isValidSubdomain', () => {
  it('should accept valid subdomains', () => {
    expect(isValidSubdomain('abc')).toBe(true);
    expect(isValidSubdomain('my-app')).toBe(true);
    expect(isValidSubdomain('test123')).toBe(true);
    expect(isValidSubdomain('a1b2c3d4')).toBe(true);
  });

  it('should reject subdomains shorter than 3 characters', () => {
    expect(isValidSubdomain('ab')).toBe(false);
    expect(isValidSubdomain('a')).toBe(false);
    expect(isValidSubdomain('')).toBe(false);
  });

  it('should reject subdomains longer than 63 characters', () => {
    expect(isValidSubdomain('a'.repeat(64))).toBe(false);
  });

  it('should accept subdomains of exactly 3 and 63 characters', () => {
    expect(isValidSubdomain('abc')).toBe(true);
    expect(isValidSubdomain('a'.repeat(63))).toBe(true);
  });

  it('should reject subdomains with uppercase letters', () => {
    expect(isValidSubdomain('MyApp')).toBe(false);
    expect(isValidSubdomain('ABC')).toBe(false);
  });

  it('should reject subdomains with special characters', () => {
    expect(isValidSubdomain('my_app')).toBe(false);
    expect(isValidSubdomain('my.app')).toBe(false);
    expect(isValidSubdomain('my app')).toBe(false);
    expect(isValidSubdomain('my@app')).toBe(false);
  });

  it('should reject subdomains starting or ending with hyphen', () => {
    expect(isValidSubdomain('-myapp')).toBe(false);
    expect(isValidSubdomain('myapp-')).toBe(false);
    expect(isValidSubdomain('-my-app-')).toBe(false);
  });

  it('should accept subdomains with hyphens in the middle', () => {
    expect(isValidSubdomain('my-app')).toBe(true);
    expect(isValidSubdomain('my-cool-app')).toBe(true);
  });
});
