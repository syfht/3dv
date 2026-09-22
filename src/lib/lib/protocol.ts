// Messages exchanged between the browser and the game server over one
// WebSocket. Shared by both sides; keep it free of browser/Node imports.

import type { BlockType, WorldEdit } from "@/components/voxelWorld";
import type { ItemType } from "@/components/inventory";

export const MAX_HEALTH = 20; // 10 hearts
/** Melee reach: you can only hit a player within this many blocks. */
export const HIT_RANGE = 4;
/** How long a hit player flashes red (ms). */
export const HURT_FLASH_MS = 400;
/** Server snapshot rate (Hz). */
export const SNAPSHOT_HZ = 15;
/** A player whose browser has not reported for this long gets server-side gravity. */
export const STALE_POSE_MS = 400;
/** Connections silent for this long are dropped. */
export const LINK_TIMEOUT_MS = 30_000;
/** Worlds nobody has visited for this long are replaced by a fresh one. */
export const WORLD_IDLE_MS = 30 * 60_000;

export type AttackKind = "punch" | "kick" | "combo";

export type Pose = {
  x: number;
  y: number;
  z: number;
  ry: number;
  moving: boolean;
  attack?: AttackKind | null;
  ap?: number;
  item?: ItemType | null;
};

export type PlayerState = Pose & {
  id: string;
  name: string;
  hp: number;
};

export type WorldInfo = {
  worldId: string;
  seed: number;
  edits: WorldEdit[];
  /** Server clock (ms) of the newest edit included; used for resync. */
  editsUpTo: number;
};

export type ClientMessage =
  | ({ t: "pose" } & Pose)
  | ({ t: "edit" } & WorldEdit)
  | { t: "hit"; target: string; amount: number }
  /** Self-inflicted damage (falls). */
  | { t: "damage"; amount: number }
  | { t: "name"; name: string }
  | { t: "hidden"; hidden: boolean }
  | { t: "sync"; since: number }
  | { t: "ping" };

export type ServerMessage =
  | { t: "welcome"; id: string; hp: number; players: PlayerState[] }
  | { t: "state"; players: PlayerState[]; hp: number }
  | ({ t: "edit"; at: number } & WorldEdit)
  | { t: "edits"; edits: WorldEdit[]; upTo: number }
  | { t: "hit"; amount: number; from: string }
  /** Somebody took damage: everyone flashes them red. */
  | { t: "hurt"; id: string }
  | { t: "respawn"; x: number; y: number; z: number }
  /** The server simulated gravity for this player while its tab slept. */
  | { t: "correct"; x: number; y: number; z: number }
  | { t: "pong" }
  | { t: "error"; message: string };

export type { BlockType, WorldEdit, ItemType };
