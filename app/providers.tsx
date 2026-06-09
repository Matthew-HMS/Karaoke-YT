"use client";

// Wraps the app in Auth.js's SessionProvider so client components can call
// useSession()/signIn()/signOut().

import { SessionProvider } from "next-auth/react";

export function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
