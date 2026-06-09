"use client";

// Hook that joins a room over Socket.IO and tracks its live state. Used by both
// the host screen and the phone remote. Returns the room state plus typed
// helpers to mutate the queue and send player commands.

import { useEffect, useRef, useState } from "react";
import { getSocket } from "./socket";
import {
  PlayerCommand,
  PlayerState,
  QueueItem,
  RoomState,
} from "./types";

export function useRoom(code: string, role: "host" | "remote", name?: string) {
  const [state, setState] = useState<RoomState | null>(null);
  // The host owns the authoritative player position; remotes receive it via
  // the `player:state` event so the scrub bar can track playback live.
  const [livePlayer, setLivePlayer] = useState<PlayerState | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(getSocket());

  useEffect(() => {
    const socket = socketRef.current;

    const join = () => {
      setConnected(true);
      socket.emit("room:join", { code, role, name });
    };

    socket.on("connect", join);
    socket.on("disconnect", () => setConnected(false));
    socket.on("room:state", (s) => {
      setState(s);
      setLivePlayer(s.playerState);
    });
    socket.on("player:state", (p) => setLivePlayer(p));

    if (socket.connected) join();

    return () => {
      socket.off("connect", join);
      socket.off("disconnect");
      socket.off("room:state");
      socket.off("player:state");
    };
  }, [code, role, name]);

  const socket = socketRef.current;

  return {
    state,
    livePlayer,
    connected,
    addSong: (item: Omit<QueueItem, "id" | "addedBy">) =>
      socket.emit("queue:add", { code, item }),
    removeSong: (id: string) => socket.emit("queue:remove", { code, id }),
    reorder: (order: string[]) => socket.emit("queue:reorder", { code, order }),
    sendCommand: (cmd: PlayerCommand) =>
      socket.emit("player:command", { code, ...cmd }),
    reportState: (s: PlayerState) => {
      // The server relays player:state to *other* clients, so the host never
      // hears its own reports — update our local copy directly so the host's
      // own progress bar advances too.
      setLivePlayer(s);
      socket.emit("player:report", { code, state: s });
    },
    notifyEnded: () => socket.emit("player:ended", { code }),
  };
}
