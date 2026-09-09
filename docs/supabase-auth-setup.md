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
| `public.get_account_status(email)` | คืนสถานะของอีเมลหนึ่ง ใช้กับ popup ตอน login |

**ไม่มี** policy สำหรับ UPDATE โดยเจตนา — ผู้ใช้จึงอนุมัติตัวเองไม่ได้ไม่ว่าจะ
ยิง API ตรงแค่ไหน การอนุมัติทำได้จาก dashboard (service role) เท่านั้น

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

## 5. อนุมัติบัญชี (งานของแอดมิน)

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

## Flow ที่เกิดขึ้นจริง

```
สมัคร:  /register → Google → /auth/callback
        ├─ อีเมลไม่ใช่ @chula.ac.th → sign out ทันที + แจ้งเตือน (ไปต่อไม่ได้)
        └─ ผ่าน → กรอก ชื่อ/นามสกุล/เบอร์โทร → insert แถว status='pending'
                → หน้า "รออนุมัติ"

เข้าสู่ระบบ: /login (Google หรือ อีเมล+รหัสผ่าน)
        ├─ ไม่มีแถวในตาราง   → popup "อีเมลนี้ยังไม่ได้ลงทะเบียน" + sign out
        ├─ status = pending  → popup "อยู่ระหว่างการตรวจสอบสิทธิ์" + sign out
        ├─ status = rejected → popup "คำขอไม่ได้รับการอนุมัติ" + sign out
        └─ status = approved → เข้าหน้าคอนโซลได้เลย (ไม่มี popup)
```

## หมายเหตุ

- **การสมัครทำผ่าน Google เท่านั้น** ช่อง "ตั้งรหัสผ่าน" ในหน้าสมัครเป็น
  ตัวเลือกเสริม มีไว้เพื่อให้ล็อกอินด้วยอีเมล + รหัสผ่านได้ภายหลัง
  ถ้าไม่ตั้ง ก็ต้องเข้าสู่ระบบด้วยปุ่ม Google เสมอ
- คนที่ล็อกอิน Google ด้วยอีเมลที่ไม่เคยลงทะเบียน จะมีแถวค้างใน
  `auth.users` (Supabase สร้างให้อัตโนมัติ) แต่ **ไม่มีสิทธิ์ใด ๆ** เพราะไม่มี
  แถวใน `access_requests` ลบทิ้งได้จาก Authentication → Users
- ถ้าเปลี่ยน `VITE_ALLOWED_EMAIL_DOMAIN` ต้องแก้ CHECK constraint
  `access_requests_allowed_domain` ใน `supabase/schema.sql` ให้ตรงกันด้วย
  ไม่เช่นนั้น insert จะถูกปฏิเสธจากฝั่งฐานข้อมูล
