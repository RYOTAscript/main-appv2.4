import { cn } from "@/lib/cn";

/**
 * The "main" brand mark — the chrome star, self-hosted at /logo.png. The source
 * art is on a near-black field so it sits naturally in the dark UI; a hairline
 * border + rounded frame make it read as a badge like the app icon.
 */
export function Logo({
  size = 36,
  className,
  rounded = "rounded-2xl",
  bordered = true,
}: {
  size?: number;
  className?: string;
  rounded?: string;
  bordered?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex flex-shrink-0 items-center justify-center overflow-hidden bg-black",
        rounded,
        bordered && "border border-white/10",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo.png"
        alt="main logo"
        width={size}
        height={size}
        className="h-full w-full object-cover"
        draggable={false}
      />
    </span>
  );
}
