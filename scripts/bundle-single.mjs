/**
 * Optional: build one self-contained HTML file (everything inlined) so the sim
 * can be opened by double-clicking, no server and no network.
 *
 *   npm run build:single   ->  dist/Tyres, Not Tweens.html
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const bundled = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  minify: true,
  write: false,
  target: 'es2022',
});
const js = bundled.outputFiles[0].text;

let html = await readFile('index.html', 'utf8');
const css = await readFile('styles.css', 'utf8');

html = html.replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, '');
html = html.replace('<link rel="stylesheet" href="./styles.css" />', `<style>\n${css}\n</style>`);
html = html.replace(
  '<script type="module" src="./src/main.js"></script>',
  `<script type="module">\n${js}\n</script>`,
);

await mkdir('dist', { recursive: true });
const out = 'dist/Tyres, Not Tweens.html';
await writeFile(out, html);
console.log(`${out}  (${(html.length / 1048576).toFixed(2)} MB, no external files)`);
