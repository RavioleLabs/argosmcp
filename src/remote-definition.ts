import { z } from 'zod';
import { canonical, hash, insist } from './foundation.js';

export const publicURL = z
  .string()
  .max(1500)
  .transform((value) => {
    const u = new URL(value);
    insist(
      u.protocol === 'https:' &&
        !u.username &&
        !u.password &&
        !u.hash &&
        !u.search &&
        (!u.port || u.port === '443') &&
        !u.hostname.includes(':') &&
        !/^(localhost|.*\.localhost|.*\.local|.*\.internal|[\d.]+)$/i.test(u.hostname) &&
        u.hostname.includes('.'),
      'Use a public HTTPS endpoint without credentials, query parameters or fragments',
      400,
    );
    return u.href;
  });
export const remoteConfigSchema = z
  .object({
    endpoint: publicURL,
    auth: z.enum(['oauth', 'bearer', 'none']),
    oauth: z
      .object({
        issuer: publicURL,
        authorize: publicURL,
        token: publicURL,
        clientId: z.string().min(1).max(300),
        scope: z.string().max(1000).default(''),
        resource: publicURL.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.auth === 'oauth') !== !!v.oauth)
      ctx.addIssue({ code: 'custom', message: 'OAuth configuration required only for OAuth' });
  });
export type RemoteConfig = z.infer<typeof remoteConfigSchema>;
export type RemoteTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export type RemoteDefinition = {
  id: string;
  name: string;
  config: RemoteConfig;
  fingerprint: string;
  status: string;
  tools: RemoteTool[];
  candidate: RemoteTool[];
  catalogId: string | null;
};
export const configFingerprint = (config: RemoteConfig) => hash(canonical(config));
export const remoteToolName = (id: string, name: string) =>
  'mcp_' + id.replaceAll('-', '') + '_' + hash(name).slice(0, 16);

// No code generation, regular expressions or remote JSON Schema references in company-supplied schemas.
export function inputValidator(schema: Record<string, unknown>) {
  insist(Buffer.byteLength(JSON.stringify(schema)) <= 16000, 'Tool schema too large', 400);
  const visit = (v: unknown, depth = 0): void => {
    insist(depth <= 16, 'Tool schema is too deep', 400);
    if (!v || typeof v !== 'object') return;
    for (const [key, value] of Object.entries(v)) {
      insist(
        ![
          '$ref',
          '$dynamicRef',
          'pattern',
          'patternProperties',
          '__proto__',
          'constructor',
          'prototype',
        ].includes(key),
        'Unsupported tool schema feature: ' + key,
        400,
      );
      visit(value, depth + 1);
    }
  };
  visit(schema);
  insist(schema.type === 'object', 'Tool input must be an object', 400);
  const allowed = new Set([
    '$schema',
    '$id',
    '$comment',
    'title',
    'description',
    'examples',
    'default',
    'deprecated',
    'readOnly',
    'writeOnly',
    'type',
    'enum',
    'const',
    'properties',
    'required',
    'additionalProperties',
    'propertyNames',
    'minProperties',
    'maxProperties',
    'items',
    'prefixItems',
    'additionalItems',
    'minItems',
    'maxItems',
    'uniqueItems',
    'contains',
    'minContains',
    'maxContains',
    'minLength',
    'maxLength',
    'format',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'anyOf',
    'oneOf',
    'allOf',
  ]);
  let nodes = 0;
  const normalize = (node: any): any => {
    insist(++nodes <= 300, 'Tool schema is too complex', 400);
    if (typeof node === 'boolean') return node;
    insist(node && typeof node === 'object' && !Array.isArray(node), 'Invalid JSON Schema', 400);
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      insist(
        allowed.has(key) || key.startsWith('x-'),
        'Unsupported tool schema keyword: ' + key,
        400,
      );
      // JSON Schema defaults are annotations, not instructions to rewrite approved arguments.
      if (key === 'default') continue;
      if (key === 'properties')
        result[key] = Object.fromEntries(
          Object.entries(value as object).map(([k, v]) => [k, normalize(v)]),
        );
      else if (['anyOf', 'oneOf', 'allOf', 'prefixItems'].includes(key)) {
        insist(Array.isArray(value) && value.length <= 20, 'Too many schema branches', 400);
        result[key] = value.map(normalize);
      } else if (
        ['items', 'additionalItems', 'additionalProperties', 'propertyNames', 'contains'].includes(
          key,
        )
      )
        result[key] = normalize(value);
      else result[key] = value;
    }
    return result;
  };
  try {
    return z.fromJSONSchema(normalize(schema));
  } catch (error) {
    insist(false, 'Unsupported or invalid tool input schema', 400);
  }
}
export function parseTools(input: unknown): RemoteTool[] {
  const tools = z
    .array(
      z
        .object({
          name: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
          description: z.string().max(2000).default(''),
          inputSchema: z.record(z.string(), z.unknown()),
        })
        .strict(),
    )
    .min(1)
    .max(100)
    .parse(input);
  insist(new Set(tools.map((t) => t.name)).size === tools.length, 'Duplicate tool names', 400);
  insist(Buffer.byteLength(JSON.stringify(tools)) <= 180000, 'Tool manifest too large', 400);
  for (const t of tools) {
    insist(
      !t.name.startsWith('portal_codemode_'),
      'Disable Cloudflare Code Mode and expose individual tools before connecting this portal',
      400,
    );
    inputValidator(t.inputSchema);
  }
  return tools;
}
export function remoteToolDefinition(d: Pick<RemoteDefinition, 'id' | 'name'>, t: RemoteTool) {
  return {
    provider: 'mcp',
    connectorId: d.id,
    title: d.name + ': ' + t.name,
    write: true,
    // A wrapper preserves upstream properties named connection_id or request_id.
    schema: z.object({ arguments: inputValidator(t.inputSchema) }).strict(),
    inputSchema: {
      type: 'object',
      properties: { arguments: t.inputSchema },
      required: ['arguments'],
      additionalProperties: false,
    },
  };
}
