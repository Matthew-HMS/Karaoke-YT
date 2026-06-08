"use client";

// Browser-side Socket.IO singleton. One connection per tab, shared across
// components. Connects back to the same origin that served the page.

import { io, Socket } from "socket.io-client";
import { ClientToServerEvents, ServerToClientEvents } from "./types";

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: AppSocket | null = null;

export function getSocket(): AppSocket {
  if (!socket) {
    socket = io({ autoConnect: true, transports: ["websocket", "polling"] });
  }
  return socket;
}
