import { sign } from 'node:crypto';
import { proofMessage } from '../device-protocol.js';
import { opaque, insist, Fault } from '../foundation.js';
import type { Profile } from './storage.js';
export function validOrigin(value: string) {
  const u = new URL(value);
  insist(
    u.origin === value &&
      !u.username &&
      !u.password &&
      (u.protocol === 'https:' ||
        (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))),
    'Use your workspace HTTPS origin (or localhost for development)',
    400,
  );
  return value;
}
export async function remote(
  p: Pick<Profile, 'origin' | 'deviceId' | 'privateKey'>,
  path: string,
  body: unknown = {},
) {
  const at = Date.now(),
    nonce = opaque();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-argos-device': p.deviceId,
    'x-argos-time': String(at),
    'x-argos-nonce': nonce,
    'x-argos-signature': sign(
      null,
      Buffer.from(proofMessage(p.origin, path, p.deviceId, at, nonce, body)),
      p.privateKey,
    ).toString('base64url'),
  };
  const r = await fetch(p.origin + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  // Do not forward arbitrary server error strings to an agent or a native shell.
  if (!r.ok)
    throw new Fault(
      r.status,
      r.status === 401
        ? 'Device access expired. Pair this device again.'
        : r.status === 403
          ? 'Action refused by your workspace.'
          : 'Workspace request failed (' + r.status + ').',
    );
  const reader = r.body!.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2000000) {
        await reader.cancel();
        throw new Error('Workspace response too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
