import { useRef, useState } from "react";

type Props = {
  onMove: (x: number, y: number) => void;
  onJump: () => void;
  onPlace: () => void;
  onOpenCrafting: () => void;
  onOpenInventory: () => void;
  showCrafting?: boolean;
};

const RADIUS = 46;

export default function MobileControls({
  onMove,
  onJump,
  onPlace,
  onOpenCrafting,
  onOpenInventory,
  showCrafting = false,
}: Props) {
  const padRef = useRef<HTMLDivElement>(null);
  const activeId = useRef<number | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });

  const update = (clientX: number, clientY: number) => {
    const pad = padRef.current;
    if (!pad) return;
    const rect = pad.getBoundingClientRect();
    let dx = clientX - (rect.left + rect.width / 2);
    let dy = clientY - (rect.top + rect.height / 2);
    const length = Math.hypot(dx, dy);
    if (length > RADIUS) {
      dx = (dx / length) * RADIUS;
      dy = (dy / length) * RADIUS;
    }
    setKnob({ x: dx, y: dy });
    onMove(dx / RADIUS, dy / RADIUS);
  };

  const release = () => {
    activeId.current = null;
    setKnob({ x: 0, y: 0 });
    onMove(0, 0);
  };

  return (
    <div className="touch-controls">
      <div
        ref={padRef}
        className="touch-pad"
        aria-label="Movement joystick"
        onPointerDown={(event) => {
          event.preventDefault();
          activeId.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          update(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (activeId.current !== event.pointerId) return;
          update(event.clientX, event.clientY);
        }}
        onPointerUp={release}
        onPointerCancel={release}
      >
        <span className="touch-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
      </div>

      <div className="touch-buttons">
        <div className="touch-row is-top">
          <button
            type="button"
            className="touch-btn is-bag"
            aria-label="Open inventory"
            onPointerDown={(event) => {
              event.preventDefault();
              onOpenInventory();
            }}
          >
            BAG
          </button>
        </div>
        <div className="touch-row">
        {showCrafting ? (
          <button
            type="button"
            className="touch-btn is-craft"
            aria-label="Interact"
            onPointerDown={(event) => {
              event.preventDefault();
              onOpenCrafting();
            }}
          >
            <span className="craft-glyph" aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="touch-btn"
          aria-label="Place block"
          onPointerDown={(event) => {
            event.preventDefault();
            onPlace();
          }}
        >
          PLACE
        </button>
        <button
          type="button"
          className="touch-btn is-jump"
          aria-label="Jump"
          onPointerDown={(event) => {
            event.preventDefault();
            onJump();
          }}
        >
          JUMP
        </button>
        </div>
      </div>
    </div>
  );
}
