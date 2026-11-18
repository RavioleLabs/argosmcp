import { insist } from './foundation.js';

const VERSION = /^[a-f0-9]{16}$/;
export const dashboardHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
async function bounded(url: string, type: string, limit: number) {
  // An operator-configured publisher, never a user-provided API proxy. No request headers are forwarded.
  const response = await fetch(url, {
    redirect: 'manual',
    headers: { Accept: type },
    signal: AbortSignal.timeout(15000),
  });
  insist(response.ok && response.status !== 206, 'Dashboard publisher unavailable', 503);
  insist(
    response.headers.get('content-type')?.split(';')[0] === type,
    'Invalid dashboard asset type',
    502,
  );
  const reader = response.body?.getReader();
  insist(reader, 'Empty dashboard asset', 502);
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error('Dashboard asset too large');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts);
}
export async function dashboardAsset(
  path: string,
  environment: NodeJS.ProcessEnv,
): Promise<Response> {
  const publisher = environment.ARGOS_DASHBOARD_URL;
  if (!publisher)
    return new Response(
      'ArgosMCP backend is running. Set ARGOS_DASHBOARD_URL to your trusted dashboard publisher to enable the web interface.',
      {
        status: 503,
        headers: { ...dashboardHeaders, 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
      },
    );
  const origin = new URL(publisher);
  insist(
    origin.origin === publisher &&
      !origin.username &&
      !origin.password &&
      (origin.protocol === 'https:' ||
        (origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))),
    'Invalid dashboard publisher configuration',
    503,
  );
  if (path === '/') {
    let version = environment.ARGOS_DASHBOARD_VERSION;
    if (!version) {
      const metadata = JSON.parse(
        (await bounded(publisher + '/manifest.json', 'application/json', 4096)).toString(),
      );
      insist(metadata.apiVersion === 1, 'Dashboard API version is incompatible', 503);
      version = metadata.version;
    }
    insist(typeof version === 'string' && VERSION.test(version), 'Invalid dashboard release', 503);
    const html = (
      await bounded(publisher + '/releases/' + version + '/index.html', 'text/html', 500000)
    ).toString();
    insist(html.includes('data-argos-dashboard="service"'), 'Incompatible dashboard document', 503);
    return new Response(
      html.replace('data-argos-dashboard="service"', 'data-argos-dashboard="backend"'),
      {
        headers: {
          ...dashboardHeaders,
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    );
  }
  const asset = path.match(
    /^\/dashboard-assets(\/releases\/([a-f0-9]{16})\/assets\/[A-Za-z0-9_.-]+\.(js|css|woff2|png|svg))$/,
  );
  insist(asset, 'Unknown dashboard asset', 404);
  const type = (
    {
      js: 'text/javascript',
      css: 'text/css',
      woff2: 'font/woff2',
      png: 'image/png',
      svg: 'image/svg+xml',
    } as Record<string, string>
  )[asset[3]];
  const bytes = await bounded(publisher + asset[1], type, 2000000);
  return new Response(bytes, {
    headers: {
      ...dashboardHeaders,
      'Content-Type': type,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
