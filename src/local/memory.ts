import { catalog, type ToolName } from '../connectors.js';
import { canonical, hash, id, insist } from '../foundation.js';
import type { LocalStorage, Profile, LocalConnection } from './storage.js';
interface Memory {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: number;
}
const terms = (s: string): string[] =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
// Contexts share no plaintext index. Decrypt only the exact authorized context.
export function memoryContext(p: Profile, c: LocalConnection) {
  insist(p.identity && c.provider === 'engram', 'Memory context unavailable');
  insist(c.scope !== 'team' || c.teamId, 'Team context missing');
  return hash(
    canonical({
      origin: p.origin,
      org: p.identity.orgId,
      scope: c.scope ?? 'personal',
      owner: c.scope === 'team' ? c.teamId : p.identity.userId,
    }),
  );
}
export function executeMemory(
  storage: LocalStorage,
  p: Profile,
  c: LocalConnection,
  tool: ToolName,
  input: Record<string, unknown>,
) {
  insist(c.provider === 'engram' && catalog[tool].provider === 'engram', 'Not a memory action');
  const args = catalog[tool].schema.parse(input) as Record<string, any>,
    context = memoryContext(p, c);
  if (tool === 'engram_remember') {
    const count = storage.db
      .prepare('SELECT count(*) AS n FROM memories WHERE context=?')
      .get(context) as { n: number };
    insist(count.n < 10000, 'This context has reached its 10,000 memory limit', 409);
    const m: Memory = {
      id: id(),
      title: args.title ?? args.content.slice(0, 80),
      content: args.content,
      tags: args.tags ?? [],
      createdAt: Date.now(),
    };
    storage.db
      .prepare('INSERT INTO memories VALUES(?,?,?)')
      .run(context, m.id, storage.vault.seal(m, `memory:${context}:${m.id}`));
    return { id: m.id, title: m.title, createdAt: m.createdAt };
  }
  if (tool === 'engram_forget')
    return {
      deleted:
        storage.db.prepare('DELETE FROM memories WHERE context=? AND id=?').run(context, args.id)
          .changes === 1,
    };
  const docs = (
    storage.db.prepare('SELECT id,payload FROM memories WHERE context=?').all(context) as {
      id: string;
      payload: string;
    }[]
  ).map((r) => storage.vault.open<Memory>(r.payload, `memory:${context}:${r.id}`));
  const query = [...new Set(terms(args.query))],
    tokens = docs.map((m) => terms(`${m.title} ${m.title} ${m.tags.join(' ')} ${m.content}`));
  const avg = tokens.reduce((n, t) => n + t.length, 0) / Math.max(docs.length, 1);
  const frequencies = query.map((q) => tokens.filter((t) => t.includes(q)).length);
  const results = docs
    .map((m, i) => {
      const t = tokens[i];
      const score = query.reduce((sum, q, j) => {
        const f = t.filter((x) => x === q).length;
        return (
          sum +
          (Math.log(1 + (docs.length - frequencies[j] + 0.5) / (frequencies[j] + 0.5)) * f * 2.2) /
            (f + 1.2 * (0.25 + (0.75 * t.length) / (avg || 1)))
        );
      }, 0);
      return { ...m, score, source: `engram://${context}/${m.id}` };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
    .slice(0, args.limit);
  return { results, retrieval: 'bm25', context: c.label };
}
