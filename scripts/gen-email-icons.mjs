import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const SIZE = 40;
const canvas = () => new Uint8Array(SIZE * SIZE * 4);
const hex = (value) => {
  const v = value.replace("#", "");
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16), 255];
};
const set = (buf, x, y, color) => {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) return;
  const i = (py * SIZE + px) * 4;
  buf[i] = color[0];
  buf[i + 1] = color[1];
  buf[i + 2] = color[2];
  buf[i + 3] = color[3];
};
const rect = (buf, x, y, w, h, color) => {
  for (let yy = y; yy < y + h; yy += 1) for (let xx = x; xx < x + w; xx += 1) set(buf, xx, yy, color);
};
const disc = (buf, cx, cy, r, color) => {
  for (let y = Math.floor(cy - r); y <= cy + r; y += 1)
    for (let x = Math.floor(cx - r); x <= cx + r; x += 1)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(buf, x, y, color);
};
const ring = (buf, cx, cy, r, thickness, color) => {
  const inner = r - thickness;
  for (let y = Math.floor(cy - r); y <= cy + r; y += 1)
    for (let x = Math.floor(cx - r); x <= cx + r; x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r && d >= inner) set(buf, x, y, color);
    }
};
const line = (buf, x1, y1, x2, y2, weight, color) => {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2);
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const cx = x1 + (x2 - x1) * t;
    const cy = y1 + (y2 - y1) * t;
    disc(buf, cx, cy, weight / 2, color);
  }
};
const roundRect = (buf, x, y, w, h, r, color) => {
  rect(buf, x + r, y, w - r * 2, h, color);
  rect(buf, x, y + r, w, h - r * 2, color);
  disc(buf, x + r, y + r, r, color);
  disc(buf, x + w - r - 1, y + r, r, color);
  disc(buf, x + r, y + h - r - 1, r, color);
  disc(buf, x + w - r - 1, y + h - r - 1, r, color);
};

const ink = hex("#374151");
const white = [255, 255, 255, 255];

function build(name) {
  const buf = canvas();
  if (name === "globe") {
    ring(buf, 20, 20, 15, 2.6, ink);
    ring(buf, 20, 20, 14, 1.2, ink);
    line(buf, 20, 6, 20, 34, 1.6, ink);
    line(buf, 8, 16, 32, 16, 1.4, ink);
    line(buf, 8, 24, 32, 24, 1.4, ink);
  } else if (name === "mail") {
    roundRect(buf, 6, 10, 28, 20, 3, ink);
    rect(buf, 9, 13, 22, 14, [0, 0, 0, 0]);
    line(buf, 9, 13, 20, 22, 1.8, ink);
    line(buf, 31, 13, 20, 22, 1.8, ink);
  } else if (name === "calendar") {
    roundRect(buf, 7, 9, 26, 24, 3, ink);
    rect(buf, 10, 15, 20, 15, [0, 0, 0, 0]);
    line(buf, 8, 17, 32, 17, 2, ink);
    disc(buf, 15, 24, 2, ink);
    disc(buf, 21, 24, 2, ink);
    disc(buf, 27, 24, 2, ink);
  } else if (name === "linkedin") {
    roundRect(buf, 4, 4, 32, 32, 7, hex("#0A66C2"));
    disc(buf, 13, 14, 2.6, white);
    rect(buf, 11, 18, 4, 12, white);
    rect(buf, 19, 18, 4, 12, white);
    line(buf, 23, 20, 23, 30, 4, white);
    ring(buf, 26, 23, 5, 4, white);
    rect(buf, 24, 23, 4, 7, white);
  } else if (name === "x") {
    roundRect(buf, 4, 4, 32, 32, 7, hex("#111111"));
    line(buf, 12, 12, 28, 28, 3.4, white);
    line(buf, 28, 12, 12, 28, 3.4, white);
  } else if (name === "github") {
    disc(buf, 20, 20, 16, hex("#24292F"));
    disc(buf, 20, 17, 6, white);
    rect(buf, 17, 22, 6, 8, white);
    disc(buf, 14, 29, 2, white);
    disc(buf, 26, 29, 2, white);
  } else if (name === "instagram") {
    roundRect(buf, 6, 6, 28, 28, 8, hex("#C13584"));
    roundRect(buf, 10, 10, 20, 20, 6, [0, 0, 0, 0]);
    ring(buf, 20, 20, 7, 2.4, white);
    disc(buf, 26.5, 13.5, 1.8, white);
  } else if (name === "accent") {
    rect(buf, 8, 6, 6, 28, ink);
  }
  return buf;
}

function png(buf) {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (SIZE * 4 + 1)] = 0;
    for (let x = 0; x < SIZE; x += 1) {
      const from = (y * SIZE + x) * 4;
      const to = y * (SIZE * 4 + 1) + 1 + x * 4;
      raw[to] = buf[from];
      raw[to + 1] = buf[from + 1];
      raw[to + 2] = buf[from + 2];
      raw[to + 3] = buf[from + 3];
    }
  }
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public/icons/email", { recursive: true });
for (const name of ["globe", "linkedin", "x", "github", "instagram", "calendar", "mail"]) {
  writeFileSync(`public/icons/email/${name}.png`, png(build(name)));
  console.log("wrote", name);
}
