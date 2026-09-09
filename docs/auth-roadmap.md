# แผนงานระบบ Auth ที่ยังเหลือ

บันทึกไว้เมื่อ 2026-09-09 — สิ่งที่ *ยังไม่ได้ทำ* ในระบบยืนยันตัวตนและการอนุมัติบัญชี
เรียงตามลำดับความสำคัญ แต่ละข้อมีเหตุผล แนวทาง และไฟล์ที่เกี่ยวข้อง เพื่อให้หยิบ
ขึ้นมาทำต่อได้โดยไม่ต้องรื้อบริบทใหม่

ภาพรวมการติดตั้งและ flow ปัจจุบันอยู่ใน [`supabase-auth-setup.md`](./supabase-auth-setup.md)

---

## สถานะปัจจุบัน (ทำไปแล้ว)

| สิ่งที่มีแล้ว | อยู่ที่ไหน |
|---|---|
| สมัคร/เข้าสู่ระบบด้วย Google อย่างเดียว (ไม่มีรหัสผ่านในระบบ) | `src/pages/Login.tsx`, `Register.tsx` |
| บังคับโดเมน `@chula.ac.th` ทั้งฝั่ง client และ CHECK constraint ใน DB | `src/auth/accountStatus.ts`, `supabase/schema.sql` |
| คิวอนุมัติ `access_requests` + RLS (ผู้ใช้อนุมัติตัวเองไม่ได้) | `supabase/schema.sql` |
| popup 3 สถานะตอน login (ไม่ได้ลงทะเบียน / รออนุมัติ / ไม่อนุมัติ) | `src/auth/AccountStatusDialog.tsx` |
| ตรวจ token ฝั่ง server ก่อนใช้ Gemini key ทั้ง REST และ WebSocket | `server/auth.ts` |

---

## 1. ถอนสิทธิ์แล้วยังไม่มีผลกับหน้าจอที่เปิดค้างไว้

**ความสำคัญ: สูง** · **แรง: ปานกลาง**

`status` ถูกอ่านครั้งเดียวตอน mount (`AuthProvider` → `loadStatus`) คอนโซลนี้เปิดค้าง
ได้ทั้งวัน ถ้าแอดมินถอนสิทธิ์ตอนบ่าย คนนั้นยังเห็นหน้าจอและใช้งานต่อได้จนกว่าจะ
refresh

**บรรเทาไปแล้วบางส่วน:** `server/auth.ts` cache ผลไว้ 60 วินาที ดังนั้น *งานใหม่*
(สรุปการประชุม, เปิด live session ใหม่) จะถูกปฏิเสธภายใน 1 นาที — แต่สิ่งที่ยังเหลือคือ

- หน้าจอไม่เด้งออก ผู้ใช้ไม่รู้ว่าถูกถอนสิทธิ์แล้ว จนกว่าจะกดอะไรสักอย่างแล้วพัง
- **WebSocket ที่กำลังสตรีมอยู่ไม่ถูกตัด** — ตรวจสิทธิ์แค่ตอน handshake เท่านั้น
  session ที่เปิดค้างจึงยังกินเงินต่อได้เรื่อย ๆ

**แนวทาง**

1. ฝั่ง client — subscribe แถวของตัวเองด้วย Supabase Realtime แล้ว `signOut()`
   ทันทีที่ `status` เปลี่ยนจาก `approved` (ทางเลือกที่ถูกกว่า: re-check ตอน
   `window` focus + ทุก 5 นาที) → `src/auth/AuthProvider.tsx`
2. ฝั่ง server — ให้ bridge ตรวจซ้ำเป็นระยะระหว่าง session (เช่นทุก 5 นาที) แล้ว
   `close(4403)` ถ้าไม่ผ่าน → `server/geminiLiveProxy.ts` + `geminiLiveBridge.ts`

**ปุ่มปรับที่มีอยู่แล้ว:** `withVerifierCache(verify, { successTtlMs })` ใน
`server.ts` — ลดค่านี้ = ถอนสิทธิ์มีผลเร็วขึ้น แลกกับ request ไป Supabase ถี่ขึ้น

---

## 2. แอดมินไม่รู้ว่ามีคำขอเข้ามา

**ความสำคัญ: สูง** · **แรง: ต่ำ** ← คุ้มที่สุดในลิสต์นี้

ตอนนี้ต้องเปิด SQL Editor เช็คเอง ในทางปฏิบัติแปลว่าคนสมัครจะรอนานโดยไม่มีใครรู้

**แนวทาง:** Supabase → Database → Webhooks → trigger บน `INSERT` ของ
`public.access_requests` ยิงไปที่ email / LINE Notify / Slack

ถ้าไม่อยากได้ทีละใบ ใช้ `pg_cron` สรุปคิวที่ค้างส่งวันละครั้งแทนก็ได้

---

## 3. ผู้ใช้ไม่รู้ว่าได้รับอนุมัติแล้ว

**ความสำคัญ: ปานกลาง** · **แรง: ปานกลาง**

ตอนนี้ต้องคอยกลับมาลอง login เองเรื่อย ๆ

**แนวทาง:** trigger บน `UPDATE` เมื่อ `status` เปลี่ยนเป็น `approved` → Edge Function
ส่งอีเมลแจ้ง (ต้องต่อ email provider เช่น Resend หรือ SendGrid — Supabase ไม่ได้ส่ง
เมลทั่วไปให้)

ทำคู่กับข้อ 2 ได้ในงานเดียว เพราะใช้กลไกเดียวกัน

---

## 4. หน้าอนุมัติในแอป (แทนการรัน SQL)

**ความสำคัญ: ปานกลาง** · **แรง: สูง**

ตอนนี้ "แอดมิน" = คนที่เข้า Supabase dashboard ได้ ยังไม่มี concept ของ role ในระบบเลย
ถ้าจะทำหน้าอนุมัติในแอป ต้องเพิ่มของพวกนี้ก่อน

**แนวทาง**

1. เพิ่มคอลัมน์ `is_admin boolean not null default false` (หรือแยกตาราง `admins`)
2. RLS policy ใหม่: admin อ่านได้ทุกแถว และ `update` เฉพาะคอลัมน์ `status`,
   `reviewed_*` ได้
3. หน้า `/admin/approvals` — คิว, ปุ่มอนุมัติ/ปฏิเสธ, ช่องใส่เหตุผล
4. ฝั่ง server ถ้ามี endpoint ใหม่ ต้องตรวจ `is_admin` ด้วย ไม่ใช่แค่ `approved`

> **ข้อควรระวัง 2 อย่าง**
> - policy ต้องกันไม่ให้ admin แก้ `is_admin` ของตัวเองหรือของคนอื่นผ่าน anon key
>   ไม่งั้นได้ privilege escalation มาฟรี ๆ
> - policy ที่อ่านตารางเดียวกับที่มัน guard อยู่ทำให้เกิด **recursive RLS** —
>   ต้องใช้ `security definer` function ช่วยตรวจ role แทนการ join ตรง ๆ

---

## 5. ล้าง orphan `auth.users`

**ความสำคัญ: ต่ำ** · **แรง: ต่ำ**

คนที่กด login ด้วย Google โดยใช้อีเมลนอกโดเมน จะทิ้งแถวไว้ใน `auth.users`
(Supabase สร้างให้อัตโนมัติตอน OAuth) แถวพวกนี้ **ไม่มีสิทธิ์อะไรเลย** เพราะไม่มี
แถวใน `access_requests` — เป็นแค่ขยะสะสม

**แนวทาง:** `pg_cron` ลบ user ที่ไม่มีแถวใน `access_requests` และสร้างมาเกิน N วัน
หรือลบมือจาก Authentication → Users เป็นครั้งคราว

---

## 6. Audit trail

**ความสำคัญ: ต่ำ** · **แรง: ต่ำ**

`reviewed_by` ตอนนี้เป็น `text` เปล่า ๆ กรอกอะไรก็ได้ ไม่ได้ผูกกับตัวตนจริง

**แนวทาง**

- `reviewed_by` → `uuid references auth.users(id)`
- เพิ่ม `updated_at` + trigger
- ถ้าต้องการประวัติเต็ม (ใครเปลี่ยนสถานะอะไรเมื่อไหร่) ทำตาราง
  `access_request_events` แยก แทนการทับข้อมูลเดิม

---

## 7. เปลี่ยนชื่อโดเมนบนหน้า consent ของ Google

**ความสำคัญ: ต่ำ (cosmetic)** · **แรง: สูง — ต้องใช้ Supabase Pro**

หน้า consent ของ Google แสดง `<project-ref>.supabase.co` เพราะโดเมนนั้นคือผู้รับ
OAuth code จริง ๆ เปลี่ยนได้ทางเดียวคือใช้ **Supabase Custom Domain** (Pro plan ขึ้นไป)
ให้ auth server อยู่บนโดเมนของเราเอง แล้วแก้ redirect URI ใน Google Cloud Console
กับ `VITE_SUPABASE_URL` ตาม

ไม่กระทบความปลอดภัยหรือการทำงาน — ทำตอนใกล้เปิดใช้จริงกับผู้ใช้ภายนอกก็ได้

---

## 8. Checklist ก่อนขึ้น production

ไม่ใช่ฟีเจอร์ แต่เป็นสิ่งที่ต้องไม่ลืม

- [ ] เพิ่ม URL ของ production ใน **Authentication → URL Configuration → Redirect URLs**
      (ไม่งั้น login แล้วเด้งกลับไม่ได้)
- [ ] **Publish** OAuth consent screen ใน Google Cloud Console — ระหว่างเป็น *Testing*
      เฉพาะบัญชีที่อยู่ในรายชื่อ test users เท่านั้นที่ login ได้
- [ ] ปิด **Email provider** และ **Allow anonymous sign-ins** ใน Supabase
- [ ] `HOST=0.0.0.0` ปลอดภัยแล้วหลังมี `server/auth.ts` แต่ยังควรอยู่หลัง
      reverse proxy ที่มี HTTPS — token เดินทางใน header ทั้ง REST และ WebSocket
- [ ] พิจารณา rate limit ที่ `/api/gemini/*` — auth กันคนนอกได้ แต่ยังไม่กันบัญชี
      ที่ผ่านการอนุมัติแล้วจากการยิงถี่จนบิลบานปลาย
- [ ] ตรวจว่า `.env` ของ production ตั้ง `VITE_SUPABASE_*` ครบ ไม่งั้นเซิร์ฟเวอร์จะ
      ปฏิเสธทุก request (fail closed) พร้อม error ใน log ตอนเริ่มทำงาน
