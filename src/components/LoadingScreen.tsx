import { useEffect, useRef, useState } from "react";

export default function LoadingScreen({ percent, onFull }: { percent: number; onFull?: () => void }) {
  const target = Math.max(0, Math.min(100, percent));
  const onFullRef = useRef(onFull);
  onFullRef.current = onFull;
  const firedRef = useRef(false);
  const [displayed, setDisplayed] = useState(0);
  const displayedRef = useRef(0);
  const [fakeN, setFakeN] = useState(1);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const current = displayedRef.current;
      if (current < target) {
        // Ease toward the target, but never faster than ~55%/s so the bar
        // climbs gradually even when the asset arrives in a single chunk.
        const eased = (target - current) * 3 * dt;
        const step = Math.min(Math.max(eased, 8 * dt), 55 * dt);
        const next = Math.min(target, current + step);
        displayedRef.current = next;
        setDisplayed(next);
        if (next >= 100 && !firedRef.current) {
          firedRef.current = true;
          onFullRef.current?.();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  // While nothing has started loading yet, show a fake asset counter that
  // climbs by a random 20-50 every tick — purely cosmetic, unrelated to the
  // real load progress.
  useEffect(() => {
    if (target > 0) return;
    const id = setInterval(() => {
      setFakeN((n) => Math.min(976, n + Math.floor(Math.random() * 31) + 20));
    }, 120);
    return () => clearInterval(id);
  }, [target]);

  const value = Math.max(0, Math.min(100, Math.round(displayed)));
  const finding = target === 0;
  return (
    <div className="loading-screen">
      <div className="loading-card">
        <h1 className="start-title loading-title">Craft&Mine</h1>
        <p className="loading-copy">
          {finding ? `Finding assets to load (${fakeN}/976)..` : "Loading assets…"}
        </p>
        <div className="loading-bar">
          <div className="loading-bar-fill" style={{ width: `${value}%` }} />
        </div>
        <p className="loading-percent">{value}%</p>
      </div>
    </div>
  );
}
