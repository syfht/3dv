// Browsers throttle timers and stop animation frames in background tabs, which
// freezes the game (players hang in mid-air) and starves the live connection
// until the tab is opened again. Web workers keep their own timers running at
// full speed, so we drive background work from one.

const WORKER_SOURCE = `
let timer = null;
self.onmessage = (event) => {
  const interval = event.data && event.data.interval;
  if (interval) {
    clearInterval(timer);
    timer = setInterval(() => self.postMessage("tick"), interval);
  } else {
    clearInterval(timer);
    timer = null;
  }
};
`;

/**
 * Calls `onTick` roughly every `interval` ms, also while the tab is hidden.
 * Returns a function that stops the ticker.
 */
export function startBackgroundTicker(onTick: () => void, interval = 50): () => void {
  if (typeof Worker !== "undefined" && typeof Blob !== "undefined") {
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
      const worker = new Worker(url);
      worker.onmessage = () => onTick();
      worker.postMessage({ interval });
      return () => {
        worker.postMessage({ interval: 0 });
        worker.terminate();
        URL.revokeObjectURL(url);
      };
    } catch {
      /* fall through to a plain timer */
    }
  }
  const timer = setInterval(onTick, interval);
  return () => clearInterval(timer);
}
