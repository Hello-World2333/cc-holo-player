/**
 * Scan a .ccv and assert every MV source rect stays inside the region.
 * The CC throws ArrayIndexOutOfBoundsException on an escaping vector, so this
 * must be zero for a playable file.
 */
import * as fs from "node:fs";
import { readCcvHeader, readCcvRecords, readCcvMessage } from "../node/dist/container.js";
import { decodeFrame, MSG } from "../node/dist/protocol.js";

const fd = fs.openSync(process.argv[2], "r");
const h = readCcvHeader(fd);
const recs = readCcvRecords(fd, h);
const B = h.block, W = h.regionW, Hh = h.regionH;
const bx = Math.ceil(W / B);
let mv = 0, bad = 0, worst = null;
for (const r of recs) {
  const m = readCcvMessage(fd, r);
  if (m.readUInt8(0) !== MSG.FRAME) continue;
  for (const blk of decodeFrame(m, B).blocks) {
    if (blk.mode !== 1) continue;
    mv++;
    const px = (blk.index % bx) * B, py = Math.floor(blk.index / bx) * B;
    const sx = px + blk.dx, sy = py + blk.dy;
    if (sx < 0 || sx + B > W || sy < 0 || sy + B > Hh) {
      bad++;
      if (!worst) worst = { seq: r.seq, px, py, dx: blk.dx, dy: blk.dy };
    }
  }
}
console.error(`[mv] ${mv} MV blocks, ${bad} out of bounds${worst ? " e.g. " + JSON.stringify(worst) : ""}`);
process.exit(bad === 0 ? 0 : 1);
