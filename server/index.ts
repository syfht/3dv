// Production entry point: one Express server on one public port that serves
// the built game (static files), the game API, and the WebSocket link every
// player connects to. Share http://<your-server>:<PORT>/ and people can join.
//
//   npm run build:node   # builds the game into dist/client
//   npm start            # node server/index.ts   (Node 22.18+ / 24+)
//
// Environment:
//   PORT           public port (default 3000)
//   HOST           bind address (default 0.0.0.0 = every network interface)
//   GAME_DB_PATH   SQLite file (default data/galaxia.db)
//   GAME_PUBLIC_DIR built files to serve (default dist/client)

import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { createGameServer } from "./game-server.ts";
import { ensureModelFile } from "./model-file.ts";

const PORT = Number(process.env["PORT"] ?? 3000);
const HOST = process.env["HOST"] ?? "0.0.0.0";
const DB_PATH = process.env["GAME_DB_PATH"] ?? "data/galaxia.db";
const PUBLIC_DIR = resolve(process.env["GAME_PUBLIC_DIR"] ?? "dist/client");
// TanStack Start emits the single-page shell as _shell.html.
const INDEX_HTML = resolve(PUBLIC_DIR, "_shell.html");

async function main() {
  // Stitch the character model back together (stored split for git limits).
  ensureModelFile(PUBLIC_DIR, existsSync(resolve(PUBLIC_DIR, "models")) ? PUBLIC_DIR : resolve("public"));
  const game = await createGameServer({ dbPath: DB_PATH });
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  // Game API: /api/game/world, /api/game/health
  app.use((req, res, next) => {
    if (!game.handleHttp(req, res)) next();
  });

  if (!existsSync(INDEX_HTML)) {
    console.warn(`[game] ${INDEX_HTML} not found - run "npm run build:node" first. Serving the game API only.`);
    app.use((_req, res) => {
      res.status(503).type("text/plain").send("Game not built yet. Run: npm run build:node");
    });
  } else {
    // Hashed assets can be cached forever; everything else revalidates.
    app.use(
      "/assets",
      express.static(resolve(PUBLIC_DIR, "assets"), { immutable: true, maxAge: "1y", fallthrough: true }),
    );
    app.use(express.static(PUBLIC_DIR, { maxAge: "1h", index: false }));
    // Single-page app: any other path gets the game shell.
    app.get("/{*splat}", (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(INDEX_HTML);
    });
  }

  const server = createServer(app);
  server.on("upgrade", (req, socket, head) => {
    if (!game.handleUpgrade(req, socket, head)) socket.destroy();
  });

  server.listen(PORT, HOST, () => {
    console.log(`[game] database: ${DB_PATH}`);
    console.log(`[game] listening on port ${PORT}. Players can join at:`);
    console.log(`       http://localhost:${PORT}/`);
    for (const url of publicUrls(PORT)) console.log(`       ${url}`);
  });

  const shutdown = () => {
    console.log("[game] shutting down");
    server.close();
    game.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function publicUrls(port: number) {
  const urls: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) urls.push(`http://${net.address}:${port}/`);
    }
  }
  return urls;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
