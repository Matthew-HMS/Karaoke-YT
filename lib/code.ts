// Pure room-code helpers, safe to import on the client (no server state).
// Must use the same alphabet as the server's generateRoomCode (lib/rooms.ts).

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateClientCode(): string {
  return Array.from(
    { length: 4 },
    () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  ).join("");
}

// Normalize user-typed codes: uppercase, strip anything not in the alphabet.
export function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .split("")
    .filter((c) => CODE_CHARS.includes(c))
    .join("")
    .slice(0, 4);
}

export function isValidCode(code: string): boolean {
  return /^[A-HJ-NP-Z2-9]{4}$/.test(code);
}

// Passwords are user-typed, so allow the FULL alphabet incl. 0/1/I/O.
export function normalizePassword(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 4);
}

export function isValidPassword(pw: string): boolean {
  return /^[A-Z0-9]{4}$/.test(pw);
}
