# สรุปการทำงานของระบบ AI Realtime Conference Interpreter & Translator
(System Overview & Architecture Documentation)

> อัปเดตล่าสุด: 2026-09-07 — เขียนใหม่ทั้งฉบับหลังรวมระบบเข้ากับ ASR backend
> ใหม่ (`../thai-realtime-asr-mt`) ในสาขา `feat/asr-backend-integration`
> รายละเอียดการออกแบบและแผนการทำงานทั้งหมดอยู่ที่
> [`docs/superpowers/specs/2026-09-03-asr-backend-integration-design.md`](docs/superpowers/specs/2026-09-03-asr-backend-integration-design.md)
> และ [`docs/superpowers/plans/2026-09-03-asr-backend-integration.md`](docs/superpowers/plans/2026-09-03-asr-backend-integration.md)

ระบบ **AI Realtime Conference Interpreter & Translator** คือ operator console
สำหรับถอดความเสียงพูดสด (Speech-to-Text) และแปลภาษาแบบเรียลไทม์ (Thai ↔
English) สำหรับการประชุม สัมมนา งานแถลงข่าว และการบรรยายสองภาษา — ออกแบบให้
กล่องคำแปลหลักเป็นกล่องเดียวแบบ subtitle เพื่อให้ crop ด้วย OBS ไปสตรีมต่อได้

**การเปลี่ยนแปลงใหญ่ที่สุด**: เดิมระบบนี้ทำ ASR (ผ่าน Web Speech API ของ
เบราว์เซอร์) และแปลภาษา (ผ่าน Google Gemini) เองทั้งหมดในโปรเจกต์เดียว ตอนนี้
สองงานนั้นย้ายไปอยู่ที่ backend Python แยกต่างหาก (`thai-realtime-asr-mt`,
FastAPI + Google Cloud Speech Chirp 3 + Google Translate) และ repo นี้เหลือ
หน้าที่แค่เป็น **operator console**: จับเสียงจากไมโครโฟน ส่งขึ้น backend,
รับ caption กลับมาแสดง, ส่งคำสั่งควบคุม (สลับภาษา, พัก/เล่นต่อ, พจนานุกรม,
สรุปช่วงประชุม) — ไม่มี Gemini, ไม่มี Web Speech API, ไม่มี Socket.IO เหลือ
อยู่ใน repo นี้อีกต่อไป

---

## 1. สถาปัตยกรรมระบบ (System Architecture)

```
[ไมโครโฟนของผู้ใช้ในเบราว์เซอร์]
        │  AudioWorklet → 16kHz mono PCM
        ▼
 ┌────────────────────────────┐        ┌──────────────────────────────────┐
 │  React Operator Console     │        │  thai-realtime-asr-mt (FastAPI)   │
 │  (repo นี้ — Live-Translation-│  WS    │  ── ../thai-realtime-asr-mt ──    │
 │   Conference)               │◄──────►│                                   │
 │                              │ /ws/{id}      • Session registry (in-memory,│
 │  - ถือ operator token        │        │       MAX_SESSIONS=3)             │
 │  - เปิด WS คุมคำสั่ง +       │        │  ── /ws/{id}/audio ──►           │
 │    caption ผ่าน /ws/{id}     │  WS     │     • Google Cloud Speech Chirp 3 │
 │  - ส่งเสียง PCM ผ่าน         │────────►│       (ASR, th⇄en code-switching) │
 │    /ws/{id}/audio            │        │     • Google Translate (แปลภาษา)  │
 │  - แสดง caption กล่องเดียว   │        │     • Glossary 3 หมวด (process-   │
 │    แบบ subtitle              │        │       wide ไม่แยกต่อ session)     │
 └──────────────┬───────────────┘        │     • Section report (สรุปด้วย    │
                │ POST /api/asr/token     │       Vertex AI Gemini)           │
                ▼                        └──────────────────────────────────┘
 ┌────────────────────────────┐
 │  Node server.ts (บาง)       │   ถือรหัสผ่าน operator ที่ตั้งไว้ใน env
 │  - เสิร์ฟหน้าเว็บ (Vite)     │   (ASR_OPERATOR_PASSWORD) แลกเป็น token
 │  - โบรกเกอร์ token เดียว:   │   ให้ browser โดยที่รหัสผ่านไม่หลุดไปถึง
 │    POST /api/asr/token      │   ฝั่ง client เลย
 └────────────────────────────┘
```

**จุดสำคัญของสถาปัตยกรรมนี้**:
- **หนึ่งโปรเจกต์ (Project) มีได้หลาย session** — session ของ ASR ฝั่ง Python
  อยู่ใน memory เท่านั้น (ไม่รอด backend restart) แต่ project เก็บอยู่ใน
  localStorage ของเบราว์เซอร์ (ยังไม่มี database จริง — ดู §4) ดังนั้นหนึ่ง
  project จึงสะสม session ได้หลายครั้งตลอดอายุของมัน — **นี่คือการแก้ไข
  จากแผนเดิมใน §4 ฉบับก่อนหน้าที่เคยระบุว่า "1 project = 1 session"**
- **โทเคนเดินทางผ่าน `Sec-WebSocket-Protocol` เท่านั้น** ไม่เคยอยู่ใน URL —
  กันหลุดผ่าน proxy log / browser history
- **พจนานุกรมเป็นไฟล์เดียวใช้ร่วมกันทุก session บน backend** ไม่ใช่ต่อ
  project — คอนโซลมีข้อความเตือนเรื่องนี้ให้เห็นชัดเจนตรงหน้าจอพจนานุกรม

---

## 2. ฟังก์ชันหลักของระบบ (Core System Features)

### 2.1 กล่อง Subtitle เดียว สำหรับ crop ไป OBS
พื้นที่แสดงคำแปลหลักเป็น **กล่องเดียว** แสดงคำแปลของ caption ล่าสุดเท่านั้น
(เหมือน subtitle บน YouTube) แทนรายการที่เลื่อนยาวลงเรื่อยๆ — ออกแบบมาให้
operator เปิด OBS แล้ว window-crop เฉพาะกล่องนี้ไปสตรีมได้โดยไม่ติดปุ่ม/เมนู
อื่น ข้อความต้นฉบับ (ถ้าเปิดแสดง) จะตามเสียงพูดสดตลอด แต่คำแปลจะ "ค้าง" ไว้ที่
ประโยคก่อนหน้าจนกว่าคำแปลของประโยคใหม่จะมาถึง — ไม่มีช่วงว่างกระพริบระหว่างรอ
ประวัติทั้งหมด (แก้ไข/คัดลอก/ซ่อนรายการ) อยู่ใน panel พับเก็บด้านล่างกล่อง
(ค่าเริ่มต้นพับอยู่)

**ค่าเริ่มต้น**: ทั้ง "แสดงประโยคต้นฉบับ" และ "แสดง Latency" **ปิดไว้**
เพื่อให้กล่องที่ crop ไปสตรีมสะอาดที่สุด เปิดได้จากแท็บตั้งค่า

### 2.2 การจับคู่ภาษา (Thai ⇄ English เท่านั้น)
Backend รองรับคู่ภาษาเดียวคือ `th ⇄ en` (ตาม
[protocol-v1.md](../thai-realtime-asr-mt/docs/protocol-v1.md)) เลือกภาษา
ต้นทางแล้วปลายทางจะสลับให้อัตโนมัติเสมอ มีปุ่ม **⇅ สลับภาษา** ทั้งใน sidebar
และแถบหัวฟีด การสลับภาษาต้นทางจะรีสตาร์ทการฟังเสียงราว 1 วินาทีฝั่ง backend
(ไม่ใช่ระบบตัดวรรค/chunking ที่เคยมีในเวอร์ชันเก่า — Chirp 3 จัดการการตัด
ประโยคเองทั้งหมด ไม่มี UI ให้ปรับความไวอีกต่อไป)

### 2.3 พจนานุกรมศัพท์เฉพาะทาง (Glossary — 3 หมวด, ใช้ร่วมกันทุก session)
พจนานุกรมเป็นไฟล์เดียวบน backend ที่ใช้ร่วมกันทุก session ที่กำลังถ่ายทอด
สดอยู่พร้อมกัน (ไม่ใช่ต่อ project เหมือนเวอร์ชันเก่า) แบ่ง 3 หมวดตาม wire
protocol:
- **ศัพท์เฉพาะ** (`protected_terms`) — ไทย → อังกฤษ คำที่ต้องคงคำแปลไว้เสมอ
- **ชื่อบุคคล** (`person_names`) — ไทย → อังกฤษ ชื่อผู้พูดที่ถอดเสียงเป็น
  อังกฤษ
- **แก้คำไทยที่ฟังผิด** (`thai_corrections`) — ไทย → ไทย แก้คำที่ระบบมักได้
  ยินผิด

รองรับค้นหา, เพิ่ม/ลบทีละคำ, และวางสองคอลัมน์จาก Excel/Sheets พร้อมกันได้
หน้าจอมีข้อความเตือนตลอดว่าการแก้ไขมีผลกับทุก session ที่กำลังถ่ายทอดสดอยู่

### 2.4 การบันทึกและสรุปช่วงประชุมอัตโนมัติ (Auto Section Report)
**ไม่มีปุ่ม "เริ่มบันทึก" ให้กดพลาดอีกต่อไป** — ระบบส่งคำสั่งเริ่มเก็บบท
สนทนา (`control.report_start`) ให้ backend ทันทีที่ session เชื่อมต่อสำเร็จ
และสั่งหยุด (`control.report_stop`) โดยอัตโนมัติตอนกด "จบ Session" คอนโซลจะ
**รอผลสรุปก่อนลบ session จริง** (สูงสุด 20 วินาที — สั้นกว่า timeout ของ
backend เอง) เพื่อไม่ให้ผลสรุปมาถึงหลัง session ถูกลบไปแล้วแล้วไม่มีใครรับ
ปุ่มจะขึ้น "กำลังสรุปผลการประชุม…" ระหว่างรอ

ผลสรุปมาจาก Vertex AI Gemini ฝั่ง backend หากเรียกไม่สำเร็จ (เช่น ยังไม่ได้
เปิดใช้งาน API บน GCP project) ระบบจะยังส่ง transcript ดิบมาให้เหมือนเดิม
(ไม่เสียข้อมูล) และคอนโซลจะขึ้นข้อความเตือนแทนสรุป AI

### 2.5 ประวัติ Session ในโปรเจกต์และสรุปย้อนหลัง
กดไอคอน 📋 ข้างชื่อโปรเจกต์เพื่อเปิดดูรายการ session ทั้งหมดที่เคยบันทึกไว้
ในโปรเจกต์นี้ (เรียงล่าสุดก่อน) คลิกแต่ละ session เพื่อกางดูสรุปการประชุม
ของครั้งนั้น — ยังไม่มี database จริง (ดู §4) ข้อมูลนี้จึงเก็บอยู่ใน
localStorage เดียวกับข้อมูล project อื่นๆ ไปก่อน

### 2.6 การส่งออกผลลัพธ์ (Export)
- **TXT**: บันทึกบทสนทนาการประชุมพร้อมเวลาและคำแปล
- **SRT**: ไฟล์คำบรรยายพร้อม Timecode สำหรับประกอบวิดีโอ

ทั้งสองแบบดึงจากรายการ caption ทั้งหมดของ project รวมคำแปลที่ operator แก้ไข
เองด้วย (การแก้ไขเป็นแบบ local เท่านั้น — protocol v1 ยังไม่มีคำสั่งแก้ไข
caption ที่ backend เก็บไว้)

### 2.7 สิ่งที่ตัดออกจากเวอร์ชันเก่า (ไม่มีในระบบนี้อีกต่อไป)
- **แถบทดสอบ/พิมพ์ข้อความจำลอง** — protocol v1 ไม่มีช่องยิงข้อความเข้า
  pipeline โดยตรง ทดสอบได้จากการพูดใส่ไมค์เท่านั้น
- **"ให้ AI แปลใหม่" รายบรรทัด** — caption เป็นของ backend (server-authored)
  ไม่มีคำสั่งขอแปลใหม่เฉพาะบรรทัด
- **ปุ่ม "✂️ ตัดแปลทันที"** — Chirp 3 ใช้ VAD ตัดประโยคเอง ไม่มีคำสั่งสั่ง
  ตัดจากฝั่ง client
- **ตัวเลือกโมเดล AI แปลภาษา / speech engine** — backend คุมค่าเหล่านี้ผ่าน
  env ของตัวเอง ไม่มีอะไรให้ตั้งค่าจากฝั่ง console
- **หน้า "API Key" ใน Admin Console** — ไม่มี custom API key ต่อผู้ใช้อีก
  ต่อไป รหัสผ่าน operator ตั้งค่าครั้งเดียวใน `.env` ของ Node server
  (`ASR_OPERATOR_PASSWORD`) และไม่เคยหลุดไปถึง browser

---

## 3. วิธีการเริ่มใช้งาน (Quick User Guide)

**เตรียมก่อนใช้งาน**: ต้องรัน backend `thai-realtime-asr-mt` (`uv run python
server/main.py`) และตั้งค่า `ASR_OPERATOR_PASSWORD` ใน `.env` ของ repo นี้ให้
ตรงกับรหัสผ่าน operator ที่ตั้งไว้ฝั่ง backend (`OPERATOR_PASSWORD_HASH`)
รายละเอียดดูที่ [`docs/superpowers/plans/2026-09-03-asr-backend-integration.md`](docs/superpowers/plans/2026-09-03-asr-backend-integration.md)
§15

1. **เลือกหรือสร้างโปรเจกต์** จากหน้าแรก
2. **กด "เริ่ม Session"** มุมขวาบน — ระบบจะสร้าง session ใหม่บน backend (หรือ
   ต่อ session เดิมถ้ามีอยู่แล้ว) และขอสิทธิ์ไมโครโฟน เริ่มบันทึกช่วงประชุม
   อัตโนมัติ
3. **พูดใส่ไมโครโฟน** — เห็นข้อความ interim (กำลังฟัง) ก่อน แล้วคำแปลจะขึ้น
   ในกล่อง subtitle กลางจอ
4. **สลับภาษา / พัก-เล่นต่อ** ได้จากปุ่มในแถบหัวเรื่องหรือ sidebar โดยไม่ต้อง
   หยุด session
5. **กด "จบ Session"** เมื่อเลิกใช้งาน — รอสรุปผลสักครู่ (ขึ้น "กำลังสรุปผล
   การประชุม…") แล้วจะเห็น panel สรุปโผล่ขึ้นมาอัตโนมัติที่ด้านล่าง
6. ดูสรุปย้อนหลังของ session ก่อนๆ ได้จากไอคอน 📋 ข้างชื่อโปรเจกต์ (§2.5)

---

## 4. แผนพัฒนาต่อ (Roadmap — P1–P4 ยังไม่ได้เริ่มพัฒนา)

ส่วนนี้เคยเป็นแผน multi-tenant/auth/billing ฉบับก่อนที่จะเริ่มงานรวมระบบกับ
ASR backend (P0) รายละเอียดเดิมถูกแทนที่ด้วยแผนที่ผ่านการ brainstorm ใหม่
ร่วมกับผู้ใช้แล้ว ดูฉบับเต็มได้ที่ design spec ของ P0 หัวข้อ "Roadmap
context" — สรุปสั้นๆ:

| # | Sub-project | สถานะ |
|---|---|---|
| **P0** | ASR backend integration (เอกสารนี้บรรยายผลลัพธ์) | **เสร็จแล้ว** |
| P1 | Auth จริง — Supabase email/password, Node เป็น BFF ตรวจ JWT | ยังไม่เริ่ม |
| P2 | Persistence จริง — Postgres + Drizzle แทน localStorage, projects ↔ ASR sessions | ยังไม่เริ่ม |
| P3 | พจนานุกรมแยกต่อ session (ปัจจุบันเป็นไฟล์เดียวใช้ร่วมกันทั้งเซิร์ฟเวอร์ — §2.3) | ยังไม่เริ่ม |
| P4 | Usage metering จริง + billing PDF (ปัจจุบัน bill เป็นตัวเลขประมาณการ placeholder เท่านั้น) | ยังไม่เริ่ม |

**ข้อตกลงเดิมที่ยังใช้ได้อยู่**: ไม่มีระบบ self-registration (แอดมินสร้าง
account ให้ user เอง), billing เป็นรายงานสรุปในระบบไม่ผูก payment gateway,
เก็บเฉพาะข้อความ (text-only ไม่มี object storage สำหรับไฟล์เสียง)

**ข้อที่เปลี่ยนไปจากแผนเดิม**: แผนเดิมระบุว่า "1 project = 1 การประชุมครั้ง
เดียว ไม่ต้องมี entity Session แยกจาก Project" — ตอนนี้ไม่จริงแล้ว เพราะ ASR
session ของ backend Python อยู่ใน memory เท่านั้นและตายเมื่อ backend restart
project จึงต้องเก็บ session หลายรายการตลอดอายุของมัน (ดู §1 และ
`ProjectSession[]` ใน [`src/types.ts`](src/types.ts)) — เมื่อ P2 (Postgres)
เริ่มพัฒนาจริง โครงร่างข้อมูลนี้ต้องออกแบบรองรับ "1 project : N sessions"
ตั้งแต่ต้น ไม่ใช่ 1:1 แบบแผนเดิม
