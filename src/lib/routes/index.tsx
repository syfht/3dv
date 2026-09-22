import { createFileRoute } from "@tanstack/react-router";
import GameShell from "@/components/GameShell";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Galaxia — Open Terrain" },
      { name: "description", content: "Explore an open 3D landscape as Galaxia." },
      { property: "og:title", content: "Galaxia — Open Terrain" },
      { property: "og:description", content: "Explore an open 3D landscape as Galaxia." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: GameShell,
});
