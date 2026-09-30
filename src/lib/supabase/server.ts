import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Supabase client for use in Server Components, Route Handlers and Server Actions.
 * Reads/writes the auth cookie via Next's cookies() store.
 *
 * Uses the getAll()/setAll() cookie interface, which is the current
 * @supabase/ssr API — the older per-cookie get()/set()/remove() shape is
 * deprecated and unreliable on recent library versions.
 */
export function createClient() {
  const cookieStore = cookies();

  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component with no writable cookie store —
          // safe to ignore as long as middleware.ts is refreshing sessions.
        }
      },
    },
  });
}

/**
 * Admin client using the service-role key — bypasses Row Level Security.
 * ONLY use this in server-only code (route handlers, webhooks) that has
 * already established who the request is for. Never import this into a
 * Client Component or send its key to the browser.
 */
export function createAdminClient() {
  const { createClient: createSupabaseClient } = require("@supabase/supabase-js");
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
