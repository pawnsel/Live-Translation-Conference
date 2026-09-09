/** The sign-in outcome popup.
 *
 *  Three things can be true of someone who just proved who they are, and the
 *  difference matters enough to say out loud:
 *
 *    none     — the address was never registered.
 *    pending  — registered, waiting for an admin.
 *    rejected — an admin said no.
 *
 *  There is deliberately no 'approved' variant: an approved person is sent
 *  straight into the console without a dialog in the way.
 */

import { useNavigate } from 'react-router-dom';
import { Clock, Mail, ShieldX, UserPlus, X } from 'lucide-react';
import type { AccountStatus } from './accountStatus';

export type BlockedStatus = Extract<AccountStatus, 'none' | 'pending' | 'rejected'>;

interface Props {
  status: BlockedStatus | null;
  email: string;
  onClose: () => void;
}

const COPY: Record<
  BlockedStatus,
  { title: string; body: string; tone: string; icon: typeof Clock; badge: string }
> = {
  none: {
    title: 'อีเมลนี้ยังไม่ได้ลงทะเบียน',
    body: 'ยังไม่พบคำขอใช้งานสำหรับอีเมลนี้ในระบบ กรุณาสมัครสมาชิกและส่งคำขอเพื่อให้ผู้ดูแลระบบอนุมัติก่อนเข้าใช้งาน',
    tone: 'bg-slate-50 border-slate-200 text-slate-500',
    icon: UserPlus,
    badge: 'ยังไม่ลงทะเบียน',
  },
  pending: {
    title: 'อยู่ระหว่างการตรวจสอบสิทธิ์',
    body: 'คำขอของคุณถูกส่งเรียบร้อยแล้ว ขณะนี้ผู้ดูแลระบบกำลังตรวจสอบข้อมูล เมื่อได้รับการอนุมัติจึงจะเข้าใช้งานระบบได้',
    tone: 'bg-amber-50 border-amber-200 text-amber-500',
    icon: Clock,
    badge: 'รออนุมัติ',
  },
  rejected: {
    title: 'คำขอไม่ได้รับการอนุมัติ',
    body: 'ผู้ดูแลระบบไม่ได้อนุมัติคำขอใช้งานของอีเมลนี้ หากคิดว่าเป็นความผิดพลาด กรุณาติดต่อผู้ดูแลระบบ',
    tone: 'bg-red-50 border-red-200 text-red-500',
    icon: ShieldX,
    badge: 'ไม่อนุมัติ',
  },
};

export default function AccountStatusDialog({ status, email, onClose }: Props) {
  const navigate = useNavigate();
  if (!status) return null;

  const { title, body, tone, icon: Icon, badge } = COPY[status];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-status-title"
    >
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-slate-200 p-7 text-center relative">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg"
          aria-label="ปิด"
        >
          <X className="w-4 h-4" />
        </button>

        <div className={`w-14 h-14 rounded-2xl border flex items-center justify-center mx-auto ${tone}`}>
          <Icon className="w-7 h-7" />
        </div>

        <h2 id="account-status-title" className="text-lg font-bold text-slate-900 mt-4">
          {title}
        </h2>

        {email && (
          <div className="mt-2.5 inline-flex items-center gap-1.5 max-w-full px-3 py-1.5 rounded-full bg-slate-100 border border-slate-200">
            <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span className="text-xs font-semibold text-slate-600 truncate">{email}</span>
          </div>
        )}

        <p className="text-sm text-slate-500 leading-relaxed mt-3.5">{body}</p>

        <div className="mt-5 flex items-center justify-center">
          <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-slate-100 text-slate-500 border border-slate-200">
            สถานะ: {badge}
          </span>
        </div>

        <div className="mt-6 flex items-center gap-3">
          {status === 'none' ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-600 hover:bg-slate-50 text-sm font-semibold"
              >
                ปิด
              </button>
              <button
                type="button"
                onClick={() => navigate('/register')}
                className="flex-1 px-4 py-2.5 rounded-xl bg-[#DE5C8E] text-white text-sm font-semibold hover:bg-[#c94e7d] transition-colors"
              >
                ไปหน้าสมัครสมาชิก
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-xl bg-[#DE5C8E] text-white text-sm font-semibold hover:bg-[#c94e7d] transition-colors"
            >
              รับทราบ
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
