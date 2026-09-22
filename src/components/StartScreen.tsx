import { useState } from "react";

const TITLE = "Craft&Mine";

const KEYBINDS: { label: string; key: string }[] = [
  { label: "Move", key: "WASD" },
  { label: "Jump", key: "Space" },
  { label: "Mine / Attack", key: "Hold Click" },
  { label: "Place Block", key: "Right Click" },
  { label: "Select Slot", key: "1 – 7" },
  { label: "Inventory", key: "T" },
  { label: "Crafting Table", key: "E" },
  { label: "Close Menus", key: "ESC" },
];

type Props = {
  onStart: (username: string) => void;
};

export default function StartScreen({ onStart }: Props) {
  const [name, setName] = useState("");
  const start = () => onStart(name.trim() || "Player");

  return (
    <main className="start-screen">
      <h1 className="start-title">{TITLE}</h1>
      <div className="start-row">
        <form
          className="start-card"
          onSubmit={(event) => {
            event.preventDefault();
            start();
          }}
        >
          <label htmlFor="username">Name</label>
          <input
            id="username"
            className="start-input"
            value={name}
            maxLength={16}
            placeholder="Name"
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="start-button">
            Enter Game
          </button>
        </form>
        <aside className="start-keybinds">
          <h2>Controls</h2>
          <ul className="keybind-list">
            {KEYBINDS.map((kb) => (
              <li key={kb.label}>
                <span className="keybind-label">{kb.label}</span>
                <span className="keybind-key">{kb.key}</span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </main>
  );
}
