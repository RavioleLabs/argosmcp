import { cpSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
if (process.platform !== 'darwin')
  throw new Error(
    'Build the macOS app on macOS. The local connector also runs with npm run local on other platforms.',
  );
const root = resolve('build/Argos Personal.app'),
  contents = join(root, 'Contents'),
  resources = join(contents, 'Resources'),
  runtime = join(resources, 'runtime'),
  app = join(resources, 'app');
// This is a generated artifact; never retain stale runtime libraries across rebuilds.
rmSync(root, { recursive: true, force: true });
for (const p of [join(contents, 'MacOS'), runtime, app]) mkdirSync(p, { recursive: true });
for (const p of ['dist', 'desktop/ui', 'package.json', 'LICENSE'])
  cpSync(resolve(p), join(app, p), { recursive: true });
// Copy only production dependencies and their resolved dependency closure. Never include .data or .env.
const seen = new Set();
function copyPackage(name, from = process.cwd()) {
  let dir = from,
    source;
  while (true) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      source = candidate;
      break;
    }
    const up = dirname(dir);
    if (up === dir) throw new Error('Missing dependency ' + name);
    dir = up;
  }
  const relative = source.slice(resolve('node_modules').length + 1);
  if (seen.has(relative)) return;
  seen.add(relative);
  const target = join(app, 'node_modules', relative);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, filter: (p) => !p.includes('/node_modules/.cache/') });
  const meta = JSON.parse(
    execFileSync('cat', [join(source, 'package.json')], { encoding: 'utf8' }),
  );
  for (const dep of Object.keys(meta.dependencies ?? {})) copyPackage(dep, source);
  for (const dep of Object.keys(meta.optionalDependencies ?? {})) {
    try {
      copyPackage(dep, source);
    } catch {
      /* Other-platform optional bindings. */
    }
  }
}
const meta = JSON.parse(execFileSync('cat', ['package.json'], { encoding: 'utf8' }));
for (const dep of Object.keys(meta.dependencies)) copyPackage(dep);
const nodeTarget = join(runtime, 'node');
cpSync(realpathSync(process.execPath), nodeTarget);
// Bundle Homebrew dylibs and rewrite their references so the app does not depend on Homebrew paths.
const copied = new Map();
function bundleLibs(binary, original = binary) {
  const lines = execFileSync('otool', ['-L', binary], { encoding: 'utf8' }).split('\n').slice(1);
  for (const line of lines) {
    const dep = line.trim().split(' (')[0];
    let source = dep;
    if (dep.startsWith('@rpath/')) {
      source = [
        join(dirname(original), '../lib', basename(dep)),
        join(dirname(original), basename(dep)),
        join('/opt/homebrew/lib', basename(dep)),
      ].find((p) => existsSync(p));
      if (!source) throw new Error('Cannot resolve ' + dep);
    } else if (dep.startsWith('@loader_path/'))
      source = join(dirname(original), dep.slice('@loader_path/'.length));
    else if (!dep.startsWith('/opt/homebrew/') && !dep.startsWith('/usr/local/')) continue;
    const real = realpathSync(source);
    let dest = copied.get(real);
    if (!dest) {
      dest = join(runtime, basename(real));
      copied.set(real, dest);
      cpSync(real, dest);
      execFileSync('chmod', ['u+w', dest]);
      bundleLibs(dest, real);
      execFileSync('install_name_tool', ['-id', '@loader_path/' + basename(dest), dest]);
    }
    execFileSync('install_name_tool', ['-change', dep, '@loader_path/' + basename(dest), binary]);
  }
}
bundleLibs(nodeTarget, realpathSync(process.execPath));
execFileSync(
  'swiftc',
  [
    'desktop/ArgosPersonal.swift',
    '-o',
    join(contents, 'MacOS', 'ArgosPersonal'),
    '-framework',
    'AppKit',
    '-framework',
    'WebKit',
    '-framework',
    'UserNotifications',
    '-module-cache-path',
    resolve('build/swift-cache'),
  ],
  { stdio: 'inherit' },
);
writeFileSync(
  join(contents, 'Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>ArgosPersonal</string><key>CFBundleIdentifier</key><string>ai.argosnode.personal</string><key>CFBundleName</key><string>Argos Personal</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>0.1.0</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`,
);
// Local ad-hoc signature only; a distributable release requires Developer ID and notarization.
for (const path of [...copied.values(), nodeTarget])
  execFileSync('codesign', ['--force', '--sign', '-', path], { stdio: 'pipe' });
execFileSync('codesign', ['--force', '--deep', '--sign', '-', root], { stdio: 'pipe' });
console.log('Built ' + root + ' (local ad-hoc signature; not notarized).');
