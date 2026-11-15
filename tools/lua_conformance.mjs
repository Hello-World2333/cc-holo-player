/**
 * Conformance test: run the real cc/decoder.lua inside a Lua VM against a mock
 * hologram peripheral that models blit / blitFrameBufferArea, then compare the
 * resulting buffer with node/src/codec.ts (the reference decoder).
 *
 * Any divergence means the CC would draw something different from what the
 * encoder believes it drew — i.e. the whole bit-exactness guarantee is broken.
 *
 *   node tools/lua_conformance.mjs <video.ccv>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { readCcvHeader, readCcvRecords, readCcvMessage } from "../node/dist/container.js";
import { applyFrame } from "../node/dist/codec.js";
import { decodeFrame, MSG } from "../node/dist/protocol.js";

const require = createRequire(path.join(import.meta.dirname, "..", "node", "package.json"));
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require("fengari");

const ccvPath = process.argv[2];
if (!ccvPath) { console.error("usage: lua_conformance.mjs <video.ccv>"); process.exit(1); }

const fd = fs.openSync(ccvPath, "r");
const hdr = readCcvHeader(fd);
const recs = readCcvRecords(fd, hdr);
const W = hdr.regionW, H = hdr.regionH, B = hdr.block;
console.error(`[conf] ${recs.length} msgs, ${W}x${H} block=${B}`);

// ---------- mock hologram ----------
const display = new Uint8Array(W * H);
const prev = new Uint8Array(W * H);
let active = -1; // -1 = display

function buf(id) { return id === -1 ? display : prev; }

const blitCalls = { raw: 0, mv: 0 };
const holo = {
  resize: () => {},
  setColorMapping: () => {},
  activateFrameBuffer: (id) => { active = id; },
  allocateFrameBuffer: () => 0,
  releaseAllFrameBuffer: () => {},
  sync: () => {},
  blit: (x, y, w, h, tbl) => {
    blitCalls.raw++;
    const dst = buf(active);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const px = x + i, py = y + j;
        if (px < 0 || px >= W || py < 0 || py >= H) continue;
        const v = tbl.get ? tbl.get(j * w + i) : tbl[j * w + i];
        if (v === undefined) continue;
        dst[py * W + px] = v & 0xff;
      }
    }
  },
  blitFrameBufferArea: (ax, ay, bx, by, bw, bh, bufferId) => {
    blitCalls.mv++;
    const src = buf(bufferId);
    const dst = buf(active);
    if (src === dst) return; // the real API refuses self-copy
    for (let j = 0; j < bh; j++) {
      for (let i = 0; i < bw; i++) {
        const sx = bx + i, sy = by + j;
        const dx = ax + i, dy = ay + j;
        if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
        if (dx < 0 || dx >= W || dy < 0 || dy >= H) continue;
        dst[dy * W + dx] = src[sy * W + sx];
      }
    }
  },
};

// ---------- lua setup ----------
const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);

function pushObj(o) {
  lua.lua_newtable(L);
  for (const [k, v] of Object.entries(o)) {
    lua.lua_pushstring(L, to_luastring(k));
    if (typeof v === "function") {
      lua.lua_pushcfunction(L, (LL) => {
        const n = lua.lua_gettop(LL);
        const args = [];
        for (let i = 1; i <= n; i++) {
          if (lua.lua_isnumber && lua.lua_type(LL, i) === lua.LUA_TNUMBER) args.push(lua.lua_tonumber(LL, i));
          else if (lua.lua_type(LL, i) === lua.LUA_TSTRING) args.push(to_jsstring(lua.lua_tostring(LL, i)));
          else if (lua.lua_type(LL, i) === lua.LUA_TTABLE) {
            const t = {};
            const me = LL;
            lua.lua_pushnil(me);
            while (lua.lua_next(me, i) !== 0) {
              const key = lua.lua_tonumber(me, -2);
              const val = lua.lua_tonumber(me, -1);
              t[key] = val;
              lua.lua_pop(me, 1);
            }
            t.get = (k) => t[k];
            args.push(t);
          } else args.push(undefined);
        }
        const r = v(...args);
        if (r === undefined) { lua.lua_pushnil(LL); return 1; }
        if (typeof r === "number") { lua.lua_pushnumber(LL, r); return 1; }
        lua.lua_pushboolean(LL, !!r); return 1;
      });
    } else {
      lua.lua_pushnumber(L, v);
    }
    lua.lua_settable(L, -3);
  }
}

// stub bit32 if the VM lacks it (fengari is 5.3)
lua.lua_getglobal(L, to_luastring("bit32"));
if (lua.lua_isnil(L, -1)) {
  lua.lua_pop(L, 1);
  const stub = `
    bit32 = {
      band = function(a, b)
        local r, bit = 0, 1
        for i = 0, 31 do
          local x, y = a % 2, b % 2
          if x == 1 and y == 1 then r = r + bit end
          a, b, bit = math.floor(a / 2), math.floor(b / 2), bit * 2
        end
        return r
      end,
      lshift = function(a, n) return (a * 2 ^ n) % 2 ^ 32 end,
    }
  `;
  if (lauxlib.luaL_dostring(L, to_luastring(stub)) !== 0) {
    console.error(to_jsstring(lua.lua_tostring(L, -1))); process.exit(1);
  }
} else lua.lua_pop(L, 1);

// load decoder.lua
const decSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "cc", "decoder.lua"), "utf8");
if (lauxlib.luaL_dostring(L, to_luastring(decSrc)) !== 0) {
  console.error("decoder.lua failed:", to_jsstring(lua.lua_tostring(L, -1)));
  process.exit(1);
}
// stash the module
lua.lua_setglobal(L, to_luastring("decoder"));

// state table
lua.lua_newtable(L);
const putNum = (k, v) => { lua.lua_pushstring(L, to_luastring(k)); lua.lua_pushnumber(L, v); lua.lua_settable(L, -3); };
putNum("block", B); putNum("bx", Math.ceil(W / B)); putNum("by", Math.ceil(H / B));
putNum("regionW", W); putNum("regionH", H); putNum("prevId", 0); putNum("displayId", -1);
lua.lua_setglobal(L, to_luastring("ST"));
pushObj(holo);
lua.lua_setglobal(L, to_luastring("H"));

// ---------- run ----------
const refDisplay = new Uint8Array(W * H);
const refPrev = new Uint8Array(W * H);
let curSeq = -1, pending = 0, frames = 0, diffs = 0;

for (const r of recs) {
  const msg = readCcvMessage(fd, r);
  if (msg.readUInt8(0) !== MSG.FRAME) continue;
  const f = decodeFrame(msg, B);
  if (f.seq !== curSeq) { curSeq = f.seq; pending = f.parts; }
  pending--;

  // reference
  applyFrame(refDisplay, refPrev, { w: W, h: H, block: B }, f.blocks);

  // lua
  lua.lua_getglobal(L, to_luastring("decoder"));
  lua.lua_getfield(L, -1, to_luastring("applyFrame"));
  lua.lua_getglobal(L, to_luastring("H"));
  // raw bytes: to_luastring() would re-encode as UTF-8 and corrupt values >= 0x80
  lua.lua_pushlstring(L, new Uint8Array(msg.buffer, msg.byteOffset, msg.length), msg.length);
  lua.lua_getglobal(L, to_luastring("ST"));
  if (lua.lua_pcall(L, 3, 3, 0) !== 0) {
    console.error("applyFrame failed:", to_jsstring(lua.lua_tostring(L, -1)));
    process.exit(1);
  }
  lua.lua_pop(L, 3);
  lua.lua_pop(L, 1);

  if (pending === 0) {
    refPrev.set(refDisplay);
    // lua snapshot: display -> prev
    lua.lua_getglobal(L, to_luastring("decoder"));
    lua.lua_getfield(L, -1, to_luastring("snapshot"));
    lua.lua_getglobal(L, to_luastring("H"));
    lua.lua_getglobal(L, to_luastring("ST"));
    if (lua.lua_pcall(L, 2, 0, 0) !== 0) {
      console.error("snapshot failed:", to_jsstring(lua.lua_tostring(L, -1)));
      process.exit(1);
    }
    lua.lua_pop(L, 1);

    let bad = -1;
    for (let i = 0; i < display.length; i++) if (display[i] !== refDisplay[i]) { bad = i; break; }
    if (bad >= 0) {
      diffs++;
      if (diffs <= 3) console.error(`  MISMATCH frame ${frames} at (${bad % W},${Math.floor(bad / W)}) lua=${display[bad]} ref=${refDisplay[bad]}`);
    }
    frames++;
  }
}

console.error(`[conf] ${frames} frames, lua raw=${blitCalls.raw} mv=${blitCalls.mv}, mismatches=${diffs}`);
if (diffs === 0) console.error("[conf] PASS: cc/decoder.lua is bit-exact with the reference decoder");
else { console.error("[conf] FAIL"); process.exit(1); }
