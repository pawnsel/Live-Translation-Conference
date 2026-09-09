/** Registration — file a request, then wait for an admin.
 *
 *  Three steps, and which one shows is derived from the live session rather
 *  than kept in local state, so a reload or a return from Google lands back
 *  where it should:
 *
 *    1. google  — sign in with Google. Only an allowed university address may
 *                 pass; anything else is signed straight back out and never
 *                 reaches the form.
 *    2. form    — ชื่อจริง / นามสกุล / เบอร์โทร (+ an optional password), which
 *                 becomes one 'pending' row in public.access_requests.
 *    3. pending — the request exists and is waiting for manual approval.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Check, Clock, Loader2, LogOut, Send, ShieldCheck } from 'lucide-react';
import AuthLayout from '../auth/AuthLayout';
import GoogleLogo from '../auth/GoogleLogo';
import { useAuth } from '../auth/AuthProvider';
import { ALLOWED_EMAIL_DOMAIN, isAllowedEmail } from '../auth/accountStatus';
import { isSupabaseConfigured, SUPABASE_SETUP_MESSAGE } from '../lib/supabase';

type Step = 'google' | 'form' | 'pending';

const STEPS: { key: Step; label: string }[] = [
  { key: 'google', label: 'ยืนยันบัญชี' },
  { key: 'form', label: 'กรอกข้อมูล' },
  { key: 'pending', label: 'รออนุมัติ' },
];

/** Digits only, at most 10 — displayed as 0XX-XXX-XXXX while typing. */
function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function Stepper({ current }: { current: Step }) {
  const index = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="flex items-center gap-2 mb-6">
      {STEPS.map((step, i) => {
        const done = i < index;
        const active = i === index;
        return (
          <li key={step.key} className="flex items-center gap-2 flex-1 last:flex-none">
            <span
              className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 transition-colors ${
                done
                  ? 'bg-[#DE5C8E] text-white'
                  : active
                    ? 'bg-pink-100 text-[#DE5C8E] ring-2 ring-[#DE5C8E]'
                    : 'bg-slate-100 text-slate-400'
              }`}
            >
              {done ? <Check className="w-3.5 h-3.5" /> : i + 1}
            </span>
            <span className={`text-[11px] font-semibold whitespace-nowrap ${active ? 'text-slate-800' : 'text-slate-400'}`}>
              {step.label}
            </span>
            {i < STEPS.length - 1 && <span className="h-px flex-1 bg-slate-200 ml-1" />}
          </li>
        );
      })}
    </ol>
  );
}

export default function Register() {
  const navigate = useNavigate();
  const { session, user, profile, status, ready, signInWithGoogle, submitAccessRequest, signOut } = useAuth();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** The address Google offered that this system will not accept. Held after
   *  the session is dropped so the reason survives on screen. */
  const [rejectedEmail, setRejectedEmail] = useState<string | null>(null);

  const email = session?.user?.email ?? '';
  const allowed = Boolean(email) && isAllowedEmail(email);

  // Wrong domain: no session is kept, so the details form is unreachable.
  useEffect(() => {
    if (!ready || !session || !email || allowed) return;
    setRejectedEmail(email);
    void signOut();
  }, [ready, session, email, allowed, signOut]);

  // Nothing to register: an approved account belongs in the console, and a
  // rejected one belongs in the status dialog on the login page.
  useEffect(() => {
    if (!ready || !session || !allowed) return;
    if (status === 'approved') navigate('/admin', { replace: true });
    else if (status === 'rejected') navigate('/login', { replace: true, state: { blocked: 'rejected', email } });
  }, [ready, session, allowed, status, email, navigate]);

  const step: Step = session && allowed ? (status === 'pending' ? 'pending' : 'form') : 'google';

  const handleGoogle = async () => {
    setFormError(null);
    setRejectedEmail(null);
    try {
      const { error } = await signInWithGoogle('register');
      if (error) setFormError(error.message);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const phoneDigits = phone.replace(/\D/g, '');
    if (!firstName.trim() || !lastName.trim()) {
      setFormError('กรุณากรอกชื่อจริงและนามสกุล');
      return;
    }
    if (phoneDigits.length !== 10) {
      setFormError('เบอร์โทรศัพท์ต้องมี 10 หลัก');
      return;
    }
    if (password && password.length < 8) {
      setFormError('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
      return;
    }
    if (password !== confirmPassword) {
      setFormError('รหัสผ่านทั้งสองช่องไม่ตรงกัน');
      return;
    }

    setFormError(null);
    setSubmitting(true);
    try {
      await submitAccessRequest({
        firstName,
        lastName,
        phone,
        password: password || undefined,
      });
      // status becomes 'pending', which moves the page to step 3 on its own.
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleLeave = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  if (!ready && isSupabaseConfigured) {
    return (
      <AuthLayout>
        <div className="bg-white border border-slate-200 rounded-2xl shadow-xs p-9 flex flex-col items-center gap-3 text-slate-500">
          <Loader2 className="w-6 h-6 animate-spin text-[#DE5C8E]" />
          <p className="text-sm">กำลังโหลด...</p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="bg-white border border-slate-200 rounded-2xl shadow-xs p-7 sm:p-9">
        <Stepper current={step} />

        {step === 'google' && (
          <>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">สมัครสมาชิก</h1>
            <p className="text-sm text-slate-500 mt-1.5 leading-relaxed">
              สมัครใช้งานด้วยบัญชี Google ของมหาวิทยาลัยเท่านั้น
            </p>

            {!isSupabaseConfigured && (
              <div className="mt-5 flex items-start gap-2 px-3 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-800">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <p className="text-xs leading-relaxed">{SUPABASE_SETUP_MESSAGE}</p>
              </div>
            )}

            <div className="mt-6 flex items-start gap-2.5 px-4 py-3.5 rounded-xl bg-pink-50 border border-pink-100">
              <ShieldCheck className="w-4 h-4 text-[#DE5C8E] shrink-0 mt-0.5" />
              <p className="text-xs text-slate-600 leading-relaxed">
                รับเฉพาะอีเมลที่ลงท้ายด้วย{' '}
                <span className="font-semibold text-slate-800">@{ALLOWED_EMAIL_DOMAIN}</span> (รวมโดเมนย่อย เช่น
                student.{ALLOWED_EMAIL_DOMAIN}) อีเมลอื่นจะไม่สามารถสมัครได้
              </p>
            </div>

            {rejectedEmail && (
              <div className="mt-4 flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <p className="text-xs leading-relaxed">
                  <span className="font-semibold">{rejectedEmail}</span> ไม่ใช่อีเมลของมหาวิทยาลัย
                  จึงไม่สามารถสมัครใช้งานได้ กรุณาเลือกบัญชี @{ALLOWED_EMAIL_DOMAIN}
                </p>
              </div>
            )}

            {formError && (
              <div className="mt-4 flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <p className="text-xs leading-relaxed">{formError}</p>
              </div>
            )}

            <button
              type="button"
              onClick={handleGoogle}
              disabled={!isSupabaseConfigured}
              className="mt-6 w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 disabled:hover:bg-white transition-colors font-semibold text-sm text-slate-700"
            >
              <GoogleLogo />
              ดำเนินการต่อด้วย Google
            </button>

            <p className="text-sm text-slate-500 text-center mt-6">
              มีบัญชีอยู่แล้ว?{' '}
              <Link to="/login" className="font-semibold text-[#DE5C8E] hover:underline">
                เข้าสู่ระบบ
              </Link>
            </p>
          </>
        )}

        {step === 'form' && (
          <>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">กรอกข้อมูลผู้ใช้</h1>
            <p className="text-sm text-slate-500 mt-1.5">กรอกข้อมูลให้ครบถ้วนเพื่อส่งคำขอเปิดใช้งาน</p>

            <div className="mt-5 flex items-center gap-3 px-4 py-3 rounded-xl bg-slate-50 border border-slate-200">
              <img src={user?.picture} alt="" className="w-9 h-9 rounded-full shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-slate-800 truncate">{user?.name}</div>
                <div className="text-xs text-slate-500 truncate">{email}</div>
              </div>
              <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-600 shrink-0">
                <Check className="w-3.5 h-3.5" />
                ยืนยันแล้ว
              </span>
            </div>

            <form onSubmit={handleSubmit} noValidate className="mt-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5" htmlFor="reg-first">
                    ชื่อจริง <span className="text-[#DE5C8E]">*</span>
                  </label>
                  <input
                    id="reg-first"
                    value={firstName}
                    onChange={(e) => {
                      setFirstName(e.target.value);
                      setFormError(null);
                    }}
                    placeholder="สมชาย"
                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm outline-hidden focus:border-[#DE5C8E] focus:ring-2 focus:ring-pink-100 transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5" htmlFor="reg-last">
                    นามสกุล <span className="text-[#DE5C8E]">*</span>
                  </label>
                  <input
                    id="reg-last"
                    value={lastName}
                    onChange={(e) => {
                      setLastName(e.target.value);
                      setFormError(null);
                    }}
                    placeholder="ใจดี"
                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm outline-hidden focus:border-[#DE5C8E] focus:ring-2 focus:ring-pink-100 transition-all"
                  />
                </div>
              </div>

              <label className="block text-xs font-semibold text-slate-600 mb-1.5 mt-4" htmlFor="reg-phone">
                เบอร์โทรศัพท์ <span className="text-[#DE5C8E]">*</span>
              </label>
              <input
                id="reg-phone"
                inputMode="numeric"
                value={phone}
                onChange={(e) => {
                  setPhone(formatPhone(e.target.value));
                  setFormError(null);
                }}
                placeholder="081-234-5678"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm outline-hidden focus:border-[#DE5C8E] focus:ring-2 focus:ring-pink-100 transition-all"
              />

              {/* Optional, because registration itself runs on Google. Set one
                  and the email + password form on the login page also works. */}
              <div className="mt-5 pt-5 border-t border-slate-100">
                <p className="text-xs font-semibold text-slate-600">
                  ตั้งรหัสผ่าน <span className="font-normal text-slate-400">(ไม่บังคับ)</span>
                </p>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                  ตั้งไว้เพื่อเข้าสู่ระบบด้วยอีเมลและรหัสผ่านได้ โดยไม่ต้องใช้ Google ทุกครั้ง
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setFormError(null);
                    }}
                    placeholder="รหัสผ่าน (อย่างน้อย 8 ตัว)"
                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm outline-hidden focus:border-[#DE5C8E] focus:ring-2 focus:ring-pink-100 transition-all"
                  />
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      setFormError(null);
                    }}
                    placeholder="ยืนยันรหัสผ่าน"
                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm outline-hidden focus:border-[#DE5C8E] focus:ring-2 focus:ring-pink-100 transition-all"
                  />
                </div>
              </div>

              {formError && (
                <div className="mt-4 flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <p className="text-xs leading-relaxed">{formError}</p>
                </div>
              )}

              <p className="text-[11px] text-slate-400 leading-relaxed mt-4">
                หลังส่งคำขอ ผู้ดูแลระบบจะตรวจสอบและอนุมัติบัญชีของคุณก่อนจึงจะเข้าใช้งานได้
              </p>

              <div className="flex items-center gap-3 mt-6">
                <button
                  type="button"
                  onClick={handleLeave}
                  className="px-4 py-3 rounded-xl border border-slate-300 text-slate-600 hover:bg-slate-50 text-sm font-semibold flex items-center gap-1.5"
                >
                  <ArrowLeft className="w-4 h-4" />
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#DE5C8E] text-white font-semibold text-sm hover:bg-[#c94e7d] disabled:opacity-60 transition-colors"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  {submitting ? 'กำลังส่งคำขอ...' : 'ส่งคำขอเปิดใช้งาน'}
                </button>
              </div>
            </form>
          </>
        )}

        {step === 'pending' && (
          <div className="text-center">
            <div className="w-14 h-14 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center mx-auto">
              <Clock className="w-7 h-7 text-amber-500" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 mt-5">ส่งคำขอเรียบร้อยแล้ว</h1>
            <p className="text-sm text-slate-500 mt-2 leading-relaxed">
              บัญชีของคุณอยู่ระหว่างรอผู้ดูแลระบบอนุมัติ
              <br />
              เมื่อได้รับอนุมัติแล้วจึงจะเข้าสู่ระบบเพื่อใช้งานได้
            </p>

            <dl className="mt-6 text-left rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
              {[
                ['อีเมล', profile?.email ?? email],
                ['ชื่อจริง', profile?.first_name ?? firstName],
                ['นามสกุล', profile?.last_name ?? lastName],
                ['เบอร์โทรศัพท์', profile?.phone ?? phone],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-4 px-4 py-2.5">
                  <dt className="text-xs text-slate-500 shrink-0">{label}</dt>
                  <dd className="text-xs font-semibold text-slate-800 truncate">{value}</dd>
                </div>
              ))}
              <div className="flex items-center justify-between gap-4 px-4 py-2.5 bg-slate-50">
                <dt className="text-xs text-slate-500">สถานะ</dt>
                <dd className="text-[11px] font-bold text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-0.5">
                  รออนุมัติ
                </dd>
              </div>
            </dl>

            <button
              type="button"
              onClick={handleLeave}
              className="mt-6 w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#DE5C8E] text-white font-semibold text-sm hover:bg-[#c94e7d] transition-colors"
            >
              <LogOut className="w-4 h-4" />
              ออกจากระบบและกลับหน้าเข้าสู่ระบบ
            </button>
          </div>
        )}
      </div>

      <p className="text-[11px] text-slate-400 text-center mt-5 leading-relaxed">
        ข้อมูลของคุณจะถูกบันทึกไว้เพื่อให้ผู้ดูแลระบบตรวจสอบสิทธิ์การเข้าใช้งานเท่านั้น
      </p>
    </AuthLayout>
  );
}
