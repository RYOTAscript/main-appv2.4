        function updateClock() {
            const clockTime = document.getElementById('clock-time');
            const clockSeconds = document.getElementById('clock-seconds');
            const clockAmpm = document.getElementById('clock-ampm');

            const tick = () => {
                const format = localStorage.getItem('clockFormat') || '12';
                const now = new Date();

                const timeStr = now.toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: format !== '24'
                });

                // timeStr format is "HH:MM:SS AM/PM" or "HH:MM:SS"
                const parts = timeStr.split(' ');
                const hms = parts[0]; // HH:MM:SS
                const ampm = parts[1] || ''; // AM/PM or empty

                const [h, m, s] = hms.split(':');

                clockTime.textContent = `${h}:${m}`;
                clockSeconds.textContent = `:${s}`;
                clockAmpm.textContent = ampm;
            };
            tick();
            setInterval(tick, 1000);
        }

        async function updateWeather() {
            if (!window.electronAPI?.getWeather) return;
            try {
                const data = await window.electronAPI.getWeather();
                if (!data) return;

                const weatherEl = document.getElementById('weather');
                const iconEl = document.getElementById('weather-icon');
                const tempEl = document.getElementById('weather-temp');
                
                if (!weatherEl || !iconEl || !tempEl) return;

                const iconMap = {
                    '113': 'fa-sun',
                    '116': 'fa-cloud-sun',
                    '119': 'fa-cloud',
                    '122': 'fa-cloud',
                    '143': 'fa-smog',
                    '176': 'fa-cloud-rain',
                    '182': 'fa-cloud-meatball',
                    '185': 'fa-cloud-meatball',
                    '200': 'fa-bolt',
                    '227': 'fa-snowflake',
                    '230': 'fa-icicles',
                    '248': 'fa-smog',
                    '260': 'fa-smog',
                    '263': 'fa-cloud-rain',
                    '266': 'fa-cloud-rain',
                    '281': 'fa-cloud-meatball',
                    '284': 'fa-cloud-meatball',
                    '293': 'fa-cloud-rain',
                    '296': 'fa-cloud-rain',
                    '299': 'fa-cloud-showers-heavy',
                    '302': 'fa-cloud-showers-heavy',
                    '308': 'fa-cloud-showers-heavy',
                    '311': 'fa-cloud-meatball',
                    '314': 'fa-cloud-meatball'
                };

                const iconCode = String(data.icon || '113');
                let iconClass = iconMap[iconCode] || 'fa-cloud';
                
                if (data.isTurningDark) {
                    const dayToNight = {
                        'fa-sun': 'fa-moon',
                        'fa-cloud-sun': 'fa-cloud-moon'
                    };
                    iconClass = dayToNight[iconClass] || iconClass;
                }
                
                const unit = localStorage.getItem('weatherUnit') || 'C';
                const temp = Math.round(unit === 'F' ? data.temp_F : data.temp_C);
                const city = String(data.city || 'Unknown');
                const condition = String(data.condition || 'Unknown');
                const humidity = Math.round(Number(data.humidity) || 0);
                const wind = Math.round(Number(data.wind) || 0);

                iconEl.className = `fas ${iconClass} text-neutral-500`;
                tempEl.textContent = `${temp}°${unit}`;
                weatherEl.setAttribute('data-tooltip', `${city} · ${condition} · Humidity: ${humidity}% · Wind: ${wind}km/h`);
                weatherEl.classList.remove('opacity-0');
                weatherEl.style.cursor = 'default';
            } catch (e) {
                console.warn('Weather update error:', e);
            }
        }
