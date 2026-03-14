const express = require('express');
const cors = require('cors');
const { fetchFromRadar, fetchFlight } = require('flightradar24-client');

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());

// In-memory Cache
let flightDataCache = [];
let lastFetchTime = null;
const POLLING_INTERVAL = 60 * 1000; // 60 seconds (longer interval to avoid rate limiting)

/**
 * Polls Flightradar24 for flights heading to Phuket (HKT)
 * and retrieves their ACTUAL ETA from FR24's flight detail API.
 */
async function pollRadarData() {
    try {
        console.log(`[${new Date().toISOString()}] Fetching flights from Flightradar24...`);
        const now = new Date();
        
        // Step 1: Get all flights in the region (4-hour radius around Phuket)
        const allFlights = await fetchFromRadar(30.0, 70.0, -15.0, 120.0);
        
        if (!allFlights || allFlights.length === 0) {
            console.log(`[${now.toISOString()}] No flights found.`);
            flightDataCache = [];
            lastFetchTime = now;
            return;
        }
        
        // Step 2: Filter only flights with destination HKT (Phuket)
        const hktFlights = allFlights.filter(f => 
            f.destination && f.destination.toUpperCase() === 'HKT'
        );
        
        console.log(`[${now.toISOString()}] Found ${hktFlights.length} HKT-bound flights out of ${allFlights.length} total.`);
        
        if (hktFlights.length === 0) {
            flightDataCache = [];
            lastFetchTime = now;
            return;
        }
        
        // Step 3: For each HKT flight, fetch the REAL FR24 ETA using fetchFlight
        const detailedFlights = [];
        
        for (const flight of hktFlights) {
            try {
                const detail = await fetchFlight(flight.id);
                
                const callsign = flight.callsign || flight.flight || flight.registration || 'UNKNOWN';
                
                // Use FR24's actual arrival time (real > estimated > scheduled)
                const eta = detail.arrival || detail.scheduledArrival || null;
                
                detailedFlights.push({
                    Callsign: typeof callsign === 'string' ? callsign.trim() : 'UNKNOWN',
                    ETA: eta
                });
                
                // Small delay between requests to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 200));
                
            } catch (err) {
                // If fetchFlight fails for one flight, skip it
                console.log(`  ⚠️ Could not fetch detail for ${flight.callsign || flight.id}: ${err.message}`);
            }
        }
        
        // Update cache
        flightDataCache = detailedFlights;
        if (detailedFlights.length > 0) {
            lastFetchTime = now;
        }
        
        console.log(`[${now.toISOString()}] Cache updated. Tracking ${detailedFlights.length} HKT-bound aircraft with FR24 ETA.`);

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error: ${error.message}`);
    }
}

// First fetch on startup
pollRadarData();

// Poll every 60 seconds
setInterval(pollRadarData, POLLING_INTERVAL);

// ===================================
// API Endpoints
// ===================================

app.get('/api/flights/eta', (req, res) => {
    res.json(flightDataCache);
});

app.get('/api/external/flights', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'hkt-apron-static-key') {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing x-api-key' });
    }
    res.json(flightDataCache);
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        cacheLength: flightDataCache.length,
        lastFetchTime: lastFetchTime
    });
});

app.listen(PORT, () => {
    console.log(`\n=============================================`);
    console.log(`🛰️  HKT-Radar-Engine v2.0 — Precision Mode`);
    console.log(`📡 Polling FR24 every 60 seconds (HKT-only)`);
    console.log(`🌐 Port ${PORT}`);
    console.log(`👉 http://localhost:${PORT}/api/flights/eta`);
    console.log(`=============================================\n`);
});
