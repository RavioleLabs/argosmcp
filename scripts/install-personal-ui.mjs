import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
// Explicit installation of the hosted presentation bundle. No automatic updates at startup.
process.umask(0o077);
const publisher =
  process.env.ARGOS_DASHBOARD_URL ?? 'https://argos-dashboard.leraviole.workers.dev';
const origin = new URL(publisher);
if (origin.origin !== publisher || origin.protocol !== 'https:')
  throw Error('Use a canonical HTTPS dashboard publisher.');
async function download(path, max = 2000000) {
  const response = await fetch(publisher + path, {
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error('Dashboard download failed');
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > max) throw Error('Dashboard download too large');
    parts.push(part);
  }
  return Buffer.concat(parts);
}
const latest = JSON.parse(await download('/manifest.json', 4096));
const version = process.env.ARGOS_DASHBOARD_VERSION || latest.version;
if (latest.apiVersion !== 1 || !/^[a-f0-9]{16}$/.test(version))
  throw Error('Unsupported dashboard release');
const base = '/releases/' + version + '/personal/';
const { files } = JSON.parse(await download(base + 'manifest.json', 4096));
const target = resolve('.data/personal-ui/' + version);
const temporary = target + '-' + randomUUID();
await mkdir(temporary, { recursive: true, mode: 0o700 });
try {
  for (const file of ['index.html', 'app.js', 'style.css']) {
    const data = await download(base + file);
    if (createHash('sha256').update(data).digest('hex') !== files[file])
      throw Error('Personal interface checksum mismatch');
    await writeFile(join(temporary, file), data, { mode: 0o600 });
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    // Existing immutable release must match; never overwrite a modified installation silently.
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    for (const file of ['index.html', 'app.js', 'style.css'])
      if (
        createHash('sha256')
          .update(await readFile(join(target, file)))
          .digest('hex') !== files[file]
      )
        throw Error('Existing interface differs from its release');
  }
  await writeFile(resolve('.data/personal-ui/current.json'), JSON.stringify({ version }), {
    mode: 0o600,
  });
  console.log('Installed Argos Personal interface ' + version + '. Start with npm run local.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
