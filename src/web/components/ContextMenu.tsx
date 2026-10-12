import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefBadgeInfo } from "../lib/refs";

/** What was right-clicked. Phase 4 builds its action list from this. */
export type ContextTarget =
  | { kind: "commit"; hash: string }
  | { kind: "uncommitted" }
  | { kind: "ref"; hash: string; badge: RefBadgeInfo };

export interface ContextMenuState {
  x: number;
  y: number;
  target: ContextTarget;
}

export interface ContextMenuItem {
  id: string;
  label: string;
  /** Draws a divider above this item. */
  separator?: boolean;
  /** Tooltip, e.g. why the item is disabled. */
  title?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
}

export interface ContextMenuProps {
  state: ContextMenuState;
  onClose: () => void;
  /** Return the items for `target`. Defaults to a disabled placeholder. */
  getItems?: (target: ContextTarget) => ContextMenuItem[];
}

const PLACEHOLDER: ContextMenuItem[] = [{ id: "soon", label: "Actions coming soon", disabled: true }];

export function ContextMenu({ state, onClose, getItems }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });
  const items = getItems?.(state.target) ?? PLACEHOLDER;

  // Keep the menu inside the viewport (layout effect: no frame is painted at the unclamped position).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({
      x: Math.max(4, Math.min(state.x, window.innerWidth - el.offsetWidth - 4)),
      y: Math.max(4, Math.min(state.y, window.innerHeight - el.offsetHeight - 4)),
    });
  }, [state.x, state.y]);

  // Keyboard users land on the first enabled item.
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      if (buttons.length === 0) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      let next: number | undefined;
      if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
      else if (event.key === "ArrowUp") next = index <= 0 ? buttons.length - 1 : index - 1;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = buttons.length - 1;
      else if (event.key === "Tab") {
        event.preventDefault();
        next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index + 1) % buttons.length;
      }
      if (next !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        buttons[next]!.focus();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="menu" role="menu" style={{ left: pos.x, top: pos.y }}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          title={item.title}
          disabled={item.disabled}
          className={[item.danger ? "danger" : "", item.separator ? "sep" : ""].filter(Boolean).join(" ") || undefined}
          onClick={() => {
            item.onSelect?.();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
