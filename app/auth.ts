/**
 * NextAuth v5 (Auth.js) configuration — Google OAuth, JWT sessions, user provisioning.
 *
 * Google OAuth setup:
 * 1. Go to https://console.cloud.google.com
 * 2. Create a new project or select an existing one
 * 3. Navigate to APIs & Services → Credentials
 * 4. Create OAuth 2.0 Client ID (Web application type)
 * 5. Add authorized redirect URI: http://localhost:3000/api/auth/callback/google
 * 6. Copy Client ID and Client Secret into .env.local as GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 */

import type { DefaultSession } from "next-auth"
import NextAuth from "next-auth"
import Google from "next-auth/providers/google"
import Credentials from "next-auth/providers/credentials"
import { eq } from "drizzle-orm"
import { authConfig } from "./auth.config"
import { createUser, getUserByEmail } from "@/lib/db/queries/users"
import { db } from "@/lib/db/client"
import { users } from "@/lib/db/schema"

const demoEmailUser = "demo@oikosrecall.app"

declare module "next-auth" {
  interface Session {
    user: {
      id: string
      isGuest?: boolean
    } & DefaultSession["user"]
  }
}

function splitName(fullName: string | null | undefined): {
  first_name: string | undefined
  last_name: string | undefined
} {
  if (!fullName) return { first_name: undefined, last_name: undefined }
  const parts = fullName.trim().split(/\s+/)
  const first_name = parts[0]
  const last_name = parts.length > 1 ? parts.slice(1).join(" ") : undefined
  return { first_name, last_name }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    Credentials({
      id: "guest",
      name: "Guest",
      credentials: {},
      async authorize() {
        // Real id is resolved from the DB by email in the jwt callback below — this placeholder
        // is never used as a foreign key anywhere (signIn/jwt only ever read user.email), so it
        // doesn't need to match any real row.
        return {
          id: "guest",
          email: demoEmailUser,
          name: "Demo User",
        }
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,

    async signIn({ user }) {
      if (!user.email) return false
      const existing = await getUserByEmail(user.email)
      const { first_name, last_name } = splitName(user.name)
      if (!existing) {
        await createUser({
          email: user.email,
          first_name: first_name ?? user.email.split("@")[0],
          last_name,
          country_code: "IN",
          currency: "INR",
        })
      } else if (!existing.first_name && first_name) {
        await db.update(users)
          .set({ first_name, last_name })
          .where(eq(users.id, existing.id))
      }
      return true
    },

    // Runs on sign-in (user populated) and on every JWT refresh (user undefined). Always
    // resolves the real user id by email — including for the guest user — rather than trusting a
    // separately-configured id (an env var previously had to be kept in sync with whatever UUID
    // the demo user row happened to get on creation, which is exactly the kind of thing that
    // silently drifts: unset or mismatched, it produced a "logged in" session with an id that
    // matched no real row, so every downstream `if (!session?.user?.id)` check — an empty string
    // still passes that check — 401'd instead of failing loudly). The signIn callback above
    // guarantees a row with this email exists (creates it if missing) before this ever runs.
    async jwt({ token, user }) {
      if (user?.email) {
        const dbUser = await getUserByEmail(user.email)
        if (dbUser) token["userId"] = dbUser.id
        if (user.email === demoEmailUser) {
          token["isGuest"] = true
        }
      }
      return token
    },

    async session({ session, token }) {
      if (typeof token["userId"] === "string") {
        session.user.id = token["userId"]
      }
      if (token["isGuest"]) {
        session.user.isGuest = true
      }
      return session
    },
  },
})
