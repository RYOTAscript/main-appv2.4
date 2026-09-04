const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
// Uses the Electron-`net` transport so weather/geocoding honour the OS
// certificate store (works behind a TLS-inspecting proxy/AV). See main/netClient.js.
const { netFetch: safeFetch } = require('./netClient');

// Every provider used here asks callers to identify themselves — the OSM
// Nominatim usage policy requires it outright, and wttr.in and BigDataCloud both
// ask for it so they can reach an operator rather than silently blocking an
// unknown client. One string, used on every outbound request in this file, with
// a contact address that actually works.
function userAgent(APP_VERSION) {
  return `main-launcher/${APP_VERSION} (+https://main-website-eosin-beta.vercel.app; mainappsupport@gmail.com)`;
}

async function resolveCityFromCoordinates(lat, lon, fallback, APP_VERSION) {
  const GEO_TIMEOUT_MS = 4000;

  // Primary: BigDataCloud — reliably maps suburbs/neighbourhoods to their parent city worldwide
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);
    const bdcResponse = await safeFetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
      { headers: { 'User-Agent': userAgent(APP_VERSION) }, signal: controller.signal }
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
        headers: { 'User-Agent': userAgent(APP_VERSION) },
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
  const { logger, APP_VERSION, userDataPath } = ctx;

  // Short-lived cache keyed by the requested location ('auto' for geolocation,
  // or a normalized city name). Fresh hits skip the network entirely; stale
  // entries are still returned when a later fetch fails, so a flaky connection
  // never blanks an always-visible widget.
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const weatherCache = new Map();

  // Persist the last good reading to disk so the widget paints INSTANTLY on the
  // next launch. The in-memory cache is empty on a cold start, which otherwise
  // forces every launch to block on a round-trip to wttr.in (a notoriously
  // variable free service) before the widget can show anything — that shows up
  // as "weather takes too long to load". With a persisted reading the handler can
  // serve the last value at once and revalidate in the background.
  const WEATHER_CACHE_PATH = userDataPath ? path.join(userDataPath, 'weather-cache.json') : null;

  function loadWeatherCache() {
    if (!WEATHER_CACHE_PATH) return;
    try {
      if (!fs.existsSync(WEATHER_CACHE_PATH)) return;
      const raw = JSON.parse(fs.readFileSync(WEATHER_CACHE_PATH, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [key, entry] of Object.entries(raw)) {
          if (entry && entry.data && typeof entry.fetchedAt === 'number') {
            weatherCache.set(key, { data: entry.data, fetchedAt: entry.fetchedAt });
          }
        }
      }
    } catch (e) {
      logger.debug('Weather cache load failed', { error: e.message });
    }
  }

  function saveWeatherCache() {
    if (!WEATHER_CACHE_PATH) return;
    try {
      const obj = {};
      for (const [key, entry] of weatherCache) obj[key] = entry;
      fs.writeFileSync(WEATHER_CACHE_PATH, JSON.stringify(obj), 'utf8');
    } catch (e) {
      logger.debug('Weather cache save failed', { error: e.message });
    }
  }

  loadWeatherCache();

  // Locations currently being refreshed in the background, so overlapping polls
  // don't fire duplicate wttr.in requests for the same place.
  const refreshingKeys = new Set();

  // One network fetch → parsed reading, cached (memory + disk). `timeoutMs` bounds
  // wttr.in, which has no per-request timeout of its own; httpClient's blanket 20s
  // socket timeout is a last-resort fallback, not a UX budget.
  async function fetchWeatherFresh(cacheKey, requestedCity, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const url = requestedCity
      ? `https://wttr.in/${encodeURIComponent(requestedCity)}?format=j1`
      : 'https://wttr.in?format=j1';
    let response;
    try {
      response = await safeFetch(url, {
        headers: { 'User-Agent': userAgent(APP_VERSION) },
        signal: controller.signal
      });
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
    saveWeatherCache();
    return result;
  }

  // Non-blocking revalidation: the widget already has (stale) data to show, so a
  // failure here is a no-op the user never sees. A generous timeout since nothing
  // is waiting on it.
  function refreshInBackground(cacheKey, requestedCity) {
    if (refreshingKeys.has(cacheKey)) return;
    refreshingKeys.add(cacheKey);
    fetchWeatherFresh(cacheKey, requestedCity, 15000)
      .catch((e) => logger.debug('Weather background refresh failed', { error: e.code || e.message }))
      .finally(() => refreshingKeys.delete(cacheKey));
  }

  ipcMain.handle('get-weather', async (_event, opts) => {
    const requestedCity = (opts && typeof opts.city === 'string') ? opts.city.trim() : '';
    const cacheKey = requestedCity ? requestedCity.toLowerCase() : 'auto';
    const cached = weatherCache.get(cacheKey);
    const now = Date.now();

    // Fresh — serve from cache, no network.
    if (cached && (now - cached.fetchedAt) < CACHE_TTL_MS) {
      return { ...cached.data, cached: true };
    }

    // Stale but present (including a reading restored from disk on launch): show
    // it instantly and revalidate in the background, so the widget never blocks on
    // a slow wttr.in. The next poll or panel open picks up the refreshed reading.
    if (cached) {
      refreshInBackground(cacheKey, requestedCity);
      return { ...cached.data, cached: true, stale: true };
    }

    // Cold cache with nothing to show — this one has to wait, but on a bounded
    // budget so the widget can't hang.
    try {
      return await fetchWeatherFresh(cacheKey, requestedCity, 6000);
    } catch (e) {
      logger.warn('Weather fetch failed (no cached reading to fall back on)', { error: e.code || e.message });
      return null;
    }
  });
}

module.exports = { init };
