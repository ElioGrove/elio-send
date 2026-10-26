import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

// Render every bitmap from the SVG master so browser and touch icons stay in sync.
const svg = readFileSync(new URL("../public/favicon.svg", import.meta.url));
const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map((size) => sharp(svg).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, index) => {
  const entry = 6 + index * 16;
  header[entry] = size;
  header[entry + 1] = size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[index].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
});
writeFileSync(new URL("../public/favicon.ico", import.meta.url), Buffer.concat([header, ...images]));
await sharp(svg).resize(180, 180).png().toFile(new URL("../public/apple-touch-icon.png", import.meta.url).pathname);
