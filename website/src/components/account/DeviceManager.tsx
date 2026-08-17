"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

type Device = {
  id: string;
  name: string | null;
  shortId: string;
  firstSeen: string;
  lastSeen: string;
};

type Summary = {
  limit: number;
  used: number;
  devices: Device[];
  resetInMs: number;
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function fmtDuration(ms: number) {
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.ceil(ms / (60 * 60 * 1000)));
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * Device (HWID) manager for the account page. Shows how many of the allowed
 * device slots are in use, lists the activated machines, and lets the user
 * reset (free) all slots — the self-serve fix for "this license is already
 * active on the maximum number of devices."
 */
export function DeviceManager({ initial }: { initial: Summary }) {
  const [summary, setSummary] = useState<Summary>(initial);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { limit, used, devices, resetInMs } = summary;
  const atLimit = used >= limit;
  const onCooldown = resetInMs > 0;

  const reset = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/account/devices", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as Summary & {
        removed?: number;
        error?: string;
      };
      if (!res.ok) {
        // A 429 (cooldown) still carries the fresh summary — sync it so the
        // button reflects the remaining wait.
        if (typeof data.limit === "number") {
          setSummary({
            limit: data.limit,
            used: data.used,
            devices: data.devices,
            resetInMs: data.resetInMs,
          });
        }
        setArmed(false);
        throw new Error(data.error || "Could not reset your devices.");
      }
      setSummary({
        limit: data.limit,
        used: data.used,
        devices: data.devices,
        resetInMs: data.resetInMs,
      });
      setNotice(
        data.removed
          ? `Reset complete — ${data.removed} device${
              data.removed === 1 ? "" : "s"
            } cleared. Every computer will be signed out and must sign in again next time it opens main.`
          : "You had no active devices to clear.",
      );
      setArmed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      {/* Usage indicator */}
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium",
              atLimit
                ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                : "border-white/15 bg-white/5 text-neutral-200",
            )}
          >
            <i className="fa-solid fa-desktop text-[10px]" />
            {used} of {limit} device{limit === 1 ? "" : "s"} used
          </span>
          {/* Slot pips */}
          <span className="flex items-center gap-1">
            {Array.from({ length: limit }).map((_, i) => (
              <span
                key={i}
                aria-hidden
                className={cn(
                  "h-1.5 w-5 rounded-full transition-colors",
                  i < used ? "bg-[rgb(var(--accent))]" : "bg-white/12",
                )}
              />
            ))}
          </span>
        </div>
      </div>

      {/* What this means */}
      <p className="mb-4 max-w-xl text-sm leading-relaxed text-neutral-400">
        Your license runs on up to{" "}
        <span className="font-medium text-neutral-200">{limit} computers</span>{" "}
        at once. Each computer registers a unique hardware ID (HWID) the first
        time you open main. If you get a new PC and hit the limit,{" "}
        <span className="font-medium text-neutral-200">reset your devices</span>{" "}
        below to free every slot. Every computer is then signed out and asks for
        your license key again the next time it opens main.
      </p>

      {/* Device list */}
      {devices.length > 0 ? (
        <ul className="mb-4 divide-y divide-white/5 overflow-hidden rounded-xl border border-white/8 bg-white/[0.015]">
          {devices.map((d, i) => (
            <li
              key={d.id}
              className="flex items-center gap-3 px-4 py-3 text-sm"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-neutral-300">
                <i className="fa-solid fa-desktop text-xs" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-neutral-200">
                  {d.name || `Device ${i + 1}`}
                  <span className="ml-2 font-mono text-xs text-neutral-500">
                    #{d.shortId}
                  </span>
                </p>
                <p className="text-xs text-neutral-500">
                  Added {fmtDate(d.firstSeen)} · last active{" "}
                  {fmtDate(d.lastSeen)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mb-4 rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-neutral-500">
          No devices activated yet. Your first slot fills the next time you open
          main on a PC.
        </div>
      )}

      {/* Reset control (two-step, matches the danger-zone pattern) */}
      {!armed ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setArmed(true);
              setNotice(null);
              setError(null);
            }}
            disabled={devices.length === 0 || onCooldown}
            className="inline-flex items-center gap-2 rounded-xl border border-white/12 bg-white/[0.04] px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:border-white/25 hover:bg-white/10 disabled:opacity-50 disabled:hover:border-white/12 disabled:hover:bg-white/[0.04]"
          >
            <i className="fa-solid fa-rotate-left text-xs" />
            Reset devices
          </button>
          {onCooldown && (
            <span className="inline-flex items-center gap-1.5 text-xs text-neutral-500">
              <i className="fa-regular fa-clock text-[10px]" />
              Available again in {fmtDuration(resetInMs)}
            </span>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-neutral-300">
            Free all {used} device slot{used === 1 ? "" : "s"}? Every computer
            will be signed out and must enter your license key again next time it
            opens main.
          </span>
          <button
            type="button"
            onClick={reset}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl border border-white/25 bg-white/15 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/25 disabled:opacity-60"
          >
            {busy ? (
              <i className="fa-solid fa-circle-notch animate-spin text-xs" />
            ) : (
              <i className="fa-solid fa-rotate-left text-xs" />
            )}
            Yes, reset all devices
          </button>
          <button
            type="button"
            onClick={() => setArmed(false)}
            disabled={busy}
            className="rounded-xl px-3 py-2 text-sm text-neutral-400 transition-colors hover:text-white"
          >
            Cancel
          </button>
        </div>
      )}

      {notice && (
        <p className="mt-3 flex items-center gap-2 text-xs text-green-400">
          <i className="fa-solid fa-circle-check text-[10px]" />
          {notice}
        </p>
      )}
      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
    </div>
  );
}
