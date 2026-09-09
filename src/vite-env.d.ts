/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL — Project Settings → API. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon (publishable) key. Public by design; RLS guards the data. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Email domain allowed to register. Defaults to chula.ac.th. */
  readonly VITE_ALLOWED_EMAIL_DOMAIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
