// Runs the game server inside Vite's dev server so `npm run dev` gives you a
// working multiplayer game on one port. Production uses server/index.ts.

import type { Plugin } from "vite";
import { createGameServer, type GameServer } from "./game-server.ts";
import { ensureModelFile } from "./model-file.ts";

export function gameServerPlugin(options: { dbPath?: string } = {}): Plugin {
  let game: GameServer | null = null;
  return {
    name: "galaxia-game-server",
    apply: "serve",
    async configureServer(server) {
      ensureModelFile("public");
      game = await createGameServer({
        dbPath: options.dbPath ?? process.env["GAME_DB_PATH"] ?? "data/galaxia.db",
      });
      const active = game;
      server.middlewares.use((req, res, next) => {
        if (!active.handleHttp(req, res)) next();
      });
      server.httpServer?.on("upgrade", (req, socket, head) => {
        // Vite's own HMR socket announces itself with a protocol header; leave it alone.
        if (req.headers["sec-websocket-protocol"] === "vite-hmr") return;
        active.handleUpgrade(req, socket, head);
      });
      server.httpServer?.once("close", () => {
        active.close();
        game = null;
      });
    },
  };
}
