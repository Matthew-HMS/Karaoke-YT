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
  SfxName,
} from "./types";

type UseRoomOpts = {
  password?: string; // create/co-host/guest credential
  userId?: string; // signed-in user, for per-user play counts
  create?: boolean; // host only: create the room (landing "Start a room" flow)
};

export function useRoom(
  code: string,
  role: "host" | "remote",
  opts: UseRoomOpts = {}
) {
  const { password = "", userId, create = false } = opts;
  const [state, setState] = useState<RoomState | null>(null);
  // The host owns the authoritative player position; remotes receive it via
  // the `player:state` event so the scrub bar can track playback live.
  const [livePlayer, setLivePlayer] = useState<PlayerState | null>(null);
  const [connected, setConnected] = useState(false);
  // null = not yet resolved; true = joined; "not_found"/"bad_password" = rejected.
  const [joinError, setJoinError] = useState<
    null | "not_found" | "bad_password"
  >(null);
  const [joined, setJoined] = useState(false);
  const socketRef = useRef(getSocket());
  // Each join attempt gets a sequence number. Several joins can be in flight at
  // once (the initial empty-password auto-join, reconnect re-joins, and each
  // password the guest tries), and their acks can arrive out of order. We only
  // apply the ack from the LATEST attempt — otherwise a slow "bad_password" ack
  // from an earlier try can clobber a later successful one (flashing "Incorrect
  // password" even though you got in).
  const joinSeqRef = useRef(0);

  useEffect(() => {
    const socket = socketRef.current;

    const join = () => {
      setConnected(true);
      const seq = ++joinSeqRef.current;
      // Clear any stale error from a previous attempt so the gate doesn't flash
      // "incorrect" while this new attempt (e.g. the correct password) is still
      // in flight. The ack below sets the real result.
      setJoinError(null);
      socket.emit("room:join", { code, role, password, create }, (res) => {
        if (seq !== joinSeqRef.current) return; // superseded by a newer attempt
        if (res && "error" in res) {
          setJoinError(res.error);
          setJoined(false);
        } else {
          setJoinError(null);
          setJoined(true);
        }
      });
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
  }, [code, role, password, create]);

  const socket = socketRef.current;

  return {
    state,
    livePlayer,
    connected,
    joined,
    joinError,
    addSong: (item: Omit<QueueItem, "id" | "addedBy">) =>
      socket.emit("queue:add", {
        code,
        item: userId ? { ...item, userId } : item,
      }),
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
    notifyEnded: (itemId?: string) =>
      socket.emit("player:ended", { code, itemId }),
    sendSfx: (name: SfxName) => socket.emit("sfx:play", { code, name }),
  };
}
