import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const sections = ['Third-party dependency notices\nGenerated from the pinned lockfile and locally installed package license files.\nIncludes build/test dependencies. Project licensing is separate.'];
for (const [relative, row] of Object.entries(lock.packages).sort()) {
  if (!relative) continue;
  const dir = path.join(root, relative), pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  let body = `${pkg.name}@${row.version}\nDeclared license: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? 'not declared')}`;
  const notices = fs.readdirSync(dir).filter(n => /^(?:LICEN[CS]E|COPYING|NOTICE)(?:\.[a-z]+)?$/i.test(n));
  for (const name of notices) {
    const filename = path.join(dir, name), stat = fs.lstatSync(filename);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 500_000) body += '\n\n' + name + '\n' + fs.readFileSync(filename, 'utf8');
  }
  sections.push(body);
}
fs.writeFileSync(path.join(root, 'THIRD-PARTY-LICENSES.txt'), sections.join('\n\n' + '='.repeat(72) + '\n\n') + '\n');
console.log('Third-party notices generated from local package metadata.');
