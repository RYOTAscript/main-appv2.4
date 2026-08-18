"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Logo } from "@/components/ui/Logo";
import { VERSION_LABEL } from "@/lib/site";
import { cn } from "@/lib/cn";

/**
 * Pixel-faithful, lightly-animated replica of the real "main" window
 * (main-app11/main-app/main.html), rendered at the app's native 920×640 and
 * scaled to fit by <ScaledStage>. The widget row is the app's exact three-card
 * grid — Quick Notes · Performance · Spotify — and the Spotify card reproduces
 * the real internal layout: a synced-lyrics strip on the left, the spinning
 * vinyl with a floating track label + transport + progress in the middle, and a
 * vertical volume slider on the right.
 *
 * It stays alive after assembling: a made-up track ("Neon Overdrive" — Static
 * Vega) plays on an internal clock so the progress bar creeps, the vinyl spins,
 * the beat-glow pulses, and the lyrics conveyor scrolls its timed lines. Which
 * widgets show is driven by `visible` (the <HeroApp> toolbar mirrors the app's
 * Settings → Widgets toggles: Quick Notes, Performance, Spotify player, Lyrics).
 */

export type WidgetVisibility = {
  notes: boolean;
  performance: boolean;
  spotify: boolean;
  lyrics: boolean;
};

const QUICK_LAUNCH = [
  { icon: "fa-brands fa-steam", label: "Steam" },
  { icon: "fa-brands fa-discord", label: "Discord" },
  { icon: "fa-brands fa-chrome", label: "Chrome" },
  { icon: "fa-brands fa-spotify", label: "Spotify" },
  { icon: "fa-solid fa-folder", label: "Files" },
  { icon: "fa-solid fa-gamepad", label: "Games" },
];

const STRIP = [
  { icon: "fa-solid fa-microphone", label: "Mic Mute" },
  { icon: "fa-solid fa-crosshairs", label: "Crosshair" },
  { icon: "fa-solid fa-clipboard", label: "Clipboard" },
  { icon: "fa-solid fa-hourglass-half", label: "Timer" },
  { icon: "fa-solid fa-sliders", label: "Volume Mixer" },
];

/* ── The fictional now-playing playlist + each track's synced (LRC-style)
   lyrics ──────────────────────────────────────────────────────────────────
   Wholly made-up songs so the synced-lyrics feature can show off with nothing
   to license. Times are seconds; "♪" lines are instrumental beats. The Next /
   Previous transport steps a *whole* track at a time (like the real player):
   the title, artist, album art, lyrics and duration all change together. Each
   track's `cover` is a colour gradient rendered black-and-white by the
   `.spotify-album-cover` filter, so every album cover reads as monochrome. */
type Lyric = { t: number; text: string };
type Track = {
  title: string;
  artist: string;
  duration: number;
  cover: string; // CSS background for the album art (shown grayscale)
  lyrics: Lyric[];
};

const TRACKS: Track[] = [
  {
    title: "Neon Overdrive",
    artist: "Static Vega",
    duration: 126, // 2:06 — fully covered by the lyrics below, loops cleanly
    cover:
      "linear-gradient(135deg, #ff4d8d 0%, #7a2ff2 55%, #101010 100%)",
    lyrics: [
      { t: 0, text: "♪" },
      { t: 7, text: "City lights bleed through the rain" },
      { t: 14, text: "Static humming in my chest (in my chest)" },
      { t: 21, text: "Chasing shadows down the lane" },
      { t: 28, text: "No idea where we begin (where we begin)" },
      { t: 35, text: "Turn it up, let the engine roar (let it roar)" },
      { t: 42, text: "Neon overdrive, we don't slow no more (no more)" },
      { t: 49, text: "Hold the night 'til the morning breaks" },
      { t: 56, text: "Every heartbeat's a risk we take (a risk we take)" },
      { t: 63, text: "♪" },
      { t: 70, text: "Faded polaroids and gasoline" },
      { t: 77, text: "Dreaming loud in ultramarine (ultramarine)" },
      { t: 84, text: "We were wildfire, seventeen (wildfire)" },
      { t: 91, text: "Burning up the in-between" },
      { t: 98, text: "Turn it up, let the engine roar (let it roar)" },
      { t: 105, text: "Neon overdrive, we don't slow no more (no more)" },
      { t: 112, text: "Hold the night 'til the morning breaks" },
      { t: 119, text: "Every heartbeat's a risk we take (a risk we take)" },
    ],
  },
  {
    title: "Paper Moons",
    artist: "Halcyon Drift",
    duration: 112, // 1:52
    cover:
      "radial-gradient(circle at 30% 25%, #ffd36e 0%, #ff7a3d 40%, #1a1030 100%)",
    lyrics: [
      { t: 0, text: "♪" },
      { t: 8, text: "Cut a sky out of cardboard blue" },
      { t: 16, text: "Hung a paper moon for you (just for you)" },
      { t: 24, text: "We pretend that the dark's not real" },
      { t: 32, text: "Trace the cracks in the way we feel (the way we feel)" },
      { t: 40, text: "So hold my hand through the make-believe" },
      { t: 48, text: "Nothing's fake if it helps us breathe (helps us breathe)" },
      { t: 56, text: "♪" },
      { t: 64, text: "Paper moons and a plywood sea" },
      { t: 72, text: "Sail me somewhere we're meant to be (meant to be)" },
      { t: 80, text: "Even props cast a real enough glow" },
      { t: 88, text: "Stay a while 'fore the curtains close (curtains close)" },
      { t: 96, text: "So hold my hand through the make-believe" },
      { t: 104, text: "Nothing's fake if it helps us breathe (helps us breathe)" },
    ],
  },
  {
    title: "Concrete Sky",
    artist: "The Wandering",
    duration: 138, // 2:18
    cover:
      "linear-gradient(160deg, #2ee6c8 0%, #2f7bf2 50%, #0a1424 100%)",
    lyrics: [
      { t: 0, text: "♪" },
      { t: 9, text: "Grey towers reaching for the light" },
      { t: 18, text: "Steel horizons out of sight (out of sight)" },
      { t: 27, text: "I've been counting every window pane" },
      { t: 36, text: "Looking for a face in the rain (in the rain)" },
      { t: 45, text: "But I'll build a home from the noise and dust" },
      { t: 54, text: "Concrete sky can't bury us (bury us)" },
      { t: 63, text: "♪" },
      { t: 72, text: "Sirens fade into a lullaby" },
      { t: 81, text: "Somewhere up there's a real blue sky (real blue sky)" },
      { t: 90, text: "Take the long road, take my hand" },
      { t: 99, text: "We'll find green in this iron land (iron land)" },
      { t: 108, text: "So I'll build a home from the noise and dust" },
      { t: 117, text: "Concrete sky can't bury us (bury us)" },
      { t: 126, text: "Concrete sky can't bury us (bury us)" },
    ],
  },
];

// Split a lyric line that ends in one or more parenthesised groups into a main
// line + a smaller "backing vocals" line, exactly like renderer/lyrics.js.
function parseLyricParens(
  text: string,
): { main: string; paren: string } | null {
  const m = text.match(
    /^(.*?\S)\s+(\((?:[^()]+)\)(?:\s*\((?:[^()]+)\))*)\s*$/,
  );
  if (!m) return null;
  const strippedMain = m[1].replace(/\((?:[^()]+)\)/g, "").trim();
  if (!strippedMain) return null;
  return { main: m[1], paren: m[2] };
}

const START_AT = 44; // begin mid-song so it reads as "already playing"

// Lyrics conveyor geometry — mirrors renderer/lyrics.js. The top pad gives the
// current line enough headroom that its accent glow isn't clipped by the top of
// the lyrics window (see .lyrics-window mask + .lyrics-slot-current in the CSS).
const LYRICS_TOP_PAD = 40;
const LYRICS_GAP = 14;
const LYRICS_SLOTS_AHEAD = 2;

function fmt(t: number) {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function activeLyricIndex(time: number, lyrics: Lyric[]) {
  let idx = 0;
  for (let i = 0; i < lyrics.length; i++) {
    if (lyrics[i].t <= time) idx = i;
    else break;
  }
  return idx;
}

const LYRICS_ROW_HEIGHT = 44; // fallback stride before a line is measured

function lyricsSlotOpacity(role: number) {
  if (role <= 0) return 1;
  if (role === 1) return 0.55;
  return 0.3;
}

/* ───────────────────── Lyrics conveyor (left strip) ─────────────────────
   A direct port of renderer/lyrics.js. The current line sits near the top
   glowing in the accent colour with the next two lines stacked below (opacity
   1 / 0.55 / 0.3). A natural one-line advance animates: the scrolled-past line
   slides up out of view and fades, the survivors ease into their new slots, and
   the fresh bottom line fades in from just below — so you never see a raw
   top-to-bottom jump. Slots that end in "(...)" render a smaller backing line.
   Managed imperatively (like the app) so the entrance/exit transitions play. */
function LyricsPanel({
  time,
  wide,
  lyrics,
}: {
  time: number;
  wide?: boolean;
  lyrics: Lyric[];
}) {
  const idx = activeLyricIndex(time, lyrics);
  const windowRef = useRef<HTMLDivElement>(null);
  const slotEls = useRef<Map<number, HTMLDivElement>>(new Map());
  const startRef = useRef<number | null>(null);
  const loopRef = useRef(0);
  const prevIdxRef = useRef(idx);
  const wideRef = useRef(wide);
  // Track which lyric set is mounted so a whole-track switch re-snaps cleanly
  // (rather than being mistaken for a normal one-line advance / clock wrap).
  const lyricsRef = useRef(lyrics);

  // The clock loops (0..duration), so map the looping line index to a
  // monotonically-increasing "virtual" index — that keeps every song loop a
  // clean one-line forward advance instead of a jump back to the top.
  const vActiveRef = useRef(idx);

  const total = lyrics.length;

  function buildSlot(vIdx: number) {
    const el = document.createElement("div");
    el.className = "lyrics-slot";
    const text = lyrics[vIdx % total].text;
    const parsed = parseLyricParens(text);
    if (parsed) {
      const main = document.createElement("span");
      main.className = "lyrics-main-text";
      main.textContent = parsed.main;
      const paren = document.createElement("span");
      paren.className = "lyrics-paren-text";
      paren.textContent = parsed.paren;
      el.appendChild(main);
      el.appendChild(paren);
    } else {
      el.textContent = text;
    }
    return el;
  }

  function layout(start: number) {
    const positions = new Map<number, number>();
    let y = LYRICS_TOP_PAD;
    for (let role = 0; role <= LYRICS_SLOTS_AHEAD; role++) {
      const el = slotEls.current.get(start + role);
      if (!el) continue;
      el.style.transform = `translate(-50%, ${y}px)`;
      positions.set(start + role, y);
      y += (el.offsetHeight || LYRICS_ROW_HEIGHT) + LYRICS_GAP;
    }
    return positions;
  }

  function render(newStart: number, forceSnap: boolean) {
    const windowEl = windowRef.current;
    if (!windowEl) return;
    const prevStart = startRef.current;
    const step = prevStart === null ? null : newStart - prevStart;
    const snap = forceSnap || step === null || step !== 1;

    if (snap) {
      windowEl.innerHTML = "";
      slotEls.current.clear();
      const fresh: HTMLDivElement[] = [];
      for (let role = 0; role <= LYRICS_SLOTS_AHEAD; role++) {
        const v = newStart + role;
        const el = buildSlot(v);
        el.style.transition = "none";
        el.style.opacity = String(lyricsSlotOpacity(role));
        if (role === 0) el.classList.add("lyrics-slot-current");
        windowEl.appendChild(el);
        slotEls.current.set(v, el);
        fresh.push(el);
      }
      layout(newStart);
      startRef.current = newStart;
      requestAnimationFrame(() => {
        for (const el of fresh) el.style.transition = "";
      });
      return;
    }

    // Natural one-line forward advance — animate the conveyor.
    const outgoingIdx = prevStart as number;
    const outgoingEl = slotEls.current.get(outgoingIdx);

    let incomingEl: HTMLDivElement | null = null;
    const bottomIdx = newStart + LYRICS_SLOTS_AHEAD;
    if (!slotEls.current.has(bottomIdx)) {
      incomingEl = buildSlot(bottomIdx);
      incomingEl.style.transition = "none";
      incomingEl.style.opacity = "0";
      windowEl.appendChild(incomingEl);
      slotEls.current.set(bottomIdx, incomingEl);
    }

    for (let role = 0; role <= LYRICS_SLOTS_AHEAD; role++) {
      const el = slotEls.current.get(newStart + role);
      if (!el || el === incomingEl) continue;
      el.style.opacity = String(lyricsSlotOpacity(role));
      el.classList.toggle("lyrics-slot-current", role === 0);
    }

    if (outgoingEl) {
      const h = outgoingEl.offsetHeight || LYRICS_ROW_HEIGHT;
      outgoingEl.style.transform = `translate(-50%, ${
        LYRICS_TOP_PAD - h - LYRICS_GAP
      }px)`;
      outgoingEl.style.opacity = "0";
      outgoingEl.classList.remove("lyrics-slot-current");
      slotEls.current.delete(outgoingIdx);
      setTimeout(() => outgoingEl.remove(), 500);
    }

    const positions = layout(newStart);

    if (incomingEl) {
      const finalY = positions.get(bottomIdx) ?? LYRICS_TOP_PAD;
      incomingEl.style.transform = `translate(-50%, ${finalY + 14}px)`;
      const el = incomingEl;
      requestAnimationFrame(() => {
        el.style.transition = "";
        el.style.transform = `translate(-50%, ${finalY}px)`;
        el.style.opacity = String(lyricsSlotOpacity(LYRICS_SLOTS_AHEAD));
      });
    }

    startRef.current = newStart;
  }

  // Advance the conveyor whenever the active line changes — or hard-reset it
  // when the track (lyric set) changes under us.
  useEffect(() => {
    if (lyricsRef.current !== lyrics) {
      // Whole-track switch: drop the old conveyor and snap to the new song.
      lyricsRef.current = lyrics;
      loopRef.current = 0;
      prevIdxRef.current = idx;
      vActiveRef.current = idx;
      startRef.current = null;
      render(idx, true);
      return;
    }
    if (idx < prevIdxRef.current - 2) loopRef.current += 1; // clock wrapped
    prevIdxRef.current = idx;
    vActiveRef.current = loopRef.current * total + idx;
    render(vActiveRef.current, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, lyrics]);

  // Re-snap on a width change (wide ↔ narrow) so the measured stacking is fresh.
  useEffect(() => {
    if (wideRef.current !== wide && startRef.current !== null) {
      render(startRef.current, true);
    }
    wideRef.current = wide;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wide]);

  return (
    <div
      className={cn(
        "spotify-lyrics-panel",
        wide && "spotify-lyrics-panel--wide",
      )}
    >
      <div ref={windowRef} className="lyrics-window" />
    </div>
  );
}

/* ───────────────────────── Lyrics loading skeleton ──────────────────────
   Shown for a beat right after a track change, while the (pretend) synced
   lyrics for the new song are "fetched" — shimmering placeholder bars that
   mirror the conveyor's stacking, the top bar accent-tinted like the current
   line. Then the real LyricsPanel takes over. */
const SKELETON_BARS = [
  { w: "82%", current: true },
  { w: "64%", current: false },
  { w: "72%", current: false },
];

function LyricsSkeleton({ wide }: { wide?: boolean }) {
  return (
    <div
      className={cn("spotify-lyrics-panel", wide && "spotify-lyrics-panel--wide")}
      aria-hidden="true"
    >
      <div className="lyrics-window lyrics-skeleton">
        {SKELETON_BARS.map((b, i) => (
          <span
            key={i}
            className={cn(
              "lyrics-skel-bar",
              b.current && "lyrics-skel-bar--current",
            )}
            style={{ width: b.w }}
          />
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────── Spotify widget ───────────────────────────── */

// Scattered audio-visualiser particles around the disk (the app's "particles"
// mode). Fixed positions so there's no hydration mismatch; they twinkle while
// the track plays.
const VIZ_PARTICLES = [
  { x: 8, y: 22, s: 3, d: 0 },
  { x: 16, y: 62, s: 2, d: 0.5 },
  { x: 24, y: 40, s: 4, d: 1.1 },
  { x: 30, y: 82, s: 2, d: 0.3 },
  { x: 38, y: 12, s: 3, d: 0.8 },
  { x: 46, y: 92, s: 2, d: 1.4 },
  { x: 54, y: 8, s: 4, d: 0.2 },
  { x: 62, y: 70, s: 2, d: 0.9 },
  { x: 70, y: 30, s: 3, d: 1.3 },
  { x: 76, y: 88, s: 2, d: 0.6 },
  { x: 84, y: 18, s: 3, d: 0.1 },
  { x: 90, y: 54, s: 2, d: 1.0 },
  { x: 94, y: 76, s: 4, d: 0.4 },
  { x: 12, y: 46, s: 2, d: 1.2 },
  { x: 68, y: 52, s: 2, d: 0.7 },
  { x: 50, y: 48, s: 3, d: 1.5 },
];

function SpotifyWidget({
  track,
  time,
  playing,
  showLyrics,
  lyricsLoading,
  wide,
  onToggle,
  onSeek,
  onSkip,
  style,
}: {
  track: Track;
  time: number;
  playing: boolean;
  showLyrics: boolean;
  lyricsLoading: boolean;
  wide: boolean;
  onToggle: () => void;
  onSeek: (t: number) => void;
  onSkip: (dir: number) => void;
  style?: CSSProperties;
}) {
  const pct = Math.min(100, (time / track.duration) * 100);

  return (
    <div
      className="widget-card glass glow relative flex h-52 items-center justify-center overflow-hidden rounded-3xl border border-white/10 p-5 text-center reveal-item"
      style={style}
    >
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.03] to-transparent" />

      <div className="relative z-10 flex h-full w-full">
        {/* Left: synced lyrics — a loading skeleton flashes while the new
            track's lyrics "load" after a skip, then the live conveyor mounts. */}
        {showLyrics &&
          (lyricsLoading ? (
            <LyricsSkeleton wide={wide} />
          ) : (
            <LyricsPanel time={time} wide={wide} lyrics={track.lyrics} />
          ))}

        {/* Center: vinyl + info + controls + progress */}
        <div className="relative flex flex-1 flex-col items-center justify-center">
          {/* Audio-visualiser particle field around the disk */}
          <div className="spotify-viz" aria-hidden="true">
            {VIZ_PARTICLES.map((p, i) => (
              <span
                key={i}
                className="viz-dot"
                style={{
                  left: `${p.x}%`,
                  top: `${p.y}%`,
                  width: p.s,
                  height: p.s,
                  animationDelay: `${p.d}s`,
                  animationPlayState: playing ? "running" : "paused",
                }}
              />
            ))}
          </div>
          <div className="spotify-disk-glow-wrapper relative z-10 flex h-24 w-24 items-center justify-center">
            <div className="beat-glow-halo" />
            {/* The real app's vinyl artwork (icons/player.png). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/player.png"
              alt=""
              draggable={false}
              className={cn(
                "mock-vinyl h-20 w-20 rounded-full object-cover",
                playing && "animate-spin-slow",
              )}
            />
            {/* Per-track album cover — a colour gradient rendered black-and-
               white by the .spotify-album-cover grayscale filter. */}
            <span
              className="spotify-album-cover"
              style={{ backgroundImage: track.cover }}
            />
            {/* Floating track label */}
            <div className="spotify-track-info absolute -top-1 right-0 z-10 max-w-[140px] rounded-xl border border-white/10 bg-black/70 px-2 py-1 backdrop-blur-sm">
              <p className="truncate text-[9px] font-medium leading-tight text-white">
                {track.title}
              </p>
              <p className="truncate text-[8px] leading-tight text-neutral-400">
                {track.artist}
              </p>
            </div>
          </div>

          {/* Controls */}
          <div className="mt-1 flex items-center gap-2.5">
            <button
              type="button"
              aria-label="Previous track"
              onClick={() => onSkip(-1)}
              className="spotify-control-btn flex h-6 w-6 items-center justify-center text-neutral-400 transition-colors hover:text-white"
            >
              <i className="fas fa-step-backward text-[9px]" />
            </button>
            <button
              type="button"
              aria-label={playing ? "Pause" : "Play"}
              onClick={onToggle}
              className={cn(
                "spotify-control-btn flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20",
                playing && "is-playing",
              )}
            >
              <span className="morph-play-icon">
                <span className="morph-bar morph-bar-a" />
                <span className="morph-bar morph-bar-b" />
              </span>
            </button>
            <button
              type="button"
              aria-label="Next track"
              onClick={() => onSkip(1)}
              className="spotify-control-btn flex h-6 w-6 items-center justify-center text-neutral-400 transition-colors hover:text-white"
            >
              <i className="fas fa-step-forward text-[9px]" />
            </button>
          </div>

          {/* Progress */}
          <div className="mt-1.5 w-full px-3">
            <div className="mb-0.5 flex justify-between font-mono text-[8px] text-neutral-500">
              <span>{fmt(time)}</span>
              <span>{fmt(track.duration)}</span>
            </div>
            <button
              type="button"
              aria-label="Seek"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                onSeek(((e.clientX - r.left) / r.width) * track.duration);
              }}
              className="spotify-progress-track block h-1 w-full overflow-hidden rounded-full bg-neutral-800"
            >
              <div
                className="spotify-progress-bar h-full rounded-full"
                style={{ width: `${pct}%` }}
              />
            </button>
          </div>
        </div>

        {/* Right: vertical volume */}
        <div className="flex flex-col items-center justify-center py-2 pr-1">
          <div className="spotify-volume-container spotify-volume-glow">
            <input
              type="range"
              min={0}
              max={100}
              defaultValue={68}
              tabIndex={-1}
              aria-label="Volume"
              className="spotify-volume-slider-v"
            />
          </div>
          <i className="fas fa-volume-low mt-1 text-[8px] text-neutral-500" />
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Performance ───────────────────────────────
   Matches the app's card exactly: CPU + RAM bars, a live dot, no extra chrome. */
function Performance({ style }: { style?: CSSProperties }) {
  const [cpu, setCpu] = useState(28);
  const [ram, setRam] = useState(54);

  useEffect(() => {
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduced) return;
    const id = setInterval(() => {
      setCpu(18 + Math.round(Math.random() * 34));
      setRam(46 + Math.round(Math.random() * 22));
    }, 2200);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      className="widget-card glass glow h-52 rounded-3xl border border-white/10 p-5 reveal-item"
      style={style}
    >
      <div className="mb-4 flex items-center justify-between">
        <h3 className="section-label">Performance</h3>
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-neutral-500">
          <span className="perf-live-dot" />
          <span>live</span>
        </div>
      </div>
      <div className="space-y-5 text-sm">
        <Stat label="CPU" value={cpu} />
        <Stat label="RAM" value={ram} dim />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  dim,
}: {
  label: string;
  value: number;
  dim?: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 flex justify-between">
        <span className="text-neutral-500">{label}</span>
        <span
          className={cn(
            "stat-val font-mono text-xs",
            dim ? "text-neutral-300" : "text-white",
          )}
        >
          {value}%
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-neutral-800">
        <div
          className={cn("stat-bar h-full rounded-full", dim && "opacity-80")}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

/* ─────────────────────────── Quick Notes ───────────────────────────────
   The app's basic scratch note — here it types itself out on first view. */
const NOTE_LINES = ["— grab milk & coffee", "— reply to Alex", "— gym at 7"];
const NOTE_TEXT = NOTE_LINES.join("\n");

function QuickNotes({ style }: { style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState("");
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let timer: ReturnType<typeof setTimeout>;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        io.disconnect();
        setStarted(true);
        if (reduced) {
          setTyped(NOTE_TEXT);
          return;
        }
        let i = 0;
        const tick = () => {
          i += 1;
          setTyped(NOTE_TEXT.slice(0, i));
          if (i >= NOTE_TEXT.length) return;
          const prev = NOTE_TEXT[i - 1];
          const delay =
            prev === "\n" ? 430 : prev === " " ? 68 : 40 + Math.random() * 54;
          timer = setTimeout(tick, delay);
        };
        timer = setTimeout(tick, 520);
      },
      { threshold: 0.55 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clearTimeout(timer);
    };
  }, []);

  const lines = typed.split("\n");
  const done = typed.length === NOTE_TEXT.length;

  return (
    <div
      ref={ref}
      className="widget-card glass glow relative h-52 overflow-hidden rounded-3xl border border-white/10 p-5 reveal-item"
      style={style}
    >
      <h3 className="section-label mb-3">Quick Notes</h3>
      {!started ? (
        <p className="text-xs text-neutral-600">start typing here...</p>
      ) : (
        <p className="text-sm leading-relaxed text-neutral-300">
          {lines.map((line, i) => {
            const isLast = i === lines.length - 1;
            return (
              <span key={i}>
                {line}
                {isLast && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] bg-white/70",
                      done && "animate-pulse",
                    )}
                  />
                )}
                {!isLast && <br />}
              </span>
            );
          })}
        </p>
      )}
    </div>
  );
}

/* ────────────────────────── Empty state ────────────────────────────── */

function EmptyState() {
  return (
    <div className="reveal-item flex h-52 flex-col items-center justify-center rounded-3xl border border-dashed border-white/10 text-center">
      <i className="fa-solid fa-shapes mb-3 text-2xl text-neutral-700" />
      <p className="text-sm text-neutral-500">Your dashboard, your way.</p>
      <p className="mt-1 text-xs text-neutral-600">
        Toggle a widget below to add it back.
      </p>
    </div>
  );
}

/* ─────────────────────────── Root window ───────────────────────────── */

export function AppWindowMock({
  visible,
  active = true,
}: {
  visible: WidgetVisibility;
  active?: boolean;
}) {
  const [time, setTime] = useState(START_AT);
  const [playing, setPlaying] = useState(true);
  const [trackIndex, setTrackIndex] = useState(0);
  const [lyricsLoading, setLyricsLoading] = useState(false);

  const timeRef = useRef(START_AT);
  const playingRef = useRef(true);
  const emittedRef = useRef(START_AT);
  const trackIndexRef = useRef(0);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  playingRef.current = playing;

  // Clear any pending "lyrics loading" timer when the mock unmounts.
  useEffect(
    () => () => {
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    },
    [],
  );

  // The playback clock: advances the fake track, throttled to ~5 fps of React
  // state (CSS transitions smooth the rest). Reduced-motion sits on one line.
  // Only runs while the mock is on-screen (`active`) — off-screen it stops
  // re-rendering the blurred cards, which is what makes the rest of the page
  // scroll smoothly.
  useEffect(() => {
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduced || !active) return;

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (playingRef.current) {
        const dur = TRACKS[trackIndexRef.current].duration;
        timeRef.current = (timeRef.current + dt) % dur;
        if (Math.abs(timeRef.current - emittedRef.current) > 0.2) {
          emittedRef.current = timeRef.current;
          setTime(timeRef.current);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  const seek = (t: number) => {
    const dur = TRACKS[trackIndexRef.current].duration;
    const clamped = ((t % dur) + dur) % dur;
    timeRef.current = clamped;
    emittedRef.current = clamped;
    setTime(clamped);
  };

  // Next / Previous — step a *whole* track (wrapping the playlist). The song
  // changes completely: title, artist, album art, lyrics and duration, and
  // playback restarts from the top and keeps playing.
  const skipTrack = (dir: number) => {
    const next = (trackIndexRef.current + dir + TRACKS.length) % TRACKS.length;
    trackIndexRef.current = next;
    setTrackIndex(next);
    timeRef.current = 0;
    emittedRef.current = 0;
    setTime(0);
    playingRef.current = true;
    setPlaying(true);
    // Flash the lyrics skeleton while the new song's lyrics "load".
    setLyricsLoading(true);
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    loadTimerRef.current = setTimeout(() => setLyricsLoading(false), 750);
  };

  // Visible top-level widgets drive the grid column count (the app widens the
  // remaining cards when others are hidden — grid-template-columns).
  const cols =
    (visible.notes ? 1 : 0) +
    (visible.performance ? 1 : 0) +
    (visible.spotify ? 1 : 0);

  return (
    <div
      className={cn(
        "app-mock glow-strong relative h-[640px] w-[920px] overflow-hidden rounded-[32px] border border-white/10",
        !active && "mock-paused",
      )}
      role="img"
      aria-label="A preview of the main desktop overlay window"
    >
      {/* Local background layers (a self-contained version of the FX stack) */}
      <div className="pointer-events-none absolute inset-0">
        <div className="bg-scene" />
        <div className="bg-blob bg-blob-a" />
        <div className="bg-blob bg-blob-b" />
        <div className="grid-overlay" />
        <div className="scanline" />
      </div>

      <div className="relative z-10 flex h-full flex-col">
        {/* ── Header ── */}
        <div className="mock-item flex select-none items-center justify-between border-b border-white/10 px-8 py-5">
          <div className="flex items-center gap-3">
            <Logo size={36} />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-white">
                main
              </h1>
              <p className="text-[10px] tracking-widest text-neutral-500">
                {VERSION_LABEL}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <div className="mr-4 flex items-center gap-2 font-mono text-sm tabular-nums text-neutral-400">
              <i className="fa-solid fa-cloud-sun text-neutral-500" />
              <span>18°C</span>
            </div>
            <div className="mr-2 font-mono text-sm tabular-nums text-neutral-400">
              9:41 <span className="ml-1 text-neutral-600">PM</span>
            </div>
            <span className="window-btn inline-flex items-center justify-center">
              <i className="fas fa-cog text-xs" />
            </span>
            <span className="window-btn inline-flex items-center justify-center">
              <i className="fas fa-minus text-xs" />
            </span>
          </div>
        </div>

        {/* ── Quick Launch ── */}
        <div className="px-8 pt-6">
          <div
            className="mock-item mb-5 flex items-center justify-between"
            style={{ animationDelay: "0.08s" }}
          >
            <h2 className="section-label">Quick Launch</h2>
          </div>
          <div className="grid grid-cols-6 gap-6">
            {QUICK_LAUNCH.map((app) => (
              // Exact app markup: .app-icon wrapper scales on hover, the rounded
              // .icon-tile carries the accent glow + sheen sweep (renderer/
              // ui-utils.js + styles/main.css).
              <div
                key={app.label}
                className="app-icon flex cursor-pointer flex-col items-center rounded-3xl border border-transparent px-2 py-3"
              >
                <div className="icon-tile mb-2.5 flex h-16 w-16 items-center justify-center overflow-hidden rounded-3xl border border-white/10 bg-neutral-950 text-xl text-neutral-300">
                  <i className={app.icon} />
                </div>
                <span className="text-[10px] text-neutral-500">{app.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Widgets row (exactly the app's grid, column count follows toggles) ── */}
        <div
          className="mt-6 grid gap-5 px-8"
          style={{
            gridTemplateColumns:
              cols > 0 ? `repeat(${cols}, minmax(0, 1fr))` : "1fr",
          }}
        >
          {cols === 0 ? (
            <EmptyState />
          ) : (
            <>
              {visible.notes && <QuickNotes style={{ animationDelay: "0.24s" }} />}
              {visible.performance && (
                <Performance style={{ animationDelay: "0.32s" }} />
              )}
              {visible.spotify && (
                <SpotifyWidget
                  track={TRACKS[trackIndex]}
                  time={time}
                  playing={playing}
                  showLyrics={visible.lyrics}
                  lyricsLoading={lyricsLoading}
                  wide={cols === 1}
                  onToggle={() => setPlaying((p) => !p)}
                  onSeek={seek}
                  onSkip={skipTrack}
                  style={{ animationDelay: "0.4s" }}
                />
              )}
            </>
          )}
        </div>

        {/* ── Mini Widgets strip ── */}
        <div className="mock-item mt-5 px-8" style={{ animationDelay: "0.46s" }}>
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="section-label">Mini Widgets</h2>
            <span className="mock-chip">
              <i className="fas fa-shapes text-[10px]" />
              Browse Widgets
            </span>
          </div>
          <div className="flex gap-2 overflow-hidden">
            {STRIP.map((w) => (
              <span key={w.label} className="mock-chip">
                <i className={`${w.icon} text-[10px] text-neutral-400`} />
                {w.label}
              </span>
            ))}
          </div>
        </div>

        {/* ── Footer ── (mt-auto keeps it pinned to the window's bottom edge
            while sitting in normal flow, so it never overlaps the Mini Widgets
            strip above it) */}
        <div
          className="mock-item mt-auto flex justify-between px-8 pb-4 pt-3 text-[10px] tracking-wide text-neutral-600"
          style={{ animationDelay: "0.5s" }}
        >
          <div className="font-mono">Alt+M focus · Alt+Q close</div>
          <div className="font-mono">
            <span className="text-neutral-700">made by ryota</span> ·{" "}
            {VERSION_LABEL}
          </div>
        </div>
      </div>
    </div>
  );
}
