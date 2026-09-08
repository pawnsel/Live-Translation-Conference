/** Mock sign-in.
 *
 *  UI ONLY. There is no identity provider, no server session and no database
 *  behind any of this — the "signed in" user lives in React state, mirrored to
 *  localStorage so a page reload during a demo doesn't kick you back out.
 *  Every function here is a stand-in for a call that P2 will make for real.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { avatarDataUri } from './avatar';

export interface MockUser {
  email: string;
  /** Display name as Google would hand it over. */
  name: string;
  picture: string;
  /** Filled in by the registration form, absent for a plain sign-in. */
  firstName?: string;
  lastName?: string;
  phone?: string;
}

/** The accounts the fake Google chooser offers. Deliberately mixed: the
 *  non-Chula ones exist so the registration filter can be demonstrated. */
export interface GoogleAccount {
  email: string;
  name: string;
  picture: string;
}

function account(name: string, email: string): GoogleAccount {
  return { name, email, picture: avatarDataUri(email) };
}

export const MOCK_GOOGLE_ACCOUNTS: GoogleAccount[] = [
  account('สมชาย ใจดี', 'somchai.j@chula.ac.th'),
  account('Nattha Preeda', 'nattha.p@student.chula.ac.th'),
  account('Somchai Dev', 'somchai.dev@gmail.com'),
];

/** Only Chulalongkorn addresses may register. Accepts the university domain
 *  and its faculty/student subdomains (`student.chula.ac.th`, `eng.chula...`),
 *  and rejects anything else outright — a rejected address never reaches the
 *  details form. */
export function isChulaEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split('@')[1];
  if (!domain) return false;
  return domain === 'chula.ac.th' || domain.endsWith('.chula.ac.th') || domain.startsWith('chula.');
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** Best-effort display name for an address with no Google profile behind it. */
export function nameFromEmail(email: string): string {
  const local = email.trim().split('@')[0] ?? '';
  return local.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || email;
}

const STORAGE_KEY = 'ltc.mockAuth.user';

function readStoredUser(): MockUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MockUser;
    return parsed && typeof parsed.email === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

interface AuthContextValue {
  user: MockUser | null;
  signIn: (user: MockUser) => void;
  signInWithEmail: (email: string) => void;
  signInWithGoogle: (acct: GoogleAccount) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MockUser | null>(() => readStoredUser());

  useEffect(() => {
    try {
      if (user) localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // A demo that can't persist is still a working demo.
    }
  }, [user]);

  const signIn = useCallback((next: MockUser) => setUser(next), []);

  const signInWithEmail = useCallback((email: string) => {
    const trimmed = email.trim();
    setUser({ email: trimmed, name: nameFromEmail(trimmed), picture: avatarDataUri(trimmed) });
  }, []);

  const signInWithGoogle = useCallback((acct: GoogleAccount) => {
    setUser({ email: acct.email, name: acct.name, picture: acct.picture });
  }, []);

  const signOut = useCallback(() => setUser(null), []);

  const value = useMemo(
    () => ({ user, signIn, signInWithEmail, signInWithGoogle, signOut }),
    [user, signIn, signInWithEmail, signInWithGoogle, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
