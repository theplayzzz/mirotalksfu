import { build } from 'vite';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { catalog } from './src/catalog.js';
const root = path.dirname(fileURLToPath(import.meta.url));
await writeFile(
    path.join(root, '../app/src/captcha-games.json'),
    JSON.stringify(
        catalog.map(({ id, title, revision, seconds }) => ({ id, title, revision, seconds })),
        null,
        2
    ) + '\n'
);
await build({
    root,
    configFile: false,
    base: './',
    build: {
        outDir: '../app/captcha-player',
        emptyOutDir: true,
        rollupOptions: { input: path.join(root, 'room.html') },
    },
});
