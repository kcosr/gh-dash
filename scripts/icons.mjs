// Renders the app icons in build/ from the TopBar mark (web/src/components/Icon.tsx "pulse" on the accent square,
// .brand .mark in web/src/styles/app.css). Run it with Electron (it draws the SVG on a canvas):
//   xvfb-run -a npx electron scripts/icons.mjs     (or on a desktop: npx electron scripts/icons.mjs)
// Writes build/icon.svg, build/icon.png (1024, macOS grid), build/icons/<n>x<n>.png (Linux) and build/icon.ico.
import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const ACCENT = '#2a78d6';
const PULSE = 'M1.5 8h3l2-5 3 10 2-5h3';

/**
 * The mark on a 1024 canvas. `inset`: transparent margin (macOS icons sit on an 824 px body; Linux and Windows
 * icons use most of the canvas). The glyph is 15/24 of the square, as in the TopBar; small sizes get a bolder stroke.
 */
function svg({ inset, stroke = 2 }) {
  const body = 1024 - 2 * inset;
  const radius = Math.round((body * 7) / 24);
  const glyph = (body * 15) / 24;
  const scale = glyph / 16;
  const offset = inset + (body - glyph) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="${inset}" y="${inset}" width="${body}" height="${body}" rx="${radius}" fill="${ACCENT}"/>
  <path d="${PULSE}" transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

/** Windows .ico holding PNG images (Vista+). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<!doctype html><title>icons</title>');
  const render = async (source, size) => {
    const url = `data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}`;
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = ${size};
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, ${size}, ${size});
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('svg failed to load'));
      img.src = ${JSON.stringify(url)};
    })`);
    return Buffer.from(dataUrl.split(',')[1], 'base64');
  };

  mkdirSync(join(out, 'icons'), { recursive: true });
  const mac = svg({ inset: 100 });
  const full = (size) => svg({ inset: 40, stroke: size <= 24 ? 2.8 : size <= 48 ? 2.4 : 2 });
  writeFileSync(join(out, 'icon.svg'), mac);
  writeFileSync(join(out, 'icon.png'), await render(mac, 1024));
  const linux = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const pngs = new Map();
  for (const size of linux) {
    const png = await render(full(size), size);
    pngs.set(size, png);
    writeFileSync(join(out, 'icons', `${size}x${size}.png`), png);
  }
  writeFileSync(join(out, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: pngs.get(size) }))));
  console.log(`icons written to ${out}`);
  app.quit();
});
