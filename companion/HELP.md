# ProdLink: Comms — Companion Module

Control **ProdLink Comms** production intercom directly from Bitfocus Companion. Push-to-talk, listen, latch channels, apply role presets, and see real-time talk state — all from your Stream Deck.

## Setup

1. Start the **ProdLink Comms server** (run the ProdLink-Comms desktop app or start the server manually)
2. In Companion, add a **ProdLink: Comms** connection
3. Set the **Server Host** (default `localhost`) and **Port** (default `3200`)
4. Optionally set a **Display Name** (shows up in the presence list) and **User ID**
5. Click **Save** — the module connects, loads all channels, and generates presets

## Configuration

| Field | Description |
|---|---|
| **Server Host** | IP or hostname of the ProdLink Comms server |
| **Port** | Server port, default 3200 |
| **Display Name** | Your name in the presence panel (default "Stream Deck") |
| **User ID** | Unique identifier for this deck (default "companion-deck") |

## Preset Categories

### PTT Channels
One **hold-to-talk** button per channel. Press and hold to talk, release to stop. Button turns green when you're talking, red when someone else is.

### Listen Channels
One **toggle-listen** button per channel. Tap to start listening, tap again to stop. Teal when active, red flash when someone talks.

### Latch Channels
One **latch-toggle** button per channel. Tap to latch mic open, tap again to un-latch. Orange when latched.

### Channel Combos
Combined PTT button with live talker count displayed on the button text. Shows channel color as background.

### Global Controls
- **Silence All** — Immediately stop talking and leave all channels (big red button)
- **Talk All** — Talk on every channel at once (hold = talk, release = silence)
- **Connection Status** — Shows connection state and active channel count
- **Active Talkers** — Live display of who's currently talking across all channels

### Role Presets
One button per role preset defined on the server (e.g., "Camera Op", "Director"). Tap to apply the full channel configuration for that role.

## Actions

| Action | Description |
|---|---|
| **Talk (PTT — Start)** | Join a channel and start talking |
| **Talk Stop** | Stop talking on a channel |
| **Latch Toggle** | Toggle always-on talk |
| **Listen Toggle** | Toggle listen-only mode |
| **Talk All Channels** | Start talking on every channel |
| **Silence All / Leave All** | Stop all talk, leave all channels |
| **Apply Role Preset** | Apply a server-defined role preset |

## Variables

| Variable | Description |
|---|---|
| `connected` | Server connection status (true/false) |
| `all_talkers` | All active talker names |
| `active_room_count` | Number of channels joined |
| `{channel}_name` | Channel name |
| `{channel}_users` | Connected user count |
| `{channel}_talkers` | Active talker count |
| `{channel}_talker_names` | Active talker names |
| `{channel}_mode` | Your current mode (off/listen/talk/latch) |
