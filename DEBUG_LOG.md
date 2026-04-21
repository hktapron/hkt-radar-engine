# 🛰️ HKT Radar Engine — Debug Log

> บันทึกการแก้บั๊ก / การเปลี่ยนโครงสร้างทุกครั้ง
> **กฎ:** อ่านไฟล์นี้ก่อนเริ่มงานทุกครั้ง + อัปเดตทุกครั้งหลังแก้เสร็จ

---

## 2026-04-21

### Bug Investigation Phase
- วิเคราะห์ bug ทั้งหมดในระบบ radar-engine ได้ 12 รายการ (2 critical / 4 major / 6 minor)
- รายละเอียดเต็มอยู่ใน session history
- **ตัดสินใจ defer:** Bug #1 (API key hardcoded) — ปัจจุบันข้อมูลยังไม่ sensitive, จะปิดเป็นความลับเมื่อเชื่อม ACDM ในอนาคต
- **ตัดสินใจ skip:** Bug #5 (rate limit sliding window) — endpoint เป็น in-memory read อย่างเดียว, burst ที่ boundary ไม่กระทบ server, ไม่คุ้มที่จะเพิ่ม complexity

### ✅ Bug #2 — Unified IATA casing (response shape consistency)
**Files:** `index.js`
**What changed:**
- Line 286 (คือตอน AIBT stalling count ยังไม่ครบ): `iata: iata` → `IATA: iata`
- Line 291 (คือตอน flight ยังไม่นิ่งที่ gate): `iata: iata` → `IATA: iata`
- Line 415 (คือตอน TAXIING state): `iata: iata` → `IATA: iata`

**Why:** ก่อนหน้านี้ response บางจุดใช้ `IATA` (ใหญ่) บางจุดใช้ `iata` (เล็ก) ทำให้ consumer ต้องเขียน `data.IATA || data.iata` ทุกที่
**Impact:** ตอนนี้ AMS ยังไม่เชื่อมต่อ radar-engine → fix ปลอดภัย 100% ไม่ต้อง coordinate
**Verification:** `grep "\biata:"` ใน index.js = 0 matches ✅

### ✅ Bug #4 — Memory purge moved to dedicated interval
**Files:** `index.js`
**What changed:**
- ลบ purge logic (`if (now - info.lastSeen > PURGE_THRESHOLD) ... delete(id)`) ออกจาก `if (isGroundScan)` block
- เพิ่ม `setInterval` ใหม่ทุก 5 นาที (ชื่อ `TRACKING_PURGE_INTERVAL`)
- ใช้ `processLock` pattern เดิม เพื่อไม่ race กับ `processFlightData`
- เพิ่ม log เวลามี purge จริง: `🧹 Tracking Purge: Cleared X arrivals + Y departures (stale >1h)`

**Why:** ก่อนหน้านี้ purge รันเฉพาะตอน ground scan — ถ้า FR24 ground fetch ล้มต่อเนื่อง, `trackedArrivals` และ `trackedDepartures` จะโตเรื่อยๆ จน RAM บน Render เต็ม
**Impact:** ไม่กระทบ logic detection ใดๆ, Ghost Arrival detection ยังทำงานใน ground scan เหมือนเดิม
**Verification:** pending — ต้อง syntax check + manual test

### ✅ Bug #3 — Null guards for speed / altitude
**Files:** `index.js`
**What changed:**
- `flight.altitude ?? 0` แทนทุกจุดที่ใช้ altitude เปรียบเทียบ (touchdown detection, recovery check)
- `spd = flight.speed ?? 0` ใน AIBT stalling check
- `dspd = flight.speed ?? 0` ใน departure discovery + isConfident shield
**Why:** `undefined < N` = false ใน JS → ถ้า FR24 ส่ง payload ไม่ครบ, touchdown/pushback ไม่ถูก detect

### ✅ Bug #6 — pollGroup overlap guard
**Files:** `index.js`
**What changed:**
- เพิ่ม `const pollRunning = new Set()` ระดับ module
- ต้นทาง `pollGroup`: ถ้า group อยู่ใน set → skip + log แล้ว return
- `finally` block: `pollRunning.delete(groupName)` เสมอ
**Why:** ถ้า FR24 ช้า >8s, pollGroup อันใหม่เด้งซ้อน → เปลืองโควตา FR24 upstream

### ✅ Bug #7 — Dedupe getDistance
**Files:** `index.js`, `hkt_stands.js`
**What changed:**
- Export `getDistance` จาก `hkt_stands.js`
- Import ใน `index.js`: `const { getStandInfo, getDistance, STANDS } = require('./hkt_stands')`
- ลบ `getDistance` definition ออกจาก `index.js`
**Why:** ฟังก์ชันเดิมซ้ำ 2 ที่ → ถ้าแก้สูตรด้านเดียว logic drift

### ✅ Bug #8 — console.error in error paths
**Files:** `index.js`
**What changed:**
- Line เดิม: `console.log('⚠️ ... radar check failed')` → `console.error(...)`
**Why:** Render log monitoring filter on error level จะไม่เจอ warning ถ้าใช้ log

### ✅ Bug #9 — CORS whitelist via env var
**Files:** `index.js`
**What changed:**
- `app.use(cors())` → `app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }))`
**Why:** ตอนนี้ '*' เหมือนเดิม แต่พร้อม tighten ได้ทันทีโดยตั้ง env var `ALLOWED_ORIGIN` บน Render

### ✅ Bug #10 — Graceful shutdown (SIGTERM/SIGINT)
**Files:** `index.js`
**What changed:**
- `app.listen(...)` → `const server = app.listen(...)`
- เพิ่ม `shutdown()` function + `process.on('SIGTERM')` + `process.on('SIGINT')`
- Timeout 10s force-exit ถ้า drain ไม่เสร็จ
**Why:** Render restart = request ค้างถูกตัด, graceful shutdown ให้ drain ก่อน

### ✅ Bug #11 — .catch on initial pollGroup calls
**Files:** `index.js`
**What changed:**
- `pollGroup(...).catch(err => console.error(...))`  ทั้ง APPROACH และ GROUND initial call
**Why:** Unhandled promise rejection ถ้า throw ตอน startup

### ✅ Bug #12 — lat/lon null guard before getStandInfo
**Files:** `index.js`
**What changed:**
- เพิ่ม `if (flight.latitude == null || flight.longitude == null) continue;` ก่อน `getStandInfo`
**Why:** `getStandInfo(null, null)` ให้ NaN distance → isInsideGate = false → logic เพี้ยนเงียบๆ

### 📌 Version
- Bumped: `v10.6` → `v10.7` (index.js startup banner + `/api/health` response)

---

## 2026-04-21 (Hotfix — Recheck Round)

### 🔴 REGRESSION FIX — Bug #3 touchdown detection (line 252)
**Files:** `index.js`
**Problem found in recheck:** ใช้ `flight.altitude ?? 0` ทำให้ altitude missing → alt=0 → `0 < 100` = true + `0 < 500` = true → TOUCHDOWN ยิงเสมอแม้เครื่องยังบินอยู่
**Fix:** เปลี่ยนเป็น `flight.altitude ?? Infinity` — `Infinity < 100` = false, `Infinity < 500` = false → behavior เหมือนเดิมตอน altitude ขาดข้อมูล (ไม่ยิง)
**Note:** Line 244 (`?? 0` สำหรับ `> 1500`) ยังถูกต้อง — `0 > 1500` = false เหมือนกัน

### 🟡 Bug #8 — ยังเหลือ console.log อีก 1 จุด (line 424)
**Files:** `index.js`
**Fix:** `console.log('⚠️ Error processing ...')` → `console.error(...)`
**Note:** รอบแรกเห็นแค่ line 127 miss line 424 ไป

### 📌 7 จุดที่เหลือ (ตัดสินใจ NOT fix)
Lines 218, 343, 344, 355, 373, 396, 443 — ยังมี `flight.speed`/`flight.altitude` ที่ไม่ได้ guard
**Decision:** ปล่อย fallback เป็น false ไว้ — ในระบบ radar miss detection เงียบๆ ดีกว่า false positive
ไม่ใช่ regression (behavior เหมือนก่อนแก้), ไม่กระทบ Logic Locks

---

---
