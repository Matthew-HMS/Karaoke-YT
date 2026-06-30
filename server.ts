// Custom server: wraps the Next.js request handler and attaches a Socket.IO
// server for real-time room sync. Run with `tsx server.ts` (see package.json).
//
// Serverless hosts can't hold WebSocket connections, which is why we run this
// as a single long-lived Node process (on a VM, under systemd). All live room
// state is held in memory here (lib/rooms.ts).

import dns from "node:dns";
import { createServer } from "http";
import next from "next";

// Prefer IPv4 when resolving outbound hosts. On some networks (notably macOS),
// Node/undici otherwise tries an unreachable IPv6 address first and stalls until
// the request times out — even though `curl` works fine. This was causing the
// lyrics provider fetches (lrclib.net) to time out. Set once for the process.
dns.setDefaultResultOrder("ipv4first");
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
  reapIdleRooms,
  removeFromQueue,
  reorderQueue,
  setPlayerState,
  toRoomState,
  touchRoom,
} from "./lib/rooms";
import { recordPlay } from "./lib/db";
import { ensureContour } from "./lib/reference";
import type { QueueItem } from "./lib/types";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    // Liveness/readiness probe for Kubernetes. We're inside app.prepare()'s
    // resolution, so Next is ready by the time this server is listening.
    if (req.url === "/healthz") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("ok");
      return;
    }
    handle(req, res);
  });

  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(
    httpServer,
    { cors: { origin: true } }
  );

  // Broadcast the full room state to everyone in the room (hosts + remotes).
  // Any state change counts as activity, so refresh the idle timer too.
  const broadcastState = (code: string) => {
    const room = getRoom(code);
    if (room) {
      touchRoom(room);
      io.to(code).emit("room:state", toRoomState(room));
    }
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
      touchRoom(room);
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
      // Pre-warm the pitch-reference contour while the song waits in the queue,
      // so the karaoke target line is ready by the time it plays (cached after).
      ensureContour(item.videoId);
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

    // A singing remote streams mic pitch ~20x/sec → relay to the other clients
    // (the host renders the ribbon). Deliberately does NOT touch room state or
    // refresh the idle timer: it's high-frequency and ephemeral, so we keep it
    // off the room:state broadcast path entirely.
    // Broadcast to EVERYONE in the room incl. the sender, so a host that's also
    // a singer (phone-as-host) sees its own pitch on its own ribbon — the host
    // is where the ribbon renders, so it must receive its own samples too.
    socket.on("pitch:report", ({ code, sample }) => {
      io.to(code).emit("pitch:sample", sample);
    });

    // Room-wide "show target line" toggle → relay to everyone (hosts obey it,
    // other remotes mirror the switch). Low-frequency, no room-state storage.
    socket.on("pitch:showTarget", ({ code, show }) => {
      io.to(code).emit("pitch:showTarget", { show });
    });

    // Random-singer wheel → relay the spin to EVERYONE (incl. the sender) so the
    // TV and every phone animate the identical wheel and land on the same name.
    socket.on("wheel:spin", ({ code, names, winner, turns }) => {
      if (!Array.isArray(names) || names.length < 2) return;
      io.to(code).emit("wheel:spin", { names, winner, turns });
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
        if (room) {
          if (room.hostSocketId === socket.id) room.hostSocketId = null;
          // Start the idle clock from when a client leaves, so the 3-day TTL is
          // measured from the room actually going quiet.
          touchRoom(room);
        }
      }
    });
  });

  httpServer.listen(port, () => {
    console.log(`> SingAlong ready on http://${hostname}:${port}`);
  });

  // Reap abandoned rooms so the in-memory store doesn't grow without bound.
  // Once a day, drop any room that has no connected clients and hasn't seen
  // activity in over 3 days. (Rooms in active use are never touched.)
  const ROOM_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
  const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
  const hasClients = (code: string) =>
    (io.sockets.adapter.rooms.get(code)?.size ?? 0) > 0;
  const sweepTimer = setInterval(() => {
    const removed = reapIdleRooms(ROOM_TTL_MS, hasClients);
    if (removed.length) {
      console.log(`> reaped ${removed.length} idle room(s): ${removed.join(", ")}`);
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref(); // don't keep the process alive just for the sweep

  // Kubernetes sends SIGTERM before killing the pod (deploys, scale-down,
  // node drain). Close Socket.IO (disconnecting clients cleanly) and the HTTP
  // server so in-flight requests finish, then exit. A timeout forces exit if
  // something hangs, so a wedged shutdown can't block the rollout.
  const shutdown = (signal: string) => {
    console.log(`> ${signal} received — shutting down`);
    clearInterval(sweepTimer);
    io.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
});
