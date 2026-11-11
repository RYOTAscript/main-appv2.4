        // ── Calendar mini widget (renderer) ──
        // The UI half. Main (main/calendar.js) owns the data and fires the
        // reminders; this file draws the #calendar-panel the Widget Library hosts,
        // the header "up next" chip (#calendar-indicator), and the in-app reminder
        // cards (#cal-alerts). All date logic comes from renderer/calendar-engine.js
        // (window.CalendarEngine), the same file main uses, so the two can never
        // disagree about when something happens.
        //
        // Render strategy: the panel shell (hero, quick-add bar, toolbar) is built
        // once per mount; data changes only repaint the dynamic regions, so a
        // background refresh never steals focus from the quick-add box. Sheets (the
        // event editor, settings, notifications) are overlays on #widget-detail and
        // survive panel repaints.
        //
        // Efficiency: nothing here polls. The header chip re-arms ONE timeout for
        // the next moment its text can change; the week view's "now" line ticks
        // once a minute only while it is on screen.

        const CalE = window.CalendarEngine;
        const CAL_HOUR_PX = 44;
        const CAL_SNAP = 15;
        const CAL_VIEWS = [['month', 'Month', 'fa-calendar'], ['week', 'Week', 'fa-table-columns'],
            ['agenda', 'Agenda', 'fa-list-ul'], ['year', 'Year', 'fa-table-cells']];
        const CAL_TIMED_REMINDERS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];
        const CAL_ALLDAY_REMINDERS = [0, 1440, 2880, 10080];
        // What an open sheet was last drawn from, so a settings toggle doesn't
        // rebuild the whole page under the user's cursor (see calWireListeners).
        let calSheetSig = '';

        // Raised while the user is editing something INSIDE the settings sheet.
        // The list that changed refreshes itself, so a broadcast landing in the
        // middle must not rebuild the sheet under their hands.
        let calLocalSheetEdit = 0;

        let calState = null;             // last snapshot from main
        let calStateVersion = 0;         // bumps on every snapshot (occurrence cache key)
        let calOccCache = new Map();
        let calView = null;              // 'month' | 'week' | 'agenda'
        let calCursor = null;            // date the view is anchored on
        let calSelected = null;          // selected day (month view)
        let calSearchOpen = false;
        let calSearchQuery = '';
        let calSheet = null;             // open overlay: { type, ... }
        let calEditor = null;            // editor state while the editor sheet is open
        let calDrag = null;              // pointer drag in progress
        let calFlashUid = null;          // item to highlight after quick add
        let calIndicatorTimer = null;
        let calNowLineTimer = null;
        let calListenersWired = false;
        let calRenderedDay = null;       // the "today" the panel was last drawn for
        const calAlertTimers = new Map();

        // ── Small helpers ─────────────────────────────────────────────────────

        function isCalendarEnabled() {
            const prefs = safeParseJSON(localStorage.getItem('miniWidgetPrefs'), {});
            return !!prefs.calendar;
        }

        function calClock24() { return localStorage.getItem('clockFormat') === '24'; }
        function calToday() { return CalE.todayStr(Date.now()); }
        function calSettings() { return (calState && calState.settings) || CalE.mergeSettings({}); }
        function calCalendars() { return (calState && calState.calendars) || []; }
        function calFindCal(id) { return calCalendars().find(c => c.id === id) || null; }
        function calFindEvent(id) { return ((calState && calState.events) || []).find(e => e.id === id) || null; }
        function calColor(item) { const c = item && calFindCal(item.calendarId); return c ? c.color : '#8b5cf6'; }
        function calIsVisible(ev) { const c = calFindCal(ev.calendarId); return !c || c.visible !== false; }
        function calIsReadOnly(item) { const c = item && calFindCal(item.calendarId); return !!(c && c.readOnly); }
        function calWritable() { return calCalendars().filter(c => !c.readOnly); }

        // Numeric dates in quick add follow the user's locale (9/25 vs 25/9).
        function calDateOrder() {
            const lang = String(navigator.language || 'en-US').toLowerCase();
            return lang === 'en' || lang === 'en-us' || lang === 'en-ph' ? 'mdy' : 'dmy';
        }

        function calFmtTime(t) { return CalE.fmtTime(t, calClock24()); }

        // Compact times for month chips: "10a", "10:30p" (or "10:00" in 24h).
        function calChipTime(t) {
            if (calClock24()) return t;
            let h = +t.slice(0, 2);
            const m = t.slice(3, 5);
            const ap = h >= 12 ? 'p' : 'a';
            h = h % 12 || 12;
            return (m === '00' ? h : h + ':' + m) + ap;
        }

        function calOccs(from, to) {
            const key = from + '|' + to;
            const hit = calOccCache.get(key);
            if (hit) return hit;
            let occs = CalE.expandAll(calState ? calState.events : [], from, to, calIsVisible);
            if (calSettings().termMarkers) occs = occs.concat(calTermMarkers(from, to)).sort(CalE.compareOccurrences);
            if (calOccCache.size > 24) calOccCache.clear();
            calOccCache.set(key, occs);
            return occs;
        }

        // "10 – 11 AM", "All day", "Due 5 PM", "Until 1 AM" — as seen on `day`.
        function calTimeLabel(occ, day) {
            if (occ.kind === 'task') {
                // Say WHICH day it's due: "Due today" on an overdue row from last
                // week is worse than saying nothing.
                const d = CalE.evStartDate(occ);
                const rel = CalE.fmtDayLabel(d, calToday());
                const when = ['Today', 'Tomorrow', 'Yesterday'].includes(rel) ? rel.toLowerCase() : rel;
                if (occ.allDay) return 'Due ' + when;
                const t = calFmtTime(CalE.timePart(occ.start));
                return d === (day || calToday()) ? 'Due ' + t : 'Due ' + when + ', ' + t;
            }
            if (occ.allDay) {
                const s = CalE.evStartDate(occ), e = CalE.evEndDate(occ);
                if (s === e) return 'All day';
                return 'Day ' + (CalE.diffDays(s, day || s) + 1) + ' of ' + (CalE.diffDays(s, e) + 1);
            }
            const sd = CalE.evStartDate(occ), ed = CalE.evEndDate(occ);
            const st = CalE.timePart(occ.start), et = CalE.timePart(occ.end);
            if (day && sd !== ed) {
                if (day === sd) return 'From ' + calFmtTime(st);
                if (day === ed) return 'Until ' + calFmtTime(et);
                return 'All day';
            }
            return CalE.fmtTimeRange(st, et, calClock24());
        }

        // A short countdown for things worth counting down to.
        function calCountdown(occ) {
            const today = calToday();
            const d = CalE.evStartDate(occ);
            const n = CalE.diffDays(today, d);
            if (occ.kind === 'task' && !occ.done && CalE.evEndDate(occ) < today) return { text: 'Overdue', cls: 'is-overdue' };
            if (n < 0) return null;
            if (n === 0) {
                if (occ.allDay || occ.kind === 'task') return { text: 'Today', cls: 'is-today' };
                const mins = Math.round((CalE.occStartMs(occ) - Date.now()) / 60000);
                if (mins > 0 && mins < 60) return { text: 'in ' + mins + 'm', cls: 'is-soon' };
                if (mins >= 60) return { text: 'in ' + Math.floor(mins / 60) + 'h', cls: 'is-today' };
                return null;
            }
            if (n === 1) return { text: 'Tomorrow', cls: 'is-soon' };
            return { text: 'in ' + n + ' days', cls: '' };
        }

        function calRepeatLabel(r, start) {
            if (!r) return '';
            const d = start ? String(start).slice(0, 10) : calToday();
            const days = (r.byDay || []).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
            let base;
            if (r.freq === 'daily') base = r.interval > 1 ? 'Every ' + r.interval + ' days' : 'Daily';
            else if (r.freq === 'weekly') {
                const set = days.join(',');
                if (set === '1,2,3,4,5' && r.interval === 1) base = 'Every weekday';
                else if (set === '6,0' && r.interval === 1) base = 'Every weekend';
                else {
                    const names = days.map(x => CalE.WEEKDAYS_SHORT[x]).join(', ');
                    base = (r.interval === 2 ? 'Every other week' : r.interval > 2 ? 'Every ' + r.interval + ' weeks' : 'Weekly') + (names ? ' on ' + names : '');
                }
            } else if (r.freq === 'monthly' || r.freq === 'yearly') {
                const every = r.freq === 'monthly'
                    ? (r.interval > 1 ? 'Every ' + r.interval + ' months' : 'Monthly')
                    : (r.interval > 1 ? 'Every ' + r.interval + ' years' : 'Yearly');
                if (r.monthMode === 'nth') {
                    const nth = r.nth || CalE.nthOfMonth(d);
                    const word = nth === -1 ? 'last' : ['', '1st', '2nd', '3rd', '4th'][nth];
                    base = every + ' on the ' + word + ' ' + CalE.WEEKDAYS[CalE.dow(d)] + (r.freq === 'yearly' ? ' of ' + CalE.MONTHS[+d.slice(5, 7) - 1] : '');
                } else {
                    base = every + (r.freq === 'monthly' ? ' on day ' + (+d.slice(8, 10)) : ' on ' + CalE.MONTHS_SHORT[+d.slice(5, 7) - 1] + ' ' + (+d.slice(8, 10)));
                }
            } else base = 'Repeats';
            if (r.until) base += ' · until ' + CalE.fmtDateShort(r.until);
            else if (r.count) base += ' · ' + r.count + ' times';
            return base;
        }

        // ── State sync ────────────────────────────────────────────────────────

        function calSetState(state) {
            if (!state || !Array.isArray(state.events)) return;
            calState = state;
            calStateVersion++;
            calOccCache = new Map();
        }

        async function calRefresh() {
            if (!window.electronAPI?.calendarGet) return;
            try {
                calSetState(await window.electronAPI.calendarGet());
            } catch (e) {
                console.error('Calendar: failed to load', e);
            }
        }

        function calWireListeners() {
            if (calListenersWired || !window.electronAPI) return;
            calListenersWired = true;
            window.electronAPI.onCalendarChanged?.((state) => {
                calSetState(state);
                if (document.getElementById('cal-root')) calRenderDynamic();
                // Re-draw an open sheet only when what it SHOWS actually changed.
                // Flipping a switch inside it must not rebuild it under the cursor.
                if (calSheet && (calSheet.type === 'settings' || calSheet.type === 'inbox')) {
                    if (calLocalSheetEdit) calSheetSig = calSheetSignature();
                    else if (calSheetSignature() !== calSheetSig) calRenderSheet();
                }
                calScheduleIndicator();
            });
            window.electronAPI.onCalendarAlert?.((a) => calOnAlert(a));
            window.electronAPI.onCalendarOpen?.((p) => calOpenFromNotification(p));
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    calArmAlertTimers();
                    calScheduleIndicator();
                }
            });
        }

        // Called from applyMiniWidgetPrefs() when the toggle flips (and on boot).
        async function applyCalendarEnabled(enabled) {
            calWireListeners();
            if (window.electronAPI?.calendarSetEnabled) {
                try {
                    const res = await window.electronAPI.calendarSetEnabled(enabled, { clock24: calClock24() });
                    if (res && res.state) calSetState(res.state);
                } catch (e) {
                    console.error('Calendar: enable failed', e);
                }
            }
            if (!enabled) {
                calCloseSheet();
                const host = document.getElementById('cal-alerts');
                if (host) host.innerHTML = '';
            }
            calScheduleIndicator();
            await renderCalendarPanel();
        }

        // Every save goes through one path so failures always reach the user.
        async function calCall(fn, okMessage) {
            try {
                const res = await fn();
                if (res && res.state) {
                    calSetState(res.state);
                    if (document.getElementById('cal-root')) calRenderDynamic();
                    calScheduleIndicator();
                }
                if (res && res.ok === false) {
                    if (!res.canceled) showToast(res.error || 'That didn\'t work', true);
                    return res;
                }
                if (okMessage) showToast(typeof okMessage === 'function' ? okMessage(res) : okMessage);
                return res || { ok: true };
            } catch (e) {
                console.error('Calendar: call failed', e);
                showToast('Calendar: something went wrong', true);
                return { ok: false };
            }
        }

        // ── Panel ─────────────────────────────────────────────────────────────

        async function renderCalendarPanel() {
            const panel = document.getElementById('calendar-panel');
            if (!panel) { calStopNowLine(); return; }
            if (!isCalendarEnabled()) { panel.innerHTML = ''; calStopNowLine(); return; }
            if (!calState) await calRefresh();
            if (!document.getElementById('calendar-panel')) return;
            if (!calState) {
                panel.innerHTML = '<p class="cal-empty-note">The calendar couldn\'t load. Try turning the widget off and on again.</p>';
                return;
            }
            // Keep the notifications' time format in step with the app clock.
            if (calSettings().clock24 !== calClock24() && window.electronAPI?.calendarSetSettings) {
                window.electronAPI.calendarSetSettings({ clock24: calClock24() }).catch(() => {});
            }
            const fresh = panel.dataset.calMounted !== '1';
            if (fresh || !document.getElementById('cal-root')) {
                panel.dataset.calMounted = '1';
                // A fresh open always starts at today.
                calView = calView || localStorage.getItem('calendarView') || calSettings().defaultView;
                if (!CAL_VIEWS.some(v => v[0] === calView)) calView = 'month';
                calCursor = calToday();
                calSelected = calToday();
                calSearchOpen = false;
                calSearchQuery = '';
                panel.innerHTML = calShellHtml(fresh);
                calWireRoot();
            }
            calRenderDynamic(fresh);
        }

        function calShellHtml(animate) {
            return `<div class="cal-root${animate ? '' : ' cal-no-anim'}" id="cal-root">
                <div class="cal-card cal-hero-card" style="--i:0" id="cal-hero"></div>
                <div class="cal-card cal-quick-card" style="--i:1">
                    <div class="cal-quick">
                        <i class="fas fa-wand-magic-sparkles cal-quick-icon"></i>
                        <input id="cal-quick-input" type="text" autocomplete="off" spellcheck="false" maxlength="300"
                            placeholder="Add anything — “Math test fri 10am”, “Essay due thursday”, “Gym mondays 6pm”"
                            oninput="calQuickInput(this.value)" onkeydown="calQuickKey(event)">
                        <button type="button" class="cal-quick-go" onclick="calQuickSubmit(false)" title="Add (Enter)"><i class="fas fa-arrow-up"></i></button>
                    </div>
                    <div class="cal-quick-preview" id="cal-quick-preview">${calQuickHintHtml()}</div>
                </div>
                <div class="cal-card cal-main-card" style="--i:2">
                    <div class="cal-toolbar" id="cal-toolbar"></div>
                    <div class="cal-searchbar${calSearchOpen ? '' : ' hidden'}" id="cal-searchbar">
                        <i class="fas fa-magnifying-glass"></i>
                        <input id="cal-search-input" type="text" autocomplete="off" spellcheck="false" placeholder="Search events, places and notes…"
                            oninput="calSearchInput(this.value)">
                    </div>
                    <div class="cal-legend" id="cal-legend"></div>
                    <div class="cal-view" id="cal-view"></div>
                </div>
            </div>`;
        }

        function calQuickHintHtml() {
            return `<span class="cal-quick-hint"><kbd>Enter</kbd> to add · <kbd>Tab</kbd> for details (and back) · try “every weekday”, “#work”, “@room 204”, “!” for important</span>`;
        }

        // Repaints everything that depends on data or the current view.
        function calRenderDynamic() {
            const root = document.getElementById('cal-root');
            if (!root || !calState) return;
            calRenderedDay = calToday();
            root.dataset.view = calView;
            const hero = document.getElementById('cal-hero');
            if (hero) hero.innerHTML = calHeroHtml();
            const tb = document.getElementById('cal-toolbar');
            if (tb) tb.innerHTML = calToolbarHtml();
            const legend = document.getElementById('cal-legend');
            if (legend) legend.innerHTML = calLegendHtml();
            const view = document.getElementById('cal-view');
            if (view) {
                const prevScroll = document.getElementById('cal-week-scroll')?.scrollTop;
                if (calSearchOpen && calSearchQuery.trim()) view.innerHTML = calSearchHtml();
                else if (calView === 'week') view.innerHTML = calWeekHtml();
                else if (calView === 'agenda') view.innerHTML = calAgendaHtml();
                else if (calView === 'year') view.innerHTML = calYearHtml();
                else view.innerHTML = calMonthHtml();
                if (calView === 'week' && !calSearchOpen) calAfterWeekRender(prevScroll);
                else calStopNowLine();
            }
            if (calFlashUid) {
                const el = root.querySelector(`[data-uid="${CSS.escape(calFlashUid)}"]`);
                if (el) el.classList.add('is-new');
                calFlashUid = null;
            }
            calRefreshQuickPreview();
        }

        // ── Hero ──────────────────────────────────────────────────────────────

        function calHeroHtml() {
            const now = Date.now();
            const today = calToday();
            const week = calOccs(today, CalE.addDays(today, 6)).filter(o => !o.synthetic);
            const todays = CalE.occurrencesOnDay(week, today);
            const timed = week.filter(o => !o.allDay && o.kind !== 'task');
            const { ongoing, next, focus } = calFocusOccurrence(timed, now);
            const evToday = todays.filter(o => o.kind !== 'task').length;
            const dueToday = todays.filter(o => o.kind === 'task' && !o.done).length;
            const overdue = calOccs(CalE.addDays(today, -30), CalE.addDays(today, -1))
                .filter(o => o.kind === 'task' && !o.done && CalE.evEndDate(o) < today).length;
            const weekCount = week.filter(o => o.kind !== 'task').length;

            let kicker, title, sub, progress = '';
            if (focus === ongoing && ongoing) {
                const start = CalE.occStartMs(ongoing), end = CalE.occEndMs(ongoing);
                const pct = Math.max(0, Math.min(100, ((now - start) / Math.max(1, end - start)) * 100));
                const left = Math.max(1, Math.round((end - now) / 60000));
                kicker = '<span class="cal-live-dot"></span>Happening now';
                title = ongoing.title;
                sub = `${esc(calTimeLabel(ongoing))} · ${left < 60 ? left + ' min' : CalE.fmtDuration(left)} left${ongoing.location ? ' · ' + esc(ongoing.location) : ''}`;
                progress = `<div class="cal-hero-progress" style="--c:${calColor(ongoing)}"><span style="width:${pct.toFixed(1)}%"></span></div>`;
            } else if (focus) {
                const d = CalE.evStartDate(focus);
                const next = focus;
                kicker = d === today ? 'Up next' : 'Next up · ' + esc(CalE.fmtDayLabel(d, today));
                title = next.title;
                sub = `${esc(CalE.relativePhrase(next, now, calClock24()))} · ${esc(calTimeLabel(next))}${next.location ? ' · ' + esc(next.location) : ''}`;
            } else {
                kicker = 'This week';
                title = weekCount ? 'Nothing else timed this week' : 'A clear week ahead';
                sub = dueToday ? `${dueToday} due today — tick them off below` : 'Type anything in the box below to add it.';
            }
            const link = focus ? CalE.findMeetingLink(focus) : null;
            const color = focus ? calColor(focus) : 'var(--accent-solid)';
            const d = new Date(now);
            return `<div class="cal-hero" style="--c:${color}">
                <div class="cal-hero-date" title="${esc(CalE.fmtDateLong(today))}">
                    <span class="cal-hero-dow">${CalE.WEEKDAYS_SHORT[d.getDay()]}</span>
                    <span class="cal-hero-day">${d.getDate()}</span>
                    <span class="cal-hero-month">${CalE.MONTHS_SHORT[d.getMonth()]}</span>
                </div>
                <div class="cal-hero-main"${focus ? ` onclick="calOpenOcc(${jsAttr(focus.eventId)}, ${jsAttr(focus.occKey)})" role="button"` : ''}>
                    <div class="cal-hero-kicker">${kicker}</div>
                    <div class="cal-hero-title">${esc(title || 'Untitled')}</div>
                    <div class="cal-hero-sub">${sub}</div>
                    ${progress}
                </div>
                ${link ? `<button type="button" class="cal-join" onclick="calJoin(${jsAttr(link)})"><i class="fas fa-video"></i>Join</button>` : ''}
                <div class="cal-hero-stats">
                    <div class="cal-stat"><b>${evToday}</b><span>today</span></div>
                    <div class="cal-stat${dueToday ? ' is-due' : ''}"><b>${dueToday}</b><span>due</span></div>
                    ${overdue ? `<div class="cal-stat is-overdue" onclick="calSetView('agenda')" title="Show overdue tasks"><b>${overdue}</b><span>overdue</span></div>`
                        : `<div class="cal-stat"><b>${weekCount}</b><span>7 days</span></div>`}
                </div>
            </div>`;
        }

        // What the hero and the header chip should be pointing at. Something
        // about to start beats something merely in progress: during an eight-hour
        // shift, "Chemistry lab in 12 min" is the useful sentence, not "shift,
        // 5 h left". Once nothing is imminent, the thing you're in wins again.
        const CAL_IMMINENT_MS = 30 * 60000;

        function calFocusOccurrence(timed, now) {
            const ongoing = timed.find(o => CalE.occStartMs(o) <= now && CalE.occEndMs(o) > now) || null;
            const next = timed.find(o => CalE.occStartMs(o) > now) || null;
            const imminent = next && CalE.occStartMs(next) - now <= CAL_IMMINENT_MS ? next : null;
            return { ongoing, next, focus: imminent || ongoing || next };
        }

        // ── Toolbar & legend ──────────────────────────────────────────────────

        function calToolbarHtml() {
            const s = calSettings();
            const term = CalE.termLabel(s.terms, calToday(), s.weekStart);
            const termPill = term ? '<span class="cal-term-pill" title="School term">' + esc(term.name) + ' · Wk ' + term.week + '</span>' : '';
            let title;
            if (calView === 'week') {
                const a = CalE.startOfWeek(calCursor, s.weekStart), b = CalE.addDays(a, 6);
                const am = CalE.MONTHS_SHORT[+a.slice(5, 7) - 1], bm = CalE.MONTHS_SHORT[+b.slice(5, 7) - 1];
                title = am === bm ? `${am} ${+a.slice(8, 10)} – ${+b.slice(8, 10)}, ${b.slice(0, 4)}` : `${am} ${+a.slice(8, 10)} – ${bm} ${+b.slice(8, 10)}, ${b.slice(0, 4)}`;
            } else if (calView === 'agenda') {
                title = calCursor === calToday() ? 'Coming up' : 'From ' + CalE.fmtDateShort(calCursor);
            } else {
                title = calView === 'year' ? calCursor.slice(0, 4) : CalE.fmtMonthYear(calCursor);
            }
            const unread = (calState && calState.unread) || 0;
            const views = CAL_VIEWS.map(([id, label, icon]) => `
                <button type="button" class="cal-seg-btn${calView === id ? ' on' : ''}" onclick="calSetView(${jsAttr(id)})" title="${label} (${label[0]})">
                    <i class="fas ${icon}"></i><span>${label}</span></button>`).join('');
            return `
                <div class="cal-nav">
                    <button type="button" class="cal-icon-btn" onclick="calNav(-1)" title="Previous (←)"><i class="fas fa-chevron-left"></i></button>
                    <button type="button" class="cal-today-btn${calIsShowingToday() ? ' is-here' : ''}" onclick="calGoToday()" title="Today (T)">Today</button>
                    <button type="button" class="cal-icon-btn" onclick="calNav(1)" title="Next (→)"><i class="fas fa-chevron-right"></i></button>
                </div>
                <div class="cal-title">${esc(title)}${termPill}</div>
                <div class="cal-seg">${views}</div>
                <div class="cal-tools">
                    <button type="button" class="cal-icon-btn${calSearchOpen ? ' is-on' : ''}" onclick="calToggleSearch()" title="Search (F)"><i class="fas fa-magnifying-glass"></i></button>
                    <button type="button" class="cal-icon-btn" onclick="calOpenInbox()" title="Notifications">
                        <i class="${unread ? 'fas' : 'far'} fa-bell"></i>${unread ? `<span class="cal-badge">${unread > 9 ? '9+' : unread}</span>` : ''}</button>
                    <button type="button" class="cal-icon-btn" onclick="calOpenSettings()" title="Calendar settings"><i class="fas fa-sliders"></i></button>
                    <button type="button" class="cal-new-btn" onclick="calNewEvent()" title="New event (N)"><i class="fas fa-plus"></i>New</button>
                </div>`;
        }

        function calIsShowingToday() {
            const today = calToday();
            if (calView === 'year') return calCursor.slice(0, 4) === today.slice(0, 4);
            if (calView === 'month') return calCursor.slice(0, 7) === today.slice(0, 7);
            if (calView === 'week') {
                const a = CalE.startOfWeek(calCursor, calSettings().weekStart);
                return today >= a && today <= CalE.addDays(a, 6);
            }
            return calCursor === today;
        }

        function calLegendHtml() {
            return calCalendars().map(c => `
                <button type="button" class="cal-legend-chip${c.visible === false ? ' is-off' : ''}" style="--c:${c.color}"
                    onclick="calToggleVisible(${jsAttr(c.id)})" title="${c.visible === false ? 'Show' : 'Hide'} ${esc(c.name)}">
                    <span class="cal-dot"></span><span>${esc(c.name)}</span>${c.readOnly ? '<i class="fas fa-link"></i>' : ''}${c.notify === false ? '<i class="fas fa-bell-slash"></i>' : ''}
                </button>`).join('');
        }

        // ── Shared item row (agenda, day list, search) ────────────────────────

        function calItemHtml(occ, day) {
            const color = calColor(occ);
            const cd = (occ.important || occ.kind === 'task') ? calCountdown(occ) : null;
            const link = CalE.findMeetingLink(occ);
            const ro = calIsReadOnly(occ) || !!occ.synthetic;
            const meta = [];
            if (occ.location) meta.push(`<span><i class="fas fa-location-dot"></i>${esc(occ.location)}</span>`);
            if (occ.recurring) meta.push(`<span title="Repeats"><i class="fas fa-repeat"></i></span>`);
            if (ro) meta.push(`<span title="Subscribed (read-only)"><i class="fas fa-link"></i></span>`);
            const cal = calFindCal(occ.calendarId);
            if (cal) meta.push(`<span class="cal-item-cal">${esc(cal.name)}</span>`);
            return `<div class="cal-item${occ.kind === 'task' ? ' is-task' : ''}${occ.done ? ' is-done' : ''}${occ.important ? ' is-important' : ''}${occ.synthetic ? ' is-term' : ''}"
                    style="--c:${color}" data-uid="${esc(occ.uid)}" onclick="calOpenOcc(${jsAttr(occ.eventId)}, ${jsAttr(occ.occKey)})">
                <span class="cal-item-bar"></span>
                ${occ.kind === 'task'
                    ? `<button type="button" class="cal-check${occ.done ? ' on' : ''}" ${ro ? 'disabled' : ''} title="${occ.done ? 'Mark not done' : 'Mark done'}"
                        onclick="event.stopPropagation(); calToggleDone(${jsAttr(occ.eventId)}, ${jsAttr(occ.occKey)}, ${occ.done ? 'false' : 'true'})"><i class="fas fa-check"></i></button>`
                    : ''}
                <div class="cal-item-time">${esc(calTimeLabel(occ, day))}</div>
                <div class="cal-item-body">
                    <div class="cal-item-title">${occ.important ? '<i class="fas fa-star cal-star"></i>' : ''}${esc(occ.title || 'Untitled')}</div>
                    ${meta.length ? `<div class="cal-item-meta">${meta.join('')}</div>` : ''}
                </div>
                ${cd ? `<span class="cal-pill ${cd.cls}">${esc(cd.text)}</span>` : ''}
                ${link ? `<button type="button" class="cal-join cal-join-sm" onclick="event.stopPropagation(); calJoin(${jsAttr(link)})" title="Join call"><i class="fas fa-video"></i></button>` : ''}
            </div>`;
        }

        function calEmptyHtml(icon, title, sub) {
            return `<div class="cal-empty"><div class="cal-empty-icon"><i class="${icon}"></i></div>
                <p class="cal-empty-title">${esc(title)}</p><p class="cal-empty-sub">${esc(sub)}</p></div>`;
        }

        // ── Month view ────────────────────────────────────────────────────────

        function calMonthHtml() {
            const s = calSettings();
            const today = calToday();
            const monthKey = calCursor.slice(0, 7);
            const gridStart = CalE.startOfWeek(CalE.startOfMonth(calCursor), s.weekStart);
            const gridEnd = CalE.addDays(gridStart, 41);
            const occs = calOccs(gridStart, gridEnd);
            const buckets = new Map();
            for (const o of occs) {
                let d = CalE.evStartDate(o) < gridStart ? gridStart : CalE.evStartDate(o);
                const end = CalE.evEndDate(o) > gridEnd ? gridEnd : CalE.evEndDate(o);
                for (let guard = 0; d <= end && guard < 42; d = CalE.addDays(d, 1), guard++) {
                    if (!buckets.has(d)) buckets.set(d, []);
                    buckets.get(d).push(o);
                }
            }
            const wn = s.showWeekNumbers;
            const heads = [];
            for (let i = 0; i < 7; i++) heads.push(CalE.WEEKDAYS_SHORT[(s.weekStart + i) % 7]);
            let cells = '';
            for (let i = 0; i < 42; i++) {
                const d = CalE.addDays(gridStart, i);
                if (wn && i % 7 === 0) {
                    const wk = CalE.weekNumberLabel(d, s);
                    cells += `<div class="cal-wk-num${wk.inTerm ? ' in-term' : ''}"
                        title="${esc(wk.term ? 'Week ' + wk.text + ' of ' + wk.term.name : 'Week ' + wk.text + ' of the year')}">${esc(wk.text)}</div>`;
                }
                const list = buckets.get(d) || [];
                const dow = CalE.dow(d);
                const cls = ['cal-cell'];
                if (d.slice(0, 7) !== monthKey) cls.push('is-other');
                if (d === today) cls.push('is-today');
                if (d === calSelected) cls.push('is-selected');
                if (dow === 0 || dow === 6) cls.push('is-weekend');
                if (d < today) cls.push('is-past');
                const max = list.length > 3 ? 2 : 3;
                const chips = list.slice(0, max).map(o => calMonthChipHtml(o, d)).join('');
                const more = list.length > max ? `<div class="cal-more">+${list.length - max} more</div>` : '';
                cells += `<div class="${cls.join(' ')}" data-date="${d}" onclick="calSelectDay(${jsAttr(d)})" ondblclick="calNewOn(${jsAttr(d)})">
                    <div class="cal-cell-head"><span class="cal-cell-num">${+d.slice(8, 10)}</span>${d.slice(8, 10) === '01' ? `<span class="cal-cell-mon">${CalE.MONTHS_SHORT[+d.slice(5, 7) - 1]}</span>` : ''}</div>
                    <div class="cal-cell-events">${chips}${more}</div>
                </div>`;
            }
            return `<div class="cal-month${wn ? ' has-wk' : ''}">
                <div class="cal-month-head">${wn ? '<div class="cal-wk-num">wk</div>' : ''}${heads.map(h => `<div>${h}</div>`).join('')}</div>
                <div class="cal-month-grid">${cells}</div>
            </div>
            <div class="cal-daylist" id="cal-daylist">${calDayListHtml(calSelected)}</div>`;
        }

        function calMonthChipHtml(o, day) {
            const start = CalE.evStartDate(o), end = CalE.evEndDate(o);
            const cls = ['cal-chip'];
            if (o.synthetic) cls.push('is-term');
            if (o.allDay || start !== end) cls.push('is-bar');
            if (o.kind === 'task') cls.push('is-task');
            if (o.done) cls.push('is-done');
            if (start < day) cls.push('cont-l');
            if (end > day) cls.push('cont-r');
            const ro = calIsReadOnly(o) || !!o.synthetic;
            const lead = o.kind === 'task'
                ? `<button type="button" class="cal-chip-check${o.done ? ' on' : ''}" data-notdrag="1" ${ro ? 'disabled' : ''}
                    title="${o.done ? 'Mark not done' : 'Mark done'}"
                    onclick="event.stopPropagation(); calToggleDone(${jsAttr(o.eventId)}, ${jsAttr(o.occKey)}, ${o.done ? 'false' : 'true'})"><i class="${o.done ? 'fas fa-square-check' : 'far fa-square'}"></i></button>`
                : (!o.allDay && start === day ? `<span class="cal-chip-time">${calChipTime(CalE.timePart(o.start))}</span>` : '');
            return `<div class="${cls.join(' ')}" style="--c:${calColor(o)}" data-uid="${esc(o.uid)}" ${ro ? '' : 'data-drag="month"'}
                onclick="event.stopPropagation(); calChipClick(${jsAttr(o.eventId)}, ${jsAttr(o.occKey)}, ${jsAttr(day)})"
                title="${esc((o.title || 'Untitled') + ' · ' + calTimeLabel(o, day))}">${lead}<span class="cal-chip-title">${esc(o.title || 'Untitled')}</span></div>`;
        }

        function calDayListHtml(d) {
            const today = calToday();
            const list = CalE.occurrencesOnDay(calOccs(d, d), d);
            const label = d === today ? 'Today' : CalE.fmtDayLabel(d, today);
            const sub = d === today || CalE.fmtDayLabel(d, today) !== CalE.fmtDateShort(d) ? CalE.fmtDateLong(d) : '';
            return `<div class="cal-daylist-head">
                    <div><span class="cal-daylist-title">${esc(label)}</span>${sub ? `<span class="cal-daylist-sub">${esc(sub)}</span>` : ''}</div>
                    <button type="button" class="cal-ghost-btn" onclick="calNewOn(${jsAttr(d)})"><i class="fas fa-plus"></i>Add</button>
                </div>
                ${list.length ? `<div class="cal-list">${list.map(o => calItemHtml(o, d)).join('')}</div>`
                    : `<p class="cal-daylist-empty">Nothing planned${d === today ? ' today' : ''}. Double-click a day or type above to add something.</p>`}`;
        }

        // ── Week view ─────────────────────────────────────────────────────────

        function calWeekHtml() {
            const s = calSettings();
            const today = calToday();
            const start = CalE.startOfWeek(calCursor, s.weekStart);
            const days = [];
            for (let i = 0; i < 7; i++) days.push(CalE.addDays(start, i));
            const occs = calOccs(start, days[6]);
            const allDay = occs.filter(o => o.allDay);
            const timed = occs.filter(o => !o.allDay);

            const heads = days.map(d => `<div class="cal-wh${d === today ? ' is-today' : ''}${d < today ? ' is-past' : ''}" onclick="calPickDay(${jsAttr(d)})">
                <span>${CalE.WEEKDAYS_SHORT[CalE.dow(d)]}</span><b>${+d.slice(8, 10)}</b></div>`).join('');
            const allDayCells = days.map(d => {
                const list = allDay.filter(o => CalE.evStartDate(o) <= d && CalE.evEndDate(o) >= d);
                return `<div class="cal-wad-cell" data-date="${d}" ondblclick="calNewOn(${jsAttr(d)})">${list.map(o => calMonthChipHtml(o, d)).join('')}</div>`;
            }).join('');

            let hours = '';
            for (let h = 0; h < 24; h++) {
                hours += `<div class="cal-hour" style="top:${h * CAL_HOUR_PX}px"><span>${h === 0 ? '' : calFmtTime(CalE.hhmm(h * 60)).replace(':00', '')}</span></div>`;
            }
            const cols = days.map(d => {
                const items = [];
                for (const o of timed) {
                    const sd = CalE.evStartDate(o), ed = CalE.evEndDate(o);
                    if (sd > d || ed < d) continue;
                    const startMin = sd < d ? 0 : CalE.minutesOf(CalE.timePart(o.start));
                    let endMin;
                    if (o.kind === 'task') endMin = startMin + 30;
                    else endMin = ed > d ? 1440 : CalE.minutesOf(CalE.timePart(o.end));
                    if (o.kind !== 'task' && CalE.evEndDate(o) === d && CalE.timePart(o.end) === '00:00') endMin = 1440;
                    items.push({ occ: o, startMin, endMin: Math.max(endMin, startMin + 15), id: o.uid });
                }
                const laid = CalE.layoutDayColumns(items);
                const blocks = laid.map(it => calBlockHtml(it, d)).join('');
                return `<div class="cal-wcol${d === today ? ' is-today' : ''}${CalE.dow(d) === 0 || CalE.dow(d) === 6 ? ' is-weekend' : ''}" data-date="${d}">${blocks}${d === today ? '<div class="cal-now" id="cal-now"></div>' : ''}</div>`;
            }).join('');

            return `<div class="cal-week">
                <div class="cal-week-head"><div class="cal-wgutter"></div>${heads}</div>
                <div class="cal-week-allday"><div class="cal-wgutter">all-day</div>${allDayCells}</div>
                <div class="cal-week-scroll" id="cal-week-scroll">
                    <div class="cal-week-grid" style="height:${24 * CAL_HOUR_PX}px">
                        <div class="cal-wgutter cal-hours">${hours}</div>
                        <div class="cal-wcols">${cols}</div>
                    </div>
                </div>
            </div>`;
        }

        function calBlockHtml(it, day) {
            const o = it.occ;
            const top = (it.startMin / 60) * CAL_HOUR_PX;
            const height = Math.max(18, ((it.endMin - it.startMin) / 60) * CAL_HOUR_PX - 2);
            const w = 100 / it.cols;
            const ro = calIsReadOnly(o) || !!o.synthetic;
            const short = height < 34;
            const resizable = !ro && o.kind !== 'task' && CalE.evEndDate(o) === day;
            return `<div class="cal-block${o.kind === 'task' ? ' is-task' : ''}${o.done ? ' is-done' : ''}${short ? ' is-short' : ''}${o.important ? ' is-important' : ''}"
                    style="--c:${calColor(o)};top:${top}px;height:${height}px;left:calc(${(it.col * w).toFixed(3)}% + 1px);width:calc(${w.toFixed(3)}% - 3px)"
                    data-uid="${esc(o.uid)}" data-day="${day}" ${ro ? '' : 'data-drag="week"'}
                    onclick="event.stopPropagation(); calChipClick(${jsAttr(o.eventId)}, ${jsAttr(o.occKey)}, ${jsAttr(day)})">
                <div class="cal-block-title">${o.kind === 'task' ? `<button type="button" class="cal-block-check${o.done ? ' on' : ''}" data-notdrag="1" ${ro ? 'disabled' : ''}
                    title="${o.done ? 'Mark not done' : 'Mark done'}"
                    onclick="event.stopPropagation(); calToggleDone(${jsAttr(o.eventId)}, ${jsAttr(o.occKey)}, ${o.done ? 'false' : 'true'})"><i class="${o.done ? 'fas fa-square-check' : 'far fa-square'}"></i></button>` : ''}${esc(o.title || 'Untitled')}</div>
                ${short ? '' : `<div class="cal-block-time">${esc(calTimeLabel(o, day))}</div>`}
                ${!short && o.location && height > 56 ? `<div class="cal-block-loc">${esc(o.location)}</div>` : ''}
                ${resizable ? '<div class="cal-block-resize" data-resize="1"></div>' : ''}
            </div>`;
        }

        function calAfterWeekRender(prevScroll) {
            const sc = document.getElementById('cal-week-scroll');
            if (!sc) return;
            if (typeof prevScroll === 'number') {
                sc.scrollTop = prevScroll;
            } else {
                // First paint: show the working day, or around "now" when it's later.
                const nowMin = CalE.minuteOfDay(Date.now());
                const target = calIsShowingToday() ? Math.max(7 * 60, nowMin - 90) : 7 * 60;
                sc.scrollTop = Math.max(0, (target / 60) * CAL_HOUR_PX - 8);
            }
            calPositionNowLine();
            calStartNowLine();
        }

        function calPositionNowLine() {
            const line = document.getElementById('cal-now');
            if (!line) return;
            line.style.top = ((CalE.minuteOfDay(Date.now()) / 60) * CAL_HOUR_PX) + 'px';
        }

        function calStartNowLine() {
            if (calNowLineTimer) return;
            calNowLineTimer = setInterval(() => {
                if (!document.getElementById('cal-now')) { calStopNowLine(); return; }
                if (calRenderedDay !== calToday()) { calRenderDynamic(); return; }
                calPositionNowLine();
            }, 60000);
        }

        function calStopNowLine() {
            if (calNowLineTimer) { clearInterval(calNowLineTimer); calNowLineTimer = null; }
        }

        // ── Year view ─────────────────────────────────────────────────────────
        // Twelve mini months. A day with anything on it gets a dot, school terms
        // tint their stretch, and clicking a day drops you into that month.

        function calYearHtml() {
            const s = calSettings();
            const today = calToday();
            const year = calCursor.slice(0, 4);
            const from = year + '-01-01';
            const to = year + '-12-31';
            // What sits on each day, so hovering a dot says WHAT it is rather
            // than repeating the date the cell already shows.
            const byDay = new Map();
            for (const o of calOccs(from, to)) {
                let d = CalE.evStartDate(o) < from ? from : CalE.evStartDate(o);
                const end = CalE.evEndDate(o) > to ? to : CalE.evEndDate(o);
                for (let guard = 0; d <= end && guard < 370; d = CalE.addDays(d, 1), guard++) {
                    const list = byDay.get(d) || [];
                    if (list.length < 9) list.push(calYearLabel(o, d));
                    byDay.set(d, list);
                }
            }
            const terms = s.terms || [];
            const heads = [];
            for (let i = 0; i < 7; i++) heads.push('<span>' + CalE.WEEKDAYS_SHORT[(s.weekStart + i) % 7][0] + '</span>');
            let months = '';
            for (let m = 1; m <= 12; m++) {
                const first = year + '-' + CalE.pad2(m) + '-01';
                const gridStart = CalE.startOfWeek(first, s.weekStart);
                let cells = '';
                for (let i = 0; i < 42; i++) {
                    const d = CalE.addDays(gridStart, i);
                    if (d.slice(0, 7) !== first.slice(0, 7)) { cells += '<span class="cal-y-cell is-out"></span>'; continue; }
                    const items = byDay.get(d);
                    const term = CalE.currentTerm(terms, d);
                    const cls = ['cal-y-cell'];
                    if (items) cls.push('has');
                    if (d === today) cls.push('is-today');
                    if (term) cls.push('in-term');
                    let tip = CalE.fmtDateShort(d) + (term ? ' · ' + term.name : '');
                    if (items) {
                        tip += '\n' + items.slice(0, 8).join('\n');
                        if (items.length > 8) tip += '\n+' + (items.length - 8) + ' more';
                    }
                    cells += `<button type="button" class="${cls.join(' ')}" onclick="calPickDay(${jsAttr(d)})"
                        title="${esc(tip)}">${+d.slice(8, 10)}</button>`;
                }
                months += `<div class="cal-y-month">
                    <button type="button" class="cal-y-name" onclick="calOpenMonth(${jsAttr(first)})">${CalE.MONTHS[m - 1]}</button>
                    <div class="cal-y-head">${heads.join('')}</div>
                    <div class="cal-y-grid">${cells}</div>
                </div>`;
            }
            const legend = terms.length
                ? `<div class="cal-y-legend">${terms.map(t => `<span class="cal-y-term"><span class="cal-y-swatch"></span>${esc(t.name)} · ${esc(CalE.fmtDateShort(t.start))} – ${esc(CalE.fmtDateShort(t.end))}</span>`).join('')}</div>`
                : '';
            return `<div class="cal-year">${months}</div>${legend}`;
        }

        // One line of a year-view hover: "9a  Biology", "· Mum's birthday",
        // "✓ History essay" for something already ticked off.
        function calYearLabel(o, day) {
            const title = o.title || 'Untitled';
            if (o.kind === 'task') return (o.done ? '✓ ' : '☐ ') + title;
            if (o.allDay || CalE.evStartDate(o) !== day) return '· ' + title;
            return calChipTime(CalE.timePart(o.start)) + '  ' + title;
        }

        function calOpenMonth(d) {
            calCursor = d;
            calSelected = d;
            calSetView('month');
        }

        // What an open sheet is drawn FROM — deliberately only its STRUCTURE.
        // Values the user is editing (a switch, a colour, a name, a term date)
        // are left out: the control already shows its own new state, so counting
        // them would rebuild the sheet under the person using it.
        function calSheetSignature() {
            if (!calState) return '';
            if (calSheet && calSheet.type === 'inbox') {
                return 'inbox:' + (calState.history || []).length + ':' + calState.unread;
            }
            const s = calState.settings || {};
            return 'settings:' + JSON.stringify([
                (calState.calendars || []).map(c => c.id + (c.readOnly ? '*' : '')),
                (s.terms || []).map(t => t.id)
            ]);
        }

        // ── Right-click ───────────────────────────────────────────────────────
        // Does nothing unless the user picks an action in settings: something
        // destructive on a stray click has to be opted into.

        function calContextMenu(e) {
            const action = calSettings().rightClick;
            if (!action || action === 'none') return;
            const el = e.target.closest('[data-uid]');
            if (!el) return;
            const occ = calOccByUid(el.dataset.uid);
            if (!occ) return;
            e.preventDefault();
            e.stopPropagation();
            if (calIsReadOnly(occ)) { showToast('That calendar is read-only', true); return; }
            if (action === 'done') {
                if (occ.kind !== 'task') { showToast('Only tasks can be ticked off', true); return; }
                calToggleDone(occ.eventId, occ.occKey, !occ.done);
                return;
            }
            const ev = calFindEvent(occ.eventId);
            if (ev && ev.rrule) {
                // A repeating event is never deleted on one click — ask which.
                calOpenSheet({ type: 'confirm', kind: 'delete-series', eventId: ev.id, occKey: occ.occKey, title: occ.title });
                return;
            }
            calCall(() => window.electronAPI.calendarDeleteEvent(occ.eventId, null)).then((res) => {
                if (res && res.ok !== false) { calRenderDynamic(); showToast('Deleted'); }
            });
        }

        // ── Ticking a task off from inside the editor ─────────────────────────

        function calEdIsDone() {
            if (!calEditor) return false;
            return calEditor.occ ? !!calEditor.occ.done : !!calEditor.draft.done;
        }

        async function calEdToggleDone() {
            if (!calEditor || calEditor.readOnly) return;
            const ed = calEditor;
            const next = !calEdIsDone();
            if (ed.original && ed.occ) {
                // A saved task is ticked through its own channel, which knows how
                // to mark one occurrence of a repeating task.
                await calToggleDone(ed.original.id, ed.occ.occKey, next);
                ed.occ.done = next;
                if (!ed.original.rrule) ed.draft.done = next;
            } else {
                ed.draft.done = next;
            }
            calRenderSheet();
        }

        // ── School terms (settings) ───────────────────────────────────────────

        function calTerms() { return (calSettings().terms || []).map(t => Object.assign({}, t)); }

        async function calAddTerm() {
            const terms = calTerms();
            const last = terms[terms.length - 1];
            const start = last ? CalE.addDays(last.end, 14) : calToday();
            terms.push({
                id: 'term' + Date.now().toString(36),
                name: 'Term ' + (terms.length + 1),
                start,
                end: CalE.addDays(start, 69)
            });
            calLocalSheetEdit++;
            try { await calPatchSettings({ terms }); } finally { calLocalSheetEdit--; }
            calRefreshSettingsList('terms');
        }

        async function calSetTerm(id, field, value) {
            const terms = calTerms();
            const t = terms.find(x => x.id === id);
            if (!t) return;
            if (field === 'name') t.name = value;
            else if (CalE.isDate(value)) t[field] = value;
            if (t.end < t.start) t.end = t.start;
            calLocalSheetEdit++;
            try { await calPatchSettings({ terms }); } finally { calLocalSheetEdit--; }
            calRefreshSettingsList('terms');
        }

        async function calDeleteTerm(id) {
            calLocalSheetEdit++;
            try { await calPatchSettings({ terms: calTerms().filter(t => t.id !== id) }); } finally { calLocalSheetEdit--; }
            calRefreshSettingsList('terms');
        }
        // Term start/end shown IN the calendar (a setting, off by default).
        // These are derived markers, not events: they have no id, so nothing can
        // drag, edit, delete or remind on them.
        function calTermMarkers(from, to) {
            const out = [];
            for (const t of calSettings().terms || []) {
                for (const pair of [[t.start, 'starts'], [t.end, 'ends']]) {
                    const date = pair[0];
                    if (!CalE.isDate(date) || date < from || date > to) continue;
                    out.push({
                        uid: 'term:' + t.id + ':' + pair[1], eventId: null, occKey: date, calendarId: null,
                        kind: 'event', title: t.name + ' ' + pair[1], location: '', notes: '', url: '',
                        important: false, allDay: true, start: date, end: date,
                        recurring: false, overridden: false, done: false, synthetic: true
                    });
                }
            }
            return out;
        }

        function calTermRowsHtml() {
            const terms = calSettings().terms || [];
            if (!terms.length) return '<p class="cal-ed-hint">No terms yet. Add one and the calendar knows which week of term it is.</p>';
            return terms.map(t => `
                <div class="cal-term-row" data-id="${esc(t.id)}">
                    <input type="text" class="cal-input cal-term-name" maxlength="40" value="${esc(t.name)}"
                        onchange="calSetTerm(${jsAttr(t.id)}, 'name', this.value)">
                    <input type="date" class="cal-input cal-input-sm" value="${t.start}" onchange="calSetTerm(${jsAttr(t.id)}, 'start', this.value)">
                    <span class="cal-term-dash">to</span>
                    <input type="date" class="cal-input cal-input-sm" value="${t.end}" onchange="calSetTerm(${jsAttr(t.id)}, 'end', this.value)">
                    <span class="cal-term-len">${CalE.diffDays(t.start, t.end) + 1} days</span>
                    <button type="button" class="cal-icon-btn cal-icon-danger" title="Remove term"
                        onclick="calDeleteTerm(${jsAttr(t.id)})"><i class="far fa-trash-can"></i></button>
                </div>`).join('');
        }

        function calCalRowsHtml() {
            return calCalendars().map(c => `
                <div class="cal-cal-row" data-id="${esc(c.id)}">
                    <input type="color" class="cal-color" value="${esc(c.color)}" onchange="calSetCalField(${jsAttr(c.id)}, 'color', this.value)" title="Colour">
                    <input type="text" class="cal-input cal-cal-name" maxlength="40" value="${esc(c.name)}" onchange="calSetCalField(${jsAttr(c.id)}, 'name', this.value)">
                    ${calReminderSelect(c.id, 'defaultReminders', c.defaultReminders, false)}
                    <button type="button" class="cal-icon-btn${c.visible === false ? '' : ' is-on'}" title="${c.visible === false ? 'Hidden' : 'Shown'} in the calendar"
                        onclick="calSetCalField(${jsAttr(c.id)}, 'visible', ${c.visible === false ? 'true' : 'false'})"><i class="fas ${c.visible === false ? 'fa-eye-slash' : 'fa-eye'}"></i></button>
                    <button type="button" class="cal-icon-btn${c.notify === false ? '' : ' is-on'}" title="${c.notify === false ? 'No reminders from this calendar' : 'Reminders on'}"
                        onclick="calSetCalField(${jsAttr(c.id)}, 'notify', ${c.notify === false ? 'true' : 'false'})"><i class="fas ${c.notify === false ? 'fa-bell-slash' : 'fa-bell'}"></i></button>
                    <button type="button" class="cal-icon-btn cal-icon-danger" title="Delete calendar" onclick="calAskDeleteCalendar(${jsAttr(c.id)})"><i class="far fa-trash-can"></i></button>
                </div>`).join('');
        }

        // Re-draw ONE list inside the open settings sheet. Toggling an eye or a
        // bell changes markup rather than a native control, so that row has to be
        // redrawn — but rebuilding the whole sheet for it is what made settings
        // feel like it was refreshing under the cursor.
        function calRefreshSettingsList(which) {
            if (!calSheet || calSheet.type !== 'settings') return;
            const host = document.getElementById('cal-sheet-host');
            if (!host) return;
            const el = host.querySelector(which === 'terms' ? '.cal-term-list' : '.cal-cal-list');
            if (el) el.innerHTML = which === 'terms' ? calTermRowsHtml() : calCalRowsHtml();
            calSheetSig = calSheetSignature();
        }
        // ── Agenda view ───────────────────────────────────────────────────────

        function calAgendaHtml() {
            const today = calToday();
            const from = calCursor;
            const to = CalE.addDays(from, 44);
            const occs = calOccs(from, to);
            let html = '';
            if (from <= today) {
                const overdue = calOccs(CalE.addDays(today, -30), CalE.addDays(today, -1))
                    .filter(o => o.kind === 'task' && !o.done && CalE.evEndDate(o) < today);
                if (overdue.length) {
                    html += `<div class="cal-ag-group is-overdue">
                        <div class="cal-ag-date"><b><i class="fas fa-triangle-exclamation"></i></b><span>Overdue</span></div>
                        <div class="cal-list">${overdue.map(o => calItemHtml(o, CalE.evStartDate(o))).join('')}</div></div>`;
                }
            }
            let shown = 0;
            for (let d = from; d <= to; d = CalE.addDays(d, 1)) {
                const list = CalE.occurrencesOnDay(occs, d);
                if (!list.length) continue;
                shown++;
                html += `<div class="cal-ag-group${d === today ? ' is-today' : ''}">
                    <div class="cal-ag-date" onclick="calPickDay(${jsAttr(d)})"><b>${+d.slice(8, 10)}</b><span>${esc(CalE.fmtDayLabel(d, today) === CalE.fmtDateShort(d) ? CalE.WEEKDAYS_SHORT[CalE.dow(d)] + ' · ' + CalE.MONTHS_SHORT[+d.slice(5, 7) - 1] : CalE.fmtDayLabel(d, today))}</span></div>
                    <div class="cal-list">${list.map(o => calItemHtml(o, d)).join('')}</div>
                </div>`;
            }
            if (!shown && !html) return calEmptyHtml('far fa-calendar-check', 'Nothing in the next six weeks', 'Add a class, a shift, a deadline — type it above in plain words.');
            return `<div class="cal-agenda">${html}</div>`;
        }

        // ── Search ────────────────────────────────────────────────────────────

        function calSearchHtml() {
            const hits = CalE.searchEvents(calState.events, calSearchQuery, calToday(), calIsVisible).slice(0, 60);
            if (!hits.length) return calEmptyHtml('fas fa-magnifying-glass', 'No matches', 'Search looks through titles, places and notes.');
            return `<div class="cal-list cal-search-results">${hits.map(o => `<div class="cal-search-date">${esc(CalE.fmtDayLabel(CalE.evStartDate(o), calToday()))}</div>${calItemHtml(o, CalE.evStartDate(o))}`).join('')}</div>`;
        }

        function calToggleSearch(force) {
            calSearchOpen = typeof force === 'boolean' ? force : !calSearchOpen;
            const bar = document.getElementById('cal-searchbar');
            const input = document.getElementById('cal-search-input');
            if (bar) bar.classList.toggle('hidden', !calSearchOpen);
            if (!calSearchOpen) { calSearchQuery = ''; if (input) input.value = ''; }
            calRenderDynamic();
            if (calSearchOpen && input) input.focus();
        }

        function calSearchInput(v) {
            calSearchQuery = v;
            const view = document.getElementById('cal-view');
            if (!view) return;
            if (v.trim()) view.innerHTML = calSearchHtml();
            else calRenderDynamic();
        }

        // ── Navigation ────────────────────────────────────────────────────────

        function calSetView(v) {
            if (!CAL_VIEWS.some(x => x[0] === v)) return;
            calView = v;
            try { localStorage.setItem('calendarView', v); } catch (e) { /* ignore */ }
            if (calSearchOpen) calToggleSearch(false);
            if (v === 'agenda' && calCursor < calToday() && calIsShowingToday() === false) calCursor = calToday();
            calRenderDynamic();
        }

        function calNav(dir) {
            if (calView === 'year') {
                calCursor = CalE.addMonths(calCursor, 12 * dir);
                calSelected = calCursor;
            } else if (calView === 'month') {
                calCursor = CalE.addMonths(CalE.startOfMonth(calCursor), dir);
                const today = calToday();
                calSelected = calCursor.slice(0, 7) === today.slice(0, 7) ? today : calCursor;
            } else {
                calCursor = CalE.addDays(calCursor, 7 * dir);
                calSelected = calCursor;
            }
            calRenderDynamic();
        }

        function calGoToday() {
            calCursor = calToday();
            calSelected = calCursor;
            calRenderDynamic();
        }

        function calSelectDay(d) {
            if (!CalE.isDate(d)) return;
            calSelected = d;
            if (d.slice(0, 7) !== calCursor.slice(0, 7)) {
                calCursor = d;
                calRenderDynamic();
                return;
            }
            document.querySelectorAll('#cal-view .cal-cell.is-selected').forEach(c => c.classList.remove('is-selected'));
            const cell = document.querySelector(`#cal-view .cal-cell[data-date="${d}"]`);
            if (cell) cell.classList.add('is-selected');
            const list = document.getElementById('cal-daylist');
            if (list) list.innerHTML = calDayListHtml(d);
            calRefreshQuickPreview();
        }

        // From a week/agenda day header: jump to that day in the month view.
        function calPickDay(d) {
            calCursor = d;
            calSelected = d;
            calSetView('month');
        }

        function calToggleVisible(id) {
            const c = calFindCal(id);
            if (!c || !window.electronAPI?.calendarSaveCalendar) return;
            calCall(() => window.electronAPI.calendarSaveCalendar({ id, visible: c.visible === false }));
        }

        function calJoin(url) {
            if (window.electronAPI?.calendarOpenLink) window.electronAPI.calendarOpenLink(url);
        }

        async function calToggleDone(eventId, occKey, done) {
            const res = await calCall(() => window.electronAPI.calendarSetDone(eventId, occKey, done));
            if (res && res.ok !== false && done) calCelebrate(eventId);
        }

        // A tiny burst on the tick box when something gets done.
        function calCelebrate(eventId) {
            const el = document.querySelector(`#cal-view .cal-item[data-uid^="${CSS.escape(eventId)}|"] .cal-check`);
            if (el) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
        }

        // ── Quick add ─────────────────────────────────────────────────────────
        // Parsing happens in the engine; this is the live preview of what it
        // understood and the mapping from a parse to a real event.

        function calParse(text) {
            const s = calSettings();
            return CalE.parseQuickAdd(text, {
                now: Date.now(), weekStart: s.weekStart, dateOrder: calDateOrder(), defaultDuration: s.defaultDuration
            });
        }

        function calDefaultCalendarId() {
            const writable = calWritable();
            if (!writable.length) return null;
            const last = localStorage.getItem('calendarLastCal');
            return (last && writable.some(c => c.id === last)) ? last : writable[0].id;
        }

        // Which calendar a typed line belongs in: an explicit #tag wins, then the
        // words it used (a deadline goes to Deadlines, a lecture to School), then
        // whichever calendar was used last.
        function calPickCalendar(p) {
            const writable = calWritable();
            if (!writable.length) return null;
            if (p.calendarName) {
                const n = p.calendarName.toLowerCase();
                const hit = writable.find(c => c.name.toLowerCase() === n)
                    || writable.find(c => c.name.toLowerCase().startsWith(n))
                    || writable.find(c => c.name.toLowerCase().includes(n));
                if (hit) return hit.id;
            }
            const byId = (id) => writable.find(c => c.id === id);
            if ((p.kind === 'task' || p.tags.includes('exam')) && byId('deadlines')) return byId('deadlines').id;
            if (p.tags.includes('school') && byId('school')) return byId('school').id;
            if (p.tags.includes('work') && byId('work')) return byId('work').id;
            return calDefaultCalendarId();
        }

        function calDraftFromParse(p) {
            const draft = {
                id: null,
                kind: p.kind,
                title: p.title || (p.kind === 'task' ? 'Untitled task' : 'Untitled event'),
                calendarId: calPickCalendar(p),
                allDay: p.allDay,
                start: p.start,
                end: p.end,
                reminders: p.reminders === undefined ? null : p.reminders,
                important: !!p.important || p.tags.includes('exam'),
                rrule: p.rrule || null,
                location: p.location || '',
                notes: '',
                url: ''
            };
            if (!p.hasDate) {
                // No date in the words: it lands on the day you're looking at.
                const d = calSelected || calToday();
                draft.allDay = true;
                draft.start = d;
                draft.end = d;
            }
            return draft;
        }

        function calQuickInput(value) {
            const box = document.getElementById('cal-quick-preview');
            if (!box) return;
            const text = String(value || '').trim();
            if (!text) { box.innerHTML = calQuickHintHtml(); return; }
            const p = calParse(text);
            const draft = calDraftFromParse(p);
            const cal = calFindCal(draft.calendarId);
            const chips = [];
            if (cal) chips.push(`<span class="cal-qchip"><span class="cal-dot" style="--c:${cal.color}"></span>${esc(cal.name)}</span>`);
            if (draft.kind === 'task') chips.push(`<span class="cal-qchip"><i class="far fa-square-check"></i>Task</span>`);
            const when = draft.allDay
                ? `${CalE.fmtDateShort(CalE.datePart(draft.start))} · all day`
                : `${CalE.fmtDateShort(CalE.datePart(draft.start))} · ${CalE.fmtTimeRange(CalE.timePart(draft.start), CalE.timePart(draft.end), calClock24())}`;
            chips.push(`<span class="cal-qchip${p.hasDate ? ' is-strong' : ''}"><i class="far fa-calendar"></i>${esc(when)}${p.hasDate ? '' : ' (the day you\'re on)'}</span>`);
            if (draft.rrule) chips.push(`<span class="cal-qchip"><i class="fas fa-repeat"></i>${esc(calRepeatLabel(draft.rrule, CalE.datePart(draft.start)))}</span>`);
            if (Array.isArray(draft.reminders)) {
                chips.push(`<span class="cal-qchip"><i class="far fa-bell"></i>${draft.reminders.length
                    ? esc(draft.reminders.map(m => CalE.fmtOffset(m, draft.allDay)).join(', ') + (draft.reminders.some(m => m > 0) ? ' before' : ''))
                    : 'No reminder'}</span>`);
            }
            if (draft.location) chips.push(`<span class="cal-qchip"><i class="fas fa-location-dot"></i>${esc(draft.location)}</span>`);
            if (draft.important) chips.push(`<span class="cal-qchip is-important"><i class="fas fa-star"></i>Important</span>`);
            box.innerHTML = `<span class="cal-qtitle">${esc(draft.title)}</span>${chips.join('')}`;
        }

        // An undated line ("Read chapter 4") lands on the day you're looking at,
        // and the preview says so — redraw it whenever that day changes.
        function calRefreshQuickPreview() {
            const input = document.getElementById('cal-quick-input');
            if (input && input.value.trim()) calQuickInput(input.value);
        }

        function calQuickKey(e) {
            if (e.key === 'Enter') { e.preventDefault(); calQuickSubmit(e.shiftKey); }
            else if (e.key === 'Tab' && !e.shiftKey && e.target.value.trim()) { e.preventDefault(); calQuickSubmit(true); }
            else if (e.key === 'Escape' && e.target.value) { e.preventDefault(); e.stopPropagation(); e.target.value = ''; calQuickInput(''); }
        }

        // `details` opens the full editor prefilled instead of adding straight away.
        async function calQuickSubmit(details) {
            const input = document.getElementById('cal-quick-input');
            if (!input) return;
            const text = input.value.trim();
            if (!text) { if (details) calNewEvent(); return; }
            if (!calWritable().length) { showToast('Add a calendar first (the sliders button)', true); return; }
            const draft = calDraftFromParse(calParse(text));
            if (details) {
                calOpenEditor(null, draft);
                input.value = '';
                calQuickInput('');
                return;
            }
            const res = await calCall(() => window.electronAPI.calendarSaveEvent(draft, null));
            if (!res || res.ok === false) return;
            input.value = '';
            calQuickInput('');
            if (draft.calendarId) { try { localStorage.setItem('calendarLastCal', draft.calendarId); } catch (e) { /* ignore */ } }
            const day = CalE.datePart(draft.start);
            calSelected = day;
            if (calView === 'month' ? day.slice(0, 7) !== calCursor.slice(0, 7) : true) calCursor = day;
            calFlashUid = res.id ? res.id + '|' + day : null;
            calRenderDynamic();
            const when = draft.allDay ? CalE.fmtDayLabel(day, calToday()) : CalE.fmtDayLabel(day, calToday()) + ' ' + calFmtTime(CalE.timePart(draft.start));
            showToast(`Added “${draft.title}” · ${when}`);
        }

        // ── Sheets (editor / settings / notifications) ────────────────────────
        // Overlays inside #widget-detail, so they cover the whole widget panel
        // and survive repaints of the calendar underneath.

        function calSheetHost(create) {
            let host = document.getElementById('cal-sheet-host');
            if (host || !create) return host;
            const detail = document.getElementById('widget-detail');
            if (!detail) return null;
            host = document.createElement('div');
            host.id = 'cal-sheet-host';
            host.className = 'cal-sheet-host';
            detail.appendChild(host);
            return host;
        }

        function calOpenSheet(sheet) {
            calSheet = sheet;
            const host = calSheetHost(true);
            if (!host) { calSheet = null; return; }
            calRenderSheet();
            host.classList.remove('is-in');
            void host.offsetWidth;
            host.classList.add('is-in');
        }

        function calCloseSheet() {
            const host = document.getElementById('cal-sheet-host');
            calSheet = null;
            calEditor = null;
            if (!host) return;
            host.classList.remove('is-in');
            host.innerHTML = '';
        }

        function calRenderSheet() {
            const host = document.getElementById('cal-sheet-host');
            if (!host || !calSheet) return;
            // Keep the reader where they were when a re-draw is unavoidable.
            const openBody = host.querySelector('.cal-sheet-body');
            const keepScroll = openBody ? openBody.scrollTop : 0;
            let body = '';
            if (calSheet.type === 'editor') body = calEditorHtml();
            else if (calSheet.type === 'settings') body = calSettingsHtml();
            else if (calSheet.type === 'inbox') body = calInboxHtml();
            else if (calSheet.type === 'confirm') body = calConfirmHtml();
            host.innerHTML = `<div class="cal-sheet-scrim" onclick="calCloseSheet()"></div>${body}`;
            const newBody = host.querySelector('.cal-sheet-body');
            if (newBody && keepScroll) newBody.scrollTop = keepScroll;
            calSheetSig = calSheetSignature();
            if (calSheet.type === 'editor' && calSheet.focusTitle) {
                const t = document.getElementById('cal-ed-title');
                if (t) { t.focus(); t.select(); }
                calSheet.focusTitle = false;
            }
        }

        // ── Event editor ──────────────────────────────────────────────────────

        function calDefaultStartMin(date) {
            if (date !== calToday()) return 9 * 60;
            const m = CalE.minuteOfDay(Date.now());
            return Math.min(22 * 60, Math.ceil((m + 5) / 30) * 30);
        }

        function calNewDraft(opts) {
            const o = opts || {};
            const s = calSettings();
            const date = o.date || calSelected || calToday();
            const allDay = typeof o.allDay === 'boolean' ? o.allDay : (o.startMin === undefined);
            let start, end;
            if (allDay) {
                start = date;
                end = date;
            } else {
                const startMin = o.startMin !== undefined ? o.startMin : calDefaultStartMin(date);
                const endMin = o.endMin !== undefined ? o.endMin : startMin + s.defaultDuration;
                start = date + 'T' + CalE.hhmm(startMin);
                end = CalE.fromWall(CalE.dayNum(date) * 1440 + Math.max(endMin, startMin + 15));
            }
            return {
                id: null, kind: o.kind || 'event', title: '', calendarId: calDefaultCalendarId(),
                allDay, start, end, reminders: null, important: false, rrule: null, location: '', notes: '', url: ''
            };
        }

        function calNewEvent() { calOpenEditor(null, calNewDraft({ date: calSelected })); }
        function calNewOn(date, startMin, endMin) { calOpenEditor(null, calNewDraft({ date, startMin, endMin })); }

        function calChipClick(eventId, occKey) {
            // The click a browser fires after a drag is not a click.
            if (calSuppressClick || (calDrag && calDrag.moved)) return;
            calOpenOcc(eventId, occKey);
        }

        function calOpenOcc(eventId, occKey) {
            const ev = calFindEvent(eventId);
            if (!ev) return;
            const occ = CalE.occurrenceFor(ev, occKey) || CalE.buildOccurrence(ev, CalE.evStartDate(ev), null);
            calOpenEditor(occ);
        }

        // occ === null → a new event built from `draftOverride`.
        function calOpenEditor(occ, draftOverride) {
            const ev = occ ? calFindEvent(occ.eventId) : null;
            let draft;
            if (draftOverride) {
                draft = Object.assign({}, draftOverride);
            } else if (ev && occ) {
                draft = {
                    id: ev.id, kind: ev.kind, title: occ.title, calendarId: ev.calendarId,
                    allDay: occ.allDay, start: occ.start, end: occ.end,
                    reminders: Array.isArray(ev.reminders) ? ev.reminders.slice() : null,
                    important: !!ev.important, rrule: ev.rrule ? JSON.parse(JSON.stringify(ev.rrule)) : null,
                    location: occ.location || '', notes: occ.notes || '', url: ev.url || ''
                };
            } else {
                draft = calNewDraft({});
            }
            calEditor = {
                draft,
                original: ev,
                occ: occ || null,
                scope: 'all',
                deleteArmed: false,
                readOnly: !!(ev && calIsReadOnly(ev))
            };
            calOpenSheet({ type: 'editor', focusTitle: !ev });
        }

        function calEdPatch(patch, rerender) {
            if (!calEditor) return;
            Object.assign(calEditor.draft, patch);
            if (rerender !== false) calRenderSheet();
        }

        function calEdField(field, value) {
            if (!calEditor) return;
            calEditor.draft[field] = value;
        }

        function calEdKind(kind) {
            if (!calEditor) return;
            const d = calEditor.draft;
            d.kind = kind;
            if (kind === 'task') d.end = d.start;
            else if (!d.allDay && CalE.wall(d.end) <= CalE.wall(d.start)) d.end = CalE.fromWall(CalE.wall(d.start) + calSettings().defaultDuration);
            calRenderSheet();
        }

        function calEdAllDay(on) {
            if (!calEditor) return;
            const d = calEditor.draft;
            if (on) {
                const s = CalE.datePart(d.start);
                d.allDay = true;
                d.start = s;
                d.end = d.kind === 'task' ? s : CalE.datePart(d.end) < s ? s : CalE.datePart(d.end);
            } else {
                const date = CalE.datePart(d.start);
                const startMin = calDefaultStartMin(date);
                d.allDay = false;
                d.start = date + 'T' + CalE.hhmm(startMin);
                d.end = d.kind === 'task' ? d.start : CalE.fromWall(CalE.wall(d.start) + calSettings().defaultDuration);
            }
            calRenderSheet();
        }

        // Moving the start keeps the length; moving the end never lands before it.
        function calEdStart(part, value) {
            if (!calEditor) return;
            const d = calEditor.draft;
            const len = d.allDay ? CalE.diffDays(CalE.datePart(d.start), CalE.datePart(d.end)) : CalE.wall(d.end) - CalE.wall(d.start);
            let next;
            if (part === 'date') {
                if (!CalE.isDate(value)) return;
                next = d.allDay ? value : value + 'T' + CalE.timePart(d.start);
            } else {
                if (!CalE.isTime(value)) return;
                next = CalE.datePart(d.start) + 'T' + value;
            }
            d.start = next;
            d.end = d.kind === 'task' ? next : (d.allDay ? CalE.addDays(next, Math.max(0, len)) : CalE.fromWall(CalE.wall(next) + Math.max(15, len)));
            calRenderSheet();
        }

        function calEdEnd(part, value) {
            if (!calEditor) return;
            const d = calEditor.draft;
            let next;
            if (part === 'date') {
                if (!CalE.isDate(value)) return;
                next = d.allDay ? value : value + 'T' + CalE.timePart(d.end);
            } else {
                if (!CalE.isTime(value)) return;
                next = CalE.datePart(d.end) + 'T' + value;
            }
            if (d.allDay) d.end = next < CalE.datePart(d.start) ? CalE.datePart(d.start) : next;
            else if (CalE.wall(next) <= CalE.wall(d.start)) d.end = CalE.fromWall(CalE.wall(d.start) + 15);
            else d.end = next;
            calRenderSheet();
        }

        // Repeat presets ↔ rrule. "Custom" exposes interval + unit.
        function calRepeatValue(r, startDate) {
            if (!r) return 'none';
            if (r.interval === 1 && r.freq === 'daily') return 'daily';
            if (r.freq === 'weekly' && r.interval === 1) {
                const set = (r.byDay || []).slice().sort().join(',');
                if (set === '1,2,3,4,5') return 'weekdays';
                if (set === String(CalE.dow(startDate))) return 'weekly';
                return 'custom';
            }
            if (r.freq === 'weekly' && r.interval === 2 && (r.byDay || []).join(',') === String(CalE.dow(startDate))) return 'biweekly';
            if (r.freq === 'monthly' && r.interval === 1) return r.monthMode === 'nth' ? 'monthly-nth' : 'monthly';
            if (r.freq === 'yearly' && r.interval === 1 && r.monthMode !== 'nth') return 'yearly';
            return 'custom';
        }

        function calEdRepeat(value) {
            if (!calEditor) return;
            const d = calEditor.draft;
            const date = CalE.datePart(d.start);
            const keep = d.rrule ? { until: d.rrule.until || null, count: d.rrule.count || null } : { until: null, count: null };
            const make = (r) => Object.assign(r, keep);
            if (value === 'none') d.rrule = null;
            else if (value === 'daily') d.rrule = make({ freq: 'daily', interval: 1 });
            else if (value === 'weekdays') d.rrule = make({ freq: 'weekly', interval: 1, byDay: [1, 2, 3, 4, 5] });
            else if (value === 'weekly') d.rrule = make({ freq: 'weekly', interval: 1, byDay: [CalE.dow(date)] });
            else if (value === 'biweekly') d.rrule = make({ freq: 'weekly', interval: 2, byDay: [CalE.dow(date)] });
            else if (value === 'monthly') d.rrule = make({ freq: 'monthly', interval: 1, monthMode: 'day' });
            else if (value === 'monthly-nth') d.rrule = make({ freq: 'monthly', interval: 1, monthMode: 'nth', nth: CalE.nthOfMonth(date) });
            else if (value === 'yearly') d.rrule = make({ freq: 'yearly', interval: 1, monthMode: 'day' });
            else if (value === 'custom') d.rrule = make(Object.assign({ freq: 'weekly', interval: 2, byDay: [CalE.dow(date)] }, d.rrule || {}));
            calRenderSheet();
        }

        function calEdRuleField(field, value) {
            if (!calEditor || !calEditor.draft.rrule) return;
            const r = calEditor.draft.rrule;
            if (field === 'interval') r.interval = Math.min(99, Math.max(1, Math.round(Number(value) || 1)));
            else if (field === 'freq') {
                r.freq = value;
                if (value === 'weekly' && !(r.byDay || []).length) r.byDay = [CalE.dow(CalE.datePart(calEditor.draft.start))];
                if (value === 'monthly' || value === 'yearly') r.monthMode = r.monthMode || 'day';
            } else if (field === 'until') { r.until = CalE.isDate(value) ? value : null; r.count = null; }
            else if (field === 'count') { r.count = Math.min(999, Math.max(1, Math.round(Number(value) || 1))); r.until = null; }
            calRenderSheet();
        }

        function calEdEnds(mode) {
            if (!calEditor || !calEditor.draft.rrule) return;
            const r = calEditor.draft.rrule;
            if (mode === 'never') { r.until = null; r.count = null; }
            else if (mode === 'until') { r.count = null; r.until = CalE.addDays(CalE.datePart(calEditor.draft.start), 90); }
            else { r.until = null; r.count = 10; }
            calRenderSheet();
        }

        function calEdToggleDay(n) {
            if (!calEditor || !calEditor.draft.rrule) return;
            const r = calEditor.draft.rrule;
            const set = new Set(r.byDay || []);
            if (set.has(n)) set.delete(n); else set.add(n);
            if (!set.size) set.add(n);
            r.byDay = Array.from(set).sort((a, b) => a - b);
            calRenderSheet();
        }

        function calEdReminders() {
            if (!calEditor) return [];
            const d = calEditor.draft;
            if (Array.isArray(d.reminders)) return d.reminders;
            const cal = calFindCal(d.calendarId);
            return CalE.effectiveReminders(d, cal);
        }

        function calEdAddReminder(value) {
            if (!calEditor || value === '') return;
            const list = calEdReminders().slice();
            const n = Number(value);
            if (!list.includes(n)) list.push(n);
            calEditor.draft.reminders = list.sort((a, b) => a - b).slice(0, 6);
            calRenderSheet();
        }

        function calEdRemoveReminder(min) {
            if (!calEditor) return;
            calEditor.draft.reminders = calEdReminders().filter(m => m !== min);
            calRenderSheet();
        }

        function calEdUseDefaultReminders() {
            if (!calEditor) return;
            calEditor.draft.reminders = null;
            calRenderSheet();
        }

        function calEdScope(scope) {
            if (!calEditor) return;
            calEditor.scope = scope;
            calRenderSheet();
        }

        function calEditorHtml() {
            const ed = calEditor;
            if (!ed) return '';
            const d = ed.draft;
            const isTask = d.kind === 'task';
            const date = CalE.datePart(d.start);
            const recurringEdit = !!(ed.original && ed.original.rrule && ed.occ);
            if (ed.readOnly) return calReadOnlyHtml();

            const cals = calWritable().map(c => `
                <button type="button" class="cal-calchip${c.id === d.calendarId ? ' on' : ''}" style="--c:${c.color}"
                    onclick="calEdPatch({calendarId: ${jsAttr(c.id)}})" title="${esc(c.name)}"><span class="cal-dot"></span><span>${esc(c.name)}</span></button>`).join('');

            const repeatValue = calRepeatValue(d.rrule, date);
            const repeatOptions = [
                ['none', 'Does not repeat'], ['daily', 'Every day'], ['weekdays', 'Every weekday (Mon–Fri)'],
                ['weekly', 'Every week on ' + CalE.WEEKDAYS[CalE.dow(date)]], ['biweekly', 'Every 2 weeks'],
                ['monthly', 'Every month on day ' + (+date.slice(8, 10))],
                ['monthly-nth', 'Every month on the ' + (CalE.nthOfMonth(date) === -1 ? 'last' : ['', '1st', '2nd', '3rd', '4th'][CalE.nthOfMonth(date)]) + ' ' + CalE.WEEKDAYS[CalE.dow(date)]],
                ['yearly', 'Every year'], ['custom', 'Custom…']
            ].map(([v, l]) => `<option value="${v}"${v === repeatValue ? ' selected' : ''}>${esc(l)}</option>`).join('');

            const r = d.rrule;
            const showDays = r && r.freq === 'weekly';
            const weekStart = calSettings().weekStart;
            let dayToggles = '';
            if (showDays) {
                for (let i = 0; i < 7; i++) {
                    const n = (weekStart + i) % 7;
                    dayToggles += `<button type="button" class="cal-day-toggle${(r.byDay || []).includes(n) ? ' on' : ''}" onclick="calEdToggleDay(${n})">${CalE.WEEKDAYS_SHORT[n][0]}</button>`;
                }
            }
            const endsMode = r ? (r.until ? 'until' : (r.count ? 'count' : 'never')) : 'never';
            const reminders = calEdReminders();
            const usingDefault = !Array.isArray(d.reminders);
            const options = (d.allDay ? CAL_ALLDAY_REMINDERS : CAL_TIMED_REMINDERS).filter(m => !reminders.includes(m));

            return `<div class="cal-sheet cal-sheet-editor" role="dialog" aria-modal="true">
                <div class="cal-sheet-head">
                    <span class="cal-sheet-kicker">${ed.original ? 'Edit' : 'New'} ${isTask ? 'task' : 'event'}${recurringEdit ? ' · repeating' : ''}</span>
                    <button type="button" class="cal-icon-btn" onclick="calCloseSheet()" title="Close (Esc)"><i class="fas fa-xmark"></i></button>
                </div>
                <div class="cal-sheet-body">
                    <input id="cal-ed-title" class="cal-ed-title" type="text" maxlength="200" placeholder="${isTask ? 'What needs doing?' : 'Add a title'}"
                        value="${esc(d.title)}" oninput="calEdField('title', this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault();calEdSave();}">

                    <div class="cal-ed-row">
                        <div class="cal-seg cal-seg-sm">
                            <button type="button" class="cal-seg-btn${!isTask ? ' on' : ''}" onclick="calEdKind('event')"><i class="far fa-calendar"></i><span>Event</span></button>
                            <button type="button" class="cal-seg-btn${isTask ? ' on' : ''}" onclick="calEdKind('task')"><i class="far fa-square-check"></i><span>Task</span></button>
                        </div>
                        ${isTask ? `<button type="button" class="cal-star-btn cal-done-btn${calEdIsDone() ? ' on' : ''}"
                            onclick="calEdToggleDone()" title="${calEdIsDone() ? 'Mark not done' : 'Mark done'}"><i
                            class="${calEdIsDone() ? 'fas fa-square-check' : 'far fa-square'}"></i>${calEdIsDone() ? 'Done' : 'Mark done'}</button>` : ''}
                        <button type="button" class="cal-star-btn${d.important ? ' on' : ''}" onclick="calEdPatch({important: ${d.important ? 'false' : 'true'}})"
                            title="Important — always notifies, even in quiet hours"><i class="${d.important ? 'fas' : 'far'} fa-star"></i>Important</button>
                    </div>

                    <div class="cal-ed-cals">${cals}</div>

                    <label class="cal-ed-check">
                        <span class="ios-toggle"><input type="checkbox" class="ios-toggle-input"${d.allDay ? ' checked' : ''} onchange="calEdAllDay(this.checked)"><span class="ios-toggle-track"></span></span>
                        <span>All day</span>
                    </label>

                    <div class="cal-ed-when">
                        <div class="cal-ed-when-row">
                            <label>${isTask ? 'Due' : 'Starts'}</label>
                            <input type="date" class="cal-input" value="${date}" onchange="calEdStart('date', this.value)">
                            ${d.allDay ? '' : `<input type="time" class="cal-input" value="${CalE.timePart(d.start)}" onchange="calEdStart('time', this.value)">`}
                        </div>
                        ${isTask ? '' : `<div class="cal-ed-when-row">
                            <label>Ends</label>
                            <input type="date" class="cal-input" value="${CalE.datePart(d.end)}" onchange="calEdEnd('date', this.value)">
                            ${d.allDay ? '' : `<input type="time" class="cal-input" value="${CalE.timePart(d.end)}" onchange="calEdEnd('time', this.value)">`}
                            <span class="cal-ed-len">${d.allDay ? (CalE.diffDays(date, CalE.datePart(d.end)) + 1) + ' days' : CalE.fmtDuration(Math.max(0, CalE.wall(d.end) - CalE.wall(d.start)))}</span>
                        </div>`}
                    </div>

                    <div class="cal-ed-field">
                        <label class="cal-ed-label"><i class="fas fa-repeat"></i>Repeat</label>
                        <select class="cal-input cal-input-wide" onchange="calEdRepeat(this.value)">${repeatOptions}</select>
                        ${r && repeatValue === 'custom' ? `<div class="cal-ed-sub">
                            <span>Every</span>
                            <input type="number" class="cal-input cal-input-num" min="1" max="99" value="${r.interval}" onchange="calEdRuleField('interval', this.value)">
                            <select class="cal-input" onchange="calEdRuleField('freq', this.value)">
                                ${['daily', 'weekly', 'monthly', 'yearly'].map(f => `<option value="${f}"${r.freq === f ? ' selected' : ''}>${{ daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' }[f]}</option>`).join('')}
                            </select>
                        </div>` : ''}
                        ${showDays ? `<div class="cal-day-toggles">${dayToggles}</div>` : ''}
                        ${r ? `<div class="cal-ed-sub">
                            <span>Ends</span>
                            <select class="cal-input" onchange="calEdEnds(this.value)">
                                <option value="never"${endsMode === 'never' ? ' selected' : ''}>Never</option>
                                <option value="until"${endsMode === 'until' ? ' selected' : ''}>On a date</option>
                                <option value="count"${endsMode === 'count' ? ' selected' : ''}>After…</option>
                            </select>
                            ${endsMode === 'until' ? `<input type="date" class="cal-input" value="${r.until}" min="${date}" onchange="calEdRuleField('until', this.value)">` : ''}
                            ${endsMode === 'count' ? `<input type="number" class="cal-input cal-input-num" min="1" max="999" value="${r.count}" onchange="calEdRuleField('count', this.value)"><span>times</span>` : ''}
                        </div>` : ''}
                        ${r ? `<p class="cal-ed-hint">${esc(calRepeatLabel(r, date))}</p>` : ''}
                    </div>

                    <div class="cal-ed-field">
                        <label class="cal-ed-label"><i class="far fa-bell"></i>Reminders${usingDefault ? ' <span class="cal-ed-tag">calendar default</span>' : ''}</label>
                        <div class="cal-rem-chips">
                            ${reminders.length ? reminders.map(m => `<span class="cal-rem-chip">${esc(CalE.fmtOffset(m, d.allDay))}${m > 0 ? ' before' : ''}
                                <button type="button" onclick="calEdRemoveReminder(${m})" title="Remove"><i class="fas fa-xmark"></i></button></span>`).join('')
                                : '<span class="cal-ed-hint">No reminder</span>'}
                            ${options.length ? `<select class="cal-rem-add" onchange="calEdAddReminder(this.value); this.value='';">
                                <option value="">+ Add</option>
                                ${options.map(m => `<option value="${m}">${esc(CalE.fmtOffset(m, d.allDay))}${m > 0 ? ' before' : ''}</option>`).join('')}
                            </select>` : ''}
                            ${usingDefault ? '' : '<button type="button" class="cal-ghost-btn cal-ghost-sm" onclick="calEdUseDefaultReminders()">Use default</button>'}
                        </div>
                        ${d.allDay ? `<p class="cal-ed-hint">All-day reminders arrive at ${esc(calFmtTime(calSettings().allDayReminderTime))}.</p>` : ''}
                    </div>

                    <div class="cal-ed-field">
                        <label class="cal-ed-label"><i class="fas fa-location-dot"></i>Place &amp; link</label>
                        <input type="text" class="cal-input cal-input-wide" maxlength="300" placeholder="Room 204, the gym, anywhere"
                            value="${esc(d.location)}" oninput="calEdField('location', this.value)">
                        <input type="text" class="cal-input cal-input-wide" maxlength="1000" placeholder="https://… (a Zoom/Teams/Meet link shows a Join button)"
                            value="${esc(d.url)}" oninput="calEdField('url', this.value)">
                    </div>

                    <div class="cal-ed-field">
                        <label class="cal-ed-label"><i class="far fa-note-sticky"></i>Notes</label>
                        <textarea class="cal-input cal-input-wide cal-ed-notes" maxlength="5000" rows="3" placeholder="Anything else worth remembering"
                            oninput="calEdField('notes', this.value)">${esc(d.notes)}</textarea>
                    </div>

                    ${recurringEdit ? `<div class="cal-ed-field">
                        <label class="cal-ed-label"><i class="fas fa-code-branch"></i>Apply to</label>
                        <div class="cal-seg cal-seg-sm cal-seg-3">
                            ${[['this', 'This one'], ['following', 'This &amp; after'], ['all', 'All']].map(([v, l]) =>
                                `<button type="button" class="cal-seg-btn${calEditor.scope === v ? ' on' : ''}" onclick="calEdScope(${jsAttr(v)})">${l}</button>`).join('')}
                        </div>
                        <p class="cal-ed-hint">${calEditor.scope === 'this' ? 'Only the occurrence you opened changes.'
                            : calEditor.scope === 'following' ? 'This occurrence and every one after it change; earlier ones stay as they are.'
                            : 'Every occurrence changes, including ones already past.'}</p>
                    </div>` : ''}
                </div>
                <div class="cal-sheet-foot">
                    ${ed.original ? `<button type="button" class="cal-btn cal-btn-danger" onclick="calEdDelete()"><i class="far fa-trash-can"></i>Delete</button>
                        <button type="button" class="cal-btn cal-btn-ghost" onclick="calEdDuplicate()" title="Make a copy"><i class="far fa-copy"></i></button>` : ''}
                    <span class="cal-foot-spacer"></span>
                    <button type="button" class="cal-btn cal-btn-ghost" onclick="calCloseSheet()">Cancel</button>
                    <button type="button" class="cal-btn cal-btn-primary" onclick="calEdSave()"><i class="fas fa-check"></i>${ed.original ? 'Save' : 'Add'}</button>
                </div>
            </div>`;
        }

        // Events from a subscribed calendar are shown, never edited.
        function calReadOnlyHtml() {
            const d = calEditor.draft;
            const cal = calFindCal(d.calendarId);
            const occ = calEditor.occ || d;
            const link = CalE.findMeetingLink(Object.assign({}, d));
            return `<div class="cal-sheet cal-sheet-editor" role="dialog" aria-modal="true">
                <div class="cal-sheet-head">
                    <span class="cal-sheet-kicker"><i class="fas fa-link"></i> Subscribed${cal ? ' · ' + esc(cal.name) : ''}</span>
                    <button type="button" class="cal-icon-btn" onclick="calCloseSheet()" title="Close (Esc)"><i class="fas fa-xmark"></i></button>
                </div>
                <div class="cal-sheet-body">
                    <h3 class="cal-ro-title">${esc(d.title)}</h3>
                    <p class="cal-ro-when">${esc(CalE.fmtDateLong(CalE.datePart(d.start)))} · ${esc(calTimeLabel(occ))}</p>
                    ${d.location ? `<p class="cal-ro-line"><i class="fas fa-location-dot"></i>${esc(d.location)}</p>` : ''}
                    ${d.rrule ? `<p class="cal-ro-line"><i class="fas fa-repeat"></i>${esc(calRepeatLabel(d.rrule, CalE.datePart(d.start)))}</p>` : ''}
                    ${d.notes ? `<p class="cal-ro-notes selectable">${esc(d.notes)}</p>` : ''}
                    <p class="cal-ed-hint">This comes from a calendar you subscribed to, so it updates itself and can't be edited here.</p>
                </div>
                <div class="cal-sheet-foot">
                    ${link ? `<button type="button" class="cal-btn cal-btn-ghost" onclick="calJoin(${jsAttr(link)})"><i class="fas fa-video"></i>Join</button>` : ''}
                    <span class="cal-foot-spacer"></span>
                    <button type="button" class="cal-btn cal-btn-ghost" onclick="calEdDuplicate()"><i class="far fa-copy"></i>Copy to my calendar</button>
                    <button type="button" class="cal-btn cal-btn-primary" onclick="calCloseSheet()">Close</button>
                </div>
            </div>`;
        }

        // Editing the whole series from one occurrence: the change the user made
        // to THIS occurrence is applied as a shift to the series itself.
        function calSeriesTimes(ev, occ, draft) {
            const dayDelta = CalE.diffDays(CalE.evStartDate(occ), CalE.datePart(draft.start));
            if (draft.allDay !== occ.allDay || draft.allDay) {
                const base = CalE.addDays(CalE.evStartDate(ev), dayDelta);
                if (draft.allDay) {
                    return { start: base, end: CalE.addDays(base, CalE.diffDays(CalE.datePart(draft.start), CalE.datePart(draft.end))), dayDelta };
                }
                const s = base + 'T' + CalE.timePart(draft.start);
                return { start: s, end: CalE.fromWall(CalE.wall(s) + (CalE.wall(draft.end) - CalE.wall(draft.start))), dayDelta };
            }
            const delta = CalE.wall(draft.start) - CalE.wall(occ.start);
            const s = CalE.fromWall(CalE.wall(ev.start) + delta);
            return { start: s, end: CalE.fromWall(CalE.wall(s) + (CalE.wall(draft.end) - CalE.wall(draft.start))), dayDelta };
        }

        function calShiftRuleDays(r, delta) {
            if (!r || !r.byDay || !r.byDay.length || !delta) return r;
            return Object.assign({}, r, { byDay: Array.from(new Set(r.byDay.map(d => (((d + delta) % 7) + 7) % 7))).sort((a, b) => a - b) });
        }

        async function calEdSave() {
            if (!calEditor || calEditor.readOnly) return;
            const ed = calEditor;
            const d = ed.draft;
            const payload = Object.assign({}, d);
            payload.title = String(d.title || '').trim() || (d.kind === 'task' ? 'Untitled task' : 'Untitled event');
            let opts = null;
            if (ed.original) {
                payload.id = ed.original.id;
                if (ed.original.rrule && ed.occ) {
                    if (ed.scope === 'this' || ed.scope === 'following') {
                        opts = { scope: ed.scope, occKey: ed.occ.occKey };
                    } else {
                        const t = calSeriesTimes(ed.original, ed.occ, payload);
                        payload.start = t.start;
                        payload.end = t.end;
                        if (payload.rrule) payload.rrule = calShiftRuleDays(payload.rrule, t.dayDelta);
                    }
                }
            }
            const res = await calCall(() => window.electronAPI.calendarSaveEvent(payload, opts));
            if (!res || res.ok === false) return;
            if (payload.calendarId) { try { localStorage.setItem('calendarLastCal', payload.calendarId); } catch (e) { /* ignore */ } }
            const day = CalE.datePart(payload.start);
            calSelected = day;
            if (calView === 'month' && day.slice(0, 7) !== calCursor.slice(0, 7)) calCursor = day;
            calFlashUid = (res.id || payload.id) + '|' + day;
            calCloseSheet();
            calRenderDynamic();
            showToast(ed.original ? 'Saved' : `Added “${payload.title}”`);
        }

        function calEdDuplicate() {
            if (!calEditor) return;
            const copy = Object.assign({}, calEditor.draft, { id: null, title: calEditor.draft.title + ' (copy)' });
            if (calIsReadOnly({ calendarId: copy.calendarId })) copy.calendarId = calDefaultCalendarId();
            calOpenEditor(null, copy);
        }

        function calEdDelete() {
            if (!calEditor || !calEditor.original) return;
            const ev = calEditor.original;
            const occ = calEditor.occ;
            if (ev.rrule && occ) {
                calOpenSheet({ type: 'confirm', kind: 'delete-series', eventId: ev.id, occKey: occ.occKey, title: occ.title });
                return;
            }
            calOpenSheet({ type: 'confirm', kind: 'delete-one', eventId: ev.id, title: ev.title });
        }

        function calConfirmHtml() {
            const s = calSheet;
            if (s.kind === 'delete-series') {
                return `<div class="cal-sheet cal-sheet-small" role="dialog" aria-modal="true">
                    <div class="cal-sheet-head"><span class="cal-sheet-kicker">Delete repeating event</span>
                        <button type="button" class="cal-icon-btn" onclick="calCloseSheet()"><i class="fas fa-xmark"></i></button></div>
                    <div class="cal-sheet-body">
                        <p class="cal-confirm-text">“${esc(s.title || 'Untitled')}” repeats. What should go?</p>
                        <div class="cal-confirm-choices">
                            <button type="button" class="cal-choice" onclick="calDoDelete('this')"><b>Just this one</b><span>The rest of the series stays.</span></button>
                            <button type="button" class="cal-choice" onclick="calDoDelete('following')"><b>This and everything after</b><span>Earlier ones are kept.</span></button>
                            <button type="button" class="cal-choice is-danger" onclick="calDoDelete('all')"><b>The whole series</b><span>Every occurrence, past and future.</span></button>
                        </div>
                    </div>
                </div>`;
            }
            return `<div class="cal-sheet cal-sheet-small" role="dialog" aria-modal="true">
                <div class="cal-sheet-head"><span class="cal-sheet-kicker">Delete</span>
                    <button type="button" class="cal-icon-btn" onclick="calCloseSheet()"><i class="fas fa-xmark"></i></button></div>
                <div class="cal-sheet-body"><p class="cal-confirm-text">Delete “${esc(s.title || 'Untitled')}”?</p></div>
                <div class="cal-sheet-foot">
                    <span class="cal-foot-spacer"></span>
                    <button type="button" class="cal-btn cal-btn-ghost" onclick="calCloseSheet()">Cancel</button>
                    <button type="button" class="cal-btn cal-btn-danger-solid" onclick="calDoDelete('all')"><i class="far fa-trash-can"></i>Delete</button>
                </div>
            </div>`;
        }

        async function calDoDelete(scope) {
            const s = calSheet;
            if (!s || !s.eventId) return;
            const opts = scope === 'all' ? null : { scope, occKey: s.occKey };
            const res = await calCall(() => window.electronAPI.calendarDeleteEvent(s.eventId, opts));
            if (!res || res.ok === false) return;
            calCloseSheet();
            calRenderDynamic();
            showToast(scope === 'this' ? 'Occurrence removed' : 'Deleted');
        }

        // ── Settings sheet ────────────────────────────────────────────────────

        function calOpenSettings() { calOpenSheet({ type: 'settings', busy: null }); }

        function calPatchSettings(patch) {
            return calCall(() => window.electronAPI.calendarSetSettings(patch));
        }

        async function calSetCalField(id, field, value) {
            calLocalSheetEdit++;
            let res;
            try {
                res = await calCall(() => window.electronAPI.calendarSaveCalendar(Object.assign({ id }, { [field]: value })));
            } finally {
                calLocalSheetEdit--;
            }
            calRefreshSettingsList('calendars');
            return res;
        }

        function calSetCalReminder(id, which, value) {
            const list = value === '' ? [] : [Number(value)];
            return calSetCalField(id, which, list);
        }

        async function calAddCalendar() {
            const used = new Set(calCalendars().map(c => c.color));
            const color = CalE.PALETTE.find(c => !used.has(c)) || CalE.PALETTE[0];
            const res = await calCall(() => window.electronAPI.calendarSaveCalendar({ name: 'New calendar', color }));
            if (res && res.id) {
                calRenderSheet();
                const input = document.querySelector(`#cal-sheet-host .cal-cal-row[data-id="${CSS.escape(res.id)}"] .cal-cal-name`);
                if (input) { input.focus(); input.select(); }
            }
        }

        function calAskDeleteCalendar(id) {
            const c = calFindCal(id);
            if (!c) return;
            const count = ((calState && calState.events) || []).filter(e => e.calendarId === id).length;
            calOpenSheet({ type: 'confirm', kind: 'delete-calendar', calendarId: id, title: c.name, count, readOnly: c.readOnly });
        }

        async function calDoDeleteCalendar(id, moveTo) {
            const res = await calCall(() => window.electronAPI.calendarDeleteCalendar(id, moveTo ? { moveTo } : null));
            if (!res || res.ok === false) return;
            calOpenSettings();
            showToast('Calendar removed');
        }

        async function calSubscribe() {
            const urlEl = document.getElementById('cal-sub-url');
            const nameEl = document.getElementById('cal-sub-name');
            if (!urlEl || !urlEl.value.trim()) { showToast('Paste a calendar link first', true); return; }
            calSheet.busy = 'subscribe';
            calRenderSheet();
            const res = await calCall(() => window.electronAPI.calendarSubscribe({ url: urlEl.value.trim(), name: nameEl && nameEl.value.trim() }));
            if (calSheet) calSheet.busy = null;
            calRenderSheet();
            if (res && res.ok !== false) showToast(`Subscribed · ${res.added} event${res.added === 1 ? '' : 's'}`);
        }

        async function calRefreshSub(id) {
            calSheet.busy = 'refresh:' + id;
            calRenderSheet();
            const res = await calCall(() => window.electronAPI.calendarRefresh(id));
            if (calSheet) calSheet.busy = null;
            calRenderSheet();
            if (res && res.ok !== false) showToast(`Refreshed · ${res.count} event${res.count === 1 ? '' : 's'}`);
        }

        async function calImportIcs() {
            const res = await calCall(() => window.electronAPI.calendarImportIcs());
            if (!res || res.ok === false) return;
            calRenderSheet();
            calRenderDynamic();
            showToast(`Imported ${res.added} event${res.added === 1 ? '' : 's'}`);
            if (res.warnings && res.warnings.length) setTimeout(() => showToast(res.warnings[0], true, 4000), 2400);
        }

        async function calExportIcs(calendarId) {
            const res = await calCall(() => window.electronAPI.calendarExportIcs(calendarId || null));
            if (res && res.ok !== false) showToast(`Exported ${res.count} event${res.count === 1 ? '' : 's'}`);
        }

        async function calBackup() {
            const res = await calCall(() => window.electronAPI.calendarBackupExport());
            if (res && res.ok !== false) showToast('Backup saved');
        }

        async function calRestore() {
            const res = await calCall(() => window.electronAPI.calendarBackupImport());
            if (!res || res.ok === false) return;
            calRenderSheet();
            calRenderDynamic();
            showToast(`Restored · ${res.added} new event${res.added === 1 ? '' : 's'}`);
        }

        async function calTestNotify() {
            const res = await calCall(() => window.electronAPI.calendarTestNotify());
            if (res && res.quiet) showToast('Quiet hours are on, so that one was kept silent', true, 3200);
        }

        function calReminderSelect(id, which, list, allDay) {
            const cur = Array.isArray(list) && list.length ? String(list[0]) : '';
            const opts = (allDay ? CAL_ALLDAY_REMINDERS : CAL_TIMED_REMINDERS)
                .map(m => `<option value="${m}"${cur === String(m) ? ' selected' : ''}>${esc(CalE.fmtOffset(m, allDay))}${m > 0 ? ' before' : ''}</option>`).join('');
            return `<select class="cal-input cal-input-sm" onchange="calSetCalReminder(${jsAttr(id)}, ${jsAttr(which)}, this.value)">
                <option value=""${cur === '' ? ' selected' : ''}>No reminder</option>${opts}</select>`;
        }

        function calSettingsHtml() {
            const s = calSettings();
            const busy = calSheet.busy;
            const local = calCalendars().filter(c => !c.readOnly);
            const subs = calCalendars().filter(c => c.readOnly);

            const termRows = calTermRowsHtml();
            const calRows = calCalRowsHtml();

            const subRows = subs.length ? subs.map(c => `
                <div class="cal-sub-row">
                    <span class="cal-dot" style="--c:${c.color}"></span>
                    <div class="cal-sub-main">
                        <b>${esc(c.name)}</b>
                        <span>${c.lastError ? esc(c.lastError) : (c.lastSync ? 'Synced ' + esc(calAgo(c.lastSync)) : 'Not synced yet')} · every ${c.refreshHours || 6} h</span>
                    </div>
                    <button type="button" class="cal-btn cal-btn-ghost cal-btn-sm" ${busy === 'refresh:' + c.id ? 'disabled' : ''} onclick="calRefreshSub(${jsAttr(c.id)})">
                        <i class="fas ${busy === 'refresh:' + c.id ? 'fa-spinner fa-spin' : 'fa-rotate'}"></i>Refresh</button>
                    <button type="button" class="cal-icon-btn cal-icon-danger" onclick="calAskDeleteCalendar(${jsAttr(c.id)})" title="Unsubscribe"><i class="fas fa-link-slash"></i></button>
                </div>`).join('') : '<p class="cal-ed-hint">Nothing subscribed yet. Paste a calendar link below — a school timetable, a work rota, or the “secret iCal address” from Google Calendar or Outlook.</p>';

            return `<div class="cal-sheet cal-sheet-settings" role="dialog" aria-modal="true">
                <div class="cal-sheet-head">
                    <span class="cal-sheet-kicker"><i class="fas fa-sliders"></i> Calendar settings</span>
                    <button type="button" class="cal-icon-btn" onclick="calCloseSheet()" title="Close (Esc)"><i class="fas fa-xmark"></i></button>
                </div>
                <div class="cal-sheet-body">
                    <h4 class="cal-set-h">Notifications</h4>
                    <p class="cal-set-note">Reminders come from the app itself, so they still arrive while main sits in the tray.</p>
                    <label class="cal-ed-check"><span class="ios-toggle"><input type="checkbox" class="ios-toggle-input"${s.notifications.desktop ? ' checked' : ''}
                        onchange="calPatchSettings({notifications:{desktop:this.checked}})"><span class="ios-toggle-track"></span></span><span>Desktop notifications</span></label>
                    <label class="cal-ed-check"><span class="ios-toggle"><input type="checkbox" class="ios-toggle-input"${s.notifications.inApp ? ' checked' : ''}
                        onchange="calPatchSettings({notifications:{inApp:this.checked}})"><span class="ios-toggle-track"></span></span><span>Reminder card inside main</span></label>
                    <label class="cal-ed-check"><span class="ios-toggle"><input type="checkbox" class="ios-toggle-input"${s.notifications.sound ? ' checked' : ''}
                        onchange="calPatchSettings({notifications:{sound:this.checked}})"><span class="ios-toggle-track"></span></span><span>Chime</span></label>
                    <button type="button" class="cal-btn cal-btn-ghost cal-btn-sm" onclick="calTestNotify()"><i class="far fa-bell"></i>Send a test reminder</button>

                    <div class="cal-set-split">
                        <label class="cal-ed-check"><span class="ios-toggle"><input type="checkbox" class="ios-toggle-input"${s.digest.enabled ? ' checked' : ''}
                            onchange="calPatchSettings({digest:{enabled:this.checked}})"><span class="ios-toggle-track"></span></span><span>Morning digest</span></label>
                        <input type="time" class="cal-input cal-input-sm" value="${s.digest.time}" onchange="calPatchSettings({digest:{time:this.value}})">
                    </div>
                    <p class="cal-set-note">One notification with everything the day holds.</p>

                    <div class="cal-set-split">
                        <label class="cal-ed-check"><span class="ios-toggle"><input type="checkbox" class="ios-toggle-input"${s.quietHours.enabled ? ' checked' : ''}
                            onchange="calPatchSettings({quietHours:{enabled:this.checked}})"><span class="ios-toggle-track"></span></span><span>Quiet hours</span></label>
                        <span class="cal-set-range">
                            <input type="time" class="cal-input cal-input-sm" value="${s.quietHours.start}" onchange="calPatchSettings({quietHours:{start:this.value}})">
                            <span>to</span>
                            <input type="time" class="cal-input cal-input-sm" value="${s.quietHours.end}" onchange="calPatchSettings({quietHours:{end:this.value}})">
                        </span>
                    </div>
                    <label class="cal-ed-check"><span class="ios-toggle"><input type="checkbox" class="ios-toggle-input"${s.quietHours.allowImportant ? ' checked' : ''}
                        onchange="calPatchSettings({quietHours:{allowImportant:this.checked}})"><span class="ios-toggle-track"></span></span><span>Let important items through anyway</span></label>

                    <div class="cal-set-split">
                        <span class="cal-set-label">All-day reminders arrive at</span>
                        <input type="time" class="cal-input cal-input-sm" value="${s.allDayReminderTime}" onchange="calPatchSettings({allDayReminderTime:this.value})">
                    </div>

                    <h4 class="cal-set-h">Look &amp; feel</h4>
                    <div class="cal-set-split">
                        <span class="cal-set-label">Week starts on</span>
                        <select class="cal-input cal-input-sm" onchange="calPatchSettings({weekStart:Number(this.value)})">
                            <option value="1"${s.weekStart === 1 ? ' selected' : ''}>Monday</option>
                            <option value="0"${s.weekStart === 0 ? ' selected' : ''}>Sunday</option>
                            <option value="6"${s.weekStart === 6 ? ' selected' : ''}>Saturday</option>
                        </select>
                    </div>
                    <div class="cal-set-split">
                        <span class="cal-set-label">Opens on</span>
                        <select class="cal-input cal-input-sm" onchange="calPatchSettings({defaultView:this.value})">
                            ${CAL_VIEWS.map(([v, l]) => `<option value="${v}"${s.defaultView === v ? ' selected' : ''}>${l}</option>`).join('')}
                        </select>
                    </div>
                    <div class="cal-set-split">
                        <span class="cal-set-label">New events last</span>
                        <select class="cal-input cal-input-sm" onchange="calPatchSettings({defaultDuration:Number(this.value)})">
                            ${[15, 30, 45, 60, 90, 120].map(m => `<option value="${m}"${s.defaultDuration === m ? ' selected' : ''}>${esc(CalE.fmtDuration(m))}</option>`).join('')}
                        </select>
                    </div>
                    <label class="cal-ed-check"><span class="ios-toggle"><input type="checkbox" class="ios-toggle-input"${s.showWeekNumbers ? ' checked' : ''}
                        onchange="calPatchSettings({showWeekNumbers:this.checked})"><span class="ios-toggle-track"></span></span><span>Week numbers</span></label>
                    <div class="cal-set-split">
                        <span class="cal-set-label">Week numbers count</span>
                        <select class="cal-input cal-input-sm" onchange="calPatchSettings({weekNumbersFrom:this.value})">
                            <option value="year"${s.weekNumbersFrom === 'year' ? ' selected' : ''}>From January (ISO)</option>
                            <option value="term"${s.weekNumbersFrom === 'term' ? ' selected' : ''}>From each term's start</option>
                        </select>
                    </div>
                    <p class="cal-set-note">Counting from a term makes its first week Week 1; weeks in the holidays show a dash.</p>
                    <label class="cal-ed-check"><span class="ios-toggle"><input type="checkbox" class="ios-toggle-input"${s.headerChip ? ' checked' : ''}
                        onchange="calPatchSettings({headerChip:this.checked})"><span class="ios-toggle-track"></span></span><span>“Up next” chip in the app header</span></label>
                    <p class="cal-set-note">Times follow the app's ${calClock24() ? '24-hour' : '12-hour'} clock setting (Settings → Behavior).</p>

                    <div class="cal-set-split">
                        <span class="cal-set-label">Right-click an event</span>
                        <select class="cal-input cal-input-sm" onchange="calPatchSettings({rightClick:this.value})">
                            ${[['none', 'Nothing'], ['delete', 'Delete it'], ['done', 'Tick the task off']]
                                .map(([v, l]) => `<option value="${v}"${s.rightClick === v ? ' selected' : ''}>${l}</option>`).join('')}
                        </select>
                    </div>
                    <p class="cal-set-note">Off by default. "Delete it" still asks which occurrences to remove for a repeating event.</p>

                    <h4 class="cal-set-h">School terms</h4>
                    <div class="cal-term-list">${termRows}</div>
                    <button type="button" class="cal-btn cal-btn-ghost cal-btn-sm" onclick="calAddTerm()"><i class="fas fa-plus"></i>Add a term</button>
                    <label class="cal-ed-check"><span class="ios-toggle"><input type="checkbox" class="ios-toggle-input"${s.termMarkers ? ' checked' : ''}
                        onchange="calPatchSettings({termMarkers:this.checked})"><span class="ios-toggle-track"></span></span><span>Show each term's start &amp; end in the calendar</span></label>
                    <p class="cal-set-note">Terms tint their weeks in the Year view, show "Term 3 · Wk 5" beside the date, and let quick add
                        understand "every monday until end of term".</p>
                    <h4 class="cal-set-h">Calendars</h4>
                    <div class="cal-cal-list">${calRows}</div>
                    <button type="button" class="cal-btn cal-btn-ghost cal-btn-sm" onclick="calAddCalendar()" ${local.length >= 20 ? 'disabled' : ''}><i class="fas fa-plus"></i>Add a calendar</button>

                    <h4 class="cal-set-h">Subscribed calendars</h4>
                    <div class="cal-sub-list">${subRows}</div>
                    <div class="cal-sub-add">
                        <input type="text" id="cal-sub-url" class="cal-input cal-input-wide" placeholder="https://… or webcal://… calendar link">
                        <input type="text" id="cal-sub-name" class="cal-input cal-input-sm" placeholder="Name (optional)" maxlength="40">
                        <button type="button" class="cal-btn cal-btn-primary cal-btn-sm" ${busy === 'subscribe' ? 'disabled' : ''} onclick="calSubscribe()">
                            <i class="fas ${busy === 'subscribe' ? 'fa-spinner fa-spin' : 'fa-plus'}"></i>Subscribe</button>
                    </div>
                    <p class="cal-set-note">Subscribed calendars are read-only and refresh themselves every few hours.</p>

                    <h4 class="cal-set-h">Files</h4>
                    <div class="cal-set-btns">
                        <button type="button" class="cal-btn cal-btn-ghost cal-btn-sm" onclick="calImportIcs()"><i class="fas fa-file-import"></i>Import .ics</button>
                        <button type="button" class="cal-btn cal-btn-ghost cal-btn-sm" onclick="calExportIcs(null)"><i class="fas fa-file-export"></i>Export .ics</button>
                        <button type="button" class="cal-btn cal-btn-ghost cal-btn-sm" onclick="calBackup()"><i class="fas fa-download"></i>Back up</button>
                        <button type="button" class="cal-btn cal-btn-ghost cal-btn-sm" onclick="calRestore()"><i class="fas fa-upload"></i>Restore</button>
                    </div>
                    <p class="cal-set-note">Everything stays on this PC. A backup restores by merging, so it never duplicates what you already have.</p>
                </div>
            </div>`;
        }

        function calAgo(ts) {
            const mins = Math.round((Date.now() - ts) / 60000);
            if (mins < 1) return 'just now';
            if (mins < 60) return mins + ' min ago';
            const h = Math.round(mins / 60);
            if (h < 24) return h + ' h ago';
            return Math.round(h / 24) + ' d ago';
        }

        // ── Notifications inbox ───────────────────────────────────────────────

        function calOpenInbox() {
            calOpenSheet({ type: 'inbox' });
            if (window.electronAPI?.calendarHistoryRead) window.electronAPI.calendarHistoryRead('*').catch(() => {});
        }

        function calInboxHtml() {
            const history = (calState && calState.history) || [];
            const icons = { reminder: 'far fa-bell', snooze: 'far fa-clock', missed: 'fas fa-bell-slash', digest: 'fas fa-sun', test: 'fas fa-vial' };
            const rows = history.map(h => `
                <div class="cal-inbox-row${h.read ? '' : ' is-unread'}">
                    <div class="cal-inbox-icon"><i class="${icons[h.kind] || 'far fa-bell'}"></i></div>
                    <div class="cal-inbox-main">
                        <b>${esc(h.title)}</b>
                        <span>${esc(h.body)}</span>
                        <span class="cal-inbox-time">${esc(calAgo(h.ts))}${h.quiet ? ' · held quiet' : ''}</span>
                    </div>
                    ${h.eventId ? `<div class="cal-inbox-actions">
                        <button type="button" class="cal-btn cal-btn-ghost cal-btn-sm" onclick="calInboxSnooze(${jsAttr(h.eventId)}, ${jsAttr(h.occKey)})"><i class="far fa-clock"></i>10 min</button>
                        <button type="button" class="cal-btn cal-btn-ghost cal-btn-sm" onclick="calCloseSheet(); calOpenOcc(${jsAttr(h.eventId)}, ${jsAttr(h.occKey)})">Open</button>
                    </div>` : ''}
                </div>`).join('');
            return `<div class="cal-sheet cal-sheet-inbox" role="dialog" aria-modal="true">
                <div class="cal-sheet-head">
                    <span class="cal-sheet-kicker"><i class="far fa-bell"></i> Notifications</span>
                    <div>
                        ${history.length ? '<button type="button" class="cal-btn cal-btn-ghost cal-btn-sm" onclick="calClearInbox()">Clear</button>' : ''}
                        <button type="button" class="cal-icon-btn" onclick="calCloseSheet()" title="Close (Esc)"><i class="fas fa-xmark"></i></button>
                    </div>
                </div>
                <div class="cal-sheet-body">
                    ${history.length ? rows : calEmptyHtml('far fa-bell', 'No reminders yet', 'Everything the calendar tells you shows up here, so you can catch up on anything you missed.')}
                </div>
            </div>`;
        }

        async function calInboxSnooze(eventId, occKey) {
            const res = await calCall(() => window.electronAPI.calendarSnooze(eventId, occKey, 10));
            if (res && res.ok !== false) showToast('Snoozed for 10 minutes');
        }

        function calClearInbox() {
            calCall(() => window.electronAPI.calendarHistoryClear());
            calRenderSheet();
        }

        // ── In-app reminder cards ─────────────────────────────────────────────

        function calOnAlert(a) {
            if (!a) return;
            if (a.sound) calChime(a.important);
            if (a.inApp) calShowAlertCard(a);
        }

        function calShowAlertCard(a) {
            const host = document.getElementById('cal-alerts');
            if (!host) return;
            const occ = a.occ;
            const link = a.link || null;
            const d = occ ? CalE.describeAlert(occ, Date.now(), { clock24: calClock24() }) : null;
            const card = document.createElement('div');
            card.className = 'cal-alert' + (a.important ? ' is-important' : '');
            card.style.setProperty('--c', occ ? calColor(occ) : 'var(--accent-solid)');
            card.dataset.alertId = a.id;
            if (occ && occ.eventId) {
                card.dataset.eventId = occ.eventId;
                card.dataset.occKey = occ.occKey;
            }
            const canAct = !!(occ && occ.eventId);
            card.innerHTML = `
                <span class="cal-alert-bar"></span>
                <div class="cal-alert-icon"><i class="fas ${a.kind === 'digest' ? 'fa-sun' : a.kind === 'missed' ? 'fa-bell-slash' : 'fa-bell'}"></i></div>
                <div class="cal-alert-text">
                    <div class="cal-alert-kicker">${esc(d ? d.headline : (a.kind === 'digest' ? 'Today' : 'Calendar'))}</div>
                    <div class="cal-alert-title">${esc(a.title)}</div>
                    <div class="cal-alert-sub">${esc(d ? [d.when, occ.location].filter(Boolean).join(' · ') : a.body)}</div>
                </div>
                <div class="cal-alert-actions">
                    ${link ? `<button type="button" class="cal-alert-btn is-go" onclick="calJoin(${jsAttr(link)})"><i class="fas fa-video"></i>Join</button>` : ''}
                    ${canAct ? `<button type="button" class="cal-alert-btn" onclick="calAlertSnoozeMenu(${jsAttr(a.id)})"><i class="far fa-clock"></i>Snooze</button>` : ''}
                    ${canAct ? `<button type="button" class="cal-alert-btn" onclick="calAlertOpen(${jsAttr(a.id)})">Open</button>` : ''}
                </div>
                <button type="button" class="cal-alert-close" onclick="calDismissAlert(${jsAttr(a.id)})" title="Dismiss"><i class="fas fa-xmark"></i></button>
                ${canAct ? `<div class="cal-alert-snooze hidden">
                    ${[5, 10, 30, 60].map(m => `<button type="button" onclick="calAlertSnooze(${jsAttr(a.id)}, ${m})">${m < 60 ? m + ' min' : '1 hour'}</button>`).join('')}
                </div>` : ''}`;
            host.appendChild(card);
            while (host.children.length > 3) calRemoveCard(host.firstElementChild);
            requestAnimationFrame(() => card.classList.add('is-in'));
            calArmAlertTimers();
        }

        function calCardById(id) {
            const host = document.getElementById('cal-alerts');
            return host ? host.querySelector(`[data-alert-id="${CSS.escape(String(id))}"]`) : null;
        }

        function calRemoveCard(card) {
            if (!card) return;
            const id = card.dataset.alertId;
            const t = calAlertTimers.get(id);
            if (t) { clearTimeout(t); calAlertTimers.delete(id); }
            card.classList.add('is-out');
            setTimeout(() => { if (card.parentElement) card.parentElement.removeChild(card); }, 220);
        }

        function calDismissAlert(id) { calRemoveCard(calCardById(id)); }

        function calAlertSnoozeMenu(id) {
            const card = calCardById(id);
            if (!card) return;
            const menu = card.querySelector('.cal-alert-snooze');
            if (menu) menu.classList.toggle('hidden');
        }

        async function calAlertSnooze(id, minutes) {
            const card = calCardById(id);
            if (!card) return;
            const res = await calCall(() => window.electronAPI.calendarSnooze(card.dataset.eventId, card.dataset.occKey, minutes));
            calRemoveCard(card);
            if (res && res.ok !== false) showToast(`Snoozed for ${minutes < 60 ? minutes + ' minutes' : 'an hour'}`);
        }

        function calAlertOpen(id) {
            const card = calCardById(id);
            if (!card) return;
            const eventId = card.dataset.eventId;
            const occKey = card.dataset.occKey;
            calRemoveCard(card);
            calOpenFromNotification({ eventId, occKey });
        }

        // Cards only time out while someone is actually looking at the window —
        // a reminder that arrived while it was minimised is still there later.
        function calArmAlertTimers() {
            if (document.visibilityState !== 'visible') return;
            const host = document.getElementById('cal-alerts');
            if (!host) return;
            for (const card of host.children) {
                const id = card.dataset.alertId;
                if (calAlertTimers.has(id) || card.classList.contains('is-important')) continue;
                calAlertTimers.set(id, setTimeout(() => { calAlertTimers.delete(id); calRemoveCard(card); }, 60000));
            }
        }

        // A soft two-note bell — deliberately unlike the timer's alarm blips.
        function calChime(important) {
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return;
                const ctx = new Ctx();
                const t0 = ctx.currentTime;
                const notes = important ? [[880, 0], [1174.66, 0.13], [1318.51, 0.27]] : [[987.77, 0], [1318.51, 0.11]];
                for (const [freq, at] of notes) {
                    const o = ctx.createOscillator();
                    const g = ctx.createGain();
                    o.type = 'sine';
                    o.frequency.value = freq;
                    const t = t0 + at;
                    g.gain.setValueAtTime(0.0001, t);
                    g.gain.exponentialRampToValueAtTime(0.2, t + 0.015);
                    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
                    o.connect(g);
                    g.connect(ctx.destination);
                    o.start(t);
                    o.stop(t + 0.95);
                }
                setTimeout(() => { try { ctx.close(); } catch (e) { /* ignore */ } }, 1800);
            } catch (e) {
                // Sound is a nicety — never let it break a reminder.
            }
        }

        // Clicking a desktop notification lands here.
        function calOpenFromNotification(p) {
            if (typeof openWidgetLibrary === 'function') openWidgetLibrary('calendar');
            let tries = 0;
            const go = async () => {
                if (!document.getElementById('calendar-panel') && tries++ < 20) { setTimeout(go, 60); return; }
                await renderCalendarPanel();
                if (!p || !p.eventId) return;
                const ev = calFindEvent(p.eventId);
                if (!ev) return;
                const occ = CalE.occurrenceFor(ev, p.occKey);
                const day = CalE.evStartDate(occ || ev);
                calSelected = day;
                calCursor = day;
                calRenderDynamic();
                calOpenEditor(occ || CalE.buildOccurrence(ev, CalE.evStartDate(ev), null));
            };
            setTimeout(go, 60);
        }

        // ── Drag & drop ───────────────────────────────────────────────────────
        // Pointer events (not HTML5 drag) so the ghost, the snapping and the
        // drop target all behave identically on both platforms. Nothing is
        // written until the pointer is released, and dragging one occurrence of
        // a repeating event only ever moves that occurrence.

        let calSuppressClick = false;

        function calWireRoot() {
            const root = document.getElementById('cal-root');
            if (!root) return;
            root.addEventListener('pointerdown', calPointerDown);
            root.addEventListener('contextmenu', calContextMenu);
        }

        function calOccByUid(uid) {
            const i = String(uid).lastIndexOf('|');
            if (i < 1) return null;
            const ev = calFindEvent(uid.slice(0, i));
            return ev ? CalE.occurrenceFor(ev, uid.slice(i + 1)) : null;
        }

        function calSnap(min) { return Math.round(min / CAL_SNAP) * CAL_SNAP; }

        function calPointerDown(e) {
            if (e.button !== 0 || calSheet) return;
            // A control inside a chip (the tick box) is not a drag handle.
            if (e.target.closest('[data-notdrag]')) return;
            const el = e.target.closest('[data-drag]');
            if (el) {
                const occ = calOccByUid(el.dataset.uid);
                if (!occ) return;
                calDrag = {
                    mode: e.target.closest('[data-resize]') ? 'resize' : 'move',
                    kind: el.dataset.drag, el, occ, moved: false,
                    startX: e.clientX, startY: e.clientY,
                    fromDay: el.dataset.day || (el.closest('[data-date]') ? el.closest('[data-date]').dataset.date : null),
                    origTop: parseFloat(el.style.top) || 0,
                    origHeight: parseFloat(el.style.height) || 0,
                    dayDelta: 0, minDelta: 0
                };
                window.addEventListener('pointermove', calPointerMove);
                window.addEventListener('pointerup', calPointerUp, { once: true });
                return;
            }
            if (calView !== 'week') return;
            const col = e.target.closest('.cal-wcol');
            if (!col) return;
            const rect = col.getBoundingClientRect();
            const startMin = Math.max(0, Math.min(1425, calSnap(((e.clientY - rect.top) / CAL_HOUR_PX) * 60)));
            const ghost = document.createElement('div');
            ghost.className = 'cal-block cal-block-ghost';
            ghost.style.top = (startMin / 60 * CAL_HOUR_PX) + 'px';
            ghost.style.height = (CAL_HOUR_PX / 2) + 'px';
            col.appendChild(ghost);
            calDrag = { mode: 'create', day: col.dataset.date, col, ghost, startMin, endMin: startMin + 30, moved: false, startY: e.clientY, startX: e.clientX };
            window.addEventListener('pointermove', calPointerMove);
            window.addEventListener('pointerup', calPointerUp, { once: true });
        }

        function calPointerMove(e) {
            const d = calDrag;
            if (!d) return;
            const dx = e.clientX - d.startX;
            const dy = e.clientY - d.startY;
            if (!d.moved) {
                if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
                d.moved = true;
                document.body.classList.add('cal-dragging');
                if (d.el) d.el.classList.add('is-dragging');
            }
            if (d.mode === 'create') {
                const rect = d.col.getBoundingClientRect();
                const cur = Math.max(0, Math.min(1440, calSnap(((e.clientY - rect.top) / CAL_HOUR_PX) * 60)));
                const a = Math.min(d.startMin, cur), b = Math.max(d.startMin + 15, cur);
                d.endMin = b;
                d.ghost.style.top = (a / 60 * CAL_HOUR_PX) + 'px';
                d.ghost.style.height = Math.max(12, (b - a) / 60 * CAL_HOUR_PX) + 'px';
                d.ghost.textContent = CalE.fmtTimeRange(CalE.hhmm(a), CalE.hhmm(b), calClock24());
                d.fromMin = a;
                return;
            }
            if (d.kind === 'week') {
                if (d.mode === 'resize') {
                    d.minDelta = calSnap((dy / CAL_HOUR_PX) * 60);
                    d.el.style.height = Math.max(12, d.origHeight + (d.minDelta / 60) * CAL_HOUR_PX) + 'px';
                    return;
                }
                d.minDelta = calSnap((dy / CAL_HOUR_PX) * 60);
                d.el.style.top = (d.origTop + (d.minDelta / 60) * CAL_HOUR_PX) + 'px';
                const under = document.elementFromPoint(e.clientX, e.clientY);
                const col = under && under.closest ? under.closest('.cal-wcol') : null;
                if (col && col.dataset.date !== d.el.parentElement.dataset.date) {
                    col.appendChild(d.el);
                    d.el.style.left = '1px';
                    d.el.style.width = 'calc(100% - 3px)';
                    d.dayDelta = CalE.diffDays(d.fromDay, col.dataset.date);
                }
                return;
            }
            // Month (and the week's all-day row): a ghost follows the pointer and
            // the day under it lights up.
            if (!d.ghost) {
                const g = d.el.cloneNode(true);
                g.classList.add('cal-chip-ghost');
                document.body.appendChild(g);
                d.ghost = g;
                d.el.classList.add('is-source');
            }
            d.ghost.style.left = (e.clientX + 8) + 'px';
            d.ghost.style.top = (e.clientY - 8) + 'px';
            const under = document.elementFromPoint(e.clientX, e.clientY);
            const cell = under && under.closest ? under.closest('[data-date]') : null;
            if (d.dropEl && d.dropEl !== cell) d.dropEl.classList.remove('is-drop');
            if (cell) {
                cell.classList.add('is-drop');
                d.dropEl = cell;
                d.dayDelta = CalE.diffDays(d.fromDay, cell.dataset.date);
            } else {
                d.dropEl = null;
            }
        }

        function calPointerUp() {
            const d = calDrag;
            window.removeEventListener('pointermove', calPointerMove);
            calDrag = null;
            document.body.classList.remove('cal-dragging');
            if (!d) return;
            if (d.ghost && d.ghost.parentElement && d.mode !== 'create') d.ghost.parentElement.removeChild(d.ghost);
            if (d.dropEl) d.dropEl.classList.remove('is-drop');
            if (d.el) d.el.classList.remove('is-dragging', 'is-source');

            if (d.mode === 'create') {
                if (d.ghost.parentElement) d.ghost.parentElement.removeChild(d.ghost);
                const startMin = d.moved ? d.fromMin : d.startMin;
                const endMin = d.moved ? d.endMin : startMin + calSettings().defaultDuration;
                calNewOn(d.day, startMin, endMin);
                return;
            }
            if (!d.moved) return;
            // The click that follows this pointerup is a drag artefact.
            calSuppressClick = true;
            setTimeout(() => { calSuppressClick = false; }, 0);
            if (d.mode === 'resize') {
                if (d.minDelta) calMoveOcc(d.occ, 0, d.minDelta, true); else calRenderDynamic();
                return;
            }
            if (!d.dayDelta && !d.minDelta) { calRenderDynamic(); return; }
            calMoveOcc(d.occ, d.dayDelta, d.kind === 'week' ? d.minDelta : 0, false);
        }

        async function calMoveOcc(occ, dayDelta, minDelta, resize) {
            const ev = calFindEvent(occ.eventId);
            if (!ev) return;
            const t = CalE.movedTimes(occ, dayDelta, minDelta, resize);
            const series = !!ev.rrule;
            const payload = {
                id: ev.id, kind: ev.kind, calendarId: ev.calendarId,
                // For one occurrence of a series, carry that occurrence's own
                // text so an existing exception isn't flattened back.
                title: series ? occ.title : ev.title,
                location: series ? occ.location : ev.location,
                notes: series ? occ.notes : ev.notes,
                url: ev.url, allDay: occ.allDay, start: t.start, end: t.end,
                reminders: ev.reminders, important: ev.important, rrule: ev.rrule
            };
            const res = await calCall(() => window.electronAPI.calendarSaveEvent(payload, series ? { scope: 'this', occKey: occ.occKey } : null));
            calRenderDynamic();
            if (res && res.ok !== false) {
                showToast(series ? 'Moved this occurrence only' : (resize ? 'Time updated' : 'Moved'));
            }
        }

        // ── Keyboard ──────────────────────────────────────────────────────────
        // Registered on `window` in the CAPTURE phase so it runs before the
        // Widget Library's document-level handler, which otherwise swallows
        // plain keys while a detail panel is open.
        window.addEventListener('keydown', (e) => {
            if (!document.getElementById('calendar-panel') || !isCalendarEnabled()) return;
            if (typeof bindingTarget !== 'undefined' && bindingTarget) return;
            const active = document.activeElement;
            const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);

            if (e.key === 'Escape') {
                if (calSheet) { e.preventDefault(); e.stopImmediatePropagation(); calCloseSheet(); return; }
                if (calSearchOpen) { e.preventDefault(); e.stopImmediatePropagation(); calToggleSearch(false); return; }
                return; // let the library close the detail
            }
            // Tab opened the details from the quick-add bar, so Tab closes them again
            // and hands focus back to that bar. A field OTHER than the title keeps Tab
            // for stepping between fields, so the form stays navigable once you are
            // inside it.
            if (e.key === 'Tab' && !e.shiftKey && calSheet) {
                const inField = typing && active.id !== 'cal-ed-title';
                if (!inField) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    calCloseSheet();
                    const quick = document.getElementById('cal-quick-input');
                    if (quick) quick.focus();
                    return;
                }
            }
            if (calSheet || typing || e.ctrlKey || e.metaKey || e.altKey) return;

            const actions = {
                arrowleft: () => calNav(-1),
                arrowright: () => calNav(1),
                t: () => calGoToday(),
                n: () => calNewEvent(),
                m: () => calSetView('month'),
                w: () => calSetView('week'),
                a: () => calSetView('agenda'),
                f: () => calToggleSearch(true),
                '/': () => { const i = document.getElementById('cal-quick-input'); if (i) i.focus(); }
            };
            const fn = actions[e.key.toLowerCase()];
            if (!fn) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            fn();
        }, true);

        // ── Header "up next" chip ─────────────────────────────────────────────
        // One timeout, re-aimed at the next moment the text can change: the next
        // minute tick while something is showing, otherwise the moment the next
        // event comes within the hour. No polling.

        function calScheduleIndicator() {
            clearTimeout(calIndicatorTimer);
            calIndicatorTimer = null;
            const el = document.getElementById('calendar-indicator');
            if (!el) return;
            if (!isCalendarEnabled() || !calState || calSettings().headerChip === false) {
                el.classList.add('hidden');
                el.innerHTML = '';
                return;
            }
            const now = Date.now();
            const today = CalE.todayStr(now);
            const occs = calOccs(today, CalE.addDays(today, 1)).filter(o => !o.allDay && o.kind !== 'task' && !o.done);
            const { ongoing, next, focus } = calFocusOccurrence(occs, now);
            const WINDOW = 60 * 60000;
            const show = focus === next && next ? (CalE.occStartMs(next) - now <= WINDOW ? next : null) : focus;

            if (!show) {
                el.classList.add('hidden');
                el.classList.remove('is-now', 'is-soon');
                el.innerHTML = '';
                const wait = next ? Math.max(1000, Math.min(30 * 60000, CalE.occStartMs(next) - now - WINDOW + 1000)) : 30 * 60000;
                calIndicatorTimer = setTimeout(calScheduleIndicator, wait);
                return;
            }
            const isNow = show === ongoing;
            const mins = Math.round((isNow ? CalE.occEndMs(show) - now : CalE.occStartMs(show) - now) / 60000);
            const label = isNow ? (mins < 60 ? mins + 'm left' : 'now') : (mins <= 0 ? 'now' : (mins < 60 ? mins + 'm' : Math.round(mins / 60) + 'h'));
            el.classList.remove('hidden');
            el.classList.toggle('is-now', isNow);
            el.classList.toggle('is-soon', !isNow && mins <= 10);
            el.style.setProperty('--c', calColor(show));
            el.innerHTML = `<span class="cal-ind-dot"></span><span class="cal-ind-title">${esc(show.title || 'Untitled')}</span><span class="cal-ind-time">${esc(label)}</span>`;
            el.title = `${show.title} · ${calTimeLabel(show)}${show.location ? ' · ' + show.location : ''} — click to open the calendar`;
            el.dataset.day = CalE.evStartDate(show);
            calIndicatorTimer = setTimeout(calScheduleIndicator, Math.max(1000, 60000 - (now % 60000) + 200));
        }

        function openCalendarFromIndicator() {
            const el = document.getElementById('calendar-indicator');
            if (el && el.dataset.day && CalE.isDate(el.dataset.day)) {
                calCursor = el.dataset.day;
                calSelected = el.dataset.day;
            }
            if (typeof openWidgetLibrary === 'function') openWidgetLibrary('calendar');
        }
