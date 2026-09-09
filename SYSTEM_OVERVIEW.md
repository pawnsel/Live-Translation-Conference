# สรุปการทำงานของระบบ AI Realtime Conference Interpreter & Translator
(System Overview & Architecture Documentation)

> อัปเดตล่าสุด: 2026-09-02

ระบบ **AI Realtime Conference Interpreter & Translator** คือระบบถอดความเสียงพูดสด (Speech-to-Text) และแปลภาษาแบบเรียลไทม์ (Real-time Live Translation) ที่ออกแบบมาสำหรับการประชุม สัมมนา งานแถลงข่าว และการบรรยายสองภาษา (Thai ↔ English) โดยทำงานผ่านสถาปัตยกรรม Full-Stack (React + Vite + Tailwind CSS + Node.js Express + Socket.IO + Google Gemini API)

---

## 1. แผนภาพและโครงสร้างการทำงานของระบบ (System Workflow Architecture)

```
 [เสียงพูดของผู้บรรยาย (Speaker)] 
              │
              ▼
 🎙️ [Speech Recognition (ASR Engine)] 
    - Web Speech API / Google Cloud Speech Chirp 3
    - แปลงคลื่นเสียงสดเป็นข้อความทันที (<100ms)
    - รองรับการสลับภาษาผู้พูด: ไทย (th-TH) ↔ อังกฤษ (en-US)
              │
              ▼ (WebSocket: 'new-transcription')
 ⚡ [Node.js Express + Socket.IO Server Engine]
    - จัดเก็บประวัติและคิวข้อความการประชุม
    - รองรับการเชื่อมต่อแบบ Real-time หลาย Client พร้อมกัน
              │
              ▼
 🧠 [AI Translation & Terminology Post-Corrector (Google Gemini API)]
    - ใช้โมเดลเรือธงความเร็วสูง: Gemini 3.7 Flash / Gemini 2.5 Flash
    - จับคู่คำศัพท์เฉพาะทางจาก Dictionary Glossary (Terminology Enforcement)
    - แก้ไขความผิดพลาดของเสียงวรรณยุกต์/คำพ้องเสียงจาก Speech-to-Text (ASR Error Post-Correction)
    - แปลงบริบทภาษาธรรมชาติแบบ Fluent & Context-Aware (Thai ➔ English / English ➔ Thai)
              │
              ▼ (WebSocket: 'transcripts-updated')
 🖥️ [Admin Console & Live Subtitle Display Feed]
    - แสดงข้อความต้นฉบับ + คำแปลขนาดใหญ่ปรับขนาดได้
    - Telemetry วัดความหน่วงแบบเรียลไทม์ (AI Latency ms & Socket Ping ms)
    - เครื่องมือแก้ไขคำแปลสด (Inline Edit), สั่งแปลใหม่ (AI Retranslate)
    - ส่งออกเอกสารสรุปบันทึกการประชุม (.TXT) และไฟล์คำบรรยาย (.SRT)
```

---

## 2. ฟังก์ชันหลักของระบบ (Core System Features)

### 2.1 การจับคู่ภาษาอัตโนมัติ (Intelligent Auto Language Pairing)
- **เน้นคู่ภาษาหลัก 2 ภาษา (Thai ↔ English)**:
  - **เมื่อเลือกภาษาผู้พูดเป็น "ไทย (th-TH)"** ➔ ระบบจะตั้งค่าภาษาที่ต้องการแปลเป็น **"อังกฤษ (English)"** โดยอัตโนมัติ (Auto)
  - **เมื่อเลือกภาษาผู้พูดเป็น "อังกฤษ (en-US)"** ➔ ระบบจะตั้งค่าภาษาที่ต้องการแปลเป็น **"ไทย (Thai)"** โดยอัตโนมัติ (Auto)
- **ปุ่มสลับภาษาด่วน (One-Click Quick Swap `↔ สลับภาษา`)**: สามารถสลับทิศทางการแปลระหว่าง `ไทย ➔ อังกฤษ` และ `อังกฤษ ➔ ไทย` ได้ทันทีทั้งจากแถบตั้งค่าและจากหัวตาราง Live Feed

### 2.2 ระบบตัดวรรคแปลสดอัตโนมัติ (Live Speech Chunking & Silence Segmentation)
- **แก้ปัญหาเสียงพูดภาษาไทยไม่ตัดวรรค**: ปกติ Web Speech API จะไม่ตัดจบประโยคจนกว่าผู้พูดจะเงียบไปหลายวินาที ทำให้ไม่เป็น Live Translation
- **ตรวจจับจังหวะหยุดพูดอัจฉริยะ (Acoustic Silence Debounce)**: ระบบจะตรวจจับการหยุดพักประโยคหรือจังหวะหายใจของผู้พูด และทำการตัดท่อนประโยค (Chunk) ส่งให้โมเดล AI แปลทันทีแบบสดๆ
- **ปรับแต่งความไวในการตัดวรรคได้ 3 ระดับ**:
  - `⚡ เร็วมาก (Fast: ~600ms)`: ตัดประโยคย่อยคำต่อคำทันทีเมื่อหยุดพูดเพียงเสี้ยววินาที
  - `⚖️ มาตรฐาน (Balanced: ~900ms)`: ตัดตามจังหวะเว้นวรรคหายใจตามธรรมชาติ (แนะนำสำหรับการประชุม)
  - `🧘 ผ่อนคลาย (Relaxed: ~1400ms)`: รอประโยคยาวก่อนตัดวรรค
- **ปุ่มตัดแปลสดทันที (Manual Cut Now `✂️ ตัดแปลทันที`)**: สามารถกดปุ่มตัดท่อนที่กำลังพูดอยู่บนแถบไมโครโฟนเพื่อส่งแปลได้ทันใจทุกวินาที

### 2.3 โมเดล AI แปลภาษาและการแก้ไขคำผิด (Gemini AI Translation & Post-Correction)
- ขับเคลื่อนด้วย SDK ล่าสุด `@google/genai`
- **รองรับโมเดล**:
  - `gemini-3.7-flash` (แนะนำ: ความเร็วสูง ตอบสนองทันที เหมาะกับการประชุมสด)
  - `gemini-2.5-flash` (มาตรฐานความเร็วสูง)
  - `gemini-2.5-pro` (ความแม่นยำสูง สำหรับเนื้อหาเชิงวิชาการ/กฎหมาย)
- **ASR Post-Correction Prompt**: ปรับแต่ง Prompt พิเศษเพื่อช่วยกู้คืนคำศัพท์ที่ Speech-to-Text อาจได้ยินผิดหรือสะกดผิดจากเสียงวรรณยุกต์หรือเสียงแทรก
- **ระบบ Fallback สำรอง**: มีพจนานุกรมคำศัพท์และประโยคพื้นฐานในตัว ทำให้ระบบยังคงทำงานต่อเนื่องได้แม้ในสภาวะ Offline หรือกรณีโควต้า AI ขัดข้อง

### 2.3 ระบบพจนานุกรมศัพท์เฉพาะทาง (Glossary & Terminology Manager)
- สามารถกำหนดคำเฉพาะ (Jargon), ชื่อยี่ห้อ, คำย่อ (Acronyms เช่น KPI, ROI, LLM, AGM)
- รองรับการนำเข้าตาราง Excel แบบ Copy & Paste สองคอลัมน์ได้ทันที
- บันทึกและสลับใช้งาน Dictionary Preset ชุดคำศัพท์แยกตามประเภทการประชุมได้

### 2.4 ระบบความปลอดภัยของ API Key (Server-Side Secret Protection)
- ไม่เปิดเผย `GEMINI_API_KEY` ไปยัง Client หรือ Browser DevTools
- ผู้ดูแลระบบสามารถระบุ Custom API Key ผ่าน Admin Console เพื่อส่งไปบันทึกบน Server ในหน่วยความจำปลอดภัย พร้อมปุ่ม **"ทดสอบการเชื่อมต่อ API Key"** ตรวจสอบสถานะก่อนใช้งานจริง

### 2.5 การทดสอบและการส่งข้อความจำลอง (Instant Test Input Bar)
- มีแถบ **"ตัวอย่างทดสอบ"** และช่องป้อนข้อความจำลองเสียงพูดด้านล่าง Feed เพื่อทดสอบการแปลของโมเดล AI ได้ทันทีโดยไม่ต้องรอเปิดไมโครโฟน

### 2.6 การส่งออกผลลัพธ์ (Export Capabilities)
- **TXT Export**: บันทึกบทสนทนาการประชุมพร้อมเวลาและคำแปลสำหรับทำรายงานการประชุม
- **SRT Subtitle Export**: ส่งออกไฟล์ Subtitle พร้อม Timecode สำหรับนำไปประกอบวิดีโอบันทึกการประชุม

---

## 3. วิธีการเริ่มใช้งาน (Quick User Guide)

1. **เลือกคู่ภาษา**: ระบบจะตั้งค่าเริ่มต้นเป็น `ไทย (Thai)` ➔ `อังกฤษ (English)`
2. **ทดสอบโมเดล AI**:
   - สามารถคลิกชิปตัวอย่างที่แถบด้านล่าง เช่น *"สวัสดีครับ ยินดีต้อนรับสู่การประชุม"* หรือพิมพ์ข้อความแล้วกดปุ่ม **"แปลทันที"**
   - คำแปลจาก Gemini 3.7 Flash จะปรากฏขึ้นในตาราง Feed ทันที
3. **เริ่มการแปลสดจากไมโครโฟน**:
   - กดปุ่ม **"เริ่มแปลสด"** สีชมพูที่มุมขวาบน
   - อนุญาตการเข้าถึงไมโครโฟนในเบราว์เซอร์
   - เริ่มพูดใส่ไมโครโฟน ระบบจะถอดเสียงและแปลภาษาแบบเรียลไทม์อัตโนมัติ
4. **แก้ไขคำแปลสด**:
   - หากต้องการแก้ไขคำแปล สามารถคลิกไอคอนดินสอ (Edit) ที่รายการนั้นๆ เพื่อแก้ไขหรือกด **"ให้ AI แปลใหม่"** ได้ทันที

---

## 4. แผนพัฒนาต่อ: Multi-Tenant, Authentication & Billing (Roadmap — ยังไม่ได้เริ่มพัฒนา)

> เป็นผลสรุปจากการออกแบบ architecture ร่วมกัน ยังเป็นแค่แนวทาง (design) ยังไม่ได้ลงมือแก้โค้ดจริง

### 4.1 เป้าหมาย
ปัจจุบันระบบเป็น single-tenant: มี state ส่วนกลาง (config, transcripts, API key) ตัวเดียวที่ทุก client เชื่อมต่อเข้ามาใช้ร่วมกัน ไม่มีระบบผู้ใช้ ไม่มีการแยกข้อมูลตามงาน และไม่มีการคำนวณต้นทุน เป้าหมายต่อไปคือทำให้แต่ละ **user** สามารถสร้าง **project** ของตัวเองได้หลายโปรเจกต์ (เช่น 1 project = 1 งานประชุมวิชาการ 30 นาที) โดยข้อมูลและค่าใช้จ่ายแยกกันชัดเจนเป็นรายโปรเจกต์

### 4.2 ขอบเขตที่ตกลงกันไว้ (Confirmed Scope)
- **เก็บข้อมูลเฉพาะข้อความ (text-only)** — ไม่มีการอัดหรือเก็บไฟล์เสียงดิบ จึงไม่ต้องมี Object Storage (S3/GCS) เพิ่ม ใช้ Postgres ตัวเดียวพอ
- **API Key เป็นของระบบ ไม่ใช่ของ user** — ตัดหน้า "API Key" ใน Admin console ออกทั้งหมด ระบบใช้ `GEMINI_API_KEY` ระดับ platform ตัวเดียว (จาก env) แล้วคิดต้นทุนฝั่งเราเอง ก่อนสรุปยอดส่งให้ user
- **ไม่มีระบบ self-registration** — เป็นระบบใช้ภายในองค์กร แอดมินเป็นผู้สร้าง account ให้ user เองในช่วงแรก
- **1 project = 1 การประชุมครั้งเดียว** — ไม่ต้องมี entity "Session" แยกจาก "Project"
- **Billing เป็นรายงานสรุปยอดในระบบ พร้อม export เป็นไฟล์ PDF** — ไม่ต้องผูก payment gateway (Stripe/Omise/2C2P) ในเฟสนี้ ระบบคำนวณยอดแล้ว generate ใบสรุปยอด (bill) เป็นไฟล์ PDF ให้ดาวน์โหลดต่อ project เพื่อให้ทีมนำไปเรียกเก็บเงินนอกระบบ

### 4.3 Architecture Overview

```
[Operator Browser] --HTTPS/WSS + Session-->
        │
   [Auth Layer]  →  ยืนยันตัวตนด้วย session, ไม่มีหน้า signup (แอดมินสร้าง user เอง)
        │
   [Project Service]  →  CRUD project, ผูก project กับ owner_user_id
        │
   [Realtime Session Manager]
        │   Socket.IO room = projectId  (แทนที่ io.emit() แบบ global เดิม)
        │   → io.to(projectId).emit(...) แทน io.emit(...) ทั้งหมด
        │
        ├──> [Translation Worker]  (performTranslation() เดิม ใช้ platform API key เดียว)
        │        └─> อ่าน token usage จาก Gemini response.usageMetadata → บันทึกลง Usage Ledger
        │
        └──> [Persistence Writer]  →  Postgres: เขียน transcript ทีละ event
        │
   [Usage Ledger (Postgres)]  →  รวมยอดตาม project_id
        │
   [Billing Report]  →  คำนวณ token cost + service fee → แสดงในระบบ + generate ไฟล์ PDF ให้ดาวน์โหลด (ไม่มี payment gateway)
```

### 4.4 Data Model (Postgres)

| Entity | คีย์สำคัญ | หมายเหตุ |
|---|---|---|
| `users` | id, email, password_hash, role (`admin`\|`member`), created_at | แอดมินสร้างให้เอง ไม่มี self-registration |
| `projects` | id, owner_user_id, name, status (`draft`\|`active`\|`ended`), config (JSONB: ภาษา, dictionary, chunking ms — ตรงกับ `AppConfig` เดิม), created_at, ended_at | 1 project = 1 การประชุมครั้งเดียว |
| `transcript_items` | id, project_id, original_text, translated_text, timestamp, latency_ms, is_edited, tokens_in, tokens_out | แทนที่ array `transcripts` ใน memory ของ server.ts เดิม |
| `usage_events` | id, project_id, event_type (`gemini_call`), tokens_in, tokens_out, unit_cost, total_cost, created_at | insert ทุกครั้งที่เรียก Gemini เพื่อคำนวณต้นทุน |

### 4.5 การเปลี่ยนแปลงหลักที่ต้องทำในโค้ดปัจจุบัน
1. **Auth**: เพิ่ม session-based login และ middleware เช็ค session ทั้งฝั่ง HTTP routes และตอน Socket.IO handshake (`io.use(...)`) — มี 2 ทางเลือกสำหรับตัว auth เอง (ดูรายละเอียดเปรียบเทียบใน 4.6):
   - **Option A**: hand-rolled (email + password, bcrypt + server-side session เก็บใน Postgres)
   - **Option B**: ต่อกับระบบ auth ของ IT องค์กรที่มีอยู่แล้ว (SSO ผ่าน SAML/OIDC หรือ Active Directory/LDAP) แล้วเก็บแค่ mapping user ↔ role ↔ project ไว้ในตาราง `users` ของเราเอง
2. **Realtime scoping**: เปลี่ยนทุก `io.emit(...)` ใน [server.ts](server.ts) เป็น `io.to(projectId).emit(...)` และให้ client `socket.join(projectId)` ตอนเชื่อมต่อ — ปิดช่องโหว่ transcript รั่วไปทุก client ที่เคยพบระหว่างรีวิว
3. **ตัด API Key UI**: ลบ tab "API Key" และ logic รับ/ทดสอบ custom token ทั้งหมดออกจาก [Admin.tsx](src/pages/Admin.tsx) และ [server.ts](server.ts) เหลือใช้ `GEMINI_API_KEY` จาก env เพียงตัวเดียว
4. **CORS**: ปิด `origin: "*"` ของ Socket.IO server เหลือแค่ domain จริงของแอป
5. **Usage metering**: อ่าน `response.usageMetadata` จาก Gemini SDK ในทุกครั้งที่เรียก `performTranslation()` แล้วบันทึกลงตาราง `usage_events`
6. **Persistence**: ย้าย state จาก in-memory (`currentConfig`, `transcripts`, `serverSecretApiKey`) ไปเขียน/อ่านจาก Postgres แบบ per-event (ปริมาณ event ต่องานประชุมไม่มาก ไม่จำเป็นต้องมี cache layer เพิ่ม)
7. **PDF export**: เพิ่ม endpoint generate ใบสรุปยอด (bill) เป็น PDF ต่อ project โดยรวม token cost + service fee จาก `usage_events` — ใช้ library ฝั่ง server เช่น `pdfkit` หรือ render HTML แล้วแปลงด้วย `puppeteer`
8. **Pause/Resume recording ภายใน 1 project**: แก้บั๊กที่พบระหว่างรีวิว — ปัจจุบัน [server.ts:236-241](server.ts#L236-L241) สั่ง `transcripts = []` (ล้างข้อมูลทิ้งหมด) ทุกครั้งที่ event `start-meeting` ถูกยิง แปลว่าถ้า operator กดหยุด-เริ่มมิคใหม่หลายครั้งระหว่างงานเดียวกัน ข้อมูลที่แปลไปแล้วจะหายทุกรอบ ต้องแก้ให้ project เดิมกดอัด/หยุดอัดได้หลายครั้งโดยไม่ล้างข้อมูล กล่าวคือ:
   - `start-meeting` ควรแค่ตั้ง `isMeetingActive = true` และ**ต่อ**บันทึกลง `transcript_items` ของ `project_id` เดิม ไม่ clear ของเก่า
   - `stop-meeting` เป็นแค่ pause (หยุดฟังไมค์ชั่วคราว) ไม่ใช่ end-of-project — การ "จบ project" ต้องเป็น action แยกต่างหาก (เช่นปุ่ม "จบการประชุม") ที่เปลี่ยน `projects.status` เป็น `ended` และ lock ไม่ให้แก้ transcript ต่อ

### 4.6 Stack ที่แนะนำ
- **Database**: Postgres + Prisma หรือ Drizzle ORM
- **Auth**: มี 2 ทางเลือก ขึ้นอยู่กับว่าองค์กรมีระบบ auth กลางอยู่แล้วหรือไม่
  - **Option A — hand-rolled** (bcrypt + server-side session): ไม่จำเป็นต้องใช้ Auth SaaS เพราะไม่มี self-registration และ scope เล็ก เหมาะถ้าอยากเริ่มเร็วโดยไม่ต้องพึ่งทีม IT
  - **Option B — ต่อกับระบบ auth ของ IT องค์กร** (SSO/SAML/OIDC หรือ Active Directory/LDAP ที่มีอยู่แล้ว): ข้อดีคือ user ไม่ต้องจำ password แยกอีกชุด, การปิด/เปิดสิทธิ์ user จัดการที่ระบบกลางที่เดียว (ตอนคนลาออกก็ตัดสิทธิ์อัตโนมัติ), ตรงกับ requirement "ใช้ในองค์กรเท่านั้น ไม่มี self-registration" อยู่แล้ว — ข้อควรระวังคือต้องขอข้อมูล integration (client ID/secret, endpoint) จากทีม IT ก่อน และแอปเรายังต้องมีตาราง `users` ของตัวเองไว้ map ว่า user คนนี้เป็น owner ของ project ไหนบ้าง (SSO ให้แค่ identity ไม่ได้ให้ business data)
  - แนะนำ: เริ่ม Option A ไปก่อนถ้าต้องรีบใช้งาน แล้วค่อยย้ายไป Option B ทีหลังถ้า IT มีระบบพร้อมและต้องการรวมศูนย์การจัดการสิทธิ์
- **Hosting**: ใช้ Node server เดิมต่อได้ เพิ่มแค่ Postgres (self-host หรือ managed เช่น Neon/Supabase DB)

> หมายเหตุ: ส่วนนี้เป็นผลจากการ brainstorm ยังไม่ได้เขียนเป็น spec/implementation plan อย่างเป็นทางการ เมื่อพร้อมเริ่มพัฒนาให้กลับมาทำ spec doc ก่อนลงมือแก้โค้ด
