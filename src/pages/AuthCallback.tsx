/** Where Google sends the browser back to.
 *
 *  The Supabase client has already turned the `?code=` in the URL into a
 *  session by the time this renders (detectSessionInUrl). All this page does
 *  is wait for the approval status to load and then hand off:
 *
 *    register intent → /register, which continues the form
 *    approved        → the console
 *    anything else   → /login, which shows the status dialog and signs out
 */

import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { readAuthIntent, useAuth } from '../auth/AuthProvider';

export default function AuthCallback() {
  const { session, status, ready, error } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // Google's own failures (consent denied, misconfigured client) come back as
  // query parameters rather than a session.
  const oauthError = params.get('error_description') ?? params.get('error');

  useEffect(() => {
    if (oauthError) {
      navigate('/login', { replace: true, state: { error: oauthError } });
      return;
    }
    if (!ready) return;

    if (!session) {
      navigate('/login', {
        replace: true,
        state: { error: 'เข้าสู่ระบบด้วย Google ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' },
      });
      return;
    }

    if (readAuthIntent() === 'register') {
      // Register decides for itself: wrong domain, new request, or already
      // filed. It has the session and the status too.
      navigate('/register', { replace: true });
      return;
    }

    if (status === 'approved') {
      navigate('/admin', { replace: true });
      return;
    }

    navigate('/login', {
      replace: true,
      state: { blocked: status, email: session.user.email ?? '', error },
    });
  }, [ready, session, status, error, oauthError, navigate]);

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-3 bg-slate-50 text-slate-500">
      <Loader2 className="w-6 h-6 animate-spin text-[#DE5C8E]" />
      <p className="text-sm">กำลังตรวจสอบสิทธิ์การเข้าใช้งาน...</p>
    </div>
  );
}
