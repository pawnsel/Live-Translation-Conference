# การ Deploy ขึ้น server ขององค์กร

เอกสารนี้ครอบคลุมการนำแอปขึ้น server ที่เข้าถึงผ่าน VPN + SSH
สำหรับการตั้งค่า Supabase ครั้งแรก (schema, Google provider) ดู
[docs/supabase-auth-setup.md](docs/supabase-auth-setup.md) ประกอบ — ที่นี่จะพูดถึง
เฉพาะส่วนที่ต่างไปเมื่อขึ้น production

---

## 0. สิ่งที่ต้องรู้ก่อน — สองเรื่องที่ทำให้ deploy พังบ่อยที่สุด

**เรื่องที่ 1 — ต้องเป็น HTTPS เท่านั้น**

แอปขอไมโครโฟนผ่าน `getUserMedia()` ซึ่งเบราว์เซอร์จะ**ปฏิเสธทันที**บน origin ที่เป็น
HTTP ธรรมดา (ยกเว้น `localhost`) อาการคือหน้าเว็บโหลดได้ ล็อกอินได้ แต่พอกดอัดเสียง
จะขึ้น error สิทธิ์ไมโครโฟน ซึ่งดูเหมือนบั๊กของแอปทั้งที่ไม่ใช่

ถ้ายังไม่มีใบรับรอง TLS สำหรับ host นี้ ให้ใช้ทางเลี่ยงในหัวข้อ
[ยังไม่มี TLS](#ยังไม่มี-tls-ใช้-ssh-tunnel-ไปก่อน) ซึ่งใช้ได้เพราะมันทำให้ origin
กลายเป็น `localhost` จริงๆ

**เรื่องที่ 2 — ตัวแปร `VITE_*` เป็น build-time ไม่ใช่ run-time**

Vite ฝังค่าเหล่านี้ลงในไฟล์ JavaScript ตอน build ดังนั้น `VITE_SUPABASE_URL` และ
`VITE_SUPABASE_ANON_KEY` จะถูก**แช่แข็งอยู่ใน image** แล้ว การ `docker run -e` ทีหลัง
ไม่มีผล ถ้าจะเปลี่ยนโปรเจกต์ Supabase ต้อง **build ใหม่** (`--build`)

| ตัวแปร | อ่านเมื่อไหร่ | เปลี่ยนแล้วต้องทำอะไร |
|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_ALLOWED_EMAIL_DOMAIN` | ตอน build | `docker compose up -d --build` |
| `GEMINI_API_KEY`, `GEMINI_*_MODEL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` | ตอน server start | `docker compose up -d` |

`Dockerfile` มีด่านตรวจอยู่: ถ้าไม่ส่ง `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
มาตอน build มันจะ**หยุด build ทันที** แทนที่จะปล่อยให้ได้ image ที่ดูปกติแต่ผู้ใช้คนแรก
ที่เปิดจะเจอข้อความ "ยังไม่ได้ตั้งค่า"

---

## 1. สิ่งที่ต้องมีบน server

```bash
ssh <user>@<server>          # ต่อ VPN ก่อน
docker --version             # ต้องมี
docker compose version       # ต้องเป็น plugin v2 — ไม่รองรับ docker-compose v1
uname -m                     # x86_64 = linux/amd64 (จำไว้ใช้ตอน --mode image)
```

ถ้า user ยังรัน docker ไม่ได้: `sudo usermod -aG docker $USER` แล้ว logout/login ใหม่

### ถ้า `docker compose version` ไม่ผ่าน

Compose v2 เป็น **CLI plugin แยกต่างหาก** ไม่ได้ติดมากับ `docker` — แพ็กเกจ `docker.io`
ของ distro ส่วนใหญ่ไม่มีให้ นี่คือสาเหตุที่เจอบ่อยที่สุด

`docker-compose` v1 (ตัว Python) **ใช้แทนไม่ได้** ไม่ใช่เพราะเก่า แต่เพราะไฟล์ที่ไม่มีคีย์
`version:` จะถูก v1 อ่านเป็นฟอร์แมต v1 ที่ไม่รู้จักคีย์ `services:` ด้วยซ้ำ — จะพังแบบ
ดูเหมือน syntax error แทนที่จะบอกว่าเครื่องมือผิดตัว

**วิธีหลัก — static binary** (ไม่ต้อง sudo, ไม่ผูกกับ apt repo ของเครื่อง จึงใช้ได้แน่นอน
กว่า `apt`/`dnf` ซึ่งบางเครื่องไม่มีแพ็กเกจนี้ในซอร์สที่ตั้งไว้):

```bash
mkdir -p ~/.docker/cli-plugins
curl -fsSL -o ~/.docker/cli-plugins/docker-compose \
  "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)"
chmod +x ~/.docker/cli-plugins/docker-compose
docker compose version
```

`$(uname -m)` เลือกไฟล์ให้ตรง arch เอง (`x86_64` หรือ `aarch64`) ไม่ต้องเช็คเอง

**server ต่อเน็ตออกไม่ได้** — โหลดไฟล์เดียวกันที่เครื่องคุณแล้ว `scp` ขึ้นไปวางที่
`~/.docker/cli-plugins/docker-compose` (อย่าลืม `chmod +x`)

**มี sudo และอยากลองทาง package manager ก่อน** — ใช้ได้เฉพาะเมื่อ apt/dnf source ของ
เครื่องมีแพ็กเกจนี้จริง (`E: Unable to locate package` แปลว่าไม่มี ให้ใช้ static binary
ด้านบนแทน ไม่ต้องไปเพิ่ม repo ของ Docker เอง):

```bash
sudo apt-get update && sudo apt-get install -y docker-compose-plugin   # Debian/Ubuntu
sudo dnf install -y docker-compose-plugin                              # RHEL/Rocky/Alma
```

ต้องมีเพิ่ม: **nginx** (หรือ Caddy) สำหรับ terminate TLS และ **DNS/hosts** ที่ชี้ชื่อโดเมน
มาที่ server นี้

---

## 2. สิ่งที่คุณต้อง config เอง

### 2.1 Supabase → URL Configuration

**Authentication → URL Configuration** — สำคัญที่สุด ถ้าไม่ทำ ล็อกอินจะเด้งกลับ
`localhost:3000` แล้วค้าง

| ช่อง | ค่าที่ต้องใส่ |
|---|---|
| Site URL | `https://translate.example.ac.th` |
| Redirect URLs | `https://translate.example.ac.th/auth/callback` |

> เก็บ `http://localhost:3000/auth/callback` ไว้ใน Redirect URLs ด้วยได้ เพื่อให้ยัง
> พัฒนาบนเครื่องตัวเองได้ Supabase รองรับหลาย URL

โค้ดที่เกี่ยวข้องคือ [src/auth/AuthProvider.tsx:177](src/auth/AuthProvider.tsx#L177) ซึ่งส่ง
`redirectTo: ${window.location.origin}/auth/callback` — มันใช้ origin ที่ผู้ใช้เปิดจริง
ดังนั้นถ้า URL ที่ใช้งานจริงไม่ตรงกับที่ลงทะเบียนไว้ Supabase จะปฏิเสธ

### 2.2 Google Cloud Console → OAuth client

Authorized redirect URI ที่ Google ต้องรู้จักคือของ **Supabase** ไม่ใช่ของแอป:

```
https://<project-ref>.supabase.co/auth/v1/callback
```

ค่านี้ตั้งไว้ตั้งแต่ตอน setup ครั้งแรกแล้ว **ไม่ต้องแก้ตอน deploy** — โดเมนใหม่ของแอป
ไม่ต้องไปเพิ่มที่ Google เพราะ Google คุยกับ Supabase เท่านั้น

### 2.3 โดเมนอีเมลที่อนุญาต

ค่าเริ่มต้นคือ `chula.ac.th` (และ subdomain ทั้งหมด) ถ้าจะเปลี่ยน ต้องแก้ **สองที่ให้ตรงกัน**
มิฉะนั้น database จะปฏิเสธการลงทะเบียนทุกครั้ง:

1. `VITE_ALLOWED_EMAIL_DOMAIN` ใน `.env` บน server
2. constraint `access_requests_allowed_domain` ใน
   [supabase/schema.sql:56](supabase/schema.sql#L56) แล้วรัน SQL ใหม่

### 2.4 Gemini API key

ต้องเปิด billing บน Google Cloud/AI Studio project ที่ออก key นี้ — live session
คิดเงินตามเวลาจริง (~$2.20/ชั่วโมง) แอปมีเพดานกันลืมปิดให้แล้ว: หยุดเองเมื่อเงียบเกิน
15 นาที และตัดที่ 6 ชั่วโมงเสมอ (`src/asr/audio/sessionLimits.ts`)

### 2.5 อนุมัติบัญชีผู้ใช้

ผู้ใช้ใหม่ล็อกอินได้แต่จะเข้าคอนโซลไม่ได้จนกว่าจะอนุมัติ ที่ Supabase → SQL Editor:

```sql
update public.access_requests
   set status = 'approved', reviewed_at = now(), reviewed_by = 'you@chula.ac.th'
 where lower(email) = lower('someone@chula.ac.th');
```

---

## 3. Deploy ครั้งแรก

### 3.1 สร้าง `.env` บน server (ทำมือครั้งเดียว)

ไฟล์นี้**ไม่ถูกส่งขึ้นไปจากเครื่องคุณโดยตั้งใจ** เพราะมี Gemini key อยู่

```bash
ssh <user>@<server>
sudo mkdir -p /opt/live-translation && sudo chown $USER /opt/live-translation
nano /opt/live-translation/.env     # วางเนื้อหาจาก .env.deploy.example แล้วเติมค่า
chmod 600 /opt/live-translation/.env
exit
```

### 3.2 ตั้งค่าปลายทางบนเครื่องคุณ

```bash
cp deploy.conf.example deploy.conf
nano deploy.conf                    # ใส่ SSH_HOST และ REMOTE_DIR
```

### 3.3 ยิง deploy

```bash
./deploy.sh
```

สคริปต์จะ: รัน lint + test บนเครื่องคุณ → ตรวจว่า SSH/docker/`.env` บน server พร้อม →
rsync ซอร์ส → `docker compose up -d --build --wait` → ยิง `/api/health` ยืนยัน →
ลบ image เก่าทิ้ง ถ้าขั้นไหนพัง มันจะหยุดพร้อมบอกเหตุผล ไม่ deploy ครึ่งๆ กลางๆ

> **server ต่อเน็ตออกไม่ได้?** ใช้ `./deploy.sh --mode image` แทน — build บนเครื่องคุณ
> แล้วส่ง image ผ่าน SSH ไปเลย อย่าลืมตั้ง `DOCKER_PLATFORM` ให้ตรงกับ `uname -m`
> ของ server (Mac เป็น arm64, server ส่วนใหญ่เป็น amd64 — ถ้าผิดจะขึ้น
> "exec format error")

### 3.4 ตั้ง nginx

เช็คก่อนว่า nginx ติดตั้งอยู่บน server หรือยัง (ต่อจาก `ssh <user>@<server>` ในขั้นก่อนหน้า):

```bash
which nginx || echo "ยังไม่ได้ติดตั้ง"
ls /etc/nginx/conf.d/ 2>&1   # โฟลเดอร์นี้ต้องมีอยู่ก่อนถึงจะ mv ไฟล์ลงไปได้
```

ถ้ายังไม่มี ให้ติดตั้งก่อน — package จะสร้าง `/etc/nginx/conf.d/` มาให้เอง:

```bash
sudo apt-get update && sudo apt-get install -y nginx   # Debian/Ubuntu
sudo dnf install -y nginx                               # RHEL/Rocky/Alma
```

> Debian/Ubuntu บางรุ่นตั้ง vhost ผ่าน `/etc/nginx/sites-available` +
> `sites-enabled` แทน `conf.d` — ถ้า `ls /etc/nginx/` เห็น `sites-available` แต่ไม่มี
> `conf.d` ให้ใช้ path นั้นแทนในขั้นตอนถัดไปได้เลย (`conf.d` ก็ยังใช้งานได้ตามปกติบน
> Debian/Ubuntu เช่นกัน เพราะ nginx.conf โหลดทั้งสองโฟลเดอร์)

จากนั้นค่อยวาง config (บรรทัดแรกรันจาก**เครื่องคุณ**, ที่เหลือรันบน**server**):

```bash
scp deploy/nginx.conf.example <user>@<server>:/tmp/     # รันจากเครื่องคุณ
ssh <user>@<server>
sudo mv /tmp/nginx.conf.example /etc/nginx/conf.d/live-translation.conf
sudo nano /etc/nginx/conf.d/live-translation.conf   # แก้ server_name + path ของ cert
sudo nginx -t && sudo systemctl reload nginx
```

ไฟล์ตัวอย่างจัดการเรื่องที่ default ของ nginx จะทำพังไว้ให้แล้ว:

- **WebSocket upgrade** สำหรับ `/ws/gemini-live-transcribe`
- **`proxy_read_timeout 3600s`** บน WebSocket — default 60 วินาทีจะตัดสาย
  เมื่อในห้องประชุมเงียบเกินหนึ่งนาที เพราะ caption จะถูกส่งกลับก็ต่อเมื่อมีคนพูด
- **`client_max_body_size 5m`** — default 1m จะทำให้สรุปประชุมยาวๆ ได้ 413
- **`proxy_read_timeout 180s`** บน API — งานสรุปใช้เวลาได้ถึง 150 วินาที

---

## 4. Deploy ครั้งถัดไป

```bash
./deploy.sh                 # ปกติ
./deploy.sh --logs          # ดู log
./deploy.sh --skip-checks   # ข้าม test (ใช้เมื่อรีบจริงๆ)
```

### rollback

```bash
git checkout <commit-ก่อนหน้า>
./deploy.sh
```

image เก่าถูก prune ทิ้งทุกครั้ง จึงไม่มี tag ให้ย้อนกลับ — rollback คือ deploy ซอร์ส
เวอร์ชันเก่าใหม่อีกครั้ง ถ้าต้องการ rollback แบบเร็วกว่านั้น ให้เปลี่ยน `IMAGE_NAME`
ใน `deploy.conf` เป็น tag ตาม git sha แทน `latest`

---

## 5. ตรวจว่าใช้งานได้จริง

ไล่ตามลำดับนี้ — แต่ละข้อแยกปัญหาออกเป็นชั้นๆ

```bash
# 1. คอนเทนเนอร์
ssh <user>@<server> "cd /opt/live-translation && docker compose ps"
#    ต้องเห็น State = running (healthy)

# 2. แอป (ข้าม nginx)
ssh <user>@<server> "curl -s http://127.0.0.1:3000/api/health"
#    {"status":"ok"}

# 3. ผ่าน nginx + TLS
curl -s https://translate.example.ac.th/api/health
```

จากนั้นในเบราว์เซอร์: เปิดเว็บ → ล็อกอิน Google → ต้องเด้งกลับมาที่โดเมน production
(ไม่ใช่ localhost) → กดอัดเสียง → ต้องขึ้นขออนุญาตไมโครโฟน → พูดแล้วต้องเห็น caption

---

## 6. อาการที่เจอบ่อย

| อาการ | สาเหตุ | แก้ |
|---|---|---|
| หน้าเว็บบอก "ยังไม่ได้ตั้งค่า VITE_SUPABASE_..." | build โดยไม่ได้ส่ง build args | ตรวจ `.env` บน server แล้ว `docker compose up -d --build` |
| ล็อกอินแล้วเด้งไป `localhost:3000` | ไม่ได้ใส่ URL production ใน Supabase | หัวข้อ 2.1 |
| ล็อกอินแล้วขึ้น "redirect_uri is not allowed" | URL ไม่ตรงกับที่ลงทะเบียน (เช่นมี/ไม่มี `www`) | หัวข้อ 2.1 ให้ตรงเป๊ะ |
| กดอัดแล้ว error สิทธิ์ไมโครโฟน | เปิดผ่าน HTTP ไม่ใช่ HTTPS | หัวข้อ 0 |
| caption หลุดทุกๆ ~1 นาทีตอนเงียบ | `proxy_read_timeout` ของ nginx | หัวข้อ 3.4 |
| WebSocket ปิดทันทีด้วย 401 | บัญชียัง `pending` หรือ token หมดอายุ | หัวข้อ 2.5 / ล็อกอินใหม่ |
| ทุก request ตอบ 503 "authentication is not configured" | `SUPABASE_URL`/`SUPABASE_ANON_KEY` ไม่ถึงคอนเทนเนอร์ | ตรวจ `.env` แล้ว `docker compose up -d` |
| สรุปประชุมได้ 413 | `client_max_body_size` | หัวข้อ 3.4 |
| container restart วนไม่หยุด | `docker compose logs app` จะบอกเหตุผลตรงๆ | ดู log |

log ของ server:

```bash
./deploy.sh --logs
# หรือบน server: docker compose logs -f --tail=200 app
```

---

## ยังไม่มี TLS — ใช้ SSH tunnel ไปก่อน

ใช้ได้กับผู้ใช้ทีละคนที่ SSH เข้า server ได้ เหมาะกับช่วงทดสอบ ไม่เหมาะกับการใช้งานจริง
ทั้งองค์กร

```bash
ssh -L 3000:127.0.0.1:3000 <user>@<server>
# แล้วเปิด http://localhost:3000 บนเครื่องตัวเอง
```

ไมโครโฟนทำงานได้เพราะเบราว์เซอร์นับ `localhost` เป็น secure context
ต้องเพิ่ม `http://localhost:3000/auth/callback` ใน Supabase → Redirect URLs ด้วย

---

## หมายเหตุ

- **แอปไม่มี state ในตัว** — transcript, glossary, project ทั้งหมดอยู่ใน Supabase
  ลบคอนเทนเนอร์ทิ้งได้โดยไม่เสียข้อมูล และไม่ต้องทำ backup ของ server เครื่องนี้
- **image ขนาด ~435MB** ส่วนใหญ่คือ dependency ของ front end ที่ vite bundle ลง
  `dist/assets` ไปแล้วแต่ยังติดมากับ `npm ci --omit=dev` ตัดออกได้อีกแต่จะเปราะ
  จึงเลือกความถูกต้องไว้ก่อน
- **`APP_URL` ใน `.env.example` เดิมเป็นค่าที่ไม่มีโค้ดไหนอ่าน** — ไม่ต้องตั้ง
- คอนเทนเนอร์เปิดพอร์ตไว้ที่ `127.0.0.1` เท่านั้น เข้าถึงได้ผ่าน nginx ทางเดียว
  ถ้าเปลี่ยนเป็น `0.0.0.0` docker จะเจาะ firewall ของ host ให้เองโดยไม่ถามด้วย
