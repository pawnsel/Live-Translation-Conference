# การติดตั้ง Supabase Auth + ระบบอนุมัติบัญชี

ระบบนี้แยก "คุณเป็นใคร" (Supabase Auth / Google) ออกจาก "คุณมีสิทธิ์ใช้งานไหม"
(ตาราง `public.access_requests`) — Google ให้ session กับใครก็ได้ แต่จะเข้าหน้า
คอนโซลได้ต่อเมื่อแอดมินอนุมัติแถวในตารางแล้วเท่านั้น

## 1. สร้างโปรเจกต์และรัน schema

1. สร้างโปรเจกต์ที่ [supabase.com](https://supabase.com)
2. เปิด **SQL Editor** → วางเนื้อหาทั้งไฟล์ `supabase/schema.sql` → Run

จะได้:

| สิ่งที่สร้าง | หน้าที่ |
|---|---|
| `public.access_status` | enum `pending` / `approved` / `rejected` |
| `public.access_requests` | คำขอใช้งาน 1 แถวต่อ 1 คน (id = auth user id) |
| RLS policies | อ่าน/สร้างได้เฉพาะแถวของตัวเอง และสร้างได้เฉพาะสถานะ `pending` |
**ไม่มี** policy สำหรับ UPDATE โดยเจตนา — ผู้ใช้จึงอนุมัติตัวเองไม่ได้ไม่ว่าจะ
ยิง API ตรงแค่ไหน การอนุมัติทำได้จาก dashboard (service role) เท่านั้น

> ถ้าเคยรัน schema เวอร์ชันก่อนหน้าไว้ ให้รันไฟล์ใหม่ทับได้เลย — มีคำสั่ง
> `drop function ... get_account_status` อยู่ในไฟล์แล้ว ฟังก์ชันนั้นไม่ใช้แล้ว
> เพราะเปิดให้ใครก็ตามที่มี anon key ตรวจสอบได้ว่าอีเมลไหนมีบัญชีอยู่

## 2. เปิด Google provider

1. **Authentication → Providers → Google** → Enable
2. คัดลอก **Callback URL** ที่ Supabase แสดง ไปใส่ใน Google Cloud Console →
   OAuth 2.0 Client → *Authorized redirect URIs*
3. เอา **Client ID** และ **Client Secret** จาก Google กลับมาใส่ใน Supabase → Save

## 3. ตั้งค่า URL ของแอป

**Authentication → URL Configuration**

| ช่อง | ค่า |
|---|---|
| Site URL | `http://localhost:3000` |
| Redirect URLs | `http://localhost:3000/auth/callback` |

ถ้ามี production ให้เพิ่ม URL ของ production ใน Redirect URLs ด้วย มิฉะนั้น
Supabase จะปฏิเสธการ redirect กลับหลัง login

## 4. ใส่ค่าใน `.env`

```env
VITE_SUPABASE_URL="https://xxxxxxxx.supabase.co"
VITE_SUPABASE_ANON_KEY="eyJhbGciOi..."
```

ทั้งสองค่าอยู่ที่ **Project Settings → API** และ **ต้องขึ้นต้นด้วย `VITE_`**
เพราะ Vite ส่งเฉพาะตัวแปรที่ขึ้นต้นแบบนี้ไปให้ฝั่ง browser

> ค่าเหล่านี้ถูกฝังตอน build — เปลี่ยนแล้วต้องรีสตาร์ท dev server หรือ build ใหม่

## 5. ปิด Email provider (แนะนำ)

**Authentication → Sign In / Providers → Email → ปิด**

ระบบเข้าสู่ระบบด้วย Google อย่างเดียว ไม่มีรหัสผ่านให้ตั้งหรือให้ลืม
การปิด provider นี้ทำให้ไม่มีทางสร้างบัญชีนอกเส้นทาง Google ได้เลย
(**Allow anonymous sign-ins** ก็ควรปิดด้วย)

## 6. อนุมัติบัญชี (งานของแอดมิน)

ดูคำขอที่รออยู่:

```sql
select email, first_name, last_name, phone, created_at
  from public.access_requests
 where status = 'pending'
 order by created_at;
```

อนุมัติ:

```sql
update public.access_requests
   set status = 'approved', reviewed_at = now(), reviewed_by = 'you@chula.ac.th'
 where lower(email) = lower('somchai.j@chula.ac.th');
```

ไม่อนุมัติ:

```sql
update public.access_requests
   set status = 'rejected', reviewed_at = now(), reviewed_by = 'you@chula.ac.th',
       review_note = 'ไม่ใช่บุคลากรในโครงการ'
 where lower(email) = lower('somchai.j@chula.ac.th');
```

ผู้ใช้จะเข้าใช้งานได้ทันทีที่โหลดหน้าใหม่หลังถูกอนุมัติ (ไม่ต้องสมัครซ้ำ)
การถอนสิทธิ์ทำได้โดยเปลี่ยนสถานะกลับ — จะมีผลตอนผู้ใช้โหลดหน้าถัดไป
ถ้าต้องการตัด session ที่เปิดค้างอยู่ทันที ให้ลบผู้ใช้ที่
**Authentication → Users** ด้วย

## การป้องกันฝั่ง server

หน้าจอกันได้แค่ "เห็นหรือไม่เห็น" เท่านั้น ตัวที่กันของแพงจริง ๆ คือ
`server/auth.ts` ซึ่งตรวจทุก request ที่จะใช้ Gemini key:

```
POST /api/gemini/*                → ต้องมี Authorization: Bearer <token>
ws://…/ws/gemini-live-transcribe  → ต้องมี Sec-WebSocket-Protocol: bearer, <token>
```

วิธีตรวจคือยิง 1 request ไป Supabase ด้วย **token ของผู้เรียกเอง**:
PostgREST ตรวจลายเซ็น JWT ให้ และ RLS กรองให้เหลือแถวของคนนั้น จึงได้คำตอบ
ทั้ง "เป็นใคร" และ "อนุมัติหรือยัง" ในครั้งเดียว

- **ไม่ใช้ service-role key** — เซิร์ฟเวอร์นี้ไม่เคยถือกุญแจที่อ่านแถวคนอื่นได้
- ถ้าติดต่อ Supabase ไม่ได้ จะ **ปฏิเสธ** (fail closed) ไม่ใช่ปล่อยผ่าน
- ผลการตรวจถูก cache ไว้ 60 วินาที → ถอนสิทธิ์แล้วจะมีผลกับงานใหม่ภายใน 1 นาที
- ถ้าไม่ได้ตั้ง `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` เซิร์ฟเวอร์จะ
  ปฏิเสธทุก request พร้อมขึ้น error ใน log ตอนเริ่มทำงาน

ทดสอบได้ด้วย:

```bash
curl -i -X POST http://127.0.0.1:3000/api/gemini/summarize \
  -H 'Content-Type: application/json' -d '{"items":[]}'
# → HTTP 401 {"error":"missing access token"}
```

## Flow ที่เกิดขึ้นจริง

```
สมัคร:  /register → Google → /auth/callback
        ├─ อีเมลไม่ใช่ @chula.ac.th → sign out ทันที + แจ้งเตือน (ไปต่อไม่ได้)
        └─ ผ่าน → กรอก ชื่อ/นามสกุล/เบอร์โทร → insert แถว status='pending'
                → หน้า "รออนุมัติ"

เข้าสู่ระบบ: /login → Google → /auth/callback
        ├─ ไม่มีแถวในตาราง   → popup "อีเมลนี้ยังไม่ได้ลงทะเบียน" + sign out
        ├─ status = pending  → popup "อยู่ระหว่างการตรวจสอบสิทธิ์" + sign out
        ├─ status = rejected → popup "คำขอไม่ได้รับการอนุมัติ" + sign out
        └─ status = approved → เข้าหน้าคอนโซลได้เลย (ไม่มี popup)
```

## งานที่ยังเหลือ

สิ่งที่ระบบนี้ยังไม่มี (แจ้งเตือนแอดมิน, ถอนสิทธิ์แบบทันที, หน้าอนุมัติในแอป
ฯลฯ) รวบรวมไว้ใน [`auth-roadmap.md`](./auth-roadmap.md)

## หมายเหตุ

- **ทั้งสมัครและเข้าสู่ระบบใช้ Google อย่างเดียว** ไม่มีรหัสผ่านในระบบนี้
  จึงไม่มี flow ลืมรหัสผ่าน และไม่มีรหัสผ่านให้รั่ว
- คนที่ล็อกอิน Google ด้วยอีเมลที่ไม่เคยลงทะเบียน จะมีแถวค้างใน
  `auth.users` (Supabase สร้างให้อัตโนมัติ) แต่ **ไม่มีสิทธิ์ใด ๆ** เพราะไม่มี
  แถวใน `access_requests` ลบทิ้งได้จาก Authentication → Users
- ถ้าเปลี่ยน `VITE_ALLOWED_EMAIL_DOMAIN` ต้องแก้ CHECK constraint
  `access_requests_allowed_domain` ใน `supabase/schema.sql` ให้ตรงกันด้วย
  ไม่เช่นนั้น insert จะถูกปฏิเสธจากฝั่งฐานข้อมูล
