/** Registration — MOCK UI ONLY.
 *
 *  Three steps:
 *    1. google  — sign in with Google. Only a @chula.ac.th address may pass;
 *                 anything else is rejected here and never reaches step 2.
 *    2. form    — ชื่อจริง / นามสกุล / เบอร์โทร, on top of the verified account.
 *    3. pending — the request is "sent" and waits for an admin to approve it.
 *
 *  Nothing is stored anywhere. Step 3 is where a POST to the accounts service
 *  will go once P2 exists; today it is a setTimeout.
 */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Check, Clock, Loader2, Send, ShieldCheck } from 'lucide-react';
import AuthLayout from '../auth/AuthLayout';
import GoogleAccountPicker, { GoogleLogo } from '../auth/GoogleAccountPicker';
import { isChulaEmail, type GoogleAccount } from '../auth/mockAuth';

type Step = 'google' | 'form' | 'pending';

const STEPS: { key: Step; label: string }[] = [
  { key: 'google', label: 'ยืนยันบัญชี' },
  { key: 'form', label: 'กรอกข้อมูล' },
  { key: 'pending', label: 'รออนุมัติ' },
];

interface Details {
  firstName: string;
  lastName: string;
  phone: string;
}

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
            <span
              className={`text-[11px] font-semibold whitespace-nowrap ${
                active ? 'text-slate-800' : 'text-slate-400'
              }`}
            >
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

  const [step, setStep] = useState<Step>('google');
  const [account, setAccount] = useState<GoogleAccount | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);

  const [details, setDetails] = useState<Details>({ firstName: '', lastName: '', phone: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ── Step 1: the @chula gate ────────────────────────────────────────────
  const handleGoogleSelect = (acct: GoogleAccount) => {
    if (!isChulaEmail(acct.email)) {
      // Rejected addresses stay in the chooser: no account is remembered and
      // the details form is never reached.
      setPickerError(`อีเมล ${acct.email} ไม่ใช่อีเมลของจุฬาลงกรณ์มหาวิทยาลัย กรุณาใช้อีเมล @chula.ac.th เท่านั้น`);
      setRejected(acct.email);
      return;
    }
    setPickerError(null);
    setRejected(null);
    setAccount(acct);
    setPickerOpen(false);
    setStep('form');
  };

  const openPicker = () => {
    setPickerError(null);
    setPickerOpen(true);
  };

  // ── Step 2: details ────────────────────────────────────────────────────
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const phoneDigits = details.phone.replace(/\D/g, '');
    if (!details.firstName.trim() || !details.lastName.trim()) {
      setFormError('กรุณากรอกชื่อจริงและนามสกุล');
      return;
    }
    if (phoneDigits.length !== 10) {
      setFormError('เบอร์โทรศัพท์ต้องมี 10 หลัก');
      return;
    }
    setFormError(null);
    setSubmitting(true);
    // Mock only — no request is sent and nothing is written to a database.
    window.setTimeout(() => {
      setSubmitting(false);
      setStep('pending');
    }, 800);
  };

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

            <div className="mt-6 flex items-start gap-2.5 px-4 py-3.5 rounded-xl bg-pink-50 border border-pink-100">
              <ShieldCheck className="w-4 h-4 text-[#DE5C8E] shrink-0 mt-0.5" />
              <p className="text-xs text-slate-600 leading-relaxed">
                รับเฉพาะอีเมลที่ลงท้ายด้วย <span className="font-semibold text-slate-800">@chula.ac.th</span>{' '}
                (รวมโดเมนย่อย เช่น student.chula.ac.th) อีเมลอื่นจะไม่สามารถสมัครได้
              </p>
            </div>

            {rejected && (
              <div className="mt-4 flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <p className="text-xs leading-relaxed">
                  <span className="font-semibold">{rejected}</span> ไม่ผ่านเงื่อนไข กรุณาเลือกบัญชีอีเมล @chula.ac.th
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={openPicker}
              className="mt-6 w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 transition-colors font-semibold text-sm text-slate-700"
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

        {step === 'form' && account && (
          <>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">กรอกข้อมูลผู้ใช้</h1>
            <p className="text-sm text-slate-500 mt-1.5">กรอกข้อมูลให้ครบถ้วนเพื่อส่งคำขอเปิดใช้งาน</p>

            <div className="mt-5 flex items-center gap-3 px-4 py-3 rounded-xl bg-slate-50 border border-slate-200">
              <img src={account.picture} alt="" className="w-9 h-9 rounded-full shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-slate-800 truncate">{account.name}</div>
                <div className="text-xs text-slate-500 truncate">{account.email}</div>
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
                    value={details.firstName}
                    onChange={(e) => {
                      setDetails((d) => ({ ...d, firstName: e.target.value }));
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
                    value={details.lastName}
                    onChange={(e) => {
                      setDetails((d) => ({ ...d, lastName: e.target.value }));
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
                value={details.phone}
                onChange={(e) => {
                  setDetails((d) => ({ ...d, phone: formatPhone(e.target.value) }));
                  setFormError(null);
                }}
                placeholder="081-234-5678"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm outline-hidden focus:border-[#DE5C8E] focus:ring-2 focus:ring-pink-100 transition-all"
              />

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
                  onClick={() => {
                    setAccount(null);
                    setStep('google');
                  }}
                  className="px-4 py-3 rounded-xl border border-slate-300 text-slate-600 hover:bg-slate-50 text-sm font-semibold flex items-center gap-1.5"
                >
                  <ArrowLeft className="w-4 h-4" />
                  ย้อนกลับ
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

        {step === 'pending' && account && (
          <div className="text-center">
            <div className="w-14 h-14 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center mx-auto">
              <Clock className="w-7 h-7 text-amber-500" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 mt-5">ส่งคำขอเรียบร้อยแล้ว</h1>
            <p className="text-sm text-slate-500 mt-2 leading-relaxed">
              บัญชีของคุณอยู่ระหว่างรอผู้ดูแลระบบอนุมัติ
              <br />
              ระบบจะแจ้งผลไปยังอีเมลของคุณเมื่อได้รับการอนุมัติ
            </p>

            <dl className="mt-6 text-left rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
              {[
                ['อีเมล', account.email],
                ['ชื่อจริง', details.firstName],
                ['นามสกุล', details.lastName],
                ['เบอร์โทรศัพท์', details.phone],
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
              onClick={() => navigate('/login')}
              className="mt-6 w-full px-4 py-3 rounded-xl bg-[#DE5C8E] text-white font-semibold text-sm hover:bg-[#c94e7d] transition-colors"
            >
              กลับไปหน้าเข้าสู่ระบบ
            </button>
          </div>
        )}
      </div>

      <p className="text-[11px] text-slate-400 text-center mt-5 leading-relaxed">
        หน้านี้เป็น mock UI ข้อมูลที่กรอกยังไม่ถูกบันทึกลงฐานข้อมูลจริง
      </p>

      <GoogleAccountPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handleGoogleSelect}
        error={pickerError}
        purpose="เพื่อสมัครใช้งาน AI Live Translator"
      />
    </AuthLayout>
  );
}
