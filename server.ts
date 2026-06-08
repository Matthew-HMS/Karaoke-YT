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
  getOrCreateRoom,
  getRoom,
  removeFromQueue,
  reorderQueue,
  setPlayerState,
  toRoomState,
} from "./lib/rooms";
import { logPlay } from "./lib/db";
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

  // Record a play to history when a different song becomes now-playing.
  const logIfNewSong = (prevId: string | undefined, current: QueueItem | null) => {
    if (current && current.id !== prevId) {
      logPlay(
        {
          videoId: current.videoId,
          title: current.title,
          thumbnail: current.thumbnail,
          durationSec: current.durationSec,
        },
        current.singer
      );
    }
  };

  io.on("connection", (socket) => {
    let joinedCode: string | null = null;

    socket.on("room:join", ({ code, role }, ack) => {
      const room = getOrCreateRoom(code);
      joinedCode = code;
      socket.join(code);
      if (role === "host") room.hostSocketId = socket.id;
      const state = toRoomState(room);
      ack?.(state);
      socket.emit("room:state", state);
    });

    socket.on("queue:add", ({ code, item }) => {
      const room = getRoom(code);
      if (!room) return;
      const prevId = room.nowPlaying?.id;
      addToQueue(room, item, socket.id);
      logIfNewSong(prevId, room.nowPlaying);
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
          logIfNewSong(prevId, room.nowPlaying);
        }
        broadcastState(code);
      }
      // Always relay to the host so it can act on the iframe.
      if (room.hostSocketId) io.to(room.hostSocketId).emit("player:command", cmd);
    });

    // Host → everyone: report real playback position for the live scrub bar.
    socket.on("player:report", ({ code, state }) => {
      const room = getRoom(code);
      if (!room) return;
      setPlayerState(room, state);
      socket.to(code).emit("player:state", state);
    });

    // Host: current video ended → advance the queue and resync.
    socket.on("player:ended", ({ code }) => {
      const room = getRoom(code);
      if (!room) return;
      const prevId = room.nowPlaying?.id;
      advanceQueue(room);
      logIfNewSong(prevId, room.nowPlaying);
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
