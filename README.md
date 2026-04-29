# companion-module-prodlink-comms

Bitfocus Companion module for **ProdLink Comms** — production intercom control from your Stream Deck.

## Features

- **Push-to-Talk (PTT)** — Hold to talk, release to stop
- **Latch Talk** — Tap to toggle always-on microphone
- **Listen Toggle** — Monitor channels without transmitting
- **Push-to-Listen (PTL)** — Hold to listen, release to stop
- **Smart Channel Combos** — Gesture-based control (double-tap = listen, tap = latch, hold = PTT)
- **Solo Channels** — Isolate a single channel
- **Role Presets** — Apply server-defined role configurations
- **Master Controls** — Mic mute, master volume, sidetone, channel mute
- **Rotary Encoder Support** — Stream Deck+ volume control for mix, sidetone, and per-channel levels
- **Real-time Feedback** — Live talk state, channel modes, and talker names on every button

## Requirements

- [ProdLink Comms](https://github.com/prodcontroller/prodlink-comms) server running on the network
- [Bitfocus Companion](https://bitfocus.io/companion) v4.0 or later

## Configuration

| Field | Description | Default |
|-------|-------------|---------|
| **Server Host** | IP or hostname of the ProdLink Comms server | `localhost` |
| **Port** | Server port | `3200` |
| **Workstation ID** | The workstation ID set in ProdLink Comms settings on the desktop client (e.g. `booth-1`, `foh-main`) | — |

## How It Works

This module connects to the ProdLink Comms server via Socket.IO and binds to a **workstation ID**. It mirrors and controls whichever user is logged into ProdLink Comms on that machine. The companion module never directly joins audio rooms — it sends control intents to the server, which relays them to the desktop client.

State is kept in sync through three layers:
1. **Push sync** — Server pushes state changes in real-time
2. **Direct events** — Instant talk state for PTT feedback
3. **Polling** — Safety-net periodic sync every 3 seconds

## Development

```bash
yarn install
yarn build       # compile TypeScript
yarn dev          # watch mode
```

## License

MIT
