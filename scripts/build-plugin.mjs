import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)), dest = path.join(root, 'plugins/harness-chat-manager/lib');
fs.mkdirSync(dest, { recursive: true });
for (const name of ['contracts', 'packet', 'harness-chats', 'harness-chat-plugin', 'managed-session']) {
  fs.copyFileSync(path.join(root, 'dist/src', name + '.js'), path.join(dest, name + '.js'));
}
console.log('Built self-contained local Harness plugin. No host settings changed.');
