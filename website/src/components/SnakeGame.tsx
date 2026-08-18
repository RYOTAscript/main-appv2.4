"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { SectionLabel } from "@/components/ui/SectionLabel";

/**
 * Glass Snake — the hidden arcade opened from the footer logo.
 *
 * Canvas-rendered so it can read the live `--accent` each frame and paint the
 * snake/food in whatever accent the visitor picked, on the same glass board as
 * the rest of the UI. Game state lives in a ref; a single rAF loop ticks on a
 * shrinking interval (it speeds up as you eat). React state only carries the
 * phase + score/best for the HUD and overlays.
 *
 * Controls: arrow keys / WASD, or swipe.
 */

const N = 15; // grid is N×N
const MAX_PX = 360;
const START_STEP = 100; // ms per move
const MIN_STEP = 55;
const BEST_KEY = "main.play.snake.best";

type Pt = { x: number; y: number };
type Phase = "idle" | "playing" | "over";
type Game = {
  snake: Pt[]; // head first
  dir: Pt;
  queue: Pt[]; // up to 2 buffered turns for snappy input
  food: Pt;
  step: number;
  score: number;
};

const EQ = (a: Pt, b: Pt) => a.x === b.x && a.y === b.y;

function spawnFood(snake: Pt[]): Pt {
  const taken = new Set(snake.map((s) => `${s.x},${s.y}`));
  const free: Pt[] = [];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      if (!taken.has(`${x},${y}`)) free.push({ x, y });
  return free[(Math.random() * free.length) | 0] ?? { x: 0, y: 0 };
}

function freshGame(): Game {
  const cy = (N / 2) | 0;
  const snake: Pt[] = [
    { x: 5, y: cy },
    { x: 4, y: cy },
    { x: 3, y: cy },
  ];
  return {
    snake,
    dir: { x: 1, y: 0 },
    queue: [],
    food: spawnFood(snake),
    step: START_STEP,
    score: 0,
  };
}

export function SnakeGame() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [px, setPx] = useState(0);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game>(freshGame());
  const phaseRef = useRef<Phase>("idle");
  const rafRef = useRef(0);
  const lastRef = useRef(0);
  const accRef = useRef(0);
  const accentRef = useRef("255, 255, 255");
  phaseRef.current = phase;

  // Measure available width → square board (capped), before first paint.
  useLayoutEffect(() => {
    const measure = () => {
      const w = wrapRef.current?.clientWidth ?? MAX_PX;
      setPx(Math.max(220, Math.min(MAX_PX, Math.floor(w) - 20)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const readAccent = () => {
    if (typeof window === "undefined") return "255, 255, 255";
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim();
    return v || "255, 255, 255";
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || px <= 0) return;
    const cell = px / N;
    const accent = accentRef.current; // cached; refreshed per tick, not per frame
    // Draw in CSS pixels; scale the context so the hi-DPI backing store stays crisp.
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, px, px);

    // faint grid
    ctx.strokeStyle = `rgba(${accent}, 0.05)`;
    ctx.lineWidth = 1;
    for (let i = 1; i < N; i++) {
      ctx.beginPath();
      ctx.moveTo(Math.round(i * cell) + 0.5, 0);
      ctx.lineTo(Math.round(i * cell) + 0.5, px);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, Math.round(i * cell) + 0.5);
      ctx.lineTo(px, Math.round(i * cell) + 0.5);
      ctx.stroke();
    }

    const roundCell = (
      p: Pt,
      fill: string,
      glow: number,
      inset: number,
    ) => {
      const x = p.x * cell + inset;
      const y = p.y * cell + inset;
      const s = cell - inset * 2;
      const r = Math.min(6, s / 3);
      ctx.save();
      ctx.shadowBlur = glow;
      ctx.shadowColor = `rgba(${accent}, 0.85)`;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.roundRect(x, y, s, s, r);
      ctx.fill();
      ctx.restore();
    };

    // food — a pulsing accent pellet
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 400);
    roundCell(
      gameRef.current.food,
      `rgba(${accent}, 0.95)`,
      6 + 8 * pulse,
      cell * 0.22,
    );

    // snake — brightest at the head, fading toward the tail
    const snake = gameRef.current.snake;
    snake.forEach((seg, i) => {
      const a = 0.9 - (i / Math.max(1, snake.length)) * 0.55;
      roundCell(
        seg,
        `rgba(${accent}, ${a.toFixed(3)})`,
        i === 0 ? 14 : 0,
        cell * 0.1,
      );
    });
  }, [px]);

  const endGame = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const s = gameRef.current.score;
    setBest((b) => {
      const nb = Math.max(b, s);
      try {
        localStorage.setItem(BEST_KEY, String(nb));
      } catch {
        /* ignore */
      }
      return nb;
    });
    setPhase("over");
  }, []);

  const tick = useCallback(() => {
    const g = gameRef.current;
    // Commit the next buffered turn, if any.
    if (g.queue.length) g.dir = g.queue.shift() as Pt;
    accentRef.current = readAccent(); // refresh once per move, not per frame
    const head = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
    // wall or self collision
    if (
      head.x < 0 ||
      head.y < 0 ||
      head.x >= N ||
      head.y >= N ||
      g.snake.some((s, i) => i < g.snake.length - 1 && EQ(s, head))
    ) {
      endGame();
      return;
    }
    g.snake.unshift(head);
    if (EQ(head, g.food)) {
      g.score += 1;
      g.step = Math.max(MIN_STEP, g.step - 4);
      g.food = spawnFood(g.snake);
      setScore(g.score);
    } else {
      g.snake.pop();
    }
  }, [endGame]);

  const loop = useCallback(
    (now: number) => {
      if (phaseRef.current !== "playing") return;
      // Cap dt so a backgrounded tab doesn't unleash a burst of catch-up moves.
      const dt = Math.min(200, now - lastRef.current);
      lastRef.current = now;
      accRef.current += dt;
      let ticks = 0;
      while (accRef.current >= gameRef.current.step && ticks < 4) {
        accRef.current -= gameRef.current.step;
        ticks++;
        tick();
        if (phaseRef.current !== "playing") break;
      }
      draw();
      if (phaseRef.current === "playing")
        rafRef.current = requestAnimationFrame(loop);
    },
    [tick, draw],
  );

  const begin = useCallback(() => {
    if (px <= 0) return;
    gameRef.current = freshGame();
    accentRef.current = readAccent();
    setScore(0);
    setPhase("playing");
    lastRef.current = performance.now();
    accRef.current = 0;
    rafRef.current = requestAnimationFrame(loop);
  }, [px, loop]);

  // Load best; draw the idle preview board once sized.
  useEffect(() => {
    try {
      setBest(Number(localStorage.getItem(BEST_KEY)) || 0);
    } catch {
      /* ignore */
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  useEffect(() => {
    if (phase !== "playing") {
      accentRef.current = readAccent();
      draw();
    }
  }, [px, phase, draw]);

  // Buffer a turn. Queues up to 2 so a fast corner (e.g. ↑ then ←) both land,
  // and if we're already past halfway to the next move, apply it on the very
  // next frame instead of waiting a whole step — that's what kills the "lag".
  const enqueueDir = useCallback((nd: Pt) => {
    const g = gameRef.current;
    const ref = g.queue.length ? g.queue[g.queue.length - 1] : g.dir;
    if (nd.x === ref.x && nd.y === ref.y) return; // same heading
    if (nd.x === -ref.x && nd.y === -ref.y) return; // 180° reversal
    if (g.queue.length >= 2) return;
    g.queue.push(nd);
    if (accRef.current >= g.step * 0.5) accRef.current = g.step;
  }, []);

  // Keyboard.
  useEffect(() => {
    const dirs: Record<string, Pt> = {
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      w: { x: 0, y: -1 },
      s: { x: 0, y: 1 },
      a: { x: -1, y: 0 },
      d: { x: 1, y: 0 },
    };
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const nd = dirs[key];
      if (!nd) return;
      e.preventDefault();
      enqueueDir(nd);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enqueueDir]);

  // Swipe.
  const touch = useRef<Pt | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touch.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.current.x;
    const dy = t.clientY - touch.current.y;
    touch.current = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    enqueueDir(
      Math.abs(dx) > Math.abs(dy)
        ? { x: dx > 0 ? 1 : -1, y: 0 }
        : { x: 0, y: dy > 0 ? 1 : -1 },
    );
  };

  return (
    <div className="flex w-full max-w-md flex-col items-center">
      <SectionLabel className="mb-3">Arcade · hidden</SectionLabel>
      <h1 className="display-type mb-1 text-4xl font-bold tracking-tight text-white">
        Snake
      </h1>
      <p className="mb-6 text-sm text-neutral-500">
        Eat the pellets. Arrow keys, WASD, or swipe.
      </p>

      <div className="mb-4 flex w-full items-stretch justify-center gap-3">
        <div className="glass glow rounded-2xl border border-white/10 px-4 py-2 text-center">
          <div className="section-label">Score</div>
          <div className="font-mono text-lg font-semibold text-white">
            {score}
          </div>
        </div>
        <div className="glass rounded-2xl border border-white/10 px-4 py-2 text-center">
          <div className="section-label">Best</div>
          <div className="font-mono text-lg font-semibold text-accent-solid">
            {best}
          </div>
        </div>
      </div>

      <div ref={wrapRef} className="flex w-full justify-center">
        <div
          className="snake-board"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          <canvas
            ref={canvasRef}
            width={px * (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1)}
            height={px * (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1)}
            style={{ width: px, height: px, borderRadius: 12, display: "block" }}
          />

          {phase !== "playing" && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-[20px] bg-black/55 px-6 text-center backdrop-blur-sm">
              {phase === "over" ? (
                <>
                  <p className="font-mono text-xs uppercase tracking-[0.2em] text-neutral-500">
                    Game over
                  </p>
                  <p className="display-type text-3xl font-bold text-white">
                    {score}
                  </p>
                  <p className="text-xs text-neutral-400">
                    best <span className="text-accent-solid">{best}</span>
                    {score >= best && score > 0 && (
                      <span className="ml-2 text-accent-solid">· new best!</span>
                    )}
                  </p>
                </>
              ) : (
                <p className="max-w-[15rem] text-sm text-neutral-300">
                  Guide the snake, grab the glowing pellets, don&apos;t bite
                  yourself or hit a wall.
                </p>
              )}
              <button
                type="button"
                onClick={begin}
                className="mt-1 inline-flex items-center gap-2 rounded-2xl bg-white px-6 py-2.5 text-sm font-semibold text-black transition-transform hover:-translate-y-0.5 active:scale-95"
              >
                <i className="fa-solid fa-play text-xs" />
                {phase === "over" ? "Play again" : "Play"}
              </button>
            </div>
          )}
        </div>
      </div>

      <p className="mt-6 font-mono text-xs tracking-wide text-neutral-600">
        press <span className="text-neutral-400">Esc</span> to close
      </p>
    </div>
  );
}
