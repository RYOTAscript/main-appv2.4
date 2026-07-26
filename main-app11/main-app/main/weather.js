const { ipcMain } = require('electron');
const { safeFetch } = require('./httpClient');

async function resolveCityFromCoordinates(lat, lon, fallback, APP_VERSION) {
  const GEO_TIMEOUT_MS = 4000;

  // Primary: BigDataCloud — reliably maps suburbs/neighbourhoods to their parent city worldwide
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);
    const bdcResponse = await safeFetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);
    if (bdcResponse.ok) {
      const bdcData = await bdcResponse.json();
      if (bdcData.city) return bdcData.city;
      const admin = bdcData.localityInfo?.administrative || [];
      const cityLevel = admin.find((entry) => entry.adminLevel >= 5 && entry.adminLevel <= 8 && entry.name);
      if (cityLevel?.name) return cityLevel.name;
    }
  } catch (e) {
    // fall through to Nominatim
  }

  // Fallback: Nominatim at city-level zoom with broad international address field coverage
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);
    const geoResponse = await safeFetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&zoom=10`,
      {
        headers: { 'User-Agent': `main-launcher/${APP_VERSION}` },
        signal: controller.signal
      }
    );
    clearTimeout(timeoutId);
    if (geoResponse.ok) {
      const geoData = await geoResponse.json();
      const addr = geoData.address;
      if (addr) {
        const city =
          addr.city ||
          addr.city_district ||
          addr.town ||
          addr.municipality ||
          addr.county ||
          addr.state_district ||
          addr.village;
        if (city) return city;
      }
    }
  } catch (e) {
    // keep fallback
  }

  return fallback;
}

function parseHMToMinutes(str) {
  if (!str) return null;
  const m = String(str).trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

// Build a compact 3-day forecast from wttr.in's `weather` array. Each day's
// representative icon/condition is taken from the midday (12:00) hourly slot
// so the summary reflects daytime, not a 3am reading.
function buildForecast(weatherDays) {
  if (!Array.isArray(weatherDays)) return [];
  return weatherDays.slice(0, 3).map((day) => {
    const hourly = Array.isArray(day.hourly) ? day.hourly : [];
    // Hourly slots are 3-hourly ("0","300",…,"1200",…); pick the 12:00 one,
    // falling back to the middle of whatever slots exist.
    const midday = hourly.find((h) => String(h.time) === '1200')
      || hourly[Math.floor(hourly.length / 2)]
      || {};
    return {
      date: day.date || null,
      maxtemp_C: day.maxtempC,
      maxtemp_F: day.maxtempF,
      mintemp_C: day.mintempC,
      mintemp_F: day.mintempF,
      icon: midday.weatherCode || null,
      condition: midday.weatherDesc?.[0]?.value || null
    };
  });
}

function init(ctx) {
  const { logger, APP_VERSION } = ctx;

  // Short-lived cache keyed by the requested location ('auto' for geolocation,
  // or a normalized city name). Fresh hits skip the network entirely; stale
  // entries are still returned when a later fetch fails, so a flaky connection
  // never blanks an always-visible widget.
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const weatherCache = new Map();

  ipcMain.handle('get-weather', async (_event, opts) => {
    const requestedCity = (opts && typeof opts.city === 'string') ? opts.city.trim() : '';
    const cacheKey = requestedCity ? requestedCity.toLowerCase() : 'auto';
    const cached = weatherCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
      return { ...cached.data, cached: true };
    }

    try {
      // wttr.in has no per-request timeout of its own; httpClient's blanket 20s
      // socket timeout is a last-resort fallback, not a real UX budget — an
      // always-visible widget stuck "loading" for 20s reads as broken. Match
      // the geocoding fallbacks' own explicit AbortController timeout instead.
      const WEATHER_TIMEOUT_MS = 6000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
      const url = requestedCity
        ? `https://wttr.in/${encodeURIComponent(requestedCity)}?format=j1`
        : 'https://wttr.in?format=j1';
      let response;
      try {
        response = await safeFetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
      const data = await response.json();
      const current = data.current_condition[0];

      const astronomy = data?.weather?.[0]?.astronomy?.[0] || {};
      const sunrise = astronomy.sunrise || null;
      const sunset = astronomy.sunset || null;

      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const sunsetMinutes = parseHMToMinutes(sunset);

      // Consider "turning dark" to be within 30 minutes before/after sunset
      const isTurningDark = (typeof sunsetMinutes === 'number') && (nowMinutes >= (sunsetMinutes - 30));

      const nearestArea = data?.nearest_area?.[0];
      const suburbFallback = nearestArea?.areaName?.[0]?.value || 'Unknown';

      let city;
      if (requestedCity) {
        // A manual override already names the place; trust wttr.in's resolved
        // area label (nicer casing/spelling) and skip reverse-geocoding.
        city = nearestArea?.areaName?.[0]?.value || requestedCity;
      } else {
        const lat = nearestArea?.latitude;
        const lon = nearestArea?.longitude;
        city = suburbFallback;
        if (lat && lon) {
          city = await resolveCityFromCoordinates(lat, lon, suburbFallback, APP_VERSION);
        }
      }

      const result = {
        temp_C: current.temp_C,
        temp_F: current.temp_F,
        feelsLike_C: current.FeelsLikeC,
        feelsLike_F: current.FeelsLikeF,
        condition: current.weatherDesc[0].value,
        humidity: current.humidity,
        wind: current.windspeedKmph,
        icon: current.weatherCode,
        sunrise,
        sunset,
        isTurningDark,
        city,
        forecast: buildForecast(data.weather),
        cached: false,
        fetchedAt: Date.now()
      };
      weatherCache.set(cacheKey, { data: result, fetchedAt: result.fetchedAt });
      return result;
    } catch (e) {
      logger.error('Weather fetch failed', e);
      // Serve the last good reading (if any) rather than blanking the widget.
      if (cached) return { ...cached.data, cached: true, stale: true };
      return null;
    }
  });
}

module.exports = { init };
