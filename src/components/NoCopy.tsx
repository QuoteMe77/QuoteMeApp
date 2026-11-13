"use client";

import type { ReactNode } from "react";

// Wraps price book content so it can't be selected, copied, cut, dragged, pasted into, right-clicked or
// printed from the page. This stops casual copying only — anything shown on a screen can still be
// photographed — so the real protection is that each shop can only ever load its own price book.
export default function NoCopy({ children, className = "" }: { children: ReactNode; className?: string }) {
  const stop = (e: React.SyntheticEvent) => e.preventDefault();
  return (
    <div
      className={`no-copy select-none ${className}`}
      onCopy={stop}
      onCut={stop}
      onPaste={stop}
      onDragStart={stop}
      onContextMenu={stop}
      style={{ WebkitUserSelect: "none", userSelect: "none", WebkitTouchCallout: "none" }}
    >
      {children}
    </div>
  );
}
