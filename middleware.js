// Edge middleware — protects every page except /login.html and /api/login.
// Verifies HMAC-signed `auth=email:hmac` cookie. Redirects to /login.html when missing/invalid.

import { verifyAuthCookie } from './lib/auth.js';

export const config = {
  matcher: [
    '/((?!login.html|api/login|favicon.ico|_next|_vercel|.*\\..*).*)'
  ]
};

export default async function middleware(req) {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) {
    return new Response('DASHBOARD_TOKEN not set', { status: 500 });
  }
  const cookies = req.headers.get('cookie') || '';
  const m = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
  const user = m ? await verifyAuthCookie(m[1], token) : null;
  if (!user) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      });
    }
    const next = encodeURIComponent(url.pathname + url.search);
    return Response.redirect(new URL(`/login.html?next=${next}`, req.url), 302);
  }
  return;
}
