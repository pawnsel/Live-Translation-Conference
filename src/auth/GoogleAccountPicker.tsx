/** A fake "Sign in with Google" account chooser.
 *
 *  Stands in for the real OAuth popup so both the login and the registration
 *  flow can be clicked through end to end. Picking an account resolves
 *  instantly — nothing is verified, nothing leaves the browser.
 */

import { useEffect, useState } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { MOCK_GOOGLE_ACCOUNTS, isValidEmail, nameFromEmail, type GoogleAccount } from './mockAuth';
import { avatarDataUri } from './avatar';

export function GoogleLogo({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (acct: GoogleAccount) => void;
  /** Rejection text from the caller — e.g. "this address is not @chula.ac.th".
   *  Shown inside the sheet so the reason sits next to the account list. */
  error?: string | null;
  /** Copy under the title, e.g. "เพื่อดำเนินการต่อไปยัง …". */
  purpose?: string;
}

export default function GoogleAccountPicker({ open, onClose, onSelect, error, purpose }: Props) {
  const [manual, setManual] = useState(false);
  const [email, setEmail] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setManual(false);
      setEmail('');
      setLocalError(null);
    }
  }, [open]);

  if (!open) return null;

  const submitManual = () => {
    const trimmed = email.trim();
    if (!isValidEmail(trimmed)) {
      setLocalError('รูปแบบอีเมลไม่ถูกต้อง');
      return;
    }
    setLocalError(null);
    onSelect({ email: trimmed, name: nameFromEmail(trimmed), picture: avatarDataUri(trimmed) });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
        <div className="flex items-start justify-between px-6 pt-6 pb-4">
          <div>
            <GoogleLogo className="w-7 h-7" />
            <h2 className="mt-3 text-lg font-bold text-slate-900">เลือกบัญชี</h2>
            <p className="text-xs text-slate-500 mt-0.5">{purpose ?? 'เพื่อดำเนินการต่อไปยัง AI Live Translator'}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 -mr-1.5 -mt-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg"
            aria-label="ปิด"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {(error || localError) && (
          <div className="mx-6 mb-3 flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="text-xs leading-relaxed">{error ?? localError}</p>
          </div>
        )}

        {!manual ? (
          <ul className="border-t border-slate-100">
            {MOCK_GOOGLE_ACCOUNTS.map((acct) => (
              <li key={acct.email}>
                <button
                  type="button"
                  onClick={() => onSelect(acct)}
                  className="w-full flex items-center gap-3 px-6 py-3.5 text-left hover:bg-slate-50 transition-colors"
                >
                  <img src={acct.picture} alt="" className="w-9 h-9 rounded-full shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-800 truncate">{acct.name}</div>
                    <div className="text-xs text-slate-500 truncate">{acct.email}</div>
                  </div>
                </button>
              </li>
            ))}
            <li className="border-t border-slate-100">
              <button
                type="button"
                onClick={() => setManual(true)}
                className="w-full flex items-center gap-3 px-6 py-3.5 text-left hover:bg-slate-50 transition-colors"
              >
                <span className="w-9 h-9 rounded-full border border-dashed border-slate-300 flex items-center justify-center text-slate-400 text-lg leading-none">
                  +
                </span>
                <span className="text-sm font-semibold text-slate-700">ใช้บัญชีอื่น</span>
              </button>
            </li>
          </ul>
        ) : (
          <div className="px-6 pb-2 border-t border-slate-100 pt-4">
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">อีเมล</label>
            <input
              autoFocus
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setLocalError(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && submitManual()}
              placeholder="yourname@chula.ac.th"
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm outline-hidden focus:border-[#DE5C8E] focus:ring-2 focus:ring-pink-100"
            />
            <div className="flex items-center justify-between gap-2 mt-4">
              <button
                type="button"
                onClick={() => setManual(false)}
                className="text-xs font-semibold text-slate-500 hover:text-slate-800 px-2 py-2"
              >
                ย้อนกลับ
              </button>
              <button
                type="button"
                onClick={submitManual}
                className="px-5 py-2 rounded-xl bg-[#DE5C8E] text-white text-sm font-semibold hover:bg-[#c94e7d] transition-colors"
              >
                ถัดไป
              </button>
            </div>
          </div>
        )}

        <p className="px-6 py-4 text-[11px] leading-relaxed text-slate-400 border-t border-slate-100 mt-2">
          หน้าจอนี้เป็นการจำลอง (mock) การเข้าสู่ระบบด้วย Google ยังไม่มีการเชื่อมต่อกับ Google จริง
        </p>
      </div>
    </div>
  );
}
