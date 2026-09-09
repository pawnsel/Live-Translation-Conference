/** Sign-in — Google only.
 *
 *  Proving who you are and being allowed in are two different things here.
 *  Google will issue a session to anyone; /auth/callback then reads the
 *  approval status and sends anything short of 'approved' back to this page,
 *  where it is shown as a status dialog and the session is dropped.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, ShieldCheck } from 'lucide-react';
import AuthLayout from '../auth/AuthLayout';
import GoogleLogo from '../auth/GoogleLogo';
import AccountStatusDialog, { type BlockedStatus } from '../auth/AccountStatusDialog';
import { useAuth } from '../auth/AuthProvider';
import { isSupabaseConfigured, SUPABASE_SETUP_MESSAGE } from '../lib/supabase';

interface LoginRouteState {
  from?: string;
  /** Handed over by /auth/callback when a sign-in was not approved. */
  blocked?: BlockedStatus;
  email?: string;
  error?: string;
}

export default function Login() {
  const { session, status, ready, signInWithGoogle, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = (location.state ?? {}) as LoginRouteState;
  const destination = routeState.from ?? '/admin';

  const [error, setError] = useState<string | null>(routeState.error ?? null);
  const [blocked, setBlocked] = useState<BlockedStatus | null>(routeState.blocked ?? null);
  const blockedEmail = routeState.email ?? '';

  // A blocked sign-in arrives here still holding a session. Drop it — an
  // unapproved session must not linger in localStorage.
  const dismissedRef = useRef(false);
  useEffect(() => {
    if (routeState.blocked && !dismissedRef.current) {
      dismissedRef.current = true;
      void signOut();
    }
  }, [routeState.blocked, signOut]);

  // Already approved and signed in (a bookmarked /login, or the back button):
  // there is nothing to ask, so go through.
  useEffect(() => {
    if (ready && session && status === 'approved' && !blocked) {
      navigate(destination, { replace: true });
    }
  }, [ready, session, status, blocked, destination, navigate]);

  const handleGoogle = async () => {
    setError(null);
    try {
      // Redirects the whole page to Google; execution stops here on success.
      const { error: oauthError } = await signInWithGoogle('login');
      if (oauthError) setError(oauthError.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <AuthLayout>
      <div className="bg-white border border-slate-200 rounded-2xl shadow-xs p-7 sm:p-9">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">เข้าสู่ระบบ</h1>
        <p className="text-sm text-slate-500 mt-1.5">ยินดีต้อนรับกลับมา กรุณาเข้าสู่ระบบเพื่อใช้งาน</p>

        {!isSupabaseConfigured && (
          <div className="mt-5 flex items-start gap-2 px-3 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-800">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="text-xs leading-relaxed">{SUPABASE_SETUP_MESSAGE}</p>
          </div>
        )}

        {error && (
          <div className="mt-5 flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="text-xs leading-relaxed">{error}</p>
          </div>
        )}

        <button
          type="button"
          onClick={handleGoogle}
          disabled={!isSupabaseConfigured}
          className="mt-7 w-full flex items-center justify-center gap-3 px-4 py-3.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 disabled:hover:bg-white transition-colors font-semibold text-sm text-slate-700"
        >
          <GoogleLogo />
          เข้าสู่ระบบด้วย Google
        </button>

        <div className="mt-6 flex items-start gap-2.5 px-4 py-3.5 rounded-xl bg-slate-50 border border-slate-200">
          <ShieldCheck className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
          <p className="text-xs text-slate-500 leading-relaxed">
            ระบบนี้ใช้บัญชี Google ของมหาวิทยาลัยในการยืนยันตัวตนเท่านั้น
          </p>
        </div>

        <p className="text-sm text-slate-500 text-center mt-6">
          ยังไม่มีบัญชี?{' '}
          <Link to="/register" className="font-semibold text-[#DE5C8E] hover:underline">
            สมัครสมาชิก
          </Link>
        </p>
      </div>

      <p className="text-[11px] text-slate-400 text-center mt-5 leading-relaxed">
        บัญชีต้องได้รับการอนุมัติจากผู้ดูแลระบบก่อนจึงจะเข้าใช้งานได้
      </p>

      <AccountStatusDialog status={blocked} email={blockedEmail} onClose={() => setBlocked(null)} />
    </AuthLayout>
  );
}
