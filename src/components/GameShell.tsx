import { useEffect, useState } from "react";
import LoadingScreen from "./LoadingScreen";
import StartScreen from "./StartScreen";
import TerrainGame from "./TerrainGame";
import { joinWorld, type WorldSession } from "@/lib/multiplayer";

export default function GameShell() {
  const [username, setUsername] = useState<string | null>(null);
  const [percent, setPercent] = useState(0);
  const [ready, setReady] = useState(false);
  const [barFull, setBarFull] = useState(false);
  // Join the shared world before the terrain is built so everyone online
  // generates the same map and sees the same block changes.
  const [session, setSession] = useState<WorldSession | null>(null);
  const loaded = ready && barFull;

  useEffect(() => {
    let cancelled = false;
    joinWorld().then((joined) => {
      if (!cancelled) setSession(joined);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      {session && (
        <TerrainGame
          username={username ?? "Player"}
          disabled={!username}
          session={session}
          onProgress={setPercent}
          onReady={() => setReady(true)}
        />
      )}
      {!loaded && <LoadingScreen percent={percent} onFull={() => setBarFull(true)} />}
      {loaded && !username && <StartScreen onStart={setUsername} />}
    </>
  );
}
