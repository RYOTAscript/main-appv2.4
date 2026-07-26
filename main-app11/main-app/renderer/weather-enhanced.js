        // ── Weather Enhanced mini widget UI ──
        // Renders inside the #weather-enhanced-panel container hosted in the Widget
        // Library detail view. Renderer-only: it layers on the existing weather
        // service (main/weather.js, exposed as electronAPI.getWeather) — the same
        // one the header readout uses — adding feels-like, humidity, wind, a 3-day
        // forecast, a manual city override and an on-demand refresh. Units follow
        // the existing `weatherUnit` setting so it stays consistent with the header.

        // Reuse the header's weather-code → Font Awesome mapping so both surfaces
        // pick the same icon for a given condition.
        const WEATHER_ENH_ICONS = {
            '113': 'fa-sun', '116': 'fa-cloud-sun', '119': 'fa-cloud', '122': 'fa-cloud',
            '143': 'fa-smog', '176': 'fa-cloud-rain', '182': 'fa-cloud-meatball',
            '185': 'fa-cloud-meatball', '200': 'fa-bolt', '227': 'fa-snowflake',
            '230': 'fa-icicles', '248': 'fa-smog', '260': 'fa-smog', '263': 'fa-cloud-rain',
            '266': 'fa-cloud-rain', '281': 'fa-cloud-meatball', '284': 'fa-cloud-meatball',
            '293': 'fa-cloud-rain', '296': 'fa-cloud-rain', '299': 'fa-cloud-showers-heavy',
            '302': 'fa-cloud-showers-heavy', '308': 'fa-cloud-showers-heavy',
            '311': 'fa-cloud-meatball', '314': 'fa-cloud-meatball'
        };

        // Last successful reading, kept so reopening the panel paints instantly
        // instead of flashing the loading state before the network returns.
        let weatherEnhLast = null;
        let weatherEnhLoading = false;

        function isWeatherEnhancedEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.weatherEnhanced;
        }

        function getWeatherEnhCity() {
            return (localStorage.getItem('weatherEnhancedCity') || '').trim();
        }

        function weatherEnhIcon(code, isTurningDark) {
            let cls = WEATHER_ENH_ICONS[String(code || '113')] || 'fa-cloud';
            if (isTurningDark) {
                const dayToNight = { 'fa-sun': 'fa-moon', 'fa-cloud-sun': 'fa-cloud-moon' };
                cls = dayToNight[cls] || cls;
            }
            return cls;
        }

        function weatherEnhTemp(c, f) {
            const unit = localStorage.getItem('weatherUnit') || 'C';
            const raw = unit === 'F' ? f : c;
            const n = Math.round(Number(raw));
            return Number.isFinite(n) ? `${n}°${unit}` : `--°${unit}`;
        }

        // Short weekday label ("Today" / "Mon" / "Tue" …) for a forecast date.
        function weatherEnhDayLabel(dateStr, index) {
            if (index === 0) return 'Today';
            const d = new Date(`${dateStr}T00:00:00`);
            if (isNaN(d.getTime())) return index === 1 ? 'Tomorrow' : '—';
            return d.toLocaleDateString([], { weekday: 'short' });
        }

        // Fetches fresh weather and repaints. `force` bypasses the main-process
        // cache is not possible from here, but re-rendering always reflects the
        // newest reading the service returns.
        async function weatherEnhRefresh() {
            if (!isWeatherEnhancedEnabled()) return;
            if (!window.electronAPI?.getWeather) {
                weatherEnhLast = null;
                renderWeatherEnhancedPanel();
                return;
            }
            weatherEnhLoading = true;
            renderWeatherEnhancedPanel();
            try {
                const city = getWeatherEnhCity();
                const data = await window.electronAPI.getWeather(city ? { city } : undefined);
                if (data) weatherEnhLast = data;
                else if (!weatherEnhLast) weatherEnhLast = null;
            } catch (e) {
                console.warn('Weather Enhanced: fetch failed', e);
            } finally {
                weatherEnhLoading = false;
                renderWeatherEnhancedPanel();
            }
        }

        function weatherEnhSetCity(value) {
            const city = (value || '').trim();
            if (city) localStorage.setItem('weatherEnhancedCity', city);
            else localStorage.removeItem('weatherEnhancedCity');
            scheduleSettingsSave();
            weatherEnhLast = null; // location changed — drop the stale reading
            weatherEnhRefresh();
        }

        function weatherEnhUseLocation() {
            localStorage.removeItem('weatherEnhancedCity');
            scheduleSettingsSave();
            weatherEnhLast = null;
            weatherEnhRefresh();
        }

        // Called from renderWidgetConfigPanel() (library detail) and from
        // applyMiniWidgetPrefs() when the toggle flips. Must no-op cleanly when the
        // panel div is absent (detail closed) or the widget is disabled.
        function renderWeatherEnhancedPanel() {
            const panel = document.getElementById('weather-enhanced-panel');
            if (!panel) return;
            if (!isWeatherEnhancedEnabled()) { panel.innerHTML = ''; return; }

            const city = getWeatherEnhCity();
            const cityValue = esc(city);

            // Kick off the first load lazily when there's nothing to show yet.
            if (!weatherEnhLast && !weatherEnhLoading) {
                // Defer so this render completes first (avoids re-entrancy).
                setTimeout(weatherEnhRefresh, 0);
            }

            let body;
            if (weatherEnhLoading && !weatherEnhLast) {
                body = `<div class="flex items-center justify-center py-8 text-neutral-500 text-xs">
                    <i class="fas fa-circle-notch fa-spin mr-2"></i>Loading weather…</div>`;
            } else if (!weatherEnhLast) {
                body = `<div class="flex flex-col items-center justify-center py-8 text-center text-xs text-neutral-500">
                    <i class="fas fa-triangle-exclamation text-2xl text-neutral-600 mb-2"></i>
                    <p>Couldn't load weather right now.</p>
                    <button type="button" onclick="weatherEnhRefresh()" class="hotkey-bind no-drag mt-3">Try again</button>
                </div>`;
            } else {
                const d = weatherEnhLast;
                const iconCls = weatherEnhIcon(d.icon, d.isTurningDark);
                const forecast = Array.isArray(d.forecast) ? d.forecast : [];
                const forecastHtml = forecast.length ? `
                    <div class="grid grid-cols-3 gap-2 mt-3">
                        ${forecast.map((f, i) => `
                            <div class="rounded-xl border border-white/10 bg-neutral-800/20 p-2.5 text-center">
                                <p class="text-[10px] text-neutral-500 mb-1">${esc(weatherEnhDayLabel(f.date, i))}</p>
                                <i class="fas ${weatherEnhIcon(f.icon, false)} text-neutral-300 text-sm"></i>
                                <p class="text-[11px] text-white mt-1.5 tabular-nums">${esc(weatherEnhTemp(f.maxtemp_C, f.maxtemp_F))}</p>
                                <p class="text-[10px] text-neutral-500 tabular-nums">${esc(weatherEnhTemp(f.mintemp_C, f.mintemp_F))}</p>
                            </div>`).join('')}
                    </div>` : '';

                const staleTag = d.stale
                    ? '<span class="text-[9px] text-amber-500" title="Showing the last reading — refresh failed">· offline</span>'
                    : '';

                body = `
                    <div class="rounded-xl border border-white/10 bg-neutral-800/20 p-4">
                        <div class="flex items-center justify-between gap-3">
                            <div class="min-w-0">
                                <p class="text-sm text-white truncate">${esc(String(d.city || 'Unknown'))} ${staleTag}</p>
                                <p class="text-[11px] text-neutral-500 truncate">${esc(String(d.condition || ''))}</p>
                            </div>
                            <div class="flex items-center gap-2.5 shrink-0">
                                <i class="fas ${iconCls} text-neutral-300 text-xl"></i>
                                <span class="text-2xl font-semibold text-white tabular-nums">${esc(weatherEnhTemp(d.temp_C, d.temp_F))}</span>
                            </div>
                        </div>
                        <div class="grid grid-cols-3 gap-2 mt-4 text-center">
                            <div>
                                <p class="text-[10px] text-neutral-500">Feels like</p>
                                <p class="text-xs text-neutral-200 tabular-nums mt-0.5">${esc(weatherEnhTemp(d.feelsLike_C, d.feelsLike_F))}</p>
                            </div>
                            <div>
                                <p class="text-[10px] text-neutral-500">Humidity</p>
                                <p class="text-xs text-neutral-200 tabular-nums mt-0.5">${Math.round(Number(d.humidity) || 0)}%</p>
                            </div>
                            <div>
                                <p class="text-[10px] text-neutral-500">Wind</p>
                                <p class="text-xs text-neutral-200 tabular-nums mt-0.5">${Math.round(Number(d.wind) || 0)} km/h</p>
                            </div>
                        </div>
                    </div>
                    ${forecastHtml}`;
            }

            panel.innerHTML = `<div class="mt-3 space-y-3">
                ${body}
                <div>
                    <p class="text-[11px] text-neutral-300 mb-1.5">Location</p>
                    <div class="flex items-center gap-2">
                        <input type="text" id="weather-enh-city" value="${cityValue}" placeholder="Auto (my location)"
                            class="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-neutral-600 no-drag"
                            onkeydown="if(event.key==='Enter'){event.preventDefault();weatherEnhSetCity(this.value);}"
                            onchange="weatherEnhSetCity(this.value)">
                        <button type="button" onclick="weatherEnhRefresh()" title="Refresh"
                            class="px-3 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-xl text-xs transition-colors no-drag">
                            <i class="fas fa-rotate-right${weatherEnhLoading ? ' fa-spin' : ''}"></i></button>
                    </div>
                    <div class="flex items-center justify-between mt-1.5">
                        <span class="text-[10px] text-neutral-600">Enter a city to override, or leave blank for your location.</span>
                        ${city ? `<button type="button" onclick="weatherEnhUseLocation()" class="text-[10px] text-neutral-400 hover:text-white transition-colors no-drag"><i class="fas fa-location-crosshairs mr-1"></i>Use my location</button>` : ''}
                    </div>
                </div>
            </div>`;
        }
