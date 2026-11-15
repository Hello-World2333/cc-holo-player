/**
 * Headless logic tests for cc/settings.lua and cc/gui.lua.
 *
 * Everything under test (clamping, persistence, key handling) is pure Lua logic,
 * so the whole suite is written in Lua and only file IO is delegated to Node
 * through the HOST_* functions. Asserting in Lua avoids fragile fengari
 * stack-index juggling, and the whole run takes milliseconds.
 *
 * Scope: arithmetic and the file round-trip. Anything that touches the real
 * hologram still has to be checked on computer 81.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.join(import.meta.dirname, "..", "node", "package.json"));
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require("fengari");

const root = path.join(import.meta.dirname, "..", "cc");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccvw-set-"));
const real = (p) => path.join(tmp, String(p).replace(/^\//, ""));

const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);

let failures = 0;

function setGlobalFn(name, fn) {
  lua.lua_pushcfunction(L, fn);
  lua.lua_setglobal(L, to_luastring(name));
}

setGlobalFn("HOST_EXISTS", (LL) => {
  lua.lua_pushboolean(LL, fs.existsSync(real(to_jsstring(lua.lua_tostring(LL, 1)))));
  return 1;
});
setGlobalFn("HOST_READ", (LL) => {
  const p = real(to_jsstring(lua.lua_tostring(LL, 1)));
  if (!fs.existsSync(p)) { lua.lua_pushnil(LL); return 1; }
  lua.lua_pushstring(LL, to_luastring(fs.readFileSync(p, "utf8")));
  return 1;
});
setGlobalFn("HOST_WRITE", (LL) => {
  fs.writeFileSync(real(to_jsstring(lua.lua_tostring(LL, 1))),
    to_jsstring(lua.lua_tostring(LL, 2)));
  return 0;
});
setGlobalFn("HOST_REPORT", (LL) => {
  const name = to_jsstring(lua.lua_tostring(LL, 1));
  const ok = lua.lua_toboolean(LL, 2) ? true : false;
  const detail = lua.lua_type(LL, 3) === lua.LUA_TSTRING
    ? to_jsstring(lua.lua_tostring(LL, 3)) : "";
  if (!ok) failures++;
  console.error(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  return 0;
});

const settingsSrc = fs.readFileSync(path.join(root, "settings.lua"), "utf8");
const guiSrc = fs.readFileSync(path.join(root, "gui.lua"), "utf8");

const suite = `
fs = {
  exists = function(p) return HOST_EXISTS(p) end,
  open = function(p, mode)
    if mode == "r" then
      local body = HOST_READ(p)
      if body == nil then return nil end
      local lines = {}
      for line in (body .. "\\n"):gmatch("([^\\n]*)\\n") do lines[#lines + 1] = line end
      local i = 0
      return {
        readLine = function() i = i + 1; return lines[i] end,
        readAll = function()
          local rest = {}
          for k = i + 1, #lines do rest[#rest + 1] = lines[k] end
          i = #lines
          return table.concat(rest, "\\n")
        end,
        close = function() end,
      }
    end
    local out = {}
    return {
      writeLine = function(s) out[#out + 1] = tostring(s) end,
      write = function(s) out[#out + 1] = tostring(s) end,
      close = function() HOST_WRITE(p, table.concat(out, "\\n") .. "\\n") end,
    }
  end,
}

colors = {
  white = 1, black = 32768, blue = 2048, lime = 32,
  lightGray = 128, gray = 256, yellow = 16, red = 16384,
}

keys = {
  up = 200, down = 208, left = 203, right = 205,
  leftBracket = 26, rightBracket = 27, r = 19, zero = 11, tab = 15,
}

local settings = (function()
${settingsSrc}
end)()

local gui = (function()
${guiSrc}
end)()

local function check(name, got, want)
  HOST_REPORT(name, got == want, string.format("got=%s want=%s", tostring(got), tostring(want)))
end

local v, err = settings.load()
check("no file -> reports reason", err, "no file")
check("no file -> main.ox default", v.main.ox, 0)
check("no file -> main.scale default", v.main.scale, 1)
check("no file -> ctl.ox default", v.ctl.ox, 0)
check("two screens exist", #settings.SCREENS, 2)

check("clamp above max", settings.clamp({ min = -8, max = 8 }, 99), 8)
check("clamp below min", settings.clamp({ min = -8, max = 8 }, -99), -8)
check("clamp inside", settings.clamp({ min = -8, max = 8 }, 1.5), 1.5)
check("exclusiveMin: scale 0 becomes 0.05",
      settings.clamp({ min = 0.05, max = 4, exclusiveMin = true }, 0), 0.05)
check("exclusiveMin: negative clamps",
      settings.clamp({ min = 0.05, max = 4, exclusiveMin = true }, -2), 0.05)
check("scale above 4 clamps",
      settings.clamp({ min = 0.05, max = 4, exclusiveMin = true }, 9), 4)

local saved = settings.defaults()
saved.main.ox = 1.25
saved.main.yaw = 45
saved.main.scale = 2.75
saved.ctl.oy = -0.5
saved.ctl.scale = 0.45
local okSave, saveErr = settings.save(saved)
check("save ok", okSave, true)
check("save no error", saveErr, nil)

local r = settings.load()
check("roundtrip main.ox", r.main.ox, 1.25)
check("roundtrip main.yaw", r.main.yaw, 45)
check("roundtrip main.scale", r.main.scale, 2.75)
check("roundtrip ctl.oy", r.ctl.oy, -0.5)
check("roundtrip ctl.scale", r.ctl.scale, 0.45)
-- the two screens must not bleed into each other
check("main.pitch still default", r.main.pitch, 0)
check("ctl.ox still default", r.ctl.ox, 0)

check("format zero is +0.00", settings.format(settings.BY_KEY.ox, 0), "+0.00")
check("format negative zero is +0.00", settings.format(settings.BY_KEY.ox, -0.0), "+0.00")

-- A hand-edited file with impossible values must clamp, not crash.
HOST_WRITE("/settings.cfg", "main.ox=99\\nctl.scale=0\\njunk line without equals\\n")
local r2, err2 = settings.load()
check("load clamps main.ox", r2.main.ox, 8)
check("load clamps ctl.scale", r2.ctl.scale, 0.05)
check("junk lines ignored", err2, nil)

-- Hologram mock: records draws so we can assert text actually went out, and
-- checks that the literal-escape form is used (UTF-8 would render boxes).
local drawn = {}
local holo = {
  resize = function() end,
  setColorMapping = function() end,
  setUnicodeMode = function() end,
  releaseAllFrameBuffer = function() end,
  activateFrameBuffer = function() end,
  clear = function() end,
  fill = function() end,
  sync = function() end,
  drawText = function(x, y, s, c) drawn[#drawn + 1] = s end,
}

local values = settings.defaults()
local changes = 0
local g = gui.new({
  h = holo,
  settings = settings,
  values = values,
  onChange = function() changes = changes + 1 end,
})

check("init runs", g.init(), true)
check("draw runs", pcall(g.draw), true)

-- Chinese must be emitted as literal \\uXXXX escapes, never as UTF-8. A raw
-- multi-byte character renders as the "unknown glyph" box and looks plausible
-- from a distance, so this is worth asserting rather than eyeballing.
local sawEscape, sawRawUtf8 = false, false
for _, str in ipairs(drawn) do
  if str:find("\\\\u", 1, true) then sawEscape = true end
  for i = 1, #str do
    if str:byte(i) >= 0x80 then sawRawUtf8 = true break end
  end
end
check("labels use literal escape form", sawEscape, true)
check("no raw UTF-8 in labels", sawRawUtf8, false)

-- Selection always starts on row 1, which is main.ox.
g.sel = 1
check("starts on main screen", g.screenKey(), "main")
check("starts on row 1", g.sel, 1)

g.handleKey(keys.right)
check("right moves main.ox by coarse", values.main.ox, 0.05)
g.handleKey(keys.left)
check("left moves main.ox back", values.main.ox, 0)

g.handleChar("]")
check("] uses fine step", values.main.ox, 0.01)
g.handleChar("[")
check("[ undoes fine step", values.main.ox, 0)

for _ = 1, 400 do g.handleKey(keys.right) end
check("main.ox stops at +8", values.main.ox, 8)
for _ = 1, 400 do g.handleKey(keys.left) end
check("main.ox stops at -8", values.main.ox, -8)

g.handleKey(keys.down)
check("down selects row 2", g.sel, 2)
g.handleKey(keys.right)
check("row 2 is main.oy", values.main.oy, 0.05)

g.handleChar("r")
check("r resets the selected row", values.main.oy, 0)
check("r leaves the other row alone", values.main.ox, -8)

g.handleChar("0")
check("0 resets main.ox", values.main.ox, 0)
check("0 resets main.oy", values.main.oy, 0)
check("0 resets main.scale", values.main.scale, 1)

-- The two screens are independent transforms: editing one must not touch the
-- other. This is the whole point of splitting the settings per screen.
values.ctl.ox = 0.75
g.sel = 1
g.handleKey(keys.right)
check("main edit leaves ctl.ox alone", values.ctl.ox, 0.75)
check("main edit did move main.ox", values.main.ox, 0.05)

-- Tab switches to the control screen and resets the row cursor.
check("tab switches screen", g.handleKey(keys.tab), "screen")
check("now on ctl", g.screenKey(), "ctl")
check("row cursor reset", g.sel, 1)

g.handleChar("0")
check("0 on ctl resets ctl.ox", values.ctl.ox, 0)
check("ctl reset leaves main.ox alone", values.main.ox, 0.05)

-- Tab wraps back round to main.
check("tab wraps to main", g.handleKey(keys.tab), "screen")
check("back on main", g.screenKey(), "main")

check("onChange fired for every edit", changes > 10, true)
check("q returns close", g.handleChar("q"), "close")

-- Vertical wrap in both directions.
g.sel = #settings.ITEMS
g.handleKey(keys.down)
check("down wraps last -> first", g.sel, 1)
g.handleKey(keys.up)
check("up wraps first -> last", g.sel, #settings.ITEMS)

-- Every edit must have landed on disk, for both screens.
local disk = HOST_READ("/settings.cfg") or ""
check("file has header", disk:find("# hologram view settings", 1, true) ~= nil, true)
check("file has main entries", disk:find("main.ox=", 1, true) ~= nil, true)
check("file has ctl entries", disk:find("ctl.ox=", 1, true) ~= nil, true)
check("file has scale", disk:find("scale=", 1, true) ~= nil, true)
`;

if (lauxlib.luaL_dostring(L, to_luastring(suite)) !== 0) {
  console.error("suite failed:", to_jsstring(lua.lua_tostring(L, -1)));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

console.error(failures === 0 ? "[test] PASS" : `[test] ${failures} FAILURE(S)`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
