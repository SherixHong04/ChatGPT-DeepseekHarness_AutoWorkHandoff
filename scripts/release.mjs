import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(version)) throw Error('Invalid release version');
const stage = path.join(root, 'release/staging-' + version);
if (fs.existsSync(path.dirname(stage)) && fs.lstatSync(path.dirname(stage)).isSymbolicLink()) throw Error('Linked release parent refused');
if (fs.existsSync(stage)) throw Error('Release staging already exists: preserve it and use a new build directory rather than overwrite');
const allowed = ['src', 'tests', 'dist', 'scripts', 'skills', 'plugins', 'config', 'docs', 'examples',
  'package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', 'README.md', 'THIRD-PARTY-LICENSES.txt',
  'verification/RESULTS.md', 'verification/install-check.json'];
const files = [];
function visit(relative) {
  const filename = path.join(root, relative), st = fs.lstatSync(filename);
  if (st.isSymbolicLink()) throw Error('Linked release resource refused: ' + relative);
  if (st.isDirectory()) { for (const name of fs.readdirSync(filename).sort()) visit(path.join(relative, name)); return; }
  const rel = relative.replaceAll('\\', '/');
  if (/(?:^|\/)(?:\.local|\.local-tests|node_modules|maintenance|reference)(?:\/|$)|\.sqlite(?:-|$)|\.local\.json$|\.log$/.test(rel)) throw Error('Runtime data in allowlist: ' + rel);
  const buffer = fs.readFileSync(filename), content = buffer.toString('utf8');
  // Original account/project identifiers and home path must never escape in source, docs, maps or binaries.
  const markers = JSON.parse(process.env.WORK_HANDOFF_PRIVATE_MARKERS_JSON ?? '[]');
  const forbidden = [/[A-Za-z]:[/\\]+Users[/\\]+[^/\\:\r\n"']+[/\\]/i,
    /(?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*["'][A-Za-z0-9_-]{24,}["']/i];
  if (forbidden.some(re => re.test(content)) || markers.some(marker => content.includes(marker))) throw Error('Private path, marker or credential-like assignment: ' + rel);
  files.push({ path: rel, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') });
}
for (const item of allowed) visit(item);
fs.mkdirSync(stage, { recursive: true });
for (const row of files) {
  const to = path.join(stage, row.path); fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(root, row.path), to, fs.constants.COPYFILE_EXCL);
}
const manifest = { version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  scanned: true, files, excludesRuntimeAndAccounts: true, releaseUsesExplicitAllowlist: true };
fs.writeFileSync(path.join(stage, 'RELEASE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ stage, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), scanned: true }));
