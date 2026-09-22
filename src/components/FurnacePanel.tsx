import { useRef, useState } from "react";
import { BLOCK_LABEL, HOTBAR_SIZE, type Slot } from "./inventory";

export type FurnaceState = {
  input: Slot;
  fuel: Slot;
  output: Slot;
  burnLeft: number;
  burnTotal: number;
  progress: number;
  updatedAt: number;
};

type Props = {
  inventory: Slot[];
  furnace: FurnaceState;
  cursor: Slot;
  cursorPos: { x: number; y: number };
  onSlotClick: (area: "inv" | "furnace", index: number, right: boolean) => void;
  onClose: () => void;
  onCursorMove: (x: number, y: number) => void;
};

function SlotIcon({ slot }: { slot: Slot }) {
  if (!slot) return null;
  return <><span className={`block-icon is-${slot.type}`} aria-hidden="true" />{slot.count > 1 ? <span className="slot-count">{slot.count}</span> : null}</>;
}

export default function FurnacePanel({ inventory, furnace, cursor, cursorPos, onSlotClick, onClose, onCursorMove }: Props) {
  const [singleMode, setSingleMode] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const longFired = useRef(false);
  const clearTimer = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const pressHandlers = (act: (right: boolean) => void) => ({
    onPointerDown: (event: React.PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      longFired.current = false;
      clearTimer();
      pressTimer.current = window.setTimeout(() => { longFired.current = true; act(true); }, 420);
    },
    onPointerUp: (event: React.PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      clearTimer();
      if (!longFired.current) act(singleMode);
    },
    onPointerLeave: () => { clearTimer(); longFired.current = true; },
    onPointerCancel: () => { clearTimer(); longFired.current = true; },
    onContextMenu: (event: React.MouseEvent) => { event.preventDefault(); clearTimer(); act(true); },
  });
  const slotButton = (slot: Slot, area: "inv" | "furnace", index: number, label?: string) => (
    <button key={`${area}-${index}`} type="button" className="inv-slot" aria-label={label ?? (slot ? `${BLOCK_LABEL[slot.type]} x${slot.count}` : "Empty slot")} {...pressHandlers((right) => onSlotClick(area, index, right))}>
      <SlotIcon slot={slot} />
    </button>
  );
  const burning = furnace.burnLeft > 0;
  const burnPercent = furnace.burnTotal > 0 ? (furnace.burnLeft / furnace.burnTotal) * 100 : 0;
  const smeltPercent = Math.min(100, (furnace.progress / 5) * 100);

  return <div className="inventory-overlay" onMouseMove={(event) => onCursorMove(event.clientX, event.clientY)} onPointerMove={(event) => onCursorMove(event.clientX, event.clientY)} onContextMenu={(event) => event.preventDefault()}>
    <div className="inventory-panel" role="dialog" aria-label="Furnace">
      <header className="inventory-head">
        <h2>Furnace</h2>
        <button type="button" className="inventory-close" aria-pressed={singleMode} onClick={() => setSingleMode((value) => !value)}>{singleMode ? "One at a time: ON" : "One at a time: OFF"}</button>
        <button type="button" className="inventory-close" onClick={onClose}>Close</button>
      </header>
      <section className="furnace-row" aria-label="Smelting">
        <div className="furnace-inputs">
          {slotButton(furnace.input, "furnace", 0, furnace.input ? `${BLOCK_LABEL[furnace.input.type]} input` : "Coal Ore input")}
          <div className="furnace-flame" aria-label={burning ? "Fuel burning" : "No fuel"}><span style={{ height: `${burnPercent}%` }} /></div>
          {slotButton(furnace.fuel, "furnace", 1, furnace.fuel ? `${BLOCK_LABEL[furnace.fuel.type]} fuel` : "Fuel: sticks, planks, or wood")}
        </div>
        <div className="furnace-progress" aria-label={`Smelting ${Math.round(smeltPercent)} percent`}><span style={{ width: `${smeltPercent}%` }} /></div>
        {slotButton(furnace.output, "furnace", 2, furnace.output ? `Coal output x${furnace.output.count}` : "Coal output")}
      </section>
      <div className="inv-grid" aria-label="Storage">{inventory.slice(HOTBAR_SIZE).map((slot, offset) => slotButton(slot, "inv", offset + HOTBAR_SIZE))}</div>
      <div className="inv-grid is-hotbar" aria-label="Hotbar">{inventory.slice(0, HOTBAR_SIZE).map((slot, index) => slotButton(slot, "inv", index))}</div>
      <p className="inventory-hint">Coal Ore → Coal · fuel with sticks, planks, or wood</p>
    </div>
    {cursor ? <div className="cursor-stack" style={{ left: cursorPos.x, top: cursorPos.y }} aria-hidden="true"><span className={`block-icon is-${cursor.type}`} />{cursor.count > 1 ? <span className="slot-count">{cursor.count}</span> : null}</div> : null}
  </div>;
}
