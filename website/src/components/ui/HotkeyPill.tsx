import { cn } from "@/lib/cn";

/**
 * Renders a hotkey combo as JetBrains-Mono chips, e.g. "Control+Shift+M".
 * Splits on "+" so each key is its own pill segment, like the app.
 */
export function HotkeyPill({
  combo,
  className,
}: {
  combo: string;
  className?: string;
}) {
  const keys = combo.split("+").map((k) => k.trim());
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {keys.map((key, i) => (
        <span key={`${key}-${i}`} className="hotkey-pill font-mono">
          {key}
        </span>
      ))}
    </span>
  );
}
