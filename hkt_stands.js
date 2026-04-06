/**
 * HKT Aircraft Stand Coordinates (VTSP)
 * Data Source: AIP Thailand (VTSP AD 2.24-11 - 08 OCT 2020)
 * Format: WGS-84 Decimal Degrees
 */

const STANDS = [
    // Apron B: Adjust to 70m
    { nr: "1",   lat: 8.109833, lon: 98.308278, apron: "B", radius: 70 },
    { nr: "2",   lat: 8.109786, lon: 98.307797, apron: "B", radius: 70 },
    { nr: "3",   lat: 8.109739, lon: 98.307319, apron: "B", radius: 70 },
    { nr: "4",   lat: 8.109692, lon: 98.306839, apron: "B", radius: 70 },
    { nr: "5",   lat: 8.109644, lon: 98.306361, apron: "B", radius: 70 },
    { nr: "6",   lat: 8.109567, lon: 98.305828, apron: "B", radius: 70 },

    // Apron A: Standard 60m for 7-10
    { nr: "7",   lat: 8.109025, lon: 98.305672, apron: "A", radius: 60 },
    { nr: "8",   lat: 8.108394, lon: 98.305511, apron: "A", radius: 60 },
    { nr: "9",   lat: 8.107764, lon: 98.305347, apron: "A", radius: 60 },
    { nr: "10",  lat: 8.107136, lon: 98.305186, apron: "A", radius: 60 },

    // Apron A: Adjust 11-16 to 80m (v10.3)
    { nr: "11",  lat: 8.106503, lon: 98.305083, apron: "A", radius: 80 },
    { nr: "12",  lat: 8.105786, lon: 98.304831, apron: "A", radius: 80 },
    { nr: "14",  lat: 8.105103, lon: 98.304653, apron: "A", radius: 80 },
    { nr: "15",  lat: 8.104483, lon: 98.304508, apron: "A", radius: 80 },
    { nr: "16",  lat: 8.103964, lon: 98.304372, apron: "A", radius: 80 },

    // Apron D: Adjust 31-40 to 80m (v10.3)
    { nr: "31",  lat: 8.109886, lon: 98.302925, apron: "D", radius: 80 },
    { nr: "32L", lat: 8.109006, lon: 98.302769, apron: "D", radius: 80 },
    { nr: "32",  lat: 8.109200, lon: 98.302747, apron: "D", radius: 80 },
    { nr: "32R", lat: 8.109358, lon: 98.302864, apron: "D", radius: 80 },
    { nr: "33L", lat: 8.108297, lon: 98.302583, apron: "D", radius: 80 },
    { nr: "33",  lat: 8.108492, lon: 98.302558, apron: "D", radius: 80 },
    { nr: "33R", lat: 8.108650, lon: 98.302675, apron: "D", radius: 80 },
    { nr: "34L", lat: 8.107589, lon: 98.302397, apron: "D", radius: 80 },
    { nr: "34",  lat: 8.107783, lon: 98.302372, apron: "D", radius: 80 },
    { nr: "34R", lat: 8.107942, lon: 98.302489, apron: "D", radius: 80 },
    { nr: "35",  lat: 8.107208, lon: 98.302400, apron: "D", radius: 80 },
    { nr: "36",  lat: 8.106856, lon: 98.302308, apron: "D", radius: 80 },
    { nr: "37",  lat: 8.106419, lon: 98.302128, apron: "D", radius: 80 },
    { nr: "38",  lat: 8.105900, lon: 98.301992, apron: "D", radius: 80 },
    { nr: "39",  lat: 8.105381, lon: 98.301853, apron: "D", radius: 80 },
    { nr: "40",  lat: 8.104858, lon: 98.301717, apron: "D", radius: 80 }
];

/**
 * Calculates distance between two WGS-84 points in meters
 */
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const p1 = lat1 * Math.PI / 180;
    const p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180;
    const dl = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(dp / 2) * Math.sin(dp / 2) +
              Math.cos(p1) * Math.cos(p2) *
              Math.sin(dl / 2) * Math.sin(dl / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

/**
 * Returns the nearest stand info for a given coordinate
 */
function getStandInfo(lat, lon) {
    let nearest = null;
    let minDistance = Infinity;

    for (const stand of STANDS) {
        const d = getDistance(lat, lon, stand.lat, stand.lon);
        if (d < minDistance) {
            minDistance = d;
            nearest = stand;
        }
    }

    return {
        stand: nearest ? nearest.nr : "UNKNOWN",
        apron: nearest ? nearest.apron : "UNKNOWN",
        radius: nearest ? nearest.radius : 60,
        distance: minDistance,
        lat: nearest ? nearest.lat : null,
        lon: nearest ? nearest.lon : null
    };
}

module.exports = {
    STANDS,
    getStandInfo
};
