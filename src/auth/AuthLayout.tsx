/** The split-screen frame shared by the login and registration pages:
 *  brand panel on the left (hidden on small screens), form card on the right. */

import type { ReactNode } from 'react';
import { Sparkles, Languages, ShieldCheck, Mic } from 'lucide-react';

const HIGHLIGHTS = [
  { icon: Mic, text: 'ถอดเสียงการประชุมแบบเรียลไทม์' },
  { icon: Languages, text: 'แปลไทย–อังกฤษพร้อมคำศัพท์เฉพาะทาง' },
  { icon: ShieldCheck, text: 'สำหรับบุคลากรจุฬาลงกรณ์มหาวิทยาลัยเท่านั้น' },
];

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh flex bg-slate-50 text-slate-900">
      {/* Brand panel */}
      <aside className="hidden lg:flex w-[44%] max-w-2xl flex-col justify-between p-12 bg-linear-to-br from-[#DE5C8E] to-[#8B3A67] text-white">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center backdrop-blur-xs">
            <Sparkles className="w-5 h-5" />
          </div>
          <span className="font-bold tracking-tight">Live Translation</span>
        </div>

        <div>
          <h1 className="text-4xl font-bold leading-tight tracking-tight">
            ระบบแปลภาษา
            <br />
            การประชุมด้วย AI
          </h1>
          <p className="mt-4 text-white/70 leading-relaxed max-w-md">
            ถอดเสียงและแปลบทสนทนาในห้องประชุมแบบทันที พร้อมสรุปรายงานการประชุมอัตโนมัติ
          </p>

          <ul className="mt-9 space-y-3.5">
            {HIGHLIGHTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm text-white/85">
                <span className="w-8 h-8 rounded-lg bg-white/15 flex items-center justify-center shrink-0">
                  <Icon className="w-4 h-4" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-white/50">Faculty of Medicine, Chulalongkorn University</p>
      </aside>

      {/* Form panel */}
      <main className="flex-1 flex flex-col items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="lg:hidden flex items-center gap-2.5 mb-8">
            <div className="w-9 h-9 rounded-xl bg-[#DE5C8E] flex items-center justify-center text-white">
              <Sparkles className="w-5 h-5" />
            </div>
            <span className="font-bold tracking-tight text-slate-900">Live Translation</span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
