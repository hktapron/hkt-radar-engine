const express = require('express');
const cors = require('cors');
const { fetchFromRadar, fetchFlight } = require('flightradar24-client');
const { getStandInfo } = require('./hkt_stands');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Helper: Convert Server Timestamp (Unix ms) or Date to ISO +07:00
function getHktTime(input) {
    const date = input ? new Date(input) : new Date();
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
const trackedArrivals = new Map(); // id -> { callsign, iata, state, ata, lastETA, lastPos: {lat, lon, speed, ts}, missCount }
const trackedDepartures = new Map(); // id -> { callsign, iata, state, aobt }

const APPROACH_INTERVAL = 60 * 1000; // 60s for approach/departure (ATA/ATD focus)
const GROUND_INTERVAL = 15 * 1000;   // 15s for apron/stands (AIBT/AOBT focus)
const EVENT_PERSISTENCE_TTL = 5 * 60 * 1000; // Keep events in API for 5 minutes
const MISS_THRESHOLD = 3; 
const MAX_LANDED_MISSES = 45; 
const STAND_RADIUS_METERS = 35; 

// Focused HKT zones
const APPROACH_ZONES = [
    { name: 'HKT-Approach-North', north: 8.6, west: 97.8, south: 8.12, east: 98.8, options: {} },
    { name: 'HKT-Approach-South', north: 8.08, west: 97.8, south: 7.7, east: 98.8, options: {} },
];

const GROUND_ZONES = [
    { name: 'Apron-East (1-16)', north: 8.112, west: 98.304, south: 8.100, east: 98.312, options: { onGround: true, inactive: true } },
    { name: 'Apron-West (31-40)', north: 8.112, west: 98.300, south: 8.100, east: 98.304, options: { onGround: true, inactive: true } },
];

async function pollGroup(zones, groupName) {
    try {
        console.log(`[${new Date().toISOString()}] Loop [${groupName}] scanning...`);
        const now = new Date().getTime();
        const flightMap = new Map();
        
        for (const zone of zones) {
            try {
                const flights = await fetchFromRadar(zone.north, zone.west, zone.south, zone.east, null, zone.options);
                for (const f of flights) {
                    flightMap.set(f.id, f);
                }
                await new Promise(resolve => setTimeout(resolve, 200)); 
            } catch (err) {
                console.log(`  ⚠️ ${zone.name} failed: ${err.message}`);
            }
        }
        
        await processFlightData(Array.from(flightMap.values()), now, groupName === 'GROUND');
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Loop [${groupName}] Error: ${error.message}`);
    }
}

async function processFlightData(allFlights, now, isGroundScan) {
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

    for (const flight of allFlights) {
        const origin = (flight.origin || "").toUpperCase();
        const destination = (flight.destination || "").toUpperCase();
        const fTimestamp = (flight.timestamp || Math.floor(now / 1000)) * 1000;
        
        const isPhuketDeparture = (origin === "HKT") || (flight.isOnGround && destination !== "" && destination !== "HKT");
        const isPhuketArrival = (destination === "HKT");
        
        if (!isPhuketDeparture && !isPhuketArrival) continue;
        if (reportedArrivals.has(flight.id) || reportedDepartures.has(flight.id)) continue;

        const callsign = flight.callsign || flight.flight || flight.registration || 'UNKNOWN';
        const iata = flight.flight || 'UNKNOWN';

        try {
            if (isPhuketArrival) {
                seenInThisPoll.add(flight.id);
                if (!trackedArrivals.has(flight.id)) {
                    trackedArrivals.set(flight.id, { 
                        callsign, iata, state: 'AIRBORNE', ata: null, lastETA: null, lastPos: null, missCount: 0 
                    });
                }
                const info = trackedArrivals.get(flight.id);
                info.missCount = 0;
                info.lastPos = { lat: flight.latitude, lon: flight.longitude, speed: flight.speed, ts: fTimestamp };

                if (info.state === 'AIRBORNE') {
                    if (flight.isOnGround || flight.altitude < 100) {
                        info.state = 'LANDED';
                        info.ata = getHktTime(fTimestamp);
                        console.log(`  🛬 ${callsign} TOUCHDOWN @ ${info.ata}`);
                    } else if (!isGroundScan) {
                        try {
                            // Only fetch details in approach scan
                            const detail = await fetchFlight(flight.id);
                            info.lastETA = detail.arrival || detail.scheduledArrival || null;
                        } catch(e) {}
                    }
                    if (!info.ata) {
                        responseData.set(flight.id, { Callsign: callsign, IATA: iata, ETA: getHktTime(info.lastETA) });
                    }
                } 
                
                if (info.state === 'LANDED') {
                    const standInfo = getStandInfo(flight.latitude, flight.longitude);
                    if (flight.speed <= 1.0 && standInfo.distance < STAND_RADIUS_METERS) {
                        const aibt = getHktTime(fTimestamp);
                        const eventData = { Callsign: callsign, IATA: iata, ATA: info.ata, AIBT: aibt, Stand: standInfo.stand };
                        responseData.set(flight.id, eventData);
                        recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                        reportedArrivals.add(flight.id);
                        trackedArrivals.delete(flight.id);
                        console.log(`  🛑 ${callsign} PARKED @ ${aibt}`);
                    } else {
                        responseData.set(flight.id, { Callsign: callsign, IATA: iata, ATA: info.ata });
                    }
                }
            } else if (isPhuketDeparture) {
                if (!trackedDepartures.has(flight.id)) {
                    trackedDepartures.set(flight.id, { callsign, iata, state: 'PARKED', aobt: null });
                }
                const info = trackedDepartures.get(flight.id);

                if (info.state === 'PARKED') {
                    const standInfo = getStandInfo(flight.latitude, flight.longitude);
                    // AOBT (v6.4+): Robust Logic -> Dual trigger: Speed >= 2.0 OR (Speed >= 1.0 AND Distance > 35m)
                    if (flight.isOnGround && (flight.speed >= 2.0 || (flight.speed >= 1.0 && standInfo.distance > 35))) {
                        info.state = 'TAXIING';
                        info.aobt = getHktTime(fTimestamp);
                        const eventData = { Callsign: callsign, IATA: iata, AOBT: info.aobt, Stand: standInfo.stand };
                        responseData.set(flight.id, eventData);
                        recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                        console.log(`  🚜 ${callsign} PUSHBACK detected @ ${info.aobt}`);
                    } else if (!flight.isOnGround) {
                        if (flight.altitude < 10000) {
                            info.state = 'AIRBORNE';
                            const atd = getHktTime(fTimestamp);
                            const eventData = { Callsign: callsign, IATA: iata, ATD: atd, AOBT: atd || getHktTime(fTimestamp) };
                            responseData.set(flight.id, eventData);
                            recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                            reportedDepartures.add(flight.id);
                            trackedDepartures.delete(flight.id);
                        } else {
                            reportedDepartures.add(flight.id);
                            trackedDepartures.delete(flight.id);
                        }
                    }
                } else if (info.state === 'TAXIING') {
                    if (!flight.isOnGround) {
                        info.state = 'AIRBORNE';
                        const atd = getHktTime(fTimestamp);
                        const eventData = { Callsign: callsign, IATA: iata, AOBT: info.aobt, ATD: atd };
                        responseData.set(flight.id, eventData);
                        recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                        reportedDepartures.add(flight.id);
                        trackedDepartures.delete(flight.id);
                        console.log(`  🛫 ${callsign} TOOK OFF @ ${atd}`);
                    } else {
                        responseData.set(flight.id, { Callsign: callsign, IATA: iata, AOBT: info.aobt });
                    }
                }
            }
        } catch (err) {
            console.log(`  ⚠️ Error processing ${callsign}: ${err.message}`);
        }
    }
    
    // Ghost block logic (only process disappearance in ground scan if landed)
    if (isGroundScan) {
        for (const [id, info] of trackedArrivals.entries()) {
            if (seenInThisPoll.has(id)) continue;
            // Ghost Block / Disappeared Arrivals
            if (info.state === 'LANDED') {
                 const lastPos = info.lastPos;
                 if (lastPos) {
                     const standInfo = getStandInfo(lastPos.lat, lastPos.lon);
                     if (standInfo.distance < 45 && lastPos.speed < 5) {
                         const aibt = getHktTime(lastPos.ts);
                         const eventData = { Callsign: info.callsign, IATA: info.iata, ATA: info.ata, AIBT: aibt, Stand: standInfo.stand };
                         responseData.set(id, eventData);
                         recentEvents.set(id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                         reportedArrivals.add(id);
                         trackedArrivals.delete(id);
                         console.log(`  👻 ${info.callsign} GHOST BLOCK @ ${aibt}`);
                     }
                 }
            }
        }
    }

    flightDataCache = Array.from(responseData.values());
    lastFetchTime = new Date();
}

// Separate intervals for Approach (60s) and Ground (15s)
setInterval(() => pollGroup(APPROACH_ZONES, 'APPROACH'), APPROACH_INTERVAL);
setInterval(() => pollGroup(GROUND_ZONES, 'GROUND'), GROUND_INTERVAL);

// Initial triggers
pollGroup(APPROACH_ZONES, 'APPROACH');
setTimeout(() => pollGroup(GROUND_ZONES, 'GROUND'), 2000); 

app.get('/api/flights/eta', (req, res) => res.json(flightDataCache));
app.get('/api/external/flights', (req, res) => {
    if (req.headers['x-api-key'] !== 'hkt-apron-static-key') return res.status(401).json({ error: 'Unauthorized' });
    res.json(flightDataCache);
});
app.get('/api/health', (req, res) => res.json({ status: 'ok', cacheLength: flightDataCache.length, lastFetchTime }));

app.listen(PORT, () => {
    console.log(`\n=============================================`);
    console.log(`🛰️  HKT-Radar-Engine v6.5 — Dual-Frequency Mode`);
    console.log(`🌐 Port ${PORT} | Apron: 15s | Approach: 60s`);
    console.log(`📍 West St. 31-40 | East St. 1-16`);
    console.log(`=============================================\n`);
});
