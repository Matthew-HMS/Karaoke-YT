// Auth.js (NextAuth v5) configuration. Google sign-in, JWT sessions (no DB
// adapter needed — we only need a stable user id + name). `trustHost` lets it
// work behind ngrok/Caddy where the request host isn't localhost.

import NextAuth, { type DefaultSession } from "next-auth";
import Google from "next-auth/providers/google";

// Add `id` to the session user type.
declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers: [Google],
  callbacks: {
    // On sign-in, pin the token to Google's STABLE account id. Without this,
    // the JWT strategy assigns a random token.sub each login, so favorites
    // (keyed by user id) would orphan every time the user signs back in.
    jwt({ token, account }) {
      if (account?.providerAccountId) token.uid = account.providerAccountId;
      return token;
    },
    // Expose that stable id as session.user.id — the key we scope favorites by.
    session({ session, token }) {
      if (session.user && typeof token.uid === "string") {
        session.user.id = token.uid;
      }
      return session;
    },
  },
});
