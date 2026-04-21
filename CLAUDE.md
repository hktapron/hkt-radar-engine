# 🛰️ HKT Radar Engine (A-CDM Integrator)

## Project Purpose
ไมโครเซอร์วิส (Node.js) ที่ทำหน้าที่หลักในการดึงข้อมูลจาก Flightradar24 (JSON Metadata) มาประมวลผลผ่าน "Geofence State Machine" เพื่อคำนวณหาเวลาจอด (AIBT) และเวลาดันถอย (AOBT) ของเครื่องบินที่สนามบินภูเก็ต (HKT) อย่างแม่นยำระดับวินาที และป้องกันข้อมูลรบกวน (Jitter) จากสัญญาณเรดาร์

## Tech Stack
- **Backend:** Node.js, Express
- **Data Source:** `fetch` ข้อมูล JSON ตรงจาก FR24 (ไม่ใช้ Headless Browser ป้องกันแรมบวม)
- **Deployment:** Render (Cloud)

## Core Logic & Architecture
ดูตรรกะการประมวลผลขั้นสูง (Geofence Lock, The First Step) ทั้งหมดแบบละเอียดได้ที่ไฟล์ `MASTER_GUIDELINES.md` ในโฟลเดอร์นี้
