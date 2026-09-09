/** Account approval status, and the rules for who may register at all.
 *
 *  Kept free of React so both the provider and the tests can use it.
 */

/** `none` means "no request row exists" — the person has never registered,
 *  even if Google happily signed them in. */
export type AccountStatus = 'none' | 'pending' | 'approved' | 'rejected';

export interface AccessRequest {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
  status: Exclude<AccountStatus, 'none'>;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
}

export const ACCESS_REQUESTS_TABLE = 'access_requests';

/** Which addresses may register. Defaults to the university domain; override
 *  with VITE_ALLOWED_EMAIL_DOMAIN when testing with another domain — and
 *  update the matching CHECK constraint in supabase/schema.sql if you do. */
export const ALLOWED_EMAIL_DOMAIN =
  import.meta.env.VITE_ALLOWED_EMAIL_DOMAIN?.trim().toLowerCase().replace(/^@/, '') || 'chula.ac.th';

/** True for the allowed domain and any of its subdomains — chula.ac.th,
 *  student.chula.ac.th, eng.chula.ac.th — and nothing else. */
export function isAllowedEmail(email: string, domain: string = ALLOWED_EMAIL_DOMAIN): boolean {
  const at = email.trim().toLowerCase().split('@');
  if (at.length !== 2) return false;
  const host = at[1];
  return host === domain || host.endsWith(`.${domain}`);
}

/** Kept under the old name so the copy in the UI ("@chula.ac.th เท่านั้น")
 *  and the check stay obviously the same rule. */
export const isChulaEmail = isAllowedEmail;

/** Best-effort display name for an address with no Google profile behind it. */
export function nameFromEmail(email: string): string {
  const local = email.trim().split('@')[0] ?? '';
  return local.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || email;
}
