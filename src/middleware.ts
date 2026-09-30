import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Runs on every request. Keeps the Supabase auth session cookie fresh, and
 * gates /dashboard behind login. Subscription-status gating (paid vs not)
 * happens inside the dashboard layout itself, not here, so a lapsed
 * subscriber still gets a clear "reactivate" screen instead of a dead end.
 *
 * Uses the getAll()/setAll() cookie interface, which is the current
 * @supabase/ssr API — the older per-cookie get()/set()/remove() shape is
 * deprecated and unreliable on recent library versions. Following the
 * library's own recommended pattern here: request cookies are updated first
 * so this same middleware invocation sees them, then mirrored onto a fresh
 * response so the browser gets them too.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request: { headers: request.headers } });

  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request: { headers: request.headers } });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isDashboardRoute = request.nextUrl.pathname.startsWith("/dashboard");
  if (isDashboardRoute && !user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
