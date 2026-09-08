/** Sign-in page — MOCK UI ONLY.
 *
 *  Nothing is authenticated: any well-formed email with a password gets in,
 *  and the Google button opens the fake account chooser. Wiring this to a real
 *  identity provider is P2 work; the shapes here are what it will fill in.
 */

import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Eye, EyeOff, Loader2, LogIn } from 'lucide-react';
import AuthLayout from '../auth/AuthLayout';
import GoogleAccountPicker, { GoogleLogo } from '../auth/GoogleAccountPicker';
import { isValidEmail, useAuth, type GoogleAccount } from '../auth/mockAuth';

export default function Login() {
  const { signInWithEmail, signInWithGoogle } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const destination = location.state?.from ?? '/admin';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!isValidEmail(email)) {
      setError('กรุณากรอกอีเมลให้ถูกต้อง');
      return;
    }
    if (password.length < 6) {
      setError('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
      return;
    }
    setError(null);
    setBusy(true);
    // Fake network latency so the button's loading state is visible.
    window.setTimeout(() => {
      signInWithEmail(email);
      navigate(destination, { replace: true });
    }, 600);
  };

  const handleGoogle = (acct: GoogleAccount) => {
    setPickerOpen(false);
    signInWithGoogle(acct);
    navigate(destination, { replace: true });
  };

  return (
    <AuthLayout>
      <div className="bg-white border border-slate-200 rounded-2xl shadow-xs p-7 sm:p-9">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">เข้าสู่ระบบ</h1>
        <p className="text-sm text-slate-500 mt-1.5">ยินดีต้อนรับกลับมา กรุณาเข้าสู่ระบบเพื่อใช้งาน</p>

        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="mt-7 w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 transition-colors font-semibold text-sm text-slate-700"
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
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
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
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
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

          <div className="flex items-center justify-between mt-3.5">
            <label className="flex items-center gap-2 text-xs text-slate-600 select-none">
              <input type="checkbox" className="w-3.5 h-3.5 accent-[#DE5C8E]" />
              จดจำการเข้าสู่ระบบ
            </label>
            <button type="button" className="text-xs font-semibold text-[#DE5C8E] hover:underline">
              ลืมรหัสผ่าน?
            </button>
          </div>

          {error && (
            <div className="mt-4 flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <p className="text-xs leading-relaxed">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
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
        หน้านี้เป็น mock UI ยังไม่มีการตรวจสอบสิทธิ์จริงหรือเชื่อมต่อฐานข้อมูล
      </p>

      <GoogleAccountPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handleGoogle}
        purpose="เพื่อเข้าสู่ระบบ AI Live Translator"
      />
    </AuthLayout>
  );
}
