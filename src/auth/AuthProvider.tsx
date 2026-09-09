/** Session + approval state for the whole app.
 *
 *  Two separate facts live here and both matter:
 *
 *    session — Supabase Auth says who you are. Google will hand out a session
 *              to anyone with a Google account, so this alone means nothing.
 *    status  — whether an admin has approved that person (access_requests).
 *              Only 'approved' may use the console.
 *
 *  The provider never signs anyone out on its own: registration deliberately
 *  runs on a signed-in session whose status is still 'none'. Enforcement lives
 *  in RequireAuth (App.tsx) and in the sign-in pages, which show the status
 *  dialog and then sign out.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AuthError, Session } from '@supabase/supabase-js';
import { supabase, requireSupabase } from '../lib/supabase';
import { avatarDataUri } from './avatar';
import {
  ACCESS_REQUESTS_TABLE,
  nameFromEmail,
  type AccessRequest,
  type AccountStatus,
} from './accountStatus';

/** The identity the UI renders: Google's profile, refined by the approved
 *  registration details once they exist. */
export interface AppUser {
  id: string;
  email: string;
  name: string;
  picture: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

export interface RegistrationDetails {
  firstName: string;
  lastName: string;
  phone: string;
  /** Optional. Registration happens through Google, so a password is only
   *  needed by people who also want the email + password form to work. */
  password?: string;
}

/** Where a Google redirect should return to, remembered across the round trip
 *  to accounts.google.com (which loses all in-memory state). */
export type AuthIntent = 'login' | 'register';
const INTENT_KEY = 'ltc.auth.intent';

export function readAuthIntent(): AuthIntent {
  try {
    return sessionStorage.getItem(INTENT_KEY) === 'register' ? 'register' : 'login';
  } catch {
    return 'login';
  }
}

function writeAuthIntent(intent: AuthIntent) {
  try {
    sessionStorage.setItem(INTENT_KEY, intent);
  } catch {
    // A blocked sessionStorage only costs the callback its hint; it defaults
    // to 'login', which is the safe branch.
  }
}

interface AuthContextValue {
  session: Session | null;
  user: AppUser | null;
  profile: AccessRequest | null;
  status: AccountStatus;
  /** False until both the session AND that session's approval status are
   *  known. Everything that routes on `status` must wait for this, or a fresh
   *  sign-in gets bounced by its own guard. */
  ready: boolean;
  /** Set when the status lookup itself failed (schema not applied, network
   *  down) — distinct from a legitimately absent request row. */
  error: string | null;
  signInWithGoogle: (intent: AuthIntent) => Promise<{ error: AuthError | null }>;
  signInWithPassword: (email: string, password: string) => Promise<{ error: AuthError | null }>;
  submitAccessRequest: (details: RegistrationDetails) => Promise<void>;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(Boolean(supabase));
  const [profile, setProfile] = useState<AccessRequest | null>(null);
  const [status, setStatus] = useState<AccountStatus>('none');
  const [error, setError] = useState<string | null>(null);
  /** Auth user id whose status has actually been loaded — the guard against
   *  reading a stale 'none' for a user who just signed in. */
  const [syncedFor, setSyncedFor] = useState<string | null>(null);

  // Session. The onAuthStateChange callback only touches React state:
  // awaiting other supabase calls inside it can deadlock the client's lock.
  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        setSession(data.session ?? null);
        setSessionLoading(false);
      })
      .catch(() => {
        if (!cancelled) setSessionLoading(false);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setSessionLoading(false);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  // Approval status, reloaded whenever the signed-in user changes.
  const userId = session?.user?.id ?? null;
  const requestSeq = useRef(0);

  const loadStatus = useCallback(async () => {
    const seq = ++requestSeq.current;
    if (!supabase || !userId) {
      setProfile(null);
      setStatus('none');
      setError(null);
      setSyncedFor(null);
      return;
    }
    const { data, error: queryError } = await supabase
      .from(ACCESS_REQUESTS_TABLE)
      .select('*')
      .eq('id', userId)
      .maybeSingle<AccessRequest>();

    if (seq !== requestSeq.current) return; // a newer load has superseded this one

    if (queryError) {
      setProfile(null);
      setStatus('none');
      setError(queryError.message);
    } else {
      setProfile(data ?? null);
      setStatus(data?.status ?? 'none');
      setError(null);
    }
    setSyncedFor(userId);
  }, [userId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const signInWithGoogle = useCallback(async (intent: AuthIntent) => {
    const client = requireSupabase();
    writeAuthIntent(intent);
    const { error: oauthError } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        // Always offer the account chooser: a shared machine must not silently
        // reuse whoever signed in last.
        queryParams: { prompt: 'select_account' },
      },
    });
    return { error: oauthError };
  }, []);

  const signInWithPassword = useCallback(async (email: string, password: string) => {
    const client = requireSupabase();
    const { error: signInError } = await client.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    return { error: signInError };
  }, []);

  const submitAccessRequest = useCallback(
    async (details: RegistrationDetails) => {
      const client = requireSupabase();
      const authUser = session?.user;
      if (!authUser?.email) throw new Error('เซสชันหมดอายุ กรุณายืนยันบัญชี Google อีกครั้ง');

      const { error: insertError } = await client.from(ACCESS_REQUESTS_TABLE).insert({
        id: authUser.id,
        email: authUser.email,
        first_name: details.firstName.trim(),
        last_name: details.lastName.trim(),
        phone: details.phone.trim(),
        status: 'pending',
      });

      if (insertError) {
        // 23505 = the unique index on lower(email): they already applied.
        if (insertError.code === '23505') {
          throw new Error('อีเมลนี้ส่งคำขอไว้แล้ว กรุณารอผู้ดูแลระบบตรวจสอบ');
        }
        throw new Error(insertError.message);
      }

      // Optional password, so the email + password form on the login page
      // works for this account later. A failure here must not lose the
      // request that was just filed, so it is reported softly.
      if (details.password) {
        const { error: passwordError } = await client.auth.updateUser({ password: details.password });
        if (passwordError) {
          console.warn('[auth] could not set password:', passwordError.message);
        }
      }

      await loadStatus();
    },
    [session, loadStatus],
  );

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setStatus('none');
    setSyncedFor(null);
  }, []);

  const user: AppUser | null = useMemo(() => {
    const authUser = session?.user;
    if (!authUser) return null;
    const email = authUser.email ?? '';
    const meta = (authUser.user_metadata ?? {}) as Record<string, unknown>;
    const googleName = typeof meta.full_name === 'string' ? meta.full_name : undefined;
    const googlePicture =
      (typeof meta.avatar_url === 'string' && meta.avatar_url) ||
      (typeof meta.picture === 'string' && meta.picture) ||
      undefined;
    const registeredName = profile ? `${profile.first_name} ${profile.last_name}`.trim() : '';

    return {
      id: authUser.id,
      email,
      name: registeredName || googleName || nameFromEmail(email),
      picture: googlePicture || avatarDataUri(email || authUser.id),
      firstName: profile?.first_name,
      lastName: profile?.last_name,
      phone: profile?.phone,
    };
  }, [session, profile]);

  const ready = !sessionLoading && (!userId || syncedFor === userId);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user,
      profile,
      status,
      ready,
      error,
      signInWithGoogle,
      signInWithPassword,
      submitAccessRequest,
      refresh: loadStatus,
      signOut,
    }),
    [
      session,
      user,
      profile,
      status,
      ready,
      error,
      signInWithGoogle,
      signInWithPassword,
      submitAccessRequest,
      loadStatus,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
