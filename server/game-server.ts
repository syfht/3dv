// The multiplayer game server: world storage in SQLite, one WebSocket per
// player, an authoritative snapshot broadcast, server-side health, and a
// gravity fallback for players whose browser tab has gone to sleep.
//
// In development it is attached to Vite's HTTP server (see vite-plugin.ts);
// in production `server/index.ts` hosts it in front of the built app.

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { openDatabase, type Db } from "./db.ts";
import {
  blockKey,
  generateTerrain,
  groundHeightIn,
} from "../src/lib/terrain.ts";
import {
  MAX_HEALTH,
  HIT_RANGE,
  SNAPSHOT_HZ,
  STALE_POSE_MS,
  LINK_TIMEOUT_MS,
  WORLD_IDLE_MS,
} from "../src/lib/protocol.ts";
import type {
  ClientMessage,
  PlayerState,
  Pose,
  ServerMessage,
  WorldEdit,
  WorldInfo,
} from "../src/lib/protocol.ts";

const GRAVITY = 12.5;
const REGEN_EVERY_MS = 4000;
const MAX_NAME = 16;
const MAX_HIT = 12;

type Player = {
  id: string;
  name: string;
  socket: WebSocket;
  pose: Pose;
  hp: number;
  hidden: boolean;
  lastPoseAt: number;
  lastMessageAt: number;
  regenAt: number;
  /** Vertical speed while the server is simulating this player's fall. */
  vy: number;
  /** True once the server moved this player and the browser has not agreed yet. */
  corrected: boolean;
};

type World = {
  id: string;
  seed: number;
  solid: Map<string, string>;
  players: Map<string, Player>;
  editsUpTo: number;
};

export type GameServerOptions = {
  dbPath: string;
  /** Path prefix for the HTTP API. */
  apiPath?: string;
  /** Path the WebSocket upgrades on. */
  wsPath?: string;
  log?: (...args: unknown[]) => void;
};

export type GameServer = {
  /** Handles `/api/game/*`; returns false when the request is not ours. */
  handleHttp: (req: IncomingMessage, res: ServerResponse) => boolean;
  handleUpgrade: (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => boolean;
  close: () => void;
};

export async function createGameServer(options: GameServerOptions): Promise<GameServer> {
  const apiPath = options.apiPath ?? "/api/game";
  const wsPath = options.wsPath ?? "/ws";
  const log = options.log ?? ((...args: unknown[]) => console.log("[game]", ...args));
  const db = await openDatabase(options.dbPath);
  migrate(db);

  const worlds = new Map<string, World>();

  // --- persistence ---------------------------------------------------------
  const stmts = {
    latestWorld: db.prepare("SELECT id, seed, last_active FROM worlds ORDER BY created_at DESC LIMIT 1"),
    insertWorld: db.prepare("INSERT INTO worlds (id, seed, created_at, last_active) VALUES (?, ?, ?, ?)"),
    touchWorld: db.prepare("UPDATE worlds SET last_active = ? WHERE id = ?"),
    worldById: db.prepare("SELECT id, seed FROM worlds WHERE id = ?"),
    edits: db.prepare("SELECT x, y, z, block, updated_at FROM world_blocks WHERE world_id = ? AND updated_at > ? ORDER BY updated_at"),
    upsertEdit: db.prepare(
      `INSERT INTO world_blocks (world_id, x, y, z, block, actor, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(world_id, x, y, z) DO UPDATE SET block = excluded.block, actor = excluded.actor, updated_at = excluded.updated_at`,
    ),
  };

  const loadEdits = (worldId: string, since: number) =>
    stmts.edits.all(worldId, since).map((row) => ({
      x: Number(row["x"]),
      y: Number(row["y"]),
      z: Number(row["z"]),
      block: (row["block"] as WorldEdit["block"]) ?? null,
      at: Number(row["updated_at"]),
    }));

  const loadWorld = (id: string, seed: number): World => {
    let world = worlds.get(id);
    if (world) return world;
    const solid: Map<string, string> = generateTerrain(seed);
    let editsUpTo = 0;
    for (const edit of loadEdits(id, 0)) {
      applyToSolid(solid, edit);
      editsUpTo = Math.max(editsUpTo, edit.at);
    }
    world = { id, seed, solid, players: new Map(), editsUpTo };
    worlds.set(id, world);
    return world;
  };

  // The shared world: reuse the newest one unless it has been idle for a
  // while, in which case everyone gets fresh terrain.
  const currentWorld = (): World => {
    const now = Date.now();
    const latest = stmts.latestWorld.get();
    if (latest && now - Number(latest["last_active"]) < WORLD_IDLE_MS) {
      stmts.touchWorld.run(now, String(latest["id"]));
      return loadWorld(String(latest["id"]), Number(latest["seed"]));
    }
    const id = randomUUID();
    const seed = Math.floor(Math.random() * 1_000_000) + 1;
    stmts.insertWorld.run(id, seed, now, now);
    log("new world", id, "seed", seed);
    return loadWorld(id, seed);
  };

  // --- HTTP ----------------------------------------------------------------
  const handleHttp = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(apiPath)) return false;
    const route = url.pathname.slice(apiPath.length);
    res.setHeader("Cache-Control", "no-store");
    if (route === "/world" && req.method === "GET") {
      const world = currentWorld();
      const edits = loadEdits(world.id, 0);
      const body: WorldInfo = {
        worldId: world.id,
        seed: world.seed,
        edits: edits.map(({ x, y, z, block }) => ({ x, y, z, block })),
        editsUpTo: world.editsUpTo,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return true;
    }
    if (route === "/health") {
      const players = [...worlds.values()].reduce((n, w) => n + w.players.size, 0);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, players }));
      return true;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return true;
  };

  // --- WebSocket -----------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });

  const send = (player: Player, message: ServerMessage) => {
    if (player.socket.readyState === WebSocket.OPEN) player.socket.send(JSON.stringify(message));
  };
  const broadcast = (world: World, message: ServerMessage, except?: string) => {
    const text = JSON.stringify(message);
    for (const player of world.players.values()) {
      if (player.id === except) continue;
      if (player.socket.readyState === WebSocket.OPEN) player.socket.send(text);
    }
  };
  const publicState = (player: Player): PlayerState => ({
    id: player.id,
    name: player.name,
    hp: player.hp,
    ...player.pose,
  });
  const spawnPoint = (world: World) => ({
    x: 0.5,
    y: groundHeightIn(world.solid, 0.5, 0.5),
    z: 0.5,
  });

  const handleUpgrade: GameServer["handleUpgrade"] = (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== wsPath) return false;
    const worldId = url.searchParams.get("world") ?? "";
    const clientId = (url.searchParams.get("id") ?? "").slice(0, 64);
    const name = cleanName(url.searchParams.get("name"));
    const row = stmts.worldById.get(worldId);
    if (!row || !clientId) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const world = loadWorld(String(row["id"]), Number(row["seed"]));
      join(world, ws, clientId, name);
    });
    return true;
  };

  const join = (world: World, socket: WebSocket, id: string, name: string) => {
    // A reconnecting tab replaces its previous link instead of duplicating it.
    const previous = world.players.get(id);
    if (previous) {
      previous.socket.removeAllListeners();
      previous.socket.terminate();
    }
    const now = Date.now();
    const spawn = spawnPoint(world);
    const player: Player = {
      id,
      name,
      socket,
      pose: previous?.pose ?? { ...spawn, ry: 0, moving: false },
      hp: previous?.hp ?? MAX_HEALTH,
      hidden: false,
      lastPoseAt: previous?.lastPoseAt ?? now,
      lastMessageAt: now,
      regenAt: now,
      vy: 0,
      corrected: previous?.corrected ?? false,
    };
    world.players.set(id, player);
    stmts.touchWorld.run(now, world.id);
    log(`${name} (${id.slice(0, 8)}) joined; ${world.players.size} online`);

    send(player, {
      t: "welcome",
      id,
      hp: player.hp,
      players: [...world.players.values()].filter((p) => p.id !== id).map(publicState),
    });

    socket.on("message", (raw) => {
      player.lastMessageAt = Date.now();
      let message: ClientMessage;
      try {
        message = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      handleMessage(world, player, message);
    });
    socket.on("close", () => leave(world, player));
    socket.on("error", () => leave(world, player));
  };

  const leave = (world: World, player: Player) => {
    if (world.players.get(player.id) !== player) return;
    world.players.delete(player.id);
    stmts.touchWorld.run(Date.now(), world.id);
    log(`${player.name} left; ${world.players.size} online`);
  };

  const handleMessage = (world: World, player: Player, message: ClientMessage) => {
    switch (message.t) {
      case "ping":
        send(player, { t: "pong" });
        return;
      case "hidden":
        player.hidden = Boolean(message.hidden);
        return;
      case "name":
        player.name = cleanName(message.name);
        return;
      case "pose": {
        if (![message.x, message.y, message.z, message.ry].every(Number.isFinite)) return;
        const now = Date.now();
        // While the tab slept the server dropped this player onto the ground.
        // If the browser still reports the stale mid-air height, push our
        // position back to it once instead of letting the avatar snap up.
        if (player.corrected && message.y > player.pose.y + 0.35) {
          send(player, { t: "correct", x: player.pose.x, y: player.pose.y, z: player.pose.z });
          player.lastPoseAt = now;
          return;
        }
        player.corrected = false;
        player.vy = 0;
        player.pose = {
          x: message.x,
          y: message.y,
          z: message.z,
          ry: message.ry,
          moving: Boolean(message.moving),
          attack: message.attack ?? null,
          ap: typeof message.ap === "number" ? message.ap : 0,
          item: message.item ?? null,
        };
        player.lastPoseAt = now;
        return;
      }
      case "edit": {
        const { x, y, z } = message;
        if (![x, y, z].every(Number.isInteger)) return;
        const block = typeof message.block === "string" ? message.block : null;
        const edit: WorldEdit = { x, y, z, block };
        const at = Math.max(Date.now(), world.editsUpTo + 1);
        world.editsUpTo = at;
        applyToSolid(world.solid, edit);
        stmts.upsertEdit.run(world.id, x, y, z, block, player.id, at);
        broadcast(world, { t: "edit", at, ...edit }, player.id);
        return;
      }
      case "sync": {
        const since = Number.isFinite(message.since) ? message.since : 0;
        const edits = loadEdits(world.id, since);
        send(player, {
          t: "edits",
          edits: edits.map(({ x, y, z, block }) => ({ x, y, z, block })),
          upTo: world.editsUpTo,
        });
        return;
      }
      case "hit": {
        const target = world.players.get(message.target);
        const amount = Math.min(MAX_HIT, Math.max(0, Math.round(Number(message.amount) || 0)));
        if (!target || target === player || amount <= 0) return;
        // Melee reach is 4 blocks (small slack for network lag); this also
        // keeps a hacked client from sniping across the map.
        const dx = target.pose.x - player.pose.x;
        const dy = target.pose.y - player.pose.y;
        const dz = target.pose.z - player.pose.z;
        const reach = HIT_RANGE + 0.6;
        if (dx * dx + dy * dy + dz * dz > reach * reach) return;
        damage(world, target, amount, player.id);
        return;
      }
      case "damage": {
        const amount = Math.min(MAX_HEALTH, Math.max(0, Math.round(Number(message.amount) || 0)));
        if (amount > 0) damage(world, player, amount, player.id);
        return;
      }
      default:
        return;
    }
  };

  const damage = (world: World, target: Player, amount: number, from: string) => {
    target.hp = Math.max(0, target.hp - amount);
    target.regenAt = Date.now();
    send(target, { t: "hit", amount, from });
    // Everyone sees the hit player flash red.
    broadcast(world, { t: "hurt", id: target.id });
    if (target.hp <= 0) {
      target.hp = MAX_HEALTH;
      const spawn = spawnPoint(world);
      target.pose = { ...target.pose, ...spawn, moving: false, attack: null, ap: 0 };
      target.vy = 0;
      target.corrected = true;
      send(target, { t: "respawn", ...spawn });
    }
  };

  // --- simulation tick -----------------------------------------------------
  const tickMs = Math.round(1000 / SNAPSHOT_HZ);
  let lastTick = Date.now();
  let lastTouch = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.1, (now - lastTick) / 1000);
    lastTick = now;

    for (const world of worlds.values()) {
      if (world.players.size === 0) continue;

      for (const player of world.players.values()) {
        // Drop dead links (a closed laptop, a killed tab).
        if (now - player.lastMessageAt > LINK_TIMEOUT_MS) {
          player.socket.terminate();
          leave(world, player);
          continue;
        }

        // Gravity for players whose browser is not simulating itself right
        // now: mine the block under a sleeping player and they still fall.
        if (player.hidden || now - player.lastPoseAt > STALE_POSE_MS) {
          const { pose } = player;
          const ground = groundHeightIn(world.solid, pose.x, pose.z, pose.y + 0.5);
          if (pose.y > ground + 0.001) {
            player.vy -= GRAVITY * dt;
            const y = Math.max(ground, pose.y + player.vy * dt);
            player.pose = { ...pose, y, moving: false, attack: null, ap: 0 };
            player.corrected = true;
          } else if (pose.y < ground - 0.001) {
            // A block was placed under them: stand on top of it.
            player.pose = { ...pose, y: ground };
            player.corrected = true;
            player.vy = 0;
          } else {
            player.vy = 0;
          }
        }

        // Slow regeneration.
        if (player.hp < MAX_HEALTH && now - player.regenAt >= REGEN_EVERY_MS) {
          player.hp += 1;
          player.regenAt = now;
        }
      }

      // Snapshot: every other player, plus your own authoritative health.
      const states = [...world.players.values()].map(publicState);
      for (const player of world.players.values()) {
        send(player, {
          t: "state",
          hp: player.hp,
          players: states.filter((s) => s.id !== player.id),
        });
      }
    }

    if (now - lastTouch > 60_000) {
      lastTouch = now;
      for (const world of worlds.values()) {
        if (world.players.size > 0) stmts.touchWorld.run(now, world.id);
      }
    }
  }, tickMs);

  return {
    handleHttp,
    handleUpgrade,
    close: () => {
      clearInterval(timer);
      for (const world of worlds.values()) for (const p of world.players.values()) p.socket.terminate();
      wss.close();
      db.close();
    },
  };
}

function migrate(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY,
      seed INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_active INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS world_blocks (
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      z INTEGER NOT NULL,
      block TEXT,
      actor TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (world_id, x, y, z)
    );
    CREATE INDEX IF NOT EXISTS world_blocks_updated ON world_blocks (world_id, updated_at);
  `);
}

function applyToSolid(solid: Map<string, string>, edit: WorldEdit) {
  const key = blockKey(edit.x, edit.y, edit.z);
  if (edit.block) solid.set(key, edit.block);
  else solid.delete(key);
}

function cleanName(raw: string | null | undefined) {
  const name = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME);
  return name || "Player";
}
