import { describe, it, expect } from 'vitest';
import { isAllowedEmail, isValidEmail, nameFromEmail } from './accountStatus';

// The registration gate. The same rule is duplicated as a CHECK constraint in
// supabase/schema.sql — if one of these expectations changes, that constraint
// has to change with it.
describe('isAllowedEmail', () => {
  it('accepts the university domain', () => {
    expect(isAllowedEmail('somchai.j@chula.ac.th')).toBe(true);
  });

  it('accepts subdomains of it', () => {
    expect(isAllowedEmail('nattha.p@student.chula.ac.th')).toBe(true);
    expect(isAllowedEmail('a@eng.chula.ac.th')).toBe(true);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(isAllowedEmail('  Somchai.J@Chula.AC.TH ')).toBe(true);
  });

  it('rejects other domains', () => {
    expect(isAllowedEmail('somchai@gmail.com')).toBe(false);
    expect(isAllowedEmail('somchai@mahidol.ac.th')).toBe(false);
  });

  it('rejects look-alike domains that merely contain the name', () => {
    expect(isAllowedEmail('a@chula.ac.th.evil.com')).toBe(false);
    expect(isAllowedEmail('a@notchula.ac.th')).toBe(false);
    expect(isAllowedEmail('a@chula.ac.th.co')).toBe(false);
  });

  it('rejects malformed addresses', () => {
    expect(isAllowedEmail('chula.ac.th')).toBe(false);
    expect(isAllowedEmail('a@b@chula.ac.th')).toBe(false);
    expect(isAllowedEmail('')).toBe(false);
  });

  it('honours an overridden domain', () => {
    expect(isAllowedEmail('a@example.com', 'example.com')).toBe(true);
    expect(isAllowedEmail('a@chula.ac.th', 'example.com')).toBe(false);
  });
});

describe('isValidEmail', () => {
  it('accepts an ordinary address', () => {
    expect(isValidEmail('somchai.j@chula.ac.th')).toBe(true);
  });

  it('rejects addresses without a domain or a dot', () => {
    expect(isValidEmail('somchai')).toBe(false);
    expect(isValidEmail('somchai@chula')).toBe(false);
    expect(isValidEmail('somchai @chula.ac.th')).toBe(false);
  });
});

describe('nameFromEmail', () => {
  it('turns the local part into a display name', () => {
    expect(nameFromEmail('somchai.jaidee@chula.ac.th')).toBe('Somchai Jaidee');
    expect(nameFromEmail('nattha_p@chula.ac.th')).toBe('Nattha P');
  });
});
