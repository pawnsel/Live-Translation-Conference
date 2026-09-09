/** Sign-in.
 *
 *  Proving who you are and being allowed in are two different things here.
 *  Google will issue a session to anyone; this page then asks the database
 *  whether an admin approved that address, and anything short of 'approved'
 *  is shown as a status dialog and signed straight back out.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Eye, EyeOff, Loader2, LogIn } from 'lucide-react';
import AuthLayout from '../auth/AuthLayout';
import GoogleLogo from '../auth/GoogleLogo';
import AccountStatusDialog, { type BlockedStatus } from '../auth/AccountStatusDialog';
import { useAuth } from '../auth/AuthProvider';
import { fetchStatusByEmail, isValidEmail } from '../auth/accountStatus';
import { isSupabaseConfigured, SUPABASE_SETUP_MESSAGE } from '../lib/supabase';

interface LoginRouteState {
  from?: string;
  /** Handed over by /auth/callback when a Google sign-in was not approved. */
  blocked?: BlockedStatus;
  email?: string;
  error?: string;
}

export default function Login() {
  const { session, status, ready, signInWithGoogle, signInWithPassword, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = (location.state ?? {}) as LoginRouteState;
  const destination = routeState.from ?? '/admin';

  const [email, setEmail] = useState(routeState.email ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(routeState.error ?? null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<BlockedStatus | null>(routeState.blocked ?? null);
  const [blockedEmail, setBlockedEmail] = useState(routeState.email ?? '');

  // A blocked Google sign-in arrives here still holding a session. Drop it —
  // an unapproved session must not linger in localStorage.
  const dismissedRef = useRef(false);
  useEffect(() => {
    if (routeState.blocked && !dismissedRef.current) {
      dismissedRef.current = true;
      void signOut();
    }
  }, [routeState.blocked, signOut]);

  // Already approved and signed in (a bookmarked /login, or a back button):
  // there is nothing to ask, so go through.
  useEffect(() => {
    if (ready && session && status === 'approved' && !blocked) {
      navigate(destination, { replace: true });
    }
  }, [ready, session, status, blocked, destination, navigate]);

  const showBlocked = useCallback((next: BlockedStatus, addr: string) => {
    setBlocked(next);
    setBlockedEmail(addr);
  }, []);

  const handleGoogle = async () => {
    setFormError(null);
    try {
      // Redirects the whole page to Google; execution stops here on success.
      const { error } = await signInWithGoogle('login');
      if (error) setFormError(error.message);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isValidEmail(email)) {
      setFormError('กรุณากรอกอีเมลให้ถูกต้อง');
      return;
    }
    if (!password) {
      setFormError('กรุณากรอกรหัสผ่าน');
      return;
    }

    setFormError(null);
    setBusy(true);
    try {
      const { error } = await signInWithPassword(email, password);
      const accountStatus = await fetchStatusByEmail(email);

      if (accountStatus !== 'approved') {
        // Whatever the credentials were, the account itself is the blocker —
        // say which of the three states it is in. The signOut covers the case
        // where the password was in fact correct.
        await signOut();
        showBlocked(accountStatus as BlockedStatus, email.trim());
        return;
      }

      if (error) {
        // Approved, but these credentials are wrong. Registration is through
        // Google, so an approved account may simply have no password yet.
        setFormError(
          'อีเมลหรือรหัสผ่านไม่ถูกต้อง หากสมัครด้วยบัญชี Google กรุณาเข้าสู่ระบบด้วยปุ่ม Google ด้านบน',
        );
        return;
      }

      navigate(destination, { replace: true });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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

        <button
          type="button"
          onClick={handleGoogle}
          disabled={!isSupabaseConfigured}
          className="mt-7 w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 disabled:hover:bg-white transition-colors font-semibold text-sm text-slate-700"
        >
          <GoogleLogo />
          เข้าสู่ระบบด้วย Google
        </button>

        <div className="flex items-center gap-3 my-6">
          <span className="h-px flex-1 bg-slate-200" />
          <span className="text-xs text-slate-400 font-medium">หรือใช้อีเมล</span>
          <span className="h-px flex-1 bg-slate-200" />
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <label className="block text-xs font-semibold text-slate-600 mb-1.5" htmlFor="login-email">
            อีเมล
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setFormError(null);
            }}
            placeholder="yourname@chula.ac.th"
            className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm outline-hidden focus:border-[#DE5C8E] focus:ring-2 focus:ring-pink-100 transition-all"
          />

          <label className="block text-xs font-semibold text-slate-600 mb-1.5 mt-4" htmlFor="login-password">
            รหัสผ่าน
          </label>
          <div className="relative">
            <input
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setFormError(null);
              }}
              placeholder="••••••••"
              className="w-full px-3.5 py-2.5 pr-11 rounded-xl border border-slate-300 text-sm outline-hidden focus:border-[#DE5C8E] focus:ring-2 focus:ring-pink-100 transition-all"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
              aria-label={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
            ใช้ได้เฉพาะบัญชีที่ตั้งรหัสผ่านไว้ตอนสมัคร หากไม่ได้ตั้งไว้ กรุณาเข้าสู่ระบบด้วย Google
          </p>

          {formError && (
            <div className="mt-4 flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <p className="text-xs leading-relaxed">{formError}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={busy || !isSupabaseConfigured}
            className="mt-6 w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#DE5C8E] text-white font-semibold text-sm hover:bg-[#c94e7d] disabled:opacity-60 transition-colors"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
            {busy ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
          </button>
        </form>

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
