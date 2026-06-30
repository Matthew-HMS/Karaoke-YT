// Shared types used by both the Socket.IO server and the React clients.

// Re-export the pitch sample type so it lives alongside the other socket
// payloads (its detection/scoring logic stays in lib/pitch.ts).
export type { PitchSample } from "./pitch";
import type { PitchSample } from "./pitch";

export type QueueItem = {
  id: string; // uuid, unique per queue entry
  videoId: string; // YouTube video id
  title: string;
  thumbnail: string;
  durationSec: number;
  singer: string; // name typed by the guest who added it
  addedBy: string; // guest/socket id, so a guest can remove their own song
  userId?: string; // signed-in adder's user id, for per-user play counts
};

// ---- Lyrics ----

// One lyric line. For synced lyrics `timeSec` is the line's start time; for
// plain (un-timed) lyrics it's 0 and lines are shown as static scrollable text.
export type LyricLine = { timeSec: number; text: string };

export type LyricsResult = {
  synced: boolean; // true = timed lines (highlight in sync); false = plain text
  lines: LyricLine[];
  source: "lrclib" | "musixmatch";
};

export type PlayerStatus = "playing" | "paused" | "idle";

export type PlayerState = {
  status: PlayerStatus;
  currentTimeSec: number;
  durationSec: number;
};

export type RoomState = {
  code: string;
  queue: QueueItem[];
  nowPlaying: QueueItem | null;
  playerState: PlayerState;
  history: QueueItem[]; // songs already played in THIS room, most-recent first
};

export type PlayerCommand =
  | { cmd: "play" }
  | { cmd: "pause" }
  | { cmd: "skip" }
  | { cmd: "restart" }
  | { cmd: "seek"; valueSec: number };

// ---- Socket.IO event maps (typed both ends) ----

export interface ClientToServerEvents {
  "room:join": (
    payload: {
      code: string;
      role: "host" | "remote";
      name?: string;
      password?: string; // create/co-host/guest all supply it
      create?: boolean; // host only: true = create this room (from the landing
      // "Start a room" flow). Co-hosts and typed URLs leave it false, so an
      // existing room is joined (password-checked) and a missing one is rejected.
    },
    ack?: (state: RoomState | { error: "not_found" | "bad_password" }) => void
  ) => void;
  "queue:add": (payload: { code: string; item: Omit<QueueItem, "id" | "addedBy"> }) => void;
  "queue:remove": (payload: { code: string; id: string }) => void;
  "queue:reorder": (payload: { code: string; order: string[] }) => void;
  "player:command": (payload: { code: string } & PlayerCommand) => void;
  "player:report": (payload: { code: string; state: PlayerState }) => void;
  // itemId = the queue-item id that ended; lets the server ignore duplicate
  // "ended" events from other hosts so the queue only advances once.
  "player:ended": (payload: { code: string; itemId?: string }) => void;
  // A remote triggers a sound effect; the host (TV) plays it.
  "sfx:play": (payload: { code: string; name: SfxName }) => void;
  // A singing remote streams its detected mic pitch ~20x/sec; relayed to the
  // host(s) for the live pitch ribbon + score. Ephemeral — never stored.
  "pitch:report": (payload: { code: string; sample: PitchSample }) => void;
  // Room-wide toggle for the TV's blue "target" pitch line. Relayed to everyone
  // so all hosts obey and other remotes' toggles stay in sync.
  "pitch:showTarget": (payload: { code: string; show: boolean }) => void;
  // Spin the "random singer" wheel. The initiating phone picks the winner +
  // spin amount and ships its name list, so every screen (TV + phones) animates
  // the SAME wheel to the SAME result. `winner` indexes `names`; `turns` is the
  // shared number of full spins so they all land together.
  "wheel:spin": (payload: {
    code: string;
    names: string[];
    winner: number;
    turns: number;
  }) => void;
}

export interface ServerToClientEvents {
  "room:state": (state: RoomState) => void;
  "player:command": (cmd: PlayerCommand) => void;
  "player:state": (state: PlayerState) => void;
  "sfx:play": (payload: { name: SfxName }) => void;
  // Host receives each singer's pitch sample for the ribbon overlay.
  "pitch:sample": (sample: PitchSample) => void;
  // Show/hide the TV's target pitch line (synced room-wide).
  "pitch:showTarget": (payload: { show: boolean }) => void;
  // Animate the random-singer wheel (same payload on every screen).
  "wheel:spin": (payload: {
    names: string[];
    winner: number;
    turns: number;
  }) => void;
}

export const SFX_NAMES = [
  "airhorn",
  "applause",
  "whistle",
  "drumroll",
  "tada",
  "sadtrombone",
] as const;
export type SfxName = (typeof SFX_NAMES)[number];

export const DEFAULT_PLAYER_STATE: PlayerState = {
  status: "idle",
  currentTimeSec: 0,
  durationSec: 0,
};
