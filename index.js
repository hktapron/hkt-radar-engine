const express = require('express');
const cors = require('cors');
const { fetchFromRadar, fetchFlight } = require('flightradar24-client');
const { getStandInfo, getDistance, STANDS } = require('./hkt_stands');

const app = express();
const PORT = process.env.PORT || 3001;

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // Bug #9: set ALLOWED_ORIGIN env var to tighten in production
app.use(cors({ origin: ALLOWED_ORIGIN }));

// v9.6: Rate Limiting (30 requests/min per IP — no library needed)
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW = 60000; // 1 minute
setInterval(() => rateLimitMap.clear(), RATE_LIMIT_WINDOW);

app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const count = (rateLimitMap.get(ip) || 0) + 1;
    rateLimitMap.set(ip, count);
    if (count > RATE_LIMIT_MAX) {
        return res.status(429).json({ error: 'Too many requests. Try again in 1 minute.' });
    }
    next();
});

// v9.6: Crash Guard — Prevents total process death from unexpected errors
process.on('uncaughtException', (err) => {
    console.error(`[${new Date().toISOString()}] 💀 UNCAUGHT EXCEPTION: ${err.message}`);
    console.error(err.stack);
    // Don't exit — let the engine keep running
});
process.on('unhandledRejection', (reason) => {
    console.error(`[${new Date().toISOString()}] 💀 UNHANDLED REJECTION: ${reason}`);
    // Don't exit — let the engine keep running
});

/**
 * API Timeout Wrapper: Prevents engine from hanging on slow FR24 responses
 */
async function withTimeout(promise, ms = 30000, label = 'API') {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} Timeout`)), ms));
    return Promise.race([promise, timeout]);
}

/**
 * v8.5 Helper: Strips leading zeros from numeric part of flight numbers/callsigns
 * Examples: JQ071 -> JQ71, WK051 -> WK51
 */
function normalizeFlightNumber(str) {
    if (!str) return '';
    return str.replace(/([A-Z]+)0+([1-9]\d*)/i, '$1$2').toUpperCase();
}

// Helper: Convert Server Timestamp (Unix ms) or Date to ISO +07:00
function getHktTime(input) {
    const date = (typeof input === 'number' && input < 2000000000) ? new Date(input * 1000) : new Date(input || Date.now());
    if (isNaN(date.getTime())) return null;
    const hkt = new Date(date.getTime() + (7 * 60 * 60 * 1000));
    return hkt.toISOString().replace(/\.\d{3}Z$/, "+07:00");
}

let flightDataCache = [];
let lastFetchTime = null;

// Persistence maps: flightId -> { data: {Callsign, IATA, ...}, expiry: timestamp }
const recentEvents = new Map(); 

const reportedArrivals = new Set(); // Prevent duplicate firing
const reportedDepartures = new Set();
const trackedArrivals = new Map(); // id -> { callsign, iata, state, ata, lastETA, lastPos, stallingCount, lastSeen }
const trackedDepartures = new Map(); // id -> { callsign, iata, state, aobt, lockedStand, lastSeen, stallingCount }

const APPROACH_INTERVAL = 30000;     
const GROUND_INTERVAL = 8000;        
const EVENT_PERSISTENCE_TTL = 10 * 60 * 1000; 
const PURGE_THRESHOLD = 60 * 60 * 1000; // 1 hour: Clear inactive memory

// v9.9 Dynamic Thresholds (Stability First)
const AIBT_STABLE_REQUIRED = 2;      
const AOBT_MOVEMENT_THRESHOLD = 45;  
const AOBT_ZERO_SPEED_THRESHOLD = 55; 
const AOBT_MIN_DISPLACEMENT = 15;     
const AOBT_STABLE_REQUIRED = 5;      

// v8.5-8.9 Configs
const CARRIER_WHITELIST = ['JQ', 'WK', 'JST', 'EDW'];
const BLACKLIST_CALLSIGNS = ['SITEMON', 'VTSPTWR', 'VTSPGND', 'TWR', 'GND'];

// Contiguous Approach Zones
const APPROACH_ZONES = [
    { name: 'HKT-Approach-North', north: 9.5, west: 97.0, south: 8.11, east: 99.5, options: {} },
    { name: 'HKT-Approach-South', north: 8.12, west: 97.0, south: 6.5, east: 99.5, options: {} },
];

const GROUND_ZONES = [
    { name: 'HKT-Full-Ground', north: 8.125, west: 98.295, south: 8.090, east: 98.345, options: { onGround: true, inactive: true } },
];

// getDistance is imported from hkt_stands.js (single source of truth)

const pollRunning = new Set(); // Bug #6: prevent overlapping polls per group

async function pollGroup(zones, groupName) {
    if (pollRunning.has(groupName)) {
        console.log(`[${new Date().toISOString()}] ⏭️  Loop [${groupName}] skipped — previous poll still running`);
        return;
    }
    pollRunning.add(groupName);
    try {
        const now = new Date().getTime();
        const flightMap = new Map();
        
        for (const zone of zones) {
            try {
                const flights = await withTimeout(fetchFromRadar(zone.north, zone.west, zone.south, zone.east, null, zone.options), 30000, `Radar-${zone.name}`);
                for (const f of flights) {
                    flightMap.set(f.id, f);
                }
                await new Promise(resolve => setTimeout(resolve, 200)); 
            } catch (err) {
                console.error(`  ⚠️ ${zone.name} radar check failed: ${err.message}`);
            }
        }

        await processFlightData(Array.from(flightMap.values()), now, groupName === 'GROUND');

        // v9.0 Clean Logs (Removed #Count)
        const totalTracking = trackedArrivals.size + trackedDepartures.size;
        console.log(`[${new Date().toISOString()}] Loop [${groupName}] | Active: ${totalTracking} | Found: ${flightMap.size} | Cache: ${recentEvents.size}`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Loop [${groupName}] Fatal Error: ${error.message}`);
    } finally {
        pollRunning.delete(groupName); // Bug #6: always release lock
    }
}

// v9.1: Processing Lock — Prevents GROUND and APPROACH from interleaving
let processLock = Promise.resolve();

async function processFlightData(allFlights, now, isGroundScan) {
    const ticket = processLock;
    let releaseLock;
    processLock = new Promise(resolve => { releaseLock = resolve; });
    await ticket;

    try {
    const responseData = new Map();
    const seenInThisPoll = new Set();
    
    // Add current history items to response first
    for (const [id, entry] of recentEvents.entries()) {
        if (now > entry.expiry) {
            recentEvents.delete(id);
        } else {
            responseData.set(id, entry.data);
        }
    }

    const detailPromises = [];

    for (const flight of allFlights) {
        const origin = (flight.origin || "").toUpperCase();
        const destination = (flight.destination || "").toUpperCase();
        const fRawTimestamp = (flight.timestamp || Math.floor(now / 1000)) * 1000;
        
        const isFutureTime = (fRawTimestamp > now + 30000);
        const fTimestamp = isFutureTime ? now : fRawTimestamp;

        // v8.9: Improved identification (Registration fallback)
        const callsign = flight.callsign || flight.flight || flight.registration || 'UNKNOWN';
        const normCallsign = normalizeFlightNumber(callsign);
        
        // v8.8 Filter: Ignore non-aircraft transponders (Tower/SITEMON)
        if (BLACKLIST_CALLSIGNS.includes(normCallsign)) continue;

        const isWhitelisted = CARRIER_WHITELIST.some(prefix => normCallsign.startsWith(prefix));

        // Bug #12: Skip flights with missing coordinates — getStandInfo would return NaN distances
        if (flight.latitude == null || flight.longitude == null) continue;

        // v10.6 Geofence Lock: If physically at a gate during a ground scan, prioritize DEPARTURE.
        // This prevents whitelisted flights from being hijacked by 'destination: HKT' metadata while pushing back.
        const standInfo = getStandInfo(flight.latitude, flight.longitude);
        const isInsideGate = (isGroundScan && standInfo.distance < standInfo.radius);

        let isPhuketDeparture = (isGroundScan && flight.isOnGround) || (origin === "HKT") || (flight.isOnGround && destination !== "" && destination !== "HKT");
        let isPhuketArrival = (destination === "HKT") || (isGroundScan && isWhitelisted && !isInsideGate);
        
        // v10.6 Mastery: Force Departure state for whitelisted aircraft discovered at a gate
        if (isGroundScan && isWhitelisted && isInsideGate) {
            isPhuketDeparture = true;
            isPhuketArrival = false;
        }

        // v9.4: Strict Stickiness (State Lock). Prevent hijacking for flights already in mid-process!
        if (trackedDepartures.has(flight.id)) {
            isPhuketArrival = false;
            isPhuketDeparture = true;
        } else if (trackedArrivals.has(flight.id)) {
            isPhuketDeparture = false;
            isPhuketArrival = true;
        }
        
        if (!isPhuketDeparture && !isPhuketArrival) continue;

        // v10.5: Turnaround Handover Logic
        // If the ID was already reported as an Arrival, only allow it to proceed if it is NOW a Departure 
        // AND it is still safely stationary at a gate (to prevent takeover during landing roll).
        const hasFinishedArrival = reportedArrivals.has(flight.id);
        const hasFinishedDeparture = reportedDepartures.has(flight.id);

        if (hasFinishedDeparture) continue; // v10.5: Never re-track a departure session that already finished.

        if (hasFinishedArrival) {
            const standInfo = getStandInfo(flight.latitude, flight.longitude);
            const isStationaryTurnaround = (flight.speed < 5) && (standInfo.distance < (standInfo.radius + 10));
            
            // Bypass the arrival block if it's explicitly a departure now and stationary at gate
            if (isPhuketDeparture && isStationaryTurnaround && origin === "HKT") {
                isPhuketArrival = false; // Force departure track
            } else {
                continue; // Block duplicate arrivals or pre-mature turnovers
            }
        }

        const iata = flight.flight || flight.registration || 'UNKNOWN';

        try {
            if (isPhuketArrival) {
                seenInThisPoll.add(flight.id);
                if (!trackedArrivals.has(flight.id)) {
                    trackedArrivals.set(flight.id, { 
                        callsign, iata, state: 'AIRBORNE', ata: null, lastETA: null, lastPos: null, stallingCount: 0, lastSeen: fTimestamp, firstAIBT: null 
                    });
                }
                const info = trackedArrivals.get(flight.id);
                if (!info) continue; // v9.8.1 Safety Guard

                info.lastSeen = fTimestamp;
                info.lastPos = { lat: flight.latitude, lon: flight.longitude, speed: flight.speed, ts: fTimestamp };

                if (info.state === 'LANDED' && (flight.altitude ?? 0) > 1500) {
                    console.log(`  ♻️ ${callsign} RECOVERY: Resetting to AIRBORNE (Altitude: ${flight.altitude}ft)`);
                    info.state = 'AIRBORNE';
                    info.ata = null;
                    recentEvents.delete(flight.id);
                }

                if (info.state === 'AIRBORNE') {
                    const alt = flight.altitude ?? 0; // Bug #3: treat missing altitude as ground-level
                    if (!isFutureTime && (flight.isOnGround || alt < 100) && alt < 500) {
                        info.state = 'LANDED';
                        info.ata = getHktTime(fTimestamp);
                        console.log(`  [EVENT] [M13] 🛬 ${callsign} TOUCHDOWN (ATA: ${info.ata})`);
                    } else if (!isGroundScan) {
                        detailPromises.push((async () => {
                            try {
                                const detail = await withTimeout(fetchFlight(flight.id), 30000, `ArrivalDetail-${callsign}`);
                                info.lastETA = detail.arrival || detail.scheduledArrival || null;
                            } catch (e) {}
                        })());
                    }
                    if (!info.ata) {
                        responseData.set(flight.id, { Callsign: callsign, IATA: iata, ETA: getHktTime(info.lastETA) });
                    }
                } 
                
                if (info.state === 'LANDED') {
                    const standInfo = getStandInfo(flight.latitude, flight.longitude);
                    const spd = flight.speed ?? 0; // Bug #3: treat missing speed as stationary
                    if (spd <= 1.0 && standInfo.distance < standInfo.radius) {
                        info.stallingCount = (info.stallingCount || 0) + 1;
                        console.log(`  [EVENT] ${callsign}: Stalling ${info.stallingCount}/${AIBT_STABLE_REQUIRED} (AIBT-Count | Dist: ${standInfo.distance.toFixed(1)}m | Spd: ${spd})`);
                        // v9.9: Back-dating (Capture first appearance)
                        if (info.stallingCount === 1) info.firstAIBT = fTimestamp;
                        
                        if (info.stallingCount >= AIBT_STABLE_REQUIRED) {
                            const aibtTS = info.firstAIBT || fTimestamp;
                            const aibt = getHktTime(aibtTS);
                            const eventData = { Callsign: callsign, IATA: iata, ATA: info.ata, AIBT: aibt, Stand: standInfo.stand };
                            responseData.set(flight.id, eventData);
                            recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                            reportedArrivals.add(flight.id);
                            trackedArrivals.delete(flight.id);
                            console.log(`  [EVENT] [M14] 🛑 ${callsign} PARKED (AIBT: ${aibt}) | Stand: ${standInfo.stand} (Radius: ${standInfo.radius}m)`);
                        } else {
                            responseData.set(flight.id, { Callsign: callsign, IATA: iata, ATA: info.ata });
                        }
                    } else {
                        info.stallingCount = 0;
                        info.firstAIBT = null;
                        responseData.set(flight.id, { Callsign: callsign, IATA: iata, ATA: info.ata });
                    }
                }
            } else if (isPhuketDeparture) {
                seenInThisPoll.add(flight.id);
                // v9.8: Speed Guard (Discovery). Ignore high-speed runway rolls for pushback tracking.
                const dspd = flight.speed ?? 0; // Bug #3: treat missing speed as stationary
                if (!trackedDepartures.has(flight.id) && (dspd < 30)) {
                    const standInfo = getStandInfo(flight.latitude, flight.longitude);
                    // v10.4 Tuned Confidence Shield:
                    // 1. If right at the gate center (<30m): Allow higher jitter speed (12kts) — Fixes FD3159
                    // 2. If intermediate (30-50m): Strict 5kts rule applies.
                    const isConfident = (standInfo.distance < 30 && dspd < 12) || (standInfo.distance < 50 && dspd < 5);
                    
                    if (isConfident) {
                        trackedDepartures.set(flight.id, { 
                            callsign, iata, state: 'PARKED', aobt: null, 
                            lockedStand: standInfo, 
                            originLat: flight.latitude, originLon: flight.longitude, 
                            lastSeen: fTimestamp, stallingCount: 0, firstAOBT: null,
                            firstMoveTS: null // v10.4 tracking
                        });
                    } else {
                        // Discovered mid-taxi or metadata late. Skip M11 (AOBT) for data integrity.
                        trackedDepartures.set(flight.id, { 
                            callsign, iata, state: 'TAXIING', aobt: null, 
                            lockedStand: null, 
                            originLat: flight.latitude, originLon: flight.longitude, 
                            lastSeen: fTimestamp, stallingCount: 0, firstAOBT: null,
                            firstMoveTS: null
                        });
                        console.log(`  [EVENT] ${callsign} discovered mid-taxi (${flight.speed}kts). Skipping AOBT tracking.`);
                    }
                }
                const info = trackedDepartures.get(flight.id);
                if (!info) continue; // v9.8.1 Safety Guard

                if (info.state === 'PARKED') {
                    const currentStand = getStandInfo(flight.latitude, flight.longitude);
                    let displacement = 0;
                    
                    // v10.0: Relative Movement Tracking. Measure move distance from origin, not stand center.
                    if (info.originLat && info.originLon) {
                        displacement = getDistance(flight.latitude, flight.longitude, info.originLat, info.originLon);
                    } else {
                        displacement = (info.lockedStand) ? getDistance(flight.latitude, flight.longitude, info.lockedStand.lat, info.lockedStand.lon) : currentStand.distance;
                    }

                    // AOBT (v8.2-v8.7 Balance): Anti-Drift Thresholds
                    const isMovingFast = (flight.speed >= 1.5 && displacement > AOBT_MIN_DISPLACEMENT);
                    const isMovingNormal = (flight.speed >= 0.8 && displacement > AOBT_MOVEMENT_THRESHOLD);
                    const isMovingZeroSpeed = (displacement > AOBT_ZERO_SPEED_THRESHOLD); 

                    // v10.4: Origin-Relative Precision Capturing
                    if (displacement >= AOBT_MIN_DISPLACEMENT && !info.firstMoveTS) {
                        info.firstMoveTS = fTimestamp; // Record the "First Step"
                    } else if (displacement < 10) {
                        info.firstMoveTS = null; // Snapback Reset (Jitter protection)
                    }

                    // v9.8: Speed Guard (Transition). A real pushback/initial taxi won't be > 30 knots.
                    if (flight.isOnGround && (isMovingFast || isMovingNormal || isMovingZeroSpeed) && (flight.speed < 30)) {
                        info.stallingCount = (info.stallingCount || 0) + 1;
                        console.log(`  [EVENT] ${callsign}: Moving ${info.stallingCount}/${AOBT_STABLE_REQUIRED} (AOBT-Count | Dist: ${displacement.toFixed(1)}m | Spd: ${flight.speed})`);
                        // v9.9: Back-dating (Capture first movement)
                        if (info.stallingCount === 1) info.firstAOBT = fTimestamp;

                        if (info.stallingCount >= AOBT_STABLE_REQUIRED || displacement > 60) {
                            info.state = 'TAXIING';
                            // v10.4: Triple Back-dating (Prioritize FirstStepTS > BackdateTS > CurrentTS)
                            const aobtTS = info.firstMoveTS || info.firstAOBT || fTimestamp;
                            info.aobt = getHktTime(aobtTS);
                            const standNr = info.lockedStand ? info.lockedStand.stand : currentStand.stand;
                            const eventData = { Callsign: callsign, IATA: iata, AOBT: info.aobt, Stand: standNr };
                            responseData.set(flight.id, eventData);
                            recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                            console.log(`  [EVENT] [M11] 🚜 ${callsign} PUSHBACK detected (Move: ${displacement.toFixed(1)}m, Spd: ${flight.speed}) (AOBT: ${info.aobt}) | Stand: ${standNr}`);
                        }
                    } else if (!flight.isOnGround) {
                        if (flight.altitude < 15000 && flight.altitude > 0) {
                            info.state = 'AIRBORNE';
                            const atd = getHktTime(fTimestamp);
                            detailPromises.push((async () => {
                                try {
                                    const detail = await withTimeout(fetchFlight(flight.id), 30000, `GhostPushback-${callsign}`);
                                    const actualDepTs = (detail.departure && detail.departure < fRawTimestamp / 1000) ? detail.departure : (info.lastSeen / 1000);
                                    info.aobt = getHktTime(actualDepTs);
                                    const standNr = info.lockedStand ? info.lockedStand.stand : 'UNKNOWN';
                                    console.log(`  [EVENT] [M11] 👻 ${callsign} GHOST PUSHBACK (Gate-Lock Source) (AOBT: ${info.aobt}) | Stand: ${standNr}`);
                                    const eventData = { Callsign: callsign, IATA: iata, AOBT: info.aobt, ATD: atd, Stand: standNr };
                                    responseData.set(flight.id, eventData);
                                    recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                                } catch (e) {
                                    info.aobt = getHktTime(info.lastSeen);
                                    const standNr = info.lockedStand ? info.lockedStand.stand : 'UNKNOWN';
                                    console.log(`  [EVENT] [M11] 👻 ${callsign} GHOST PUSHBACK (Fallback Source) (AOBT: ${info.aobt}) | Stand: ${standNr}`);
                                    const eventData = { Callsign: callsign, IATA: iata, AOBT: info.aobt, ATD: atd, Stand: standNr };
                                    responseData.set(flight.id, eventData);
                                    recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                                }
                            })());
                            reportedDepartures.add(flight.id);
                        } else if (flight.altitude > 15000) {
                            reportedDepartures.add(flight.id);
                            trackedDepartures.delete(flight.id);
                        }
                    } else {
                        info.stallingCount = 0;
                        info.firstAOBT = null;
                        if (currentStand.distance < currentStand.radius) {
                            info.lastSeen = fTimestamp;
                        }
                    }
                } else if (info.state === 'TAXIING') {
                    if (!flight.isOnGround) {
                        info.state = 'AIRBORNE';
                        const atd = getHktTime(fTimestamp);
                        const standNr = info.lockedStand ? info.lockedStand.stand : 'UNKNOWN';
                        const eventData = { Callsign: callsign, IATA: iata, AOBT: info.aobt, ATD: atd, Stand: standNr };
                        responseData.set(flight.id, eventData);
                        recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                        reportedDepartures.add(flight.id);
                        trackedDepartures.delete(flight.id);
                        console.log(`  [EVENT] [M12] 🛫 ${callsign} TOOK OFF (AOBT: ${info.aobt} | ATD: ${atd}) | Stand: ${standNr}`);
                    } else {
                        responseData.set(flight.id, { Callsign: callsign, IATA: iata, AOBT: info.aobt });
                    }
                }
            }
        } catch (err) {
            console.log(`  ⚠️ Error processing ${callsign}: ${err.message}`);
        }
    }
    
    // Wait for all detail/ETA requests to finish in parallel
    if (detailPromises.length > 0) {
        await Promise.all(detailPromises);
    }

    // Ground persistence logic (Arrival Ghosts)
    // v10.7: Purge logic moved to dedicated interval — this block keeps only detection logic
    if (isGroundScan) {
        for (const [id, info] of trackedArrivals.entries()) {
            if (seenInThisPoll.has(id)) continue;
            if (info.state === 'LANDED') {
                 const lastPos = info.lastPos;
                 if (lastPos) {
                     const standInfo = getStandInfo(lastPos.lat, lastPos.lon);
                     // v10.3: Tightened Ghost Arrival buffer (radius + 15m) for more precision.
                     if (standInfo.distance < (standInfo.radius + 15) && lastPos.speed < 5) {
                         const aibt = getHktTime(lastPos.ts);
                         const eventData = { Callsign: info.callsign, IATA: info.iata, ATA: info.ata, AIBT: aibt, Stand: standInfo.stand };
                         responseData.set(id, eventData);
                         recentEvents.set(id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                         reportedArrivals.add(id);
                         trackedArrivals.delete(id);
                         console.log(`  [EVENT] [M14] 👻 ${info.callsign} GHOST ARRIVAL (AIBT: ${aibt}) | Stand: ${standInfo.stand}`);
                     }
                 }
            }
        }
    }

    flightDataCache = Array.from(responseData.values());
    lastFetchTime = new Date();

    } finally { releaseLock(); } // v9.1: Release processing lock
}

// v9.5: Memory Purge — Clear stale IDs every 3 days to prevent memory leak
const MEMORY_PURGE_INTERVAL = 3 * 24 * 60 * 60 * 1000; // 3 days
setInterval(() => {
    const beforeA = reportedArrivals.size;
    const beforeD = reportedDepartures.size;
    reportedArrivals.clear();
    reportedDepartures.clear();
    console.log(`[${new Date().toISOString()}] 🧹 Memory Purge: Cleared ${beforeA} arrivals + ${beforeD} departures`);
}, MEMORY_PURGE_INTERVAL);

// v10.7: Stale Tracking Purge — Runs independently of ground scan so maps don't leak if
// ground fetches fail. Uses processLock to avoid racing with processFlightData.
const TRACKING_PURGE_INTERVAL = 5 * 60 * 1000; // 5 minutes
setInterval(async () => {
    const ticket = processLock;
    let releaseLock;
    processLock = new Promise(resolve => { releaseLock = resolve; });
    await ticket;
    try {
        const now = Date.now();
        let purgedA = 0, purgedD = 0;
        for (const [id, info] of trackedArrivals.entries()) {
            if (now - info.lastSeen > PURGE_THRESHOLD) { trackedArrivals.delete(id); purgedA++; }
        }
        for (const [id, info] of trackedDepartures.entries()) {
            if (now - info.lastSeen > PURGE_THRESHOLD) { trackedDepartures.delete(id); purgedD++; }
        }
        if (purgedA + purgedD > 0) {
            console.log(`[${new Date().toISOString()}] 🧹 Tracking Purge: Cleared ${purgedA} arrivals + ${purgedD} departures (stale >1h)`);
        }
    } finally { releaseLock(); }
}, TRACKING_PURGE_INTERVAL);

setInterval(() => pollGroup(APPROACH_ZONES, 'APPROACH'), APPROACH_INTERVAL);
setInterval(() => pollGroup(GROUND_ZONES, 'GROUND'), GROUND_INTERVAL);

pollGroup(APPROACH_ZONES, 'APPROACH').catch(err => console.error(`[INIT] APPROACH poll failed: ${err.message}`));
setTimeout(() => pollGroup(GROUND_ZONES, 'GROUND').catch(err => console.error(`[INIT] GROUND poll failed: ${err.message}`)), 2000);

app.get('/api/flights/eta', (req, res) => res.json(flightDataCache));
app.get('/api/external/flights', (req, res) => {
    if (req.headers['x-api-key'] !== 'hkt-apron-static-key') return res.status(401).json({ error: 'Unauthorized' });
    res.json(flightDataCache);
});
app.get('/api/health', (req, res) => res.json({ 
    status: 'ok', 
    version: 'v10.7',
    uptime: Math.floor(process.uptime()) + 's',
    cacheLength: flightDataCache.length, 
    lastFetchTime, 
    tracking: trackedArrivals.size + trackedDepartures.size,
    memoryArrivals: reportedArrivals.size,
    memoryDepartures: reportedDepartures.size
}));

const server = app.listen(PORT, () => {
    console.log(`\n=============================================`);
    console.log(`🛰️  HKT-Radar-Engine v10.7 — The Geofence Lock`);
    console.log(`🌐 Port ${PORT} | Apron: 8s | Approach: 30s`);
    console.log(`🛡️  Precision: 15m | Geofence: Activated`);
    console.log(`=============================================\n`);
});

// Bug #10: Graceful shutdown — let in-flight requests drain before exiting
function shutdown(signal) {
    console.log(`[${new Date().toISOString()}] 🛑 ${signal} received — shutting down gracefully`);
    server.close(() => {
        console.log(`[${new Date().toISOString()}] ✅ Server closed. Exiting.`);
        process.exit(0);
    });
    setTimeout(() => { console.error('Forced exit after 10s'); process.exit(1); }, 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
