/**
 * Headless CC simulator: connects like a real computer would, decodes every
 * frame through cc/decoder.lua in a Lua VM and reports timing/throughput.
 * Catches server-side framing bugs without needing the game.
 *
 *   node tools/fake_cc.mjs ws://127.0.0.1:18755/play?token=dev [--frames 200]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.join(import.meta.dirname, "..", "node", "package.json"));
const WebSocket = require("ws");
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require("fengari");

const url = process.argv[2] || "ws://127.0.0.1:18755/play?token=dev";
const maxFrames = parseInt((process.argv[process.argv.indexOf("--frames") + 1] || "200"), 10);

let W = 0, H = 0, B = 16;
const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);
lauxlib.luaL_dostring(L, to_luastring(`
  bit32 = {
    band = function(a, b)
      local r, bit = 0, 1
      for i = 0, 31 do
        if a % 2 == 1 and b % 2 == 1 then r = r + bit end
        a, b, bit = math.floor(a / 2), math.floor(b / 2), bit * 2
      end
      return r
    end,
    lshift = function(a, n) return (a * 2 ^ n) % 2 ^ 32 end,
  }
`));
const decSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "cc", "decoder.lua"), "utf8");
if (lauxlib.luaL_dostring(L, to_luastring(decSrc)) !== 0) {
  console.error(to_jsstring(lua.lua_tostring(L, -1))); process.exit(1);
}
lua.lua_setglobal(L, to_luastring("decoder"));

const display = { buf: new Uint8Array(0) };
let active = -1;
const prevBuf = { buf: new Uint8Array(0) };
const calls = { raw: 0, mv: 0, snap: 0 };
let blitUs = 0;

function bufOf(id) { return id === -1 ? display.buf : prevBuf.buf; }

const holo = {
  resize: (w, hh) => { W = w; H = hh; display.buf = new Uint8Array(w * hh); prevBuf.buf = new Uint8Array(w * hh); },
  setColorMapping: () => {},
  activateFrameBuffer: (id) => { active = id; },
  allocateFrameBuffer: () => 0,
  releaseAllFrameBuffer: () => {},
  sync: () => {},
  blit: (x, y, w, h, tbl) => {
    calls.raw++;
    const dst = bufOf(active);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const px = x + i, py = y + j;
      if (px < 0 || px >= W || py < 0 || py >= H) continue;
      const v = tbl[j * w + i];
      if (v === undefined) continue;
      dst[py * W + px] = v;
    }
  },
  blitFrameBufferArea: (ax, ay, bx, by, bw, bh, id) => {
    calls.mv++;
    const src = bufOf(id), dst = bufOf(active);
    if (src === dst) return;
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
      const sx = bx + i, sy = by + j, dx = ax + i, dy = ay + j;
      if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
      if (dx < 0 || dx >= W || dy < 0 || dy >= H) continue;
      dst[dy * W + dx] = src[sy * W + sx];
    }
  },
};

function pushHolo(o) {
  lua.lua_newtable(L);
  for (const [k, v] of Object.entries(o)) {
    lua.lua_pushstring(L, to_luastring(k));
    lua.lua_pushcfunction(L, (LL) => {
      const n = lua.lua_gettop(LL);
      const args = [];
      for (let i = 1; i <= n; i++) {
        if (lua.lua_type(LL, i) === lua.LUA_TNUMBER) args.push(lua.lua_tonumber(LL, i));
        else if (lua.lua_type(LL, i) === lua.LUA_TTABLE) {
          const t = {};
          lua.lua_pushnil(LL);
          while (lua.lua_next(LL, i) !== 0) { t[lua.lua_tonumber(LL, -2)] = lua.lua_tonumber(LL, -1); lua.lua_pop(LL, 1); }
          args.push(t);
        } else args.push(undefined);
      }
      v(...args);
      return 0;
    });
    lua.lua_settable(L, -3);
  }
}

const ST = {};
function setST() {
  lua.lua_newtable(L);
  const put = (k, v) => { lua.lua_pushstring(L, to_luastring(k)); lua.lua_pushnumber(L, v); lua.lua_settable(L, -3); };
  put("block", B); put("bx", Math.ceil(W / B)); put("by", Math.ceil(H / B));
  put("regionW", W); put("regionH", H); put("prevId", 0); put("displayId", -1);
  lua.lua_setglobal(L, to_luastring("ST"));
}

let frames = 0, msgs = 0, bytes = 0, pending = 0, curSeq = -1;
const t0 = Date.now();

const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";

ws.on("open", () => console.error(`[fake_cc] connected ${url}`));

ws.on("message", (data, isBinary) => { try {
  const msg = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const t = msg.readUInt8(0);
  if (process.env.TRACE) console.error(`[trace] type=${t} len=${msg.length}`);
  if (t === 0x01) {
    W = msg.readUInt16BE(4); H = msg.readUInt16BE(6); B = msg.readUInt8(2);
    console.error(`[fake_cc] HELLO ${W}x${H} block=${B} fps=${msg.readUInt8(3)}`);
    holo.resize(W, H);
    lua.lua_settop(L, 0);
    pushHolo(holo);
    lua.lua_setglobal(L, to_luastring("H"));
    if (!ST.init) { ST.init = 1; setST(); }
    else setST();
    return;
  }
  if (t === 0x30) { ws.send(Buffer.from([0x31])); return; }
  if (t !== 0x10) return;

  msgs++; bytes += msg.length;
  const seq = msg.readUInt16BE(1);
  const part = msg.readUInt8(4), parts = msg.readUInt8(5);
  if (seq !== curSeq) { curSeq = seq; pending = parts; }
  pending--;

  const t1 = process.hrtime.bigint();
  lua.lua_settop(L, 0);
  lua.lua_getglobal(L, to_luastring("decoder"));
  lua.lua_getfield(L, -1, to_luastring("applyFrame"));
  lua.lua_getglobal(L, to_luastring("H"));
  lua.lua_pushlstring(L, new Uint8Array(msg.buffer, msg.byteOffset, msg.length), msg.length);
  lua.lua_getglobal(L, to_luastring("ST"));
  if (lua.lua_pcall(L, 3, 3, 0) !== 0) {
    console.error("applyFrame:", to_jsstring(lua.lua_tostring(L, -1))); process.exit(1);
  }
  lua.lua_settop(L, 0);
  blitUs += Number(process.hrtime.bigint() - t1) / 1000;

  if (process.env.TRACE) console.error(`[trace] seq=${seq} part=${part}/${parts} pending=${pending} curSeq=${curSeq}`);
  if (pending === 0) {
    lua.lua_getglobal(L, to_luastring("decoder"));
    lua.lua_getfield(L, -1, to_luastring("snapshot"));
    lua.lua_getglobal(L, to_luastring("H"));
    lua.lua_getglobal(L, to_luastring("ST"));
    lua.lua_pcall(L, 2, 0, 0);
    lua.lua_settop(L, 0);
    calls.snap++;
    frames++;
    const ms = Math.round(blitUs / 1000);
    const ack = Buffer.alloc(6);
    ack.writeUInt8(0x13, 0); ack.writeUInt16BE(seq, 1); ack.writeUInt8(0, 3); ack.writeUInt16BE(Math.min(ms, 65535), 4);
    ws.send(ack);
    blitUs = 0;

    if (frames % 50 === 0) {
      const el = (Date.now() - t0) / 1000;
      console.error(`[fake_cc] frames=${frames} ${(frames / el).toFixed(1)}fps msgs=${msgs} ${(bytes / 1024 / el).toFixed(0)}KB/s raw=${calls.raw} mv=${calls.mv}`);
    }
    if (frames >= maxFrames) {
      const el = (Date.now() - t0) / 1000;
      console.error(`[fake_cc] done frames=${frames} in ${el.toFixed(1)}s (${(frames / el).toFixed(1)} fps), ${(bytes * 8 / el / 1e6).toFixed(2)} Mbps`);
      ws.close(); process.exit(0);
    }
  }
} catch (e) {
  console.error("[fake_cc] handler error:", (e && e.stack) || e);
  process.exit(1);
}
});

ws.on("close", () => { console.error(`[fake_cc] closed after ${frames} frames`); });
ws.on("error", (e) => { console.error(`[fake_cc] error ${e.message}`); process.exit(1); });
