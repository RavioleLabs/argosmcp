import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { LocalStorage } from './storage.js';
import { LocalRuntime } from './runtime.js';
import { createLocalApp } from './app.js';

process.umask(0o077);
try {
  const storage = new LocalStorage(
    resolve(process.env.ARGOS_LOCAL_DATA ?? resolve(homedir(), '.argos-personal')),
  );
  const runtime = new LocalRuntime(storage),
    port = Number(process.env.ARGOS_LOCAL_PORT ?? 4217),
    origin = `http://localhost:${port}`;
  const { app, url } = createLocalApp(
    runtime,
    origin,
    fileURLToPath(new URL('../../desktop/ui', import.meta.url)),
  );
  const server = app.listen(port, '127.0.0.1', () => {
    if (process.env.ARGOS_DESKTOP === '1') console.log(JSON.stringify({ url }));
    else {
      console.error('Argos Personal is running on this device. Keep this process open.');
      const command =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'explorer'
            : 'xdg-open';
      execFile(command, [url], (err) => {
        if (err) console.error('Open Argos using the desktop application.');
      });
    }
  });
  server.on('error', () => {
    console.error('Cannot start Argos. Another instance may already be running.');
    storage.close();
    process.exit(1);
  });
  let polling = false;
  const tick = async () => {
    if (polling) return;
    polling = true;
    try {
      await runtime.serial(() => runtime.tick());
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 4000);
  timer.unref();
  void tick();
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      clearInterval(timer);
      server.close(() => {
        storage.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5000).unref();
    });
} catch {
  console.error(
    'Argos could not unlock its OS credential store. Unlock your keychain and retry. No plaintext fallback is used.',
  );
  process.exitCode = 1;
}
