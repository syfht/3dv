// Browser side of the multiplayer link, running on Lovable Cloud.
//
// The shared world (its seed and every block change) lives in the database,
// and everyone in the same world joins one realtime channel: poses, hits and
// block changes are broadcast between players, presence tells us who left.
// This needs no separate game server, so multiplayer works on the public
// published link.
//
// Each browser owns its own health: it applies damage it receives, regenerates,
// and respawns itself, then tells everyone else so they see the red flash.

import { supabase } from "@/integrations/supabase/client";
import type { WorldEdit, BlockType } from "@/components/voxelWorld";
import { columnHeight } from "./terrain";
import { startBackgroundTicker } from "./backgroundTicker";
import { MAX_HEALTH, SNAPSHOT_HZ, WORLD_IDLE_MS, type PlayerState, type Pose } from "./protocol";

export type { Pose };
export type RemotePose = PlayerState;

// Every browser tab gets its own player id for the session.
export const CLIENT_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

export type WorldSession = {
  worldId: string | null;
  seed: number;
  edits: WorldEdit[];
  editsUpTo: number;
  online: boolean;
  /** When this world was created (ms). Everyone shares one day/night clock. */
  startedAt: number;
};

const OFFLINE: WorldSession = {
  worldId: null,
  seed: 0,
  edits: [],
  editsUpTo: 0,
  online: false,
  startedAt: Date.now(),
};

/** Drop a player we have not heard from for this long. */
const PLAYER_TIMEOUT_MS = 6000;
/** Cap on how often we put our own pose on the wire. */
const POSE_MIN_INTERVAL_MS = 80;
/** How often we mark the world as still being played. */
const TOUCH_MS = 60_000;
/** Seconds between health regeneration steps. */
const REGEN_SECONDS = 4;

type EditRow = { id: number; x: number; y: number; z: number; block: string | null };

/**
 * Joins the shared world (a fresh one is started when the last one has been
 * empty for a while) and loads every block change made in it so far.
 */
export async function joinWorld(): Promise<WorldSession> {
  try {
    const activeSince = new Date(Date.now() - WORLD_IDLE_MS).toISOString();
    const existing = await supabase
      .from("worlds")
      .select("id, seed, created_at")
      .gte("last_active_at", activeSince)
      .order("last_active_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let worldId = existing.data?.id ?? null;
    let seed = existing.data ? Number(existing.data.seed) : 0;
    let startedAt = existing.data ? Date.parse(existing.data.created_at) : Date.now();

    if (!worldId) {
      const created = await supabase
        .from("worlds")
        .insert({ seed: Math.floor(Math.random() * 2_000_000_000) })
        .select("id, seed, created_at")
        .single();
      if (created.error || !created.data) return OFFLINE;
      worldId = created.data.id;
      seed = Number(created.data.seed);
      startedAt = Date.parse(created.data.created_at);
    } else {
      void supabase.from("worlds").update({ last_active_at: new Date().toISOString() }).eq("id", worldId);
    }

    const editRows = await supabase
      .from("world_edits")
      .select("id, x, y, z, block")
      .eq("world_id", worldId)
      .order("id", { ascending: true });

    const rows = (editRows.data ?? []) as EditRow[];
    return {
      worldId,
      seed,
      edits: rows.map(toEdit),
      editsUpTo: rows.length ? Number(rows[rows.length - 1]!.id) : 0,
      online: true,
      startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    };
  } catch (error) {
    console.warn("[multiplayer] could not join the shared world", error);
    return OFFLINE;
  }
}

function toEdit(row: EditRow): WorldEdit {
  return { x: row.x, y: row.y, z: row.z, block: (row.block as BlockType | null) ?? null };
}

export type WorldChannel = {
  sendPose: (pose: Pose) => void;
  sendEdit: (edit: WorldEdit) => void;
  sendHit: (targetId: string, amount: number) => void;
  /** Items spilled into the world (death drops): everyone should see them. */
  sendDrops: (
    position: { x: number; y: number; z: number },
    items: Array<{ id: string; type: string; count: number }>,
  ) => void;
  /** We collected a dropped item, so it is gone for everyone. */
  sendPickup: (id: string) => void;
  /** Report self-inflicted damage (falls). */
  sendDamage: (amount: number) => void;
  setName: (name: string) => void;
  dispose: () => void;
};

export type WorldHandlers = {
  onEdit: (edit: WorldEdit) => void;
  onPlayers: (players: RemotePose[]) => void;
  /** Our current health. */
  onHealth?: (hp: number) => void;
  /** Someone landed a hit on us (for effects; health arrives via onHealth). */
  onHit?: (amount: number, from: string) => void;
  /** A player (possibly us) took damage: flash them red. */
  onHurt?: (id: string) => void;
  /** We respawned after running out of health. */
  onTeleport?: (position: { x: number; y: number; z: number }, reason: "respawn" | "correct") => void;
  /** Another player spilled items into the world. */
  onDrops?: (
    position: { x: number; y: number; z: number },
    items: Array<{ id: string; type: string; count: number }>,
  ) => void;
  /** Someone else picked up a dropped item. */
  onPickup?: (id: string) => void;
  onStatus?: (connected: boolean) => void;
};

type PoseBroadcast = PlayerState;
type HitBroadcast = { target: string; amount: number; from: string };
type HurtBroadcast = { id: string };
type DropsBroadcast = {
  x: number;
  y: number;
  z: number;
  items: Array<{ id: string; type: string; count: number }>;
};
type PickupBroadcast = { id: string };

// Live link for one world: block changes plus everyone's position.
export function connectWorld(
  worldId: string,
  handlers: WorldHandlers,
  options: { name?: string; editsUpTo?: number; seed?: number } = {},
): WorldChannel {
  let name = options.name ?? "Player";
  let editsUpTo = options.editsUpTo ?? 0;
  const seed = options.seed ?? 0;

  let disposed = false;
  let connected = false;
  let hp = MAX_HEALTH;
  let regenCarry = 0;
  let lastPoseSentAt = 0;
  let lastPose: Pose | null = null;
  let lastTouchAt = Date.now();
  let lastTickAt = Date.now();

  const others = new Map<string, { state: PlayerState; seenAt: number }>();

  const spawnPoint = () => ({ x: 0.5, y: columnHeight(0, 0, seed) + 1.05, z: 0.5 });

  const channel = supabase.channel(`world:${worldId}`, {
    config: { broadcast: { self: false }, presence: { key: CLIENT_ID } },
  });

  const push = (event: string, payload: unknown) => {
    if (!connected) return;
    void channel.send({ type: "broadcast", event, payload });
  };

  const setHealth = (next: number) => {
    const clamped = Math.max(0, Math.min(MAX_HEALTH, next));
    if (clamped === hp) return;
    hp = clamped;
    handlers.onHealth?.(hp);
  };

  const takeDamage = (amount: number, from: string | null) => {
    if (amount <= 0) return;
    setHealth(hp - amount);
    regenCarry = 0;
    if (from) handlers.onHit?.(amount, from);
    handlers.onHurt?.(CLIENT_ID);
    push("hurt", { id: CLIENT_ID } satisfies HurtBroadcast);
    if (hp <= 0) respawn();
  };

  const respawn = () => {
    const point = spawnPoint();
    handlers.onTeleport?.(point, "respawn");
    hp = MAX_HEALTH;
    handlers.onHealth?.(hp);
  };

  channel
    .on("broadcast", { event: "pose" }, ({ payload }) => {
      const state = payload as PoseBroadcast;
      if (!state?.id || state.id === CLIENT_ID) return;
      others.set(state.id, { state, seenAt: Date.now() });
    })
    .on("broadcast", { event: "edit" }, ({ payload }) => {
      const edit = payload as WorldEdit & { at?: number };
      if (typeof edit?.x !== "number") return;
      if (edit.at) editsUpTo = Math.max(editsUpTo, edit.at);
      handlers.onEdit({ x: edit.x, y: edit.y, z: edit.z, block: edit.block ?? null });
    })
    .on("broadcast", { event: "hit" }, ({ payload }) => {
      const hit = payload as HitBroadcast;
      if (hit?.target !== CLIENT_ID) return;
      takeDamage(hit.amount, hit.from);
    })
    .on("broadcast", { event: "hurt" }, ({ payload }) => {
      const hurt = payload as HurtBroadcast;
      if (hurt?.id && hurt.id !== CLIENT_ID) handlers.onHurt?.(hurt.id);
    })
    .on("broadcast", { event: "drops" }, ({ payload }) => {
      const drop = payload as DropsBroadcast;
      if (!drop?.items?.length) return;
      handlers.onDrops?.({ x: drop.x, y: drop.y, z: drop.z }, drop.items);
    })
    .on("broadcast", { event: "pickup" }, ({ payload }) => {
      const pickup = payload as PickupBroadcast;
      if (pickup?.id) handlers.onPickup?.(pickup.id);
    })
    .on("presence", { event: "leave" }, ({ leftPresences }) => {
      for (const presence of leftPresences as Array<{ id?: string }>) {
        if (presence?.id) others.delete(presence.id);
      }
    })
    .subscribe((status) => {
      if (disposed) return;
      const isOpen = status === "SUBSCRIBED";
      if (isOpen === connected) return;
      connected = isOpen;
      handlers.onStatus?.(connected);
      if (!connected) return;
      void channel.track({ id: CLIENT_ID, name });
      void syncEdits();
      if (lastPose) sendPose(lastPose, true);
    });

  // Pull in block changes made while we were away or disconnected.
  const syncEdits = async () => {
    const { data } = await supabase
      .from("world_edits")
      .select("id, x, y, z, block")
      .eq("world_id", worldId)
      .gt("id", editsUpTo)
      .order("id", { ascending: true });
    for (const row of (data ?? []) as EditRow[]) {
      editsUpTo = Math.max(editsUpTo, Number(row.id));
      handlers.onEdit(toEdit(row));
    }
  };

  const sendPose = (pose: Pose, force = false) => {
    lastPose = pose;
    const now = Date.now();
    if (!force && now - lastPoseSentAt < POSE_MIN_INTERVAL_MS) return;
    lastPoseSentAt = now;
    push("pose", { ...pose, id: CLIENT_ID, name, hp } satisfies PoseBroadcast);
  };

  // Roster, health regeneration and keep-alive run off a worker ticker so they
  // keep working while the tab sits in the background.
  const stopTicker = startBackgroundTicker(() => {
    if (disposed) return;
    const now = Date.now();
    const delta = Math.min(2, (now - lastTickAt) / 1000);
    lastTickAt = now;

    for (const [id, entry] of others) {
      if (now - entry.seenAt > PLAYER_TIMEOUT_MS) others.delete(id);
    }
    handlers.onPlayers([...others.values()].map((entry) => entry.state));

    if (hp > 0 && hp < MAX_HEALTH) {
      regenCarry += delta;
      if (regenCarry >= REGEN_SECONDS) {
        regenCarry = 0;
        setHealth(hp + 1);
      }
    }

    if (now - lastTouchAt >= TOUCH_MS) {
      lastTouchAt = now;
      void supabase.from("worlds").update({ last_active_at: new Date(now).toISOString() }).eq("id", worldId);
    }
  }, Math.round(1000 / SNAPSHOT_HZ));

  const onVisibility = () => {
    if (document.hidden) return;
    void syncEdits();
    if (lastPose) sendPose(lastPose, true);
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  return {
    sendPose: (pose) => sendPose(pose),
    sendEdit: (edit) => {
      push("edit", edit);
      void supabase
        .from("world_edits")
        .insert({ world_id: worldId, x: edit.x, y: edit.y, z: edit.z, block: edit.block })
        .select("id")
        .single()
        .then(({ data }) => {
          if (data?.id) editsUpTo = Math.max(editsUpTo, Number(data.id));
        });
    },
    sendHit: (targetId, amount) => {
      push("hit", { target: targetId, amount, from: CLIENT_ID } satisfies HitBroadcast);
    },
    sendDrops: (position, items) => {
      if (!items.length) return;
      push("drops", { ...position, items } satisfies DropsBroadcast);
    },
    sendPickup: (id) => {
      push("pickup", { id } satisfies PickupBroadcast);
    },
    sendDamage: (amount) => takeDamage(amount, null),
    setName: (next) => {
      name = next;
      if (connected) void channel.track({ id: CLIENT_ID, name });
    },
    dispose: () => {
      disposed = true;
      connected = false;
      stopTicker();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      void supabase.removeChannel(channel);
    },
  };
}
