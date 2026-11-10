import { describe, expect, it } from 'vitest';
import { detectPii, isValidIban, luhn } from './detectors';

const types = (s: string) => detectPii(s).map((x) => x.type);

describe('checksums', () => {
  it('luhn', () => {
    expect(luhn('4111111111111111')).toBe(true);
    expect(luhn('4111111111111112')).toBe(false);
  });
  it('iban mod 97', () => {
    expect(isValidIban('DE89370400440532013000')).toBe(true);
    expect(isValidIban('DE89370400440532013001')).toBe(false);
  });
});

describe('detectPii', () => {
  it('finds a card number only when Luhn passes', () => {
    expect(types('card 4111 1111 1111 1111 ok')).toEqual(['card']);
    expect(types('ref 4111111111111112')).toEqual([]);
  });
  it('returns exact spans', () => {
    const s = 'mail john.smith@gmail.com now';
    const [hit] = detectPii(s);
    expect(hit).toMatchObject({ type: 'email', value: 'john.smith@gmail.com' });
    expect(s.slice(hit.start, hit.end)).toBe(hit.value);
  });
  it('finds IBAN, account, SSN, EIN, phone and token URLs', () => {
    expect(types('to DE89370400440532013000')).toEqual(['iban']);
    expect(types('PINECREST acct 4400981123')).toEqual(['account']);
    expect(types('ssn 512-44-7731')).toEqual(['ssn']);
    expect(types('EIN 84-1234567')).toEqual(['ein']);
    expect(types('call (415) 555-0132')).toEqual(['phone']);
    expect(types('call +1 718 555 0123')).toEqual(['phone']);
    expect(types('see https://pay.example/c?token=abc123def4')).toEqual(['url']);
  });
  it('ignores plain URLs and invalid SSNs', () => {
    expect(types('https://example.com/about')).toEqual([]);
    expect(types('000-12-3456')).toEqual([]);
  });
  it('does not report a card as a phone number', () => {
    expect(types('4111111111111111')).toEqual(['card']);
  });
});
