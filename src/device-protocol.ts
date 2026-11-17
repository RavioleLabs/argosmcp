import { canonical, hash } from './foundation.js';
export const proofMessage = (
  origin: string,
  path: string,
  deviceId: string,
  at: number,
  nonce: string,
  body: unknown,
) =>
  canonical({
    v: 1,
    origin,
    path,
    method: 'POST',
    deviceId,
    at,
    nonce,
    bodyHash: hash(canonical(body)),
  });
export interface Device {
  id: string;
  public_key: string;
  label: string;
  org_id: string | null;
  user_id: string | null;
  status: string;
  created_at: number;
  expires_at: number;
  last_seen: number | null;
}
export interface LocalAction {
  id: string;
  orgId: string;
  userId: string;
  grantId: string | null;
  connectionId: string;
  tool: string;
  args: Record<string, unknown>;
  digest: string;
  expiresAt: number;
  agent: string;
  requester?: string;
  status: string;
}
