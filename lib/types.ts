// Shared types used by both the Socket.IO server and the React clients.

export type QueueItem = {
  id: string; // uuid, unique per queue entry
  videoId: string; // YouTube video id
  title: string;
  thumbnail: string;
  durationSec: number;
  singer: string; // name typed by the guest who added it
  addedBy: string; // guest/socket id, so a guest can remove their own song
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
    payload: { code: string; role: "host" | "remote"; name?: string },
    ack?: (state: RoomState | { error: string }) => void
  ) => void;
  "queue:add": (payload: { code: string; item: Omit<QueueItem, "id" | "addedBy"> }) => void;
  "queue:remove": (payload: { code: string; id: string }) => void;
  "queue:reorder": (payload: { code: string; order: string[] }) => void;
  "player:command": (payload: { code: string } & PlayerCommand) => void;
  "player:report": (payload: { code: string; state: PlayerState }) => void;
  "player:ended": (payload: { code: string }) => void;
  // A remote triggers a sound effect; the host (TV) plays it.
  "sfx:play": (payload: { code: string; name: SfxName }) => void;
}

export interface ServerToClientEvents {
  "room:state": (state: RoomState) => void;
  "player:command": (cmd: PlayerCommand) => void;
  "player:state": (state: PlayerState) => void;
  "sfx:play": (payload: { name: SfxName }) => void;
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
