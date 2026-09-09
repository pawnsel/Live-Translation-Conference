/** The one Supabase client for the browser.
 *
 *  Both values are public by design: the anon key only ever reaches the
 *  database through row-level security (see supabase/schema.sql), which is
 *  what actually enforces "no access until an admin approves you".
 *
 *  When the keys are missing the client is null rather than a half-built
 *  object that throws deep inside a query — the auth screens check
 *  `isSupabaseConfigured` and say so plainly instead.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const isSupabaseConfigured = Boolean(url && anonKey);

export const SUPABASE_SETUP_MESSAGE =
  'ยังไม่ได้ตั้งค่า VITE_SUPABASE_URL และ VITE_SUPABASE_ANON_KEY ในไฟล์ .env (ดู .env.example)';

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // The Google redirect comes back with `?code=…` in the URL; the client
        // exchanges it for a session on load.
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    })
  : null;

/** For call sites that cannot proceed without a client. The thrown message is
 *  user-facing Thai — these all run behind a button press. */
export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error(SUPABASE_SETUP_MESSAGE);
  return supabase;
}

/** The current access token, refreshed if it is about to expire.
 *
 *  Every call to our own server carries this: the endpoints that spend the
 *  Gemini key verify it against the approval table (server/auth.ts). Read it
 *  at the moment of the call rather than holding on to one — tokens are
 *  short-lived and rotate underneath us. */
export async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
