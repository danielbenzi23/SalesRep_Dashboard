// Vercel Edge Middleware - multi-user auth gate
// Cookie: auth=<email>:<hmac> (HMAC-SHA256 of email using DASHBOARD_TOKEN as secret)

import { verifyAuthCookie } from './lib/auth.js';

export const config = {
  matcher: ['/((?!api/login|api/logout|api/me|login\\.html|_next|favicon\\.ico).*)']
};

export default async function middleware(request) {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) {
    return new Response('DASHBOARD_TOKEN env var not set on Vercel', { status: 500 });
  }
  // Machine-to-machine calls (Vercel Cron + the weekly pipeline's self-chained
  // invocations) carry a secret param or cron headers instead of a cookie.
  // Let them through the cookie gate — the API functions validate the secret
  // themselves and return 401 when it is wrong.
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/') && (
    url.searchParams.get('secret') ||
    request.headers.get('x-vercel-cron-schedule') ||
    (request.headers.get('authorization') || '').startsWith('Bearer ')
  )) {
    return;
  }
  const cookies = request.headers.get('cookie') || '';
  const match = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
  const user = match ? await verifyAuthCookie(match[1], token) : null;
  if (user) return;
  return Response.redirect(new URL('/login.html', request.url), 302);
}
