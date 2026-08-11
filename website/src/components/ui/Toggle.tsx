"use client";

import { useId } from "react";
import { cn } from "@/lib/cn";

/** iOS-style toggle switch, identical markup/behaviour to the app's. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange?: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={cn(
        "inline-flex items-center gap-3",
        disabled ? "opacity-50" : "cursor-pointer",
        className,
      )}
    >
      <span className="ios-toggle">
        <input
          id={id}
          type="checkbox"
          className="ios-toggle-input"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.checked)}
        />
        <span className="ios-toggle-track" />
      </span>
      {label && <span className="text-sm text-neutral-300">{label}</span>}
    </label>
  );
}
