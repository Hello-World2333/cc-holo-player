#!/usr/bin/env node
/**
 * Minimal Minecraft RCON client, used to reboot a ComputerCraft computer after
 * deploying new Lua (CraftOS only reads startup.lua at boot).
 *
 *   node tools/rcon.mjs "computercraft shutdown 81"
 *
 * Credentials come from the environment so they are not baked into the repo.
 */
import net from "node:net";

const host = process.env.RCON_HOST || "127.0.0.1";
const port = parseInt(process.env.RCON_PORT || "26768", 10);
const pass = process.env.RCON_PASS;
if (!pass) { console.error("RCON_PASS is not set"); process.exit(1); }

const cmd = process.argv.slice(2).join(" ");
if (!cmd) { console.error("usage: rcon.mjs <command>"); process.exit(1); }

const TYPE_AUTH = 3, TYPE_AUTH_RESP = 2, TYPE_CMD = 2, TYPE_RESP = 0;

function packet(id, type, body) {
  const b = Buffer.from(body, "utf8");
  const p = Buffer.alloc(14 + b.length);
  p.writeInt32LE(10 + b.length, 0);
  p.writeInt32LE(id, 4);
  p.writeInt32LE(type, 8);
  b.copy(p, 12);
  p.writeInt16LE(0, 12 + b.length);
  return p;
}

const sock = net.connect(port, host);
let buf = Buffer.alloc(0);
let authed = false;

sock.on("connect", () => sock.write(packet(1, TYPE_AUTH, pass)));

sock.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 12) {
    const len = buf.readInt32LE(0);
    if (buf.length < len + 4) break;
    const id = buf.readInt32LE(4);
    const type = buf.readInt32LE(8);
    const body = buf.toString("utf8", 12, 10 + len);
    buf = buf.subarray(len + 4);

    if (!authed) {
      if (id === -1) { console.error("rcon auth failed"); process.exit(1); }
      authed = true;
      sock.write(packet(2, TYPE_CMD, cmd));
      continue;
    }
    if (body.trim()) console.log(body.trim());
    sock.end();
    process.exit(0);
  }
});

sock.on("error", (e) => { console.error(`rcon: ${e.message}`); process.exit(1); });
setTimeout(() => { console.error("rcon: timeout"); process.exit(1); }, 8000);
