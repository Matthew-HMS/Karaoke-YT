// Custom server: wraps the Next.js request handler and attaches a Socket.IO
// server for real-time room sync. Run with `tsx server.ts` (see package.json).
//
// Serverless hosts can't hold WebSocket connections, which is why we run this
// as a single long-lived Node process (on a VM, under systemd). All live room
// state is held in memory here (lib/rooms.ts).

import { createServer } from "http";
import next from "next";
import { Server as SocketIOServer } from "socket.io";
import {
  ClientToServerEvents,
  ServerToClientEvents,
} from "./lib/types";
import {
  addToQueue,
  advanceQueue,
  createRoom,
  getRoom,
  removeFromQueue,
  reorderQueue,
  setPlayerState,
  toRoomState,
} from "./lib/rooms";
import { recordPlay } from "./lib/db";
import type { QueueItem } from "./lib/types";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer((req, res) => handle(req, res));

  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(
    httpServer,
    { cors: { origin: true } }
  );

  // Broadcast the full room state to everyone in the room (hosts + remotes).
  const broadcastState = (code: string) => {
    const room = getRoom(code);
    if (room) io.to(code).emit("room:state", toRoomState(room));
  };

  // When a different song becomes now-playing, count a play for the signed-in
  // user who queued it (powers the Favorites "play times" sort).
  const recordIfNewSong = (
    prevId: string | undefined,
    current: QueueItem | null
  ) => {
    if (current && current.id !== prevId && current.userId) {
      recordPlay(current.userId, current.videoId);
    }
  };


  io.on("connection", (socket) => {
    let joinedCode: string | null = null;

    socket.on("room:join", ({ code, role, password, create }, ack) => {
      let room = getRoom(code);
      if (role === "host") {
        if (!room) {
          // Only the creator (landing "Start a room" flow) may make a room.
          // A typed/unknown host URL is just "room not found".
          if (!create) {
            ack?.({ error: "not_found" });
            return;
          }
          room = createRoom(code, password ?? "");
        } else if (room.password && password !== room.password) {
          // Co-hosting an existing room needs its password — and we never let a
          // co-host overwrite the password the room was created with.
          ack?.({ error: "bad_password" });
          return;
        }
        room.hostSocketId = socket.id;
      } else {
        // A guest must join an EXISTING room with the correct password.
        if (!room) {
          ack?.({ error: "not_found" });
          return;
        }
        if (room.password && password !== room.password) {
          ack?.({ error: "bad_password" });
          return;
        }
      }
      joinedCode = code;
      socket.join(code);
      const state = toRoomState(room);
      ack?.(state);
      socket.emit("room:state", state);
    });

    socket.on("queue:add", ({ code, item }) => {
      const room = getRoom(code);
      if (!room) return;
      const prevId = room.nowPlaying?.id;
      addToQueue(room, item, socket.id);
      recordIfNewSong(prevId, room.nowPlaying);
      broadcastState(code);
    });

    socket.on("queue:remove", ({ code, id }) => {
      const room = getRoom(code);
      if (!room) return;
      removeFromQueue(room, id);
      broadcastState(code);
    });

    socket.on("queue:reorder", ({ code, order }) => {
      const room = getRoom(code);
      if (!room) return;
      reorderQueue(room, order);
      broadcastState(code);
    });

    // Remote → host: relay a transport command to the host iframe.
    socket.on("player:command", ({ code, ...cmd }) => {
      const room = getRoom(code);
      if (!room) return;
      if (cmd.cmd === "skip" || cmd.cmd === "restart") {
        if (cmd.cmd === "skip") {
          const prevId = room.nowPlaying?.id;
          advanceQueue(room);
          recordIfNewSong(prevId, room.nowPlaying);
        }
        broadcastState(code);
      }
      // Relay to EVERY host in the room (a room can have several host screens
      // open) so they all act on the command and stay in sync. Remotes have no
      // player and ignore it.
      io.to(code).emit("player:command", cmd);
    });

    // Host → everyone: report real playback position for the live scrub bar.
    socket.on("player:report", ({ code, state }) => {
      const room = getRoom(code);
      if (!room) return;
      setPlayerState(room, state);
      socket.to(code).emit("player:state", state);
    });

    // A remote triggered a sound effect → relay to the room so the host (TV)
    // plays it. (Broadcast to everyone in the room; only the host page acts.)
    socket.on("sfx:play", ({ code, name }) => {
      io.to(code).emit("sfx:play", { name });
    });

    // Host: current video ended → advance the queue and resync. With multiple
    // host screens, each fires "ended" for the same song; only advance once by
    // ignoring events whose itemId no longer matches the current song.
    socket.on("player:ended", ({ code, itemId }) => {
      const room = getRoom(code);
      if (!room) return;
      if (itemId && room.nowPlaying && room.nowPlaying.id !== itemId) return;
      const prevId = room.nowPlaying?.id;
      advanceQueue(room);
      recordIfNewSong(prevId, room.nowPlaying);
      broadcastState(code);
    });

    socket.on("disconnect", () => {
      if (joinedCode) {
        const room = getRoom(joinedCode);
        if (room && room.hostSocketId === socket.id) room.hostSocketId = null;
      }
    });
  });

  httpServer.listen(port, () => {
    console.log(`> SingAlong ready on http://${hostname}:${port}`);
  });
});
