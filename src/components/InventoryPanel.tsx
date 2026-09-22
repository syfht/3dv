import { useRef, useState } from "react";
import { BLOCK_LABEL, HOTBAR_SIZE, craftResult, type Slot } from "./inventory";
import PlayerPreview from "./PlayerPreview";

type Props = {
  title: string;
  largeGrid?: boolean;
  inventory: Slot[];
  craftGrid: Slot[];
  chestSlots?: Slot[];
  cursor: Slot;
  cursorPos: { x: number; y: number };
  onSlotClick: (area: "inv" | "craft" | "chest", index: number, right: boolean) => void;
  onTakeResult: (right: boolean) => void;
  onClose: () => void;
  onCursorMove: (x: number, y: number) => void;
};

function SlotIcon({ slot }: { slot: Slot }) {
  if (!slot) return null;
  return (
    <>
      <span className={`block-icon is-${slot.type}`} aria-hidden="true" />
      {slot.count > 1 ? <span className="slot-count">{slot.count}</span> : null}
    </>
  );
}

export default function InventoryPanel({
  title,
  largeGrid = false,
  inventory,
  craftGrid,
  chestSlots,
  cursor,
  cursorPos,
  onSlotClick,
  onTakeResult,
  onClose,
  onCursorMove,
}: Props) {
  const result = craftResult(craftGrid);
  // Touch devices have no right-click: "one at a time" mode makes every tap
  // behave like a right-click (split a stack / drop a single item per cell),
  // and a long press does the same without switching mode.
  const [singleMode, setSingleMode] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const longFired = useRef(false);

  const clearTimer = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  const pressHandlers = (act: (right: boolean) => void) => ({
    onPointerDown: (event: React.PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      longFired.current = false;
      clearTimer();
      pressTimer.current = window.setTimeout(() => {
        longFired.current = true;
        act(true);
      }, 420);
    },
    onPointerUp: (event: React.PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      clearTimer();
      if (longFired.current) return;
      act(singleMode);
    },
    onPointerLeave: () => {
      clearTimer();
      longFired.current = true;
    },
    onPointerCancel: () => {
      clearTimer();
      longFired.current = true;
    },
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      clearTimer();
      act(true);
    },
  });

  const slotButton = (slot: Slot, area: "inv" | "craft" | "chest", index: number) => (
    <button
      key={`${area}-${index}`}
      type="button"
      className="inv-slot"
      aria-label={slot ? `${BLOCK_LABEL[slot.type]} x${slot.count}` : "Empty slot"}
      {...pressHandlers((right) => onSlotClick(area, index, right))}
    >
      <SlotIcon slot={slot} />
    </button>
  );

  return (
    <div
      className="inventory-overlay"
      onMouseMove={(event) => onCursorMove(event.clientX, event.clientY)}
      onPointerMove={(event) => onCursorMove(event.clientX, event.clientY)}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="inventory-panel" role="dialog" aria-label={title}>
        <header className="inventory-head">
          <h2>{title}</h2>
          <button
            type="button"
            className="inventory-close"
            aria-pressed={singleMode}
            onClick={() => setSingleMode((value) => !value)}
          >
            {singleMode ? "One at a time: ON" : "One at a time: OFF"}
          </button>
          <button type="button" className="inventory-close" onClick={onClose}>
            Close
          </button>
        </header>

        <section className="crafting-row" aria-label="Crafting">
          <div className={largeGrid ? "craft-grid is-3x3" : "craft-grid"}>
            {craftGrid.map((slot, index) => slotButton(slot, "craft", index))}
          </div>
          <span className="craft-arrow" aria-hidden="true">
            →
          </span>
          <button
            type="button"
            className="inv-slot is-result"
            aria-label={result ? `Craft ${BLOCK_LABEL[result.type]} x${result.count}` : "No recipe"}
            {...pressHandlers((right) => onTakeResult(right))}
          >
            <SlotIcon slot={result} />
          </button>
          <PlayerPreview />
        </section>

        {chestSlots ? (
          <div className="inv-grid" aria-label="Chest">
            {chestSlots.map((slot, index) => slotButton(slot, "chest", index))}
          </div>
        ) : null}

        <div className="inv-grid" aria-label="Storage">
          {inventory.slice(HOTBAR_SIZE).map((slot, offset) => slotButton(slot, "inv", offset + HOTBAR_SIZE))}
        </div>

        <div className="inv-grid is-hotbar" aria-label="Hotbar">
          {inventory.slice(0, HOTBAR_SIZE).map((slot, index) => slotButton(slot, "inv", index))}
        </div>

        <p className="inventory-hint">
          Tap to move a whole stack · long-press (or right-click) to place one item per cell
        </p>
      </div>

      {cursor ? (
        <div className="cursor-stack" style={{ left: cursorPos.x, top: cursorPos.y }} aria-hidden="true">
          <span className={`block-icon is-${cursor.type}`} />
          {cursor.count > 1 ? <span className="slot-count">{cursor.count}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
