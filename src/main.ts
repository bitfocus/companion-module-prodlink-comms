/**
 * ProdLink Comms — Bitfocus Companion Module
 *
 * Workstation-bound Stream Deck remote control for production intercom.
 * Binds to a workstation ID (e.g. "booth-1") and mirrors/controls
 * whichever user is logged into ProdLink Comms on that machine.
 *
 * The companion never directly joins rooms — it sends control intents
 * to the server, which relays them to the desktop client.
 *
 * State sources (in priority order):
 *   1. companion:state_sync — push from server on every state change
 *   2. talk:state_changed — direct talk state events for immediate feedback
 *   3. Periodic poll via companion:state_sync request (fallback safety net)
 *
 * Gesture Detection (Main Channel Combos):
 *   - Double-tap (within 400ms): Toggle listen on/off
 *   - Single tap (<1s): Toggle latch (talk on/off)
 *   - Hold (>1s): Push-to-talk (release stops talk, keeps listening)
 *
 * Rotary Encoder (Stream Deck+):
 *   - While holding a channel combo button: adjust that channel's volume
 *   - While holding sidetone button: adjust sidetone volume
 *   - While holding all-channels button: adjust master mix volume
 */

import {
  InstanceBase,
  InstanceStatus,
  type SomeCompanionConfigField,
  type CompanionPresetDefinitions,
  type CompanionPresetSection,
  type CompanionVariableDefinitions,
  type JsonObject,
} from '@companion-module/base';
import { io, Socket } from 'socket.io-client';
import { deflateSync } from 'zlib';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ModuleConfig {
  host: string;
  port: number;
  workstationId: string;
}

type ChannelMode = 'off' | 'listen' | 'talk' | 'latch';

interface RoomState {
  id: string;
  name: string;
  color: string;
  mode: ChannelMode;
  talking: boolean;
  listening: boolean;
  latched: boolean;
  talkingUsers: string[];
  talkingNames: string[];
  connectedUsers: number;
  solo: boolean;
}

interface RolePreset {
  id: string;
  name: string;
  description: string | null;
}

interface AuxChannelState {
  id: string;
  name: string;
  color: string;
  active: boolean;
  volume: number;
  muted: boolean;
}

interface CompanionStateSync {
  connected: boolean;
  userName: string | null;
  userId?: string;
  channels: Array<{
    roomId: string;
    mode: string;
    talking: boolean;
    listening: boolean;
  }>;
  clientChannelStates?: Record<string, {
    active?: boolean;
    listening?: boolean;
    talking?: boolean;
    latched?: boolean;
    talkMode?: string;
    audioMode?: string;
    solo?: boolean;
    volume?: number;
  }>;
  talkState: Record<string, string[]>;
  activePresetId: string | null;
  globalMute?: boolean;
  soloRoomId?: string | null;
  sidetoneVolume?: number;
  mixVolume?: number;
  programChannelStates?: Record<string, {
    active?: boolean;
    volume?: number;
    muted?: boolean;
    deviceName?: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DOUBLE_TAP_WINDOW = 250;   // ms — two quick taps within this = double-tap
const HOLD_THRESHOLD    = 400;   // ms — held longer = PTT mode
const VOLUME_STEP       = 0.05;  // 5% per rotary click
const VOL_BTN_STEP      = 0.05;  // 5% per volume button press/repeat
const VOL_BTN_HOLD_DELAY = 500;  // ms before hold-repeat starts
const VOL_BTN_REPEAT_MS  = 150;  // ms between hold-repeat increments

function hexToInt(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

function darkenHex(hex: string, factor = 0.35): number {
  const cleaned = hex.replace('#', '');
  const r = Math.round(parseInt(cleaned.slice(0, 2), 16) * factor);
  const g = Math.round(parseInt(cleaned.slice(2, 4), 16) * factor);
  const b = Math.round(parseInt(cleaned.slice(4, 6), 16) * factor);
  return (r << 16) | (g << 8) | b;
}

const COLORS = {
  myTalk:     0x00cc44,
  theyTalk:   0xcc2200,
  listening:  0x006888,
  latched:    0xcc6600,
  inactive:   0x1a2035,
  connected:  0x003366,
  anyTalking: 0xcc8800,
  solo:       0xccaa00,
  wsOnline:   0x005533,
  wsOffline:  0x550000,
  muted:      0x880000,
  sidetone:   0x336688,
  white:      0xffffff,
  black:      0x000000,
};

// ─────────────────────────────────────────────────────────────────────────────
// PNG Border Generator — creates a transparent PNG with a rounded white border
// Used as png64 overlay to indicate the "talking" state on Stream Deck buttons.
// ─────────────────────────────────────────────────────────────────────────────

function generateBorderPng(
  width = 72, height = 72,
  borderWidth = 3, radius = 10,
  r = 255, g = 255, b = 255, a = 230,
): string {
  // Build raw RGBA pixel data with filter bytes
  const rawData = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (width * 4 + 1);
    rawData[rowOffset] = 0; // PNG filter: None
    for (let x = 0; x < width; x++) {
      const px = rowOffset + 1 + x * 4;
      // Check if pixel is on the border
      const onBorder = isOnRoundedBorder(x, y, width, height, borderWidth, radius);
      rawData[px]     = onBorder ? r : 0;
      rawData[px + 1] = onBorder ? g : 0;
      rawData[px + 2] = onBorder ? b : 0;
      rawData[px + 3] = onBorder ? a : 0;
    }
  }

  // Compress with zlib
  const compressed = deflateSync(rawData);

  // Build PNG file
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = makeChunk('IHDR', ihdrData);

  // IDAT chunk
  const idat = makeChunk('IDAT', compressed);

  // IEND chunk
  const iend = makeChunk('IEND', Buffer.alloc(0));

  const png = Buffer.concat([pngSignature, ihdr, idat, iend]);
  return png.toString('base64');
}

function makeChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function isOnRoundedBorder(
  x: number, y: number,
  w: number, h: number,
  bw: number, rad: number,
): boolean {
  // Quick reject: not near any edge
  if (x >= bw && x < w - bw && y >= bw && y < h - bw) return false;
  // Quick accept: on straight edge (not in corner zone)
  if (x >= rad && x < w - rad) return (y < bw || y >= h - bw);
  if (y >= rad && y < h - rad) return (x < bw || x >= w - bw);
  // Corner zone — check rounded corner distance
  let cx: number, cy: number;
  if (x < rad && y < rad) { cx = rad; cy = rad; }         // top-left
  else if (x >= w - rad && y < rad) { cx = w - rad - 1; cy = rad; } // top-right
  else if (x < rad && y >= h - rad) { cx = rad; cy = h - rad - 1; } // bottom-left
  else { cx = w - rad - 1; cy = h - rad - 1; }              // bottom-right
  const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
  return dist >= rad - bw && dist <= rad;
}

// Pre-generate the border overlay (white rounded border on transparent bg)
const TALK_BORDER_PNG64 = generateBorderPng(72, 72, 3, 14, 255, 255, 255, 230);


// ─────────────────────────────────────────────────────────────────────────────
// Module
// ─────────────────────────────────────────────────────────────────────────────

export default class ProdLinkCommsModule extends InstanceBase {
  private socket: Socket | null = null;
  private rooms: Map<string, RoomState> = new Map();

  private rolePresets: RolePreset[] = [];
  private config: ModuleConfig = { host: 'localhost', port: 3200, workstationId: '' };
  private clientConnected = false;
  private clientUserName: string | null = null;
  private clientUserId: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // ── Global state from desktop client ──
  private globalMute = false;
  private soloRoomId: string | null = null;
  private sidetoneVolume = 0;
  private mixVolume = 0.75;

  // ── Gesture detection state ──
  // Tracks per-button press timing for tap vs hold vs double-tap.
  private pressStartTimes: Map<string, number> = new Map();       // key -> timestamp of button press
  private lastTapTimes: Map<string, number> = new Map();          // key -> timestamp of last quick tap (for double-tap detection)
  private pendingSingleTapTimers: Map<string, ReturnType<typeof setTimeout>> = new Map(); // key -> timer for pending single-tap
  private heldButtons: Set<string> = new Set();                  // currently held button keys (for rotary association)

  // ── Volume display overlay ──
  private volumeDisplayTarget: string | null = null; // which target is showing volume (e.g. 'mix', 'sidetone', 'channel:id')
  private volumeDisplayTimer: ReturnType<typeof setTimeout> | null = null;
  private channelVolumes: Map<string, number> = new Map(); // optimistic per-channel volumes

  // ── Aux channel state ──
  private auxChannels: Map<string, AuxChannelState> = new Map();

  // ── Volume button hold-repeat ──
  private volBtnHoldTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private volBtnRepeatTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async init(rawConfig: JsonObject): Promise<void> {
    const config = rawConfig as unknown as ModuleConfig;
    this.config = config;
    this.updateStatus(InstanceStatus.Connecting);
    this.registerAll();
    this.connectToServer();
  }

  getConfigFields(): SomeCompanionConfigField[] {
    return [
      { type: 'textinput', id: 'host', label: 'Server Host', default: 'localhost', width: 6 },
      { type: 'number', id: 'port', label: 'Server Port', default: 3200, min: 1, max: 65535, width: 3 },
      {
        type: 'textinput', id: 'workstationId', label: 'Workstation ID', default: '', width: 6,
        tooltip: 'The workstation ID set in ProdLink Comms settings on the desktop client (e.g. booth-1, foh-main).',
      },
    ];
  }

  async configUpdated(rawConfig: JsonObject): Promise<void> {
    const config = rawConfig as unknown as ModuleConfig;
    this.config = config;
    this.disconnectFromServer();
    this.connectToServer();
  }

  async destroy(): Promise<void> {
    this.disconnectFromServer();
    // Clear all gesture timers
    for (const timer of this.pendingSingleTapTimers.values()) clearTimeout(timer);
    this.pendingSingleTapTimers.clear();
    // Clear all volume button hold timers
    for (const timer of this.volBtnHoldTimers.values()) clearTimeout(timer);
    this.volBtnHoldTimers.clear();
    for (const timer of this.volBtnRepeatTimers.values()) clearInterval(timer);
    this.volBtnRepeatTimers.clear();
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  private connectToServer(): void {
    if (!this.config.workstationId) {
      this.updateStatus(InstanceStatus.BadConfig, 'Workstation ID is required');
      return;
    }

    const url = `http://${this.config.host}:${this.config.port}`;
    this.log('info', `Connecting to ${url} (workstation: ${this.config.workstationId})`);

    this.socket = io(url, {
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionAttempts: Infinity,
    });

    this.socket.on('connect', () => {
      this.log('info', 'Connected to ProdLink Comms server');
      this.socket?.emit('companion:bind', { workstationId: this.config.workstationId });
      this.fetchRooms();
      this.fetchRolePresets();
      this.fetchAuxChannels();
      this.startPolling();
    });

    this.socket.on('disconnect', () => {
      this.updateStatus(InstanceStatus.Disconnected);
      this.clientConnected = false;
      this.clientUserName = null;
      this.clientUserId = null;
      this.stopPolling();
      this.refreshAllFeedbacks();
      this.log('warn', 'Disconnected from server');
    });

    this.socket.on('connect_error', (err: Error) => {
      this.updateStatus(InstanceStatus.ConnectionFailure, err.message);
    });

    // ── Primary: Push-based state sync from server ──
    this.socket.on('companion:state_sync', (state: CompanionStateSync) => {
      this.log('debug', `State sync received: connected=${state.connected}, user=${state.userName}, channels=${state.channels?.length || 0}, soloRoomId=${state.soloRoomId ?? 'null'}`);
      this.handleStateSync(state);
    });

    // ── Secondary: Direct talk state events for instant PTT feedback ──
    this.socket.on('talk:state_changed', (data: { roomId: string; userId: string; displayName: string; talking: boolean }) => {
      const room = this.rooms.get(data.roomId);
      if (!room) return;

      if (data.talking) {
        if (!room.talkingUsers.includes(data.userId)) {
          room.talkingUsers.push(data.userId);
          room.talkingNames.push(data.displayName);
        }
      } else {
        room.talkingUsers = room.talkingUsers.filter(id => id !== data.userId);
        room.talkingNames = room.talkingNames.filter(n => n !== data.displayName);
      }

      // If this is OUR user, update the room's own talk state
      if (this.clientUserId && data.userId === this.clientUserId) {
        room.talking = data.talking;
        if (data.talking) {
          room.mode = room.latched ? 'latch' : 'talk';
        } else if (!room.latched) {
          room.mode = room.listening ? 'listen' : 'off';
        }
      }

      this.refreshAllFeedbacks();
    });

    // ── Listen for presence updates to track who's on channels ──
    this.socket.on('presence:update', () => {
      // Presence changed — request fresh state
      this.requestStateSync();
    });
  }

  private disconnectFromServer(): void {
    this.stopPolling();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.clientConnected = false;
    this.clientUserName = null;
    this.clientUserId = null;
    this.rooms.clear();
    this.auxChannels.clear();
  }

  // ─── Polling (safety net) ──────────────────────────────────────────────────

  private startPolling(): void {
    this.stopPolling();
    // Re-request state every 3 seconds as a safety net
    this.pollTimer = setInterval(() => {
      this.requestStateSync();
    }, 3000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Ask the server to send us the current state */
  private requestStateSync(): void {
    if (this.socket?.connected) {
      this.socket.emit('companion:request_sync', { workstationId: this.config.workstationId });
    }
  }

  // ─── State Sync ────────────────────────────────────────────────────────────

  private handleStateSync(state: CompanionStateSync): void {
    this.clientConnected = state.connected;
    this.clientUserName = state.userName;
    this.clientUserId = state.userId || null;

    // Global state from desktop client
    this.globalMute = state.globalMute ?? false;
    this.soloRoomId = state.soloRoomId ?? null;
    this.sidetoneVolume = state.sidetoneVolume ?? 0;
    this.mixVolume = state.mixVolume ?? 0.75;

    if (this.soloRoomId) {
      this.log('debug', `[StateSync] soloRoomId = ${this.soloRoomId}`);
    }

    if (!state.connected) {
      this.updateStatus(InstanceStatus.Ok, 'No client on workstation');
      for (const room of this.rooms.values()) {
        room.mode = 'off';
        room.talking = false;
        room.listening = false;
        room.latched = false;
        room.solo = false;
        room.talkingUsers = [];
        room.talkingNames = [];
      }
    } else {
      this.updateStatus(InstanceStatus.Ok);

      // Reset all rooms
      for (const room of this.rooms.values()) {
        room.mode = 'off';
        room.talking = false;
        room.listening = false;
        room.latched = false;
        room.solo = this.soloRoomId === room.id;
      }

      // Apply from clientChannelStates (rich React state) FIRST
      const clientStates = state.clientChannelStates || {};
      for (const [roomId, cs] of Object.entries(clientStates)) {
        const room = this.rooms.get(roomId);
        if (!room) continue;
        room.solo = cs.solo ?? (this.soloRoomId === roomId);
        if (cs.active) {
          room.talking = cs.talking || false;
          room.listening = cs.listening || false;
          room.latched = cs.latched || false;
          if (room.latched) room.mode = 'latch';
          else if (room.talking) room.mode = 'talk';
          else if (room.listening) room.mode = 'listen';
          else room.mode = 'off';
        }
        // Sync channel volume from desktop client
        if (cs.volume != null) {
          this.channelVolumes.set(roomId, cs.volume);
        }
      }

      // ALSO apply from server-side channels (always has current talk state)
      for (const ch of state.channels) {
        const room = this.rooms.get(ch.roomId);
        if (!room) continue;
        if (!clientStates[ch.roomId]) {
          room.mode = ch.mode as ChannelMode || 'off';
          room.talking = ch.talking;
          room.listening = ch.listening;
        } else {
          if (ch.talking && !room.talking) {
            room.talking = true;
            room.mode = room.latched ? 'latch' : 'talk';
          }
        }
      }

      // Update talk state from the full talkState map
      for (const [roomId, talkerIds] of Object.entries(state.talkState)) {
        const room = this.rooms.get(roomId);
        if (room) {
          room.talkingUsers = talkerIds;
          room.talkingNames = talkerIds; // TODO: resolve display names
        }
      }

      // Apply aux channel (program channel) states
      const pgStates = state.programChannelStates || {};
      for (const [chId, ps] of Object.entries(pgStates)) {
        const aux = this.auxChannels.get(chId);
        if (aux) {
          aux.active = ps.active ?? false;
          aux.volume = ps.volume ?? 0.75;
          aux.muted = ps.muted ?? false;
        }
      }
    }

    this.refreshAllFeedbacks();
  }

  private refreshAllFeedbacks(): void {
    this.checkFeedbacks(
      'workstation_connected', 'channel_active', 'channel_talking', 'channel_my_talk',
      'channel_listening', 'channel_latched', 'any_talking', 'channel_solo',
      'global_mute', 'sidetone_active', 'mix_muted', 'volume_display',
      'aux_active', 'aux_muted',
    );
    this.updateVariableValues();
  }

  // ─── Data Fetching ─────────────────────────────────────────────────────────

  /** Fetch with AbortController timeout to prevent indefinite hangs */
  private async fetchWithTimeout(url: string, timeoutMs = 5000): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async fetchRooms(): Promise<void> {
    try {
      const res = await this.fetchWithTimeout(`http://${this.config.host}:${this.config.port}/api/rooms`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>[];



      const existing = new Map(this.rooms);
      this.rooms.clear();

      for (const room of data) {
        const roomId = room.id as string;
        const prev = existing.get(roomId);
        this.rooms.set(roomId, {
          id: roomId,
          name: room.name as string,
          color: (room.color as string) || '#3b82f6',
          mode: prev?.mode ?? 'off',
          talking: prev?.talking ?? false,
          listening: prev?.listening ?? false,
          latched: prev?.latched ?? false,
          talkingUsers: prev?.talkingUsers ?? [],
          talkingNames: prev?.talkingNames ?? [],
          connectedUsers: prev?.connectedUsers ?? 0,
          solo: prev?.solo ?? false,
        });
      }

      this.log('info', `Loaded ${data.length} rooms`);
      this.registerAll();
    } catch (err) {
      this.log('error', `Failed to fetch rooms: ${err}`);
    }
  }

  private async fetchRolePresets(): Promise<void> {
    try {
      const res = await this.fetchWithTimeout(`http://${this.config.host}:${this.config.port}/api/role-presets`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>[];
      this.rolePresets = data.map((p) => ({ id: p.id as string, name: p.name as string, description: p.description as string | null }));
      this.log('info', `Loaded ${data.length} role presets`);
      this.registerAll();
    } catch (err) {
      this.log('error', `Failed to fetch role presets: ${err}`);
    }
  }

  private async fetchAuxChannels(): Promise<void> {
    try {
      const res = await this.fetchWithTimeout(`http://${this.config.host}:${this.config.port}/api/program-channels`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>[];

      const existing = new Map(this.auxChannels);
      this.auxChannels.clear();

      for (const ch of data) {
        const id = ch.id as string;
        const prev = existing.get(id);
        this.auxChannels.set(id, {
          id,
          name: ch.name as string,
          color: (ch.color as string) || '#8b5cf6',
          active: prev?.active ?? false,
          volume: prev?.volume ?? 0.75,
          muted: prev?.muted ?? false,
        });
      }

      this.log('info', `Loaded ${data.length} aux channels`);
      this.registerAll();
    } catch (err) {
      this.log('error', `Failed to fetch aux channels: ${err}`);
    }
  }

  // ─── Volume Display Helpers ────────────────────────────────────────────────

  /**
   * Optimistically update tracked volume and show the display overlay.
   * Called from volume_up/volume_down action callbacks.
   */
  private optimisticVolumeUpdate(target: string, delta: number): void {
    let newVol: number;
    if (target === 'mix') {
      this.mixVolume = Math.max(0, Math.min(1, this.mixVolume + delta));
      newVol = this.mixVolume;
    } else if (target === 'sidetone') {
      this.sidetoneVolume = Math.max(0, Math.min(1, this.sidetoneVolume + delta));
      newVol = this.sidetoneVolume;
    } else if (target.startsWith('channel:')) {
      const roomId = target.replace('channel:', '');
      const current = this.channelVolumes.get(roomId) ?? 1;
      newVol = Math.max(0, Math.min(1, current + delta));
      this.channelVolumes.set(roomId, newVol);
    } else if (target.startsWith('aux:')) {
      const auxId = target.replace('aux:', '');
      const aux = this.auxChannels.get(auxId);
      if (aux) {
        aux.volume = Math.max(0, Math.min(1, aux.volume + delta));
        newVol = aux.volume;
      } else {
        return;
      }
    } else {
      return;
    }
    this.showVolumeDisplay(target);
  }

  /**
   * Show the volume percentage overlay on the target button for 1 second.
   */
  private showVolumeDisplay(target: string): void {
    this.volumeDisplayTarget = target;
    if (this.volumeDisplayTimer) clearTimeout(this.volumeDisplayTimer);
    this.volumeDisplayTimer = setTimeout(() => {
      this.volumeDisplayTarget = null;
      this.volumeDisplayTimer = null;
      this.checkFeedbacks('volume_display');
    }, 1000);
    this.checkFeedbacks('volume_display');
  }

  // ─── Volume Button Hold-Repeat ─────────────────────────────────────────────

  /**
   * Volume button DOWN — execute one step immediately, then start
   * hold-repeat after VOL_BTN_HOLD_DELAY ms.
   */
  private volBtnDown(target: string, delta: number): void {
    const key = `${target}:${delta > 0 ? 'up' : 'down'}`;
    // Immediate first step
    this.emitVolumeStep(target, delta);
    this.optimisticVolumeUpdate(target, delta);
    // Schedule hold-repeat
    const holdTimer = setTimeout(() => {
      this.volBtnHoldTimers.delete(key);
      const repeatTimer = setInterval(() => {
        this.emitVolumeStep(target, delta);
        this.optimisticVolumeUpdate(target, delta);
      }, VOL_BTN_REPEAT_MS);
      this.volBtnRepeatTimers.set(key, repeatTimer);
    }, VOL_BTN_HOLD_DELAY);
    this.volBtnHoldTimers.set(key, holdTimer);
  }

  /**
   * Volume button UP — cancel any hold or repeat timers.
   */
  private volBtnUp(target: string, delta: number): void {
    const key = `${target}:${delta > 0 ? 'up' : 'down'}`;
    const hold = this.volBtnHoldTimers.get(key);
    if (hold) { clearTimeout(hold); this.volBtnHoldTimers.delete(key); }
    const repeat = this.volBtnRepeatTimers.get(key);
    if (repeat) { clearInterval(repeat); this.volBtnRepeatTimers.delete(key); }
  }

  /**
   * Emit the actual socket event for a volume change.
   */
  private emitVolumeStep(target: string, delta: number): void {
    const wkId = this.config.workstationId;
    if (target === 'mix' || target === 'sidetone') {
      this.socket?.emit('companion:set_volume', { workstationId: wkId, target, delta });
    } else if (target.startsWith('channel:')) {
      const roomId = target.replace('channel:', '');
      this.socket?.emit('companion:set_volume', { workstationId: wkId, target: 'channel', roomId, delta });
    } else if (target.startsWith('aux:')) {
      const channelId = target.replace('aux:', '');
      this.socket?.emit('companion:aux_volume_set', { workstationId: wkId, channelId, delta });
    }
  }

  // ─── Gesture Helpers ───────────────────────────────────────────────────────

  /**
   * Smart Channel Combo — button DOWN handler.
   *
   * STATE-DEPENDENT gesture:
   *
   * Channel OFF:
   *   - Hold (>= HOLD_THRESHOLD): PTT + latch listen ON
   *   - Quick tap: turn on listen
   *
   * Channel LISTENING:
   *   - Hold (>= HOLD_THRESHOLD): PTT (talk while held)
   *   - Single tap (no 2nd tap): turn off listen
   *   - Double-tap: latch talk toggle
   */
  private handleComboDown(roomId: string): void {
    const now = Date.now();
    this.pressStartTimes.set(roomId, now);
    this.heldButtons.add(roomId);

    const room = this.rooms.get(roomId);
    const isListening = room ? (room.mode !== 'off') : false;

    // Start a timer — if still held after HOLD_THRESHOLD, begin PTT
    const holdTimer = setTimeout(() => {
      if (!this.heldButtons.has(roomId)) return;

      if (!isListening) {
        // Channel was OFF → latch listen ON first, then start PTT
        this.log('debug', `[Gesture] Hold on OFF channel ${roomId} — listen_toggle + talk_start`);
        this.socket?.emit('companion:listen_toggle', {
          workstationId: this.config.workstationId,
          roomId,
        });
      } else {
        this.log('debug', `[Gesture] Hold on LISTENING channel ${roomId} — talk_start (PTT)`);
      }

      this.socket?.emit('companion:talk_start', {
        workstationId: this.config.workstationId,
        roomId,
      });
      // Mark that PTT is active so release sends talk_stop
      this.pressStartTimes.set(`ptt_active_${roomId}`, 1);
    }, HOLD_THRESHOLD);
    this.pendingSingleTapTimers.set(`hold_${roomId}`, holdTimer);
  }

  /**
   * Smart Channel Combo — button UP handler.
   */
  private handleComboUp(roomId: string): void {
    const now = Date.now();
    const pressStart = this.pressStartTimes.get(roomId) || now;
    const duration = now - pressStart;
    this.heldButtons.delete(roomId);

    // Cancel the hold timer if it hasn't fired yet
    const holdTimer = this.pendingSingleTapTimers.get(`hold_${roomId}`);
    if (holdTimer) {
      clearTimeout(holdTimer);
      this.pendingSingleTapTimers.delete(`hold_${roomId}`);
    }

    const pttWasActive = this.pressStartTimes.has(`ptt_active_${roomId}`);
    this.pressStartTimes.delete(`ptt_active_${roomId}`);

    if (pttWasActive || duration >= HOLD_THRESHOLD) {
      // ── Hold release → PTT stop (listen stays on) ──
      this.log('debug', `[Gesture] PTT release on ${roomId} (held ${duration}ms)`);
      this.socket?.emit('companion:talk_stop', {
        workstationId: this.config.workstationId,
        roomId,
      });
      // Clear double-tap tracking (hold resets it)
      this.lastTapTimes.delete(roomId);
      return;
    }

    // ── Quick tap — behavior depends on channel state ──
    const room = this.rooms.get(roomId);
    const isListening = room ? (room.mode !== 'off') : false;

    if (!isListening) {
      // Channel OFF → turn on listen
      this.log('debug', `[Gesture] Tap on OFF channel ${roomId} — listen_toggle (ON)`);
      this.socket?.emit('companion:listen_toggle', {
        workstationId: this.config.workstationId,
        roomId,
      });
      this.lastTapTimes.delete(roomId);
    } else {
      // Channel LISTENING → check for double-tap
      const lastTap = this.lastTapTimes.get(roomId) || 0;
      const timeSinceLastTap = now - lastTap;

      if (timeSinceLastTap < DOUBLE_TAP_WINDOW && lastTap > 0) {
        // ── Double-tap → latch toggle ──
        this.log('debug', `[Gesture] Double-tap on LISTENING ${roomId} — latch_toggle`);
        this.lastTapTimes.delete(roomId);

        // Cancel pending single-tap timer from first tap
        const pending = this.pendingSingleTapTimers.get(roomId);
        if (pending) {
          clearTimeout(pending);
          this.pendingSingleTapTimers.delete(roomId);
        }

        this.socket?.emit('companion:latch_toggle', {
          workstationId: this.config.workstationId,
          roomId,
        });
      } else {
        // ── First tap — wait for possible second tap ──
        this.lastTapTimes.set(roomId, now);

        const pendingTimer = setTimeout(() => {
          this.pendingSingleTapTimers.delete(roomId);
          this.lastTapTimes.delete(roomId);
          // Single tap confirmed → turn off listen
          this.log('debug', `[Gesture] Single-tap on LISTENING ${roomId} — listen_toggle (OFF)`);
          this.socket?.emit('companion:listen_toggle', {
            workstationId: this.config.workstationId,
            roomId,
          });
        }, DOUBLE_TAP_WINDOW);
        this.pendingSingleTapTimers.set(roomId, pendingTimer);
      }
    }
  }

  /**
   * Talk-specific down — talk starts immediately.
   */
  private handleTalkDown(roomId: string): void {
    this.pressStartTimes.set(`talk_${roomId}`, Date.now());
    this.heldButtons.add(`talk_${roomId}`);

    // Start talking immediately
    this.socket?.emit('companion:talk_start', {
      workstationId: this.config.workstationId,
      roomId,
    });
  }

  /**
   * Talk-specific up — quick tap = latch_toggle (talk stays on),
   * long press = PTT release (talk_stop).
   */
  private handleTalkUp(roomId: string): void {
    const key = `talk_${roomId}`;
    const now = Date.now();
    const pressStart = this.pressStartTimes.get(key) || now;
    const duration = now - pressStart;
    this.heldButtons.delete(key);

    if (duration >= HOLD_THRESHOLD) {
      // Long press → PTT release
      this.socket?.emit('companion:talk_stop', {
        workstationId: this.config.workstationId,
        roomId,
      });
    } else {
      // Quick tap → latch toggle (talk stays on, gets latched or unlatched)
      this.socket?.emit('companion:latch_toggle', {
        workstationId: this.config.workstationId,
        roomId,
      });
    }
  }

  // ─── Master Register ───────────────────────────────────────────────────────

  private registerAll(): void {
    this.setupActions();
    this.setupFeedbacks();
    this.setupVariables();
    this.setupPresets();
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  private setupActions(): void {
    const roomChoices = Array.from(this.rooms.values()).map((r) => ({ id: r.id, label: r.name }));
    const auxChoices = Array.from(this.auxChannels.values()).map((a) => ({ id: a.id, label: a.name }));
    const rolePresetChoices = this.rolePresets.map((p) => ({ id: p.id, label: p.name }));
    const wkId = this.config.workstationId;

    // Build combined volume target choices for rotary/button actions
    const volumeTargetChoices = [
      { id: 'mix', label: 'Master Mix' },
      { id: 'sidetone', label: 'Sidetone' },
      ...roomChoices.map(r => ({ id: `channel:${r.id}`, label: `Channel: ${r.label}` })),
      ...auxChoices.map(a => ({ id: `aux:${a.id}`, label: `Aux: ${a.label}` })),
    ];

    this.setActionDefinitions({
      // ── Smart Channel Combo actions ──
      channel_combo_down: {
        name: 'Channel Combo — Press',
        description: 'Smart channel combo press: double-tap=listen toggle, single-tap=latch toggle, hold=PTT.',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        callback: async (action) => {
          this.handleComboDown(action.options.roomId as string);
        },
      },
      channel_combo_up: {
        name: 'Channel Combo — Release',
        description: 'Smart channel combo release: resolves gesture based on press duration.',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        callback: async (action) => {
          this.handleComboUp(action.options.roomId as string);
        },
      },

      // ── Basic Talk/Listen (atomic actions) ──
      talk: {
        name: 'Talk (PTT — Start)',
        description: 'Start talking on a channel.',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        callback: async (action) => {
          this.socket?.emit('companion:talk_start', { workstationId: wkId, roomId: action.options.roomId as string });
        },
      },
      talk_stop: {
        name: 'Talk Stop',
        description: 'Stop talking on a channel.',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        callback: async (action) => {
          this.socket?.emit('companion:talk_stop', { workstationId: wkId, roomId: action.options.roomId as string });
        },
      },
      listen_toggle: {
        name: 'Listen Toggle',
        description: 'Toggle listen mode on a channel.',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        callback: async (action) => {
          this.socket?.emit('companion:listen_toggle', { workstationId: wkId, roomId: action.options.roomId as string });
        },
      },
      latch_toggle: {
        name: 'Latch Toggle',
        description: 'Toggle latch (always-on talk) on a channel.',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        callback: async (action) => {
          this.socket?.emit('companion:latch_toggle', { workstationId: wkId, roomId: action.options.roomId as string });
        },
      },

      // ── Channel Talk (with gesture: tap=latch, hold=PTT) ──
      channel_talk_down: {
        name: 'Channel Talk — Press',
        description: 'Smart talk press: tap=latch toggle, hold>1s=PTT.',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        callback: async (action) => {
          this.handleTalkDown(action.options.roomId as string);
        },
      },
      channel_talk_up: {
        name: 'Channel Talk — Release',
        description: 'Smart talk release: resolves tap vs hold.',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        callback: async (action) => {
          this.handleTalkUp(action.options.roomId as string);
        },
      },

      // ── Push to Listen (PTL) ──
      listen_start: {
        name: 'Listen Start (PTL)',
        description: 'Start listening on a channel (push to listen).',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        callback: async (action) => {
          // Use listen_toggle to turn ON. The client interprets "listen_toggle on inactive = turn on" 
          this.socket?.emit('companion:listen_toggle', { workstationId: wkId, roomId: action.options.roomId as string });
        },
      },
      listen_stop: {
        name: 'Listen Stop (PTL Release)',
        description: 'Stop listening on a channel (push to listen release).',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        callback: async (action) => {
          this.socket?.emit('companion:listen_toggle', { workstationId: wkId, roomId: action.options.roomId as string });
        },
      },

      // ── Solo ──
      solo_toggle: {
        name: 'Solo Toggle',
        description: 'Toggle solo on a channel. Only one channel can be soloed at a time.',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        callback: async (action) => {
          this.socket?.emit('companion:solo_toggle', { workstationId: wkId, roomId: action.options.roomId as string });
        },
      },

      // ── Global Controls ──
      global_mute_toggle: {
        name: 'Master Mic Mute/Unmute',
        description: 'Toggle the master mic mute for this workstation.',
        options: [],
        callback: async () => {
          this.socket?.emit('companion:global_mute_toggle', { workstationId: wkId });
        },
      },
      all_channels_mute: {
        name: 'Mute/Unmute All Channels',
        description: 'Toggle master mix volume to zero / restore previous level. Emergency mute for all channel audio.',
        options: [],
        callback: async () => {
          this.socket?.emit('companion:all_channels_mute', { workstationId: wkId });
        },
      },
      sidetone_mute_toggle: {
        name: 'Sidetone Mute/Unmute',
        description: 'Toggle sidetone (self-hearing) on/off for this workstation.',
        options: [],
        callback: async () => {
          this.socket?.emit('companion:sidetone_mute_toggle', { workstationId: wkId });
        },
      },

      // ── Volume — used by rotary encoders ──
      volume_up: {
        name: 'Volume Up (Rotary)',
        description: 'Increase volume by one step. Target: mix, sidetone, channel, or aux channel.',
        options: [
          {
            type: 'dropdown', id: 'target', label: 'Target',
            choices: volumeTargetChoices,
            default: 'mix',
          },
        ],
        callback: async (action) => {
          const targetRaw = action.options.target as string;
          this.emitVolumeStep(targetRaw, VOLUME_STEP);
          this.optimisticVolumeUpdate(targetRaw, VOLUME_STEP);
        },
      },
      volume_down: {
        name: 'Volume Down (Rotary)',
        description: 'Decrease volume by one step. Target: mix, sidetone, channel, or aux channel.',
        options: [
          {
            type: 'dropdown', id: 'target', label: 'Target',
            choices: volumeTargetChoices,
            default: 'mix',
          },
        ],
        callback: async (action) => {
          const targetRaw = action.options.target as string;
          this.emitVolumeStep(targetRaw, -VOLUME_STEP);
          this.optimisticVolumeUpdate(targetRaw, -VOLUME_STEP);
        },
      },

      // ── Volume Buttons (non-rotary, hold-to-repeat) ──
      vol_btn_up_press: {
        name: 'Volume Button Up — Press',
        description: 'Press to increase volume. Hold for continuous repeat (±5% per step, 150ms repeat after 500ms hold).',
        options: [{ type: 'dropdown', id: 'target', label: 'Target', choices: volumeTargetChoices, default: 'mix' }],
        callback: async (action) => {
          this.volBtnDown(action.options.target as string, VOL_BTN_STEP);
        },
      },
      vol_btn_up_release: {
        name: 'Volume Button Up — Release',
        description: 'Release volume up button. Stops hold-repeat.',
        options: [{ type: 'dropdown', id: 'target', label: 'Target', choices: volumeTargetChoices, default: 'mix' }],
        callback: async (action) => {
          this.volBtnUp(action.options.target as string, VOL_BTN_STEP);
        },
      },
      vol_btn_down_press: {
        name: 'Volume Button Down — Press',
        description: 'Press to decrease volume. Hold for continuous repeat (±5% per step, 150ms repeat after 500ms hold).',
        options: [{ type: 'dropdown', id: 'target', label: 'Target', choices: volumeTargetChoices, default: 'mix' }],
        callback: async (action) => {
          this.volBtnDown(action.options.target as string, -VOL_BTN_STEP);
        },
      },
      vol_btn_down_release: {
        name: 'Volume Button Down — Release',
        description: 'Release volume down button. Stops hold-repeat.',
        options: [{ type: 'dropdown', id: 'target', label: 'Target', choices: volumeTargetChoices, default: 'mix' }],
        callback: async (action) => {
          this.volBtnUp(action.options.target as string, -VOL_BTN_STEP);
        },
      },

      // ── Aux Channel Controls ──
      aux_listen_toggle: {
        name: 'Aux Listen Toggle',
        description: 'Toggle listening on an aux channel.',
        options: [{ type: 'dropdown', id: 'channelId', label: 'Aux Channel', choices: auxChoices.length > 0 ? auxChoices : [{ id: '', label: 'No aux channels' }], default: auxChoices[0]?.id ?? '' }],
        callback: async (action) => {
          const channelId = action.options.channelId as string;
          if (channelId) this.socket?.emit('companion:aux_listen_toggle', { workstationId: wkId, channelId });
        },
      },
      aux_mute_toggle: {
        name: 'Aux Mute Toggle',
        description: 'Toggle mute on an aux channel.',
        options: [{ type: 'dropdown', id: 'channelId', label: 'Aux Channel', choices: auxChoices.length > 0 ? auxChoices : [{ id: '', label: 'No aux channels' }], default: auxChoices[0]?.id ?? '' }],
        callback: async (action) => {
          const channelId = action.options.channelId as string;
          if (channelId) this.socket?.emit('companion:aux_mute_toggle', { workstationId: wkId, channelId });
        },
      },

      // ── Role Presets ──
      apply_preset: {
        name: 'Apply Role Preset',
        description: 'Tell the desktop client to apply a role preset.',
        options: [{
          type: 'dropdown', id: 'presetId', label: 'Preset',
          choices: rolePresetChoices.length > 0 ? rolePresetChoices : [{ id: '', label: 'No presets loaded' }],
          default: rolePresetChoices[0]?.id ?? '',
        }],
        callback: async (action) => {
          const presetId = action.options.presetId as string;
          if (presetId) this.socket?.emit('companion:apply_preset', { workstationId: wkId, presetId });
        },
      },
    });
  }

  // ─── Feedbacks ─────────────────────────────────────────────────────────────

  private setupFeedbacks(): void {
    const roomChoices = Array.from(this.rooms.values()).map((r) => ({ id: r.id, label: r.name }));
    const auxChoices = Array.from(this.auxChannels.values()).map((a) => ({ id: a.id, label: a.name }));

    this.setFeedbackDefinitions({
      workstation_connected: {
        type: 'boolean',
        name: 'Workstation Connected',
        description: 'True when a desktop client is connected on the bound workstation.',
        options: [],
        defaultStyle: { bgcolor: COLORS.wsOnline, color: COLORS.white },
        callback: () => this.clientConnected,
      },
      channel_active: {
        type: 'boolean',
        name: 'Channel Active (Joined)',
        description: 'True when the desktop user is joined to this channel in any mode.',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        defaultStyle: { bgcolor: COLORS.connected, color: COLORS.white },
        callback: (feedback) => {
          const room = this.rooms.get(feedback.options.roomId as string);
          return room ? room.mode !== 'off' : false;
        },
      },
      channel_talking: {
        type: 'boolean',
        name: 'Channel Talking (Anyone)',
        description: 'True when any user is currently talking on this channel.',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        defaultStyle: { bgcolor: COLORS.theyTalk, color: COLORS.white },
        callback: (feedback) => {
          const room = this.rooms.get(feedback.options.roomId as string);
          return room ? room.talkingUsers.length > 0 : false;
        },
      },
      channel_my_talk: {
        type: 'boolean',
        name: 'Channel My Talk',
        description: 'True when the desktop user is currently talking on this channel.',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        defaultStyle: { bgcolor: COLORS.myTalk, color: COLORS.black },
        callback: (feedback) => {
          const room = this.rooms.get(feedback.options.roomId as string);
          return room ? room.talking : false;
        },
      },
      channel_listening: {
        type: 'boolean',
        name: 'Channel Listening',
        description: 'True when the desktop user is in listen mode on this channel.',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        defaultStyle: { bgcolor: COLORS.listening, color: COLORS.white },
        callback: (feedback) => {
          const room = this.rooms.get(feedback.options.roomId as string);
          return room ? room.listening && !room.talking : false;
        },
      },
      channel_latched: {
        type: 'boolean',
        name: 'Channel Latched',
        description: 'True when this channel is latched (always-on talk).',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        defaultStyle: { bgcolor: COLORS.latched, color: COLORS.white },
        callback: (feedback) => {
          const room = this.rooms.get(feedback.options.roomId as string);
          return room ? room.latched : false;
        },
      },
      any_talking: {
        type: 'boolean',
        name: 'Anyone Talking (Any Channel)',
        description: 'True when at least one user is talking on any channel.',
        options: [],
        defaultStyle: { bgcolor: COLORS.anyTalking, color: COLORS.white },
        callback: () => {
          for (const room of this.rooms.values()) {
            if (room.talkingUsers.length > 0) return true;
          }
          return false;
        },
      },
      channel_solo: {
        type: 'boolean',
        name: 'Channel Soloed',
        description: 'True when this channel is currently soloed.',
        options: [{ type: 'dropdown', id: 'roomId', label: 'Channel', choices: roomChoices, default: roomChoices[0]?.id ?? '' }],
        defaultStyle: { bgcolor: COLORS.solo, color: COLORS.black },
        callback: (feedback) => {
          return this.soloRoomId === (feedback.options.roomId as string);
        },
      },
      global_mute: {
        type: 'boolean',
        name: 'Master Mic Muted',
        description: 'True when the master mic is muted on this workstation.',
        options: [],
        defaultStyle: { bgcolor: COLORS.muted, color: COLORS.white },
        callback: () => this.globalMute,
      },
      sidetone_active: {
        type: 'boolean',
        name: 'Sidetone Active',
        description: 'True when sidetone volume is above zero.',
        options: [],
        defaultStyle: { bgcolor: COLORS.sidetone, color: COLORS.white },
        callback: () => this.sidetoneVolume > 0,
      },
      mix_muted: {
        type: 'boolean',
        name: 'Master Volume Muted',
        description: 'True when the master mix volume is muted (zero).',
        options: [],
        defaultStyle: { bgcolor: COLORS.muted, color: COLORS.white },
        callback: () => this.mixVolume === 0,
      },
      volume_display: {
        type: 'advanced',
        name: 'Volume Display Overlay',
        description: 'Temporarily shows volume percentage when adjusting with rotary encoder or volume buttons.',
        options: [{ type: 'textinput', id: 'target', label: 'Volume Target', default: '' }],
        callback: (feedback) => {
          const target = feedback.options.target as string;
          if (this.volumeDisplayTarget !== target) return {};
          let vol: number;
          if (target === 'mix') vol = this.mixVolume;
          else if (target === 'sidetone') vol = this.sidetoneVolume;
          else if (target.startsWith('channel:')) vol = this.channelVolumes.get(target.replace('channel:', '')) ?? 1;
          else if (target.startsWith('aux:')) {
            const aux = this.auxChannels.get(target.replace('aux:', ''));
            vol = aux?.volume ?? 0.75;
          }
          else return {};
          return { text: `${Math.round(vol * 100)}%`, size: '30' };
        },
      },

      // ── Aux Channel Feedbacks ──
      aux_active: {
        type: 'boolean',
        name: 'Aux Channel Active (Listening)',
        description: 'True when listening to this aux channel.',
        options: [{ type: 'dropdown', id: 'channelId', label: 'Aux Channel', choices: auxChoices.length > 0 ? auxChoices : [{ id: '', label: 'No aux channels' }], default: auxChoices[0]?.id ?? '' }],
        defaultStyle: { bgcolor: COLORS.listening, color: COLORS.white },
        callback: (feedback) => {
          const aux = this.auxChannels.get(feedback.options.channelId as string);
          return aux ? aux.active : false;
        },
      },
      aux_muted: {
        type: 'boolean',
        name: 'Aux Channel Muted',
        description: 'True when this aux channel is muted.',
        options: [{ type: 'dropdown', id: 'channelId', label: 'Aux Channel', choices: auxChoices.length > 0 ? auxChoices : [{ id: '', label: 'No aux channels' }], default: auxChoices[0]?.id ?? '' }],
        defaultStyle: { bgcolor: COLORS.muted, color: COLORS.white },
        callback: (feedback) => {
          const aux = this.auxChannels.get(feedback.options.channelId as string);
          return aux ? aux.muted : false;
        },
      },
    });
  }

  // ─── Variables ─────────────────────────────────────────────────────────────

  private setupVariables(): void {
    const defs: CompanionVariableDefinitions = {
      connected: { name: 'Workstation Client Connected' },
      user_name: { name: 'Current User Name' },
      all_talkers: { name: 'All Active Talkers' },
      active_room_count: { name: 'Active Channel Count' },
      global_mute: { name: 'Master Mic Muted' },
      solo_channel: { name: 'Soloed Channel Name' },
      sidetone_volume: { name: 'Sidetone Volume' },
      mix_volume: { name: 'Mix Volume' },
    };
    for (const r of this.rooms.values()) {
      defs[`${r.id}_name`] = { name: `${r.name} — Channel Name` };
      defs[`${r.id}_talkers`] = { name: `${r.name} — Active Talker Count` };
      defs[`${r.id}_talker_names`] = { name: `${r.name} — Active Talker Names` };
      defs[`${r.id}_mode`] = { name: `${r.name} — Mode` };
      defs[`${r.id}_solo`] = { name: `${r.name} — Soloed` };
      defs[`${r.id}_volume`] = { name: `${r.name} — Volume` };
    }
    for (const a of this.auxChannels.values()) {
      defs[`aux_${a.id}_name`] = { name: `${a.name} — Aux Name` };
      defs[`aux_${a.id}_active`] = { name: `${a.name} — Aux Active` };
      defs[`aux_${a.id}_volume`] = { name: `${a.name} — Aux Volume` };
      defs[`aux_${a.id}_muted`] = { name: `${a.name} — Aux Muted` };
    }
    this.setVariableDefinitions(defs);
    this.updateVariableValues();
  }

  private updateVariableValues(): void {
    const soloRoom = this.soloRoomId ? this.rooms.get(this.soloRoomId) : null;

    const values: Record<string, string | number> = {
      connected: this.clientConnected ? 'true' : 'false',
      user_name: this.clientUserName || '',
      active_room_count: [...this.rooms.values()].filter(r => r.mode !== 'off').length,
      global_mute: this.globalMute ? 'true' : 'false',
      solo_channel: soloRoom?.name || '',
      sidetone_volume: Math.round(this.sidetoneVolume * 100),
      mix_volume: Math.round(this.mixVolume * 100),
    };
    const allTalkers: string[] = [];
    for (const room of this.rooms.values()) {
      values[`${room.id}_name`] = room.name;
      values[`${room.id}_talkers`] = room.talkingUsers.length;
      values[`${room.id}_talker_names`] = room.talkingNames.join(', ');
      values[`${room.id}_mode`] = room.mode;
      values[`${room.id}_solo`] = this.soloRoomId === room.id ? 'true' : 'false';
      values[`${room.id}_volume`] = Math.round((this.channelVolumes.get(room.id) ?? 1) * 100);
      allTalkers.push(...room.talkingNames);
    }
    values['all_talkers'] = [...new Set(allTalkers)].join(', ');
    for (const aux of this.auxChannels.values()) {
      values[`aux_${aux.id}_name`] = aux.name;
      values[`aux_${aux.id}_active`] = aux.active ? 'true' : 'false';
      values[`aux_${aux.id}_volume`] = Math.round(aux.volume * 100);
      values[`aux_${aux.id}_muted`] = aux.muted ? 'true' : 'false';
    }
    this.setVariableValues(values);
  }

  // ─── Presets ───────────────────────────────────────────────────────────────

  private setupPresets(): void {
    const presets: CompanionPresetDefinitions = {};
    const sectionEntries = new Map<string, { name: string; ids: string[] }>();
    const addToSection = (sectionId: string, sectionName: string, presetId: string): void => {
      let entry = sectionEntries.get(sectionId);
      if (!entry) { entry = { name: sectionName, ids: [] }; sectionEntries.set(sectionId, entry); }
      entry.ids.push(presetId);
    };

    for (const room of this.rooms.values()) {
      const darkBg = darkenHex(room.color, 0.25);
      const n = room.name;

      // ── Main Channel Combos (Smart: double-tap=listen, tap=latch, hold=PTT) ──
      // Three visual states via bg color + icons + png64 border:
      //   Inactive:           dark bg, no icons
      //   Listening:          bold channel color bg, 🔊 icon
      //   Talking:            bold channel color bg, 🔊🎤 icons, white border overlay
      const boldBg = hexToInt(room.color);
      const comboKey = `combo_${room.id}`;
      addToSection('main-combos', 'Main Channel Combos', comboKey);
      presets[comboKey] = {
        type: 'simple', name: `${n}`,
        style: { text: n, size: '14', color: COLORS.white, bgcolor: darkBg },
        steps: [{
          down: [{ actionId: 'channel_combo_down', options: { roomId: room.id } }],
          up: [{ actionId: 'channel_combo_up', options: { roomId: room.id } }],
          rotate_left: [{ actionId: 'volume_down', options: { target: `channel:${room.id}` } }],
          rotate_right: [{ actionId: 'volume_up', options: { target: `channel:${room.id}` } }],
        }],
        feedbacks: [
          // Listening — bold channel color + speaker icon
          { feedbackId: 'channel_listening', options: { roomId: room.id }, style: { text: `🔊\n${n}`, size: '18', bgcolor: boldBg } },
          // Latched — bold color + speaker + mic + white border
          { feedbackId: 'channel_latched', options: { roomId: room.id }, style: { text: `🔊🎤\n${n}`, size: '18', bgcolor: boldBg, png64: TALK_BORDER_PNG64 } },
          // My talk (PTT) — bold color + speaker + mic + white border
          { feedbackId: 'channel_my_talk', options: { roomId: room.id }, style: { text: `🔊🎤\n${n}`, size: '18', bgcolor: boldBg, png64: TALK_BORDER_PNG64 } },
          // Volume overlay (last = highest priority)
          { feedbackId: 'volume_display', options: { target: `channel:${room.id}` } },
        ],
      };

      // ── Channel Talk (tap=latch toggle, hold=PTT) ──
      // 🎤 appears when talk is active, disappears when not
      const talkKey = `talk_${room.id}`;
      addToSection('channel-talk', 'Channel Talk', talkKey);
      presets[talkKey] = {
        type: 'simple', name: `Talk — ${n}`,
        style: { text: `${n}\nTALK`, size: '14', color: COLORS.white, bgcolor: COLORS.inactive },
        steps: [{
          down: [{ actionId: 'channel_talk_down', options: { roomId: room.id } }],
          up: [{ actionId: 'channel_talk_up', options: { roomId: room.id } }],
        }],
        feedbacks: [
          { feedbackId: 'channel_latched', options: { roomId: room.id }, style: { text: `🎤\n${n}`, size: '18' } },
          { feedbackId: 'channel_my_talk', options: { roomId: room.id }, style: { text: `🎤\n${n}`, size: '18' } },
        ],
      };

      // ── Channel Talk PTT (pure push-to-talk) ──
      const pttKey = `ptt_${room.id}`;
      addToSection('channel-ptt', 'Channel Talk PTT', pttKey);
      presets[pttKey] = {
        type: 'simple', name: `PTT — ${n}`,
        style: { text: `${n}\nPTT`, size: '14', color: COLORS.white, bgcolor: COLORS.inactive },
        steps: [{
          down: [{ actionId: 'talk', options: { roomId: room.id } }],
          up: [{ actionId: 'talk_stop', options: { roomId: room.id } }],
        }],
        feedbacks: [
          { feedbackId: 'channel_my_talk', options: { roomId: room.id }, style: { text: `🎤\n${n}`, size: '18' } },
        ],
      };

      // ── Channel Listen Latch (toggle on/off) ──
      const listenKey = `listen_${room.id}`;
      addToSection('channel-listen', 'Channel Listen', listenKey);
      presets[listenKey] = {
        type: 'simple', name: `Listen — ${n}`,
        style: { text: `${n}\nLISTEN`, size: '14', color: COLORS.white, bgcolor: COLORS.inactive },
        steps: [{
          down: [{ actionId: 'listen_toggle', options: { roomId: room.id } }],
          up: [],
        }],
        feedbacks: [
          { feedbackId: 'channel_listening', options: { roomId: room.id }, style: { text: `🔊\n${n}`, size: '18' } },
        ],
      };

      // ── Channel Listen PTL (Push to Listen) ──
      const ptlKey = `ptl_${room.id}`;
      addToSection('channel-ptl', 'Channel Listen PTL', ptlKey);
      presets[ptlKey] = {
        type: 'simple', name: `PTL — ${n}`,
        style: { text: `${n}\nPTL`, size: '14', color: COLORS.white, bgcolor: COLORS.inactive },
        steps: [{
          down: [{ actionId: 'listen_start', options: { roomId: room.id } }],
          up: [{ actionId: 'listen_stop', options: { roomId: room.id } }],
        }],
        feedbacks: [
          { feedbackId: 'channel_listening', options: { roomId: room.id }, style: { text: `🔊\n${n}`, size: '18' } },
        ],
      };

      // ── Solo ──
      const soloKey = `solo_${room.id}`;
      addToSection('solo-channels', 'Solo Channels', soloKey);
      presets[soloKey] = {
        type: 'simple', name: `Solo — ${n}`,
        style: { text: `${n}\nSOLO`, size: '14', color: COLORS.white, bgcolor: COLORS.inactive },
        steps: [{
          down: [{ actionId: 'solo_toggle', options: { roomId: room.id } }],
          up: [],
        }],
        feedbacks: [
          { feedbackId: 'channel_solo', options: { roomId: room.id }, style: { text: `⭐\n${n}`, bgcolor: COLORS.solo, color: COLORS.black } },
        ],
      };
    }

    // ── Global Controls ──
    // Consistent styling: mid green when ON, black when OFF.

    const globalOn = 0x2d8f2d;  // mid green for all ON states
    const globalOff = COLORS.black;

    // Master Mic — 🎤 shown when unmuted
    // NOTE: global_mute feedback = true when MUTED, so default style = ON state
    addToSection('global-controls', 'Global Controls', 'global_mic_mute');
    presets['global_mic_mute'] = {
      type: 'simple', name: 'Master Mic',
      style: { text: '🎤\nMIC ON', size: '14', color: COLORS.white, bgcolor: globalOn },
      steps: [{ down: [{ actionId: 'global_mute_toggle', options: {} }], up: [] }],
      feedbacks: [
        { feedbackId: 'global_mute', options: {}, style: { text: 'MIC\nOFF', bgcolor: globalOff, color: COLORS.white } },
      ],
    };

    // Master Volume — 🔊 shown when unmuted
    // NOTE: mix_muted feedback = true when volume is 0, so default style = ON state
    addToSection('global-controls', 'Global Controls', 'global_master_vol');
    presets['global_master_vol'] = {
      type: 'simple', name: 'Master Volume',
      style: { text: '🔊\nMaster Vol\nON', size: '14', color: COLORS.white, bgcolor: globalOn },
      steps: [{
        down: [{ actionId: 'all_channels_mute', options: {} }],
        up: [],
        rotate_left: [{ actionId: 'volume_down', options: { target: 'mix' } }],
        rotate_right: [{ actionId: 'volume_up', options: { target: 'mix' } }],
      }],
      feedbacks: [
        { feedbackId: 'mix_muted', options: {}, style: { text: 'Master Vol\nOFF', bgcolor: globalOff, color: COLORS.white } },
        { feedbackId: 'volume_display', options: { target: 'mix' } },
      ],
    };

    // Hear Me (Sidetone) — 🎧 shown when active
    // NOTE: sidetone_active feedback = true when volume > 0, so default style = OFF state
    addToSection('global-controls', 'Global Controls', 'global_hear_me');
    presets['global_hear_me'] = {
      type: 'simple', name: 'Hear Me',
      style: { text: 'Hear Me\nOFF', size: '14', color: COLORS.white, bgcolor: globalOff },
      steps: [{
        down: [{ actionId: 'sidetone_mute_toggle', options: {} }],
        up: [],
        rotate_left: [{ actionId: 'volume_down', options: { target: 'sidetone' } }],
        rotate_right: [{ actionId: 'volume_up', options: { target: 'sidetone' } }],
      }],
      feedbacks: [
        { feedbackId: 'sidetone_active', options: {}, style: { text: '🎧\nHear Me\nON', bgcolor: globalOn, color: COLORS.white } },
        { feedbackId: 'volume_display', options: { target: 'sidetone' } },
      ],
    };

    // Workstation Status
    addToSection('global-controls', 'Global Controls', 'global_status');
    presets['global_status'] = {
      type: 'simple', name: 'Workstation Status',
      style: { text: '⚡\nOFFLINE', size: '14', color: COLORS.white, bgcolor: COLORS.wsOffline },
      steps: [{ down: [], up: [] }],
      feedbacks: [
        { feedbackId: 'workstation_connected', options: {}, style: { text: '⚡\nONLINE', bgcolor: COLORS.wsOnline, color: COLORS.white } },
        { feedbackId: 'any_talking', options: {}, style: { text: '🎤\nON AIR', bgcolor: COLORS.anyTalking, color: COLORS.white } },
      ],
    };

    // ── Role Presets ──
    for (const rp of this.rolePresets) {
      const rpKey = `role_preset_${rp.id}`;
      addToSection('role-presets', 'Role Presets', rpKey);
      presets[rpKey] = {
        type: 'simple', name: rp.name,
        style: { text: rp.name, size: '14', color: COLORS.white, bgcolor: 0x1a2f4a },
        steps: [{ down: [{ actionId: 'apply_preset', options: { presetId: rp.id } }], up: [] }],
        feedbacks: [],
      };
    }

    // Build aux channel + volume button presets
    this.buildAuxAndVolumePresets(presets, addToSection);

    const sections: CompanionPresetSection[] = [...sectionEntries.values()].map((s, i) => ({
      id: [...sectionEntries.keys()][i],
      name: s.name,
      definitions: s.ids,
    }));
    this.setPresetDefinitions(sections, presets);
  }

  /**
   * Generate aux channel presets and volume button presets.
   * Called from setupPresets after the main presets are built.
   */
  private buildAuxAndVolumePresets(presets: CompanionPresetDefinitions, addToSection: (sectionId: string, sectionName: string, presetId: string) => void): void {
    // ── Aux Channel Presets ──
    for (const aux of this.auxChannels.values()) {
      const darkBg = darkenHex(aux.color, 0.25);
      const boldBg = hexToInt(aux.color);
      const n = aux.name;

      // Combined Aux On/Off — single button with state feedback + rotary volume
      const auxKey = `aux_${aux.id}`;
      addToSection('aux-channels', 'Aux Channels', auxKey);
      presets[auxKey] = {
        type: 'simple', name: `${n}`,
        style: { text: `${n}\nOFF`, size: '14', color: COLORS.white, bgcolor: darkBg },
        steps: [{
          down: [{ actionId: 'aux_listen_toggle', options: { channelId: aux.id } }],
          up: [],
          rotate_left: [{ actionId: 'volume_down', options: { target: `aux:${aux.id}` } }],
          rotate_right: [{ actionId: 'volume_up', options: { target: `aux:${aux.id}` } }],
        }],
        feedbacks: [
          { feedbackId: 'aux_active', options: { channelId: aux.id }, style: { text: `${n}\nON`, size: '18', bgcolor: boldBg } },
          { feedbackId: 'aux_muted', options: { channelId: aux.id }, style: { text: `${n}\nMUTED`, size: '14', bgcolor: COLORS.inactive } },
          { feedbackId: 'volume_display', options: { target: `aux:${aux.id}` } },
        ],
      };
    }

    // ── Volume Buttons (non-rotary Stream Deck) ──
    // Master Mix volume up/down
    const volBtnBg = 0x1a2f4a;  // consistent dark blue

    addToSection('volume-buttons', 'Volume Buttons', 'vol_btn_mix_up');
    presets['vol_btn_mix_up'] = {
      type: 'simple', name: 'Master Vol ▲',
      style: { text: '🔊 ▲\nMaster', size: '14', color: COLORS.white, bgcolor: volBtnBg },
      steps: [{
        down: [{ actionId: 'vol_btn_up_press', options: { target: 'mix' } }],
        up: [{ actionId: 'vol_btn_up_release', options: { target: 'mix' } }],
      }],
      feedbacks: [
        { feedbackId: 'volume_display', options: { target: 'mix' } },
      ],
    };
    addToSection('volume-buttons', 'Volume Buttons', 'vol_btn_mix_down');
    presets['vol_btn_mix_down'] = {
      type: 'simple', name: 'Master Vol ▼',
      style: { text: '🔊 ▼\nMaster', size: '14', color: COLORS.white, bgcolor: volBtnBg },
      steps: [{
        down: [{ actionId: 'vol_btn_down_press', options: { target: 'mix' } }],
        up: [{ actionId: 'vol_btn_down_release', options: { target: 'mix' } }],
      }],
      feedbacks: [
        { feedbackId: 'volume_display', options: { target: 'mix' } },
      ],
    };

    // Sidetone volume up/down
    addToSection('volume-buttons', 'Volume Buttons', 'vol_btn_sidetone_up');
    presets['vol_btn_sidetone_up'] = {
      type: 'simple', name: 'Sidetone ▲',
      style: { text: '🎧 ▲\nSidetone', size: '14', color: COLORS.white, bgcolor: volBtnBg },
      steps: [{
        down: [{ actionId: 'vol_btn_up_press', options: { target: 'sidetone' } }],
        up: [{ actionId: 'vol_btn_up_release', options: { target: 'sidetone' } }],
      }],
      feedbacks: [
        { feedbackId: 'volume_display', options: { target: 'sidetone' } },
      ],
    };
    addToSection('volume-buttons', 'Volume Buttons', 'vol_btn_sidetone_down');
    presets['vol_btn_sidetone_down'] = {
      type: 'simple', name: 'Sidetone ▼',
      style: { text: '🎧 ▼\nSidetone', size: '14', color: COLORS.white, bgcolor: volBtnBg },
      steps: [{
        down: [{ actionId: 'vol_btn_down_press', options: { target: 'sidetone' } }],
        up: [{ actionId: 'vol_btn_down_release', options: { target: 'sidetone' } }],
      }],
      feedbacks: [
        { feedbackId: 'volume_display', options: { target: 'sidetone' } },
      ],
    };

    // Per-channel volume buttons
    for (const room of this.rooms.values()) {
      const target = `channel:${room.id}`;
      const volUpKey = `vol_btn_ch_up_${room.id}`;
      addToSection('volume-buttons', 'Volume Buttons', volUpKey);
      presets[volUpKey] = {
        type: 'simple', name: `${room.name} ▲`,
        style: { text: `▲\n${room.name}`, size: '14', color: COLORS.white, bgcolor: volBtnBg },
        steps: [{
          down: [{ actionId: 'vol_btn_up_press', options: { target } }],
          up: [{ actionId: 'vol_btn_up_release', options: { target } }],
        }],
        feedbacks: [{ feedbackId: 'volume_display', options: { target } }],
      };
      const volDownKey = `vol_btn_ch_down_${room.id}`;
      addToSection('volume-buttons', 'Volume Buttons', volDownKey);
      presets[volDownKey] = {
        type: 'simple', name: `${room.name} ▼`,
        style: { text: `▼\n${room.name}`, size: '14', color: COLORS.white, bgcolor: volBtnBg },
        steps: [{
          down: [{ actionId: 'vol_btn_down_press', options: { target } }],
          up: [{ actionId: 'vol_btn_down_release', options: { target } }],
        }],
        feedbacks: [{ feedbackId: 'volume_display', options: { target } }],
      };
    }

    // Per-aux volume buttons
    for (const aux of this.auxChannels.values()) {
      const target = `aux:${aux.id}`;
      const auxVolUpKey = `vol_btn_aux_up_${aux.id}`;
      addToSection('volume-buttons', 'Volume Buttons', auxVolUpKey);
      presets[auxVolUpKey] = {
        type: 'simple', name: `${aux.name} ▲`,
        style: { text: `▲\n${aux.name}`, size: '14', color: COLORS.white, bgcolor: volBtnBg },
        steps: [{
          down: [{ actionId: 'vol_btn_up_press', options: { target } }],
          up: [{ actionId: 'vol_btn_up_release', options: { target } }],
        }],
        feedbacks: [{ feedbackId: 'volume_display', options: { target } }],
      };
      const auxVolDownKey = `vol_btn_aux_down_${aux.id}`;
      addToSection('volume-buttons', 'Volume Buttons', auxVolDownKey);
      presets[auxVolDownKey] = {
        type: 'simple', name: `${aux.name} ▼`,
        style: { text: `▼\n${aux.name}`, size: '14', color: COLORS.white, bgcolor: volBtnBg },
        steps: [{
          down: [{ actionId: 'vol_btn_down_press', options: { target } }],
          up: [{ actionId: 'vol_btn_down_release', options: { target } }],
        }],
        feedbacks: [{ feedbackId: 'volume_display', options: { target } }],
      };
    }
  }
}

