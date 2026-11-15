--- Persistent view settings, one independent transform per hologram.
--
-- Two holograms are in play: the video wall ("main", attached to the computer)
-- and the control panel screen ("ctl", on a CEE data-hub pin). Each has its own
-- offset / rotation / scale and each is stored and applied separately.
--
-- The holograms keep these values in world NBT but expose no getters, so this
-- file is the source of truth: it is loaded at boot and re-applied on every edit.
--
-- IMPORTANT: HologramTE.setOffset rejects |v| > 8 and setScale rejects anything
-- outside (0, 4] by SILENTLY RETURNING (verified in bytecode: `ifeq` jumps
-- straight to `return`). No exception, no clamping. So clamping here is load
-- bearing: without it the UI moves and the hologram does not, with no feedback.

local M = {}

M.PATH = "/settings.cfg"

--- Rotations are passed to setRotation as (yaw, pitch, roll); the TE applies
--- them in the order rotateLocalZ(roll), rotateLocalX(pitch), rotateLocalY(yaw).
M.ITEMS = {
  { key = "ox",    label = "\\u504F\\u79FB X",  min = -8,   max = 8,   coarse = 0.05, fine = 0.01, fmt = "%+.2f" },
  { key = "oy",    label = "\\u504F\\u79FB Y",  min = -8,   max = 8,   coarse = 0.05, fine = 0.01, fmt = "%+.2f" },
  { key = "oz",    label = "\\u504F\\u79FB Z",  min = -8,   max = 8,   coarse = 0.05, fine = 0.01, fmt = "%+.2f" },
  { key = "yaw",   label = "\\u822A",            min = -180, max = 180, coarse = 5,    fine = 1,    fmt = "%+.0f" },
  { key = "pitch", label = "\\u4FEF\\u4EF0",     min = -180, max = 180, coarse = 5,    fine = 1,    fmt = "%+.0f" },
  { key = "roll",  label = "\\u6EDA\\u8F6C",     min = -180, max = 180, coarse = 5,    fine = 1,    fmt = "%+.0f" },
  { key = "scale", label = "\\u7F29\\u653E",     min = 0.05, max = 4,   coarse = 0.05, fine = 0.01, fmt = "%.2f",
    -- setScale takes a float and ignores anything <= 0 outright.
    exclusiveMin = true },
}

M.BY_KEY = {}
for _, it in ipairs(M.ITEMS) do M.BY_KEY[it.key] = it end

M.SCREENS = {
  { key = "main", label = "\\u4E3B\\u5C4F" },              -- 主屏
  { key = "ctl",  label = "\\u63A7\\u5236\\u5C4F" },        -- 控制屏
}

function M.defaults()
  local d = {}
  for _, s in ipairs(M.SCREENS) do
    d[s.key] = { ox = 0, oy = 0, oz = 0, yaw = 0, pitch = 0, roll = 0, scale = 1 }
  end
  return d
end

--- Clamp one value into the range the hologram will actually accept.
function M.clamp(it, v)
  if it.exclusiveMin and v <= it.min then return it.min end
  if v < it.min then return it.min end
  if v > it.max then return it.max end
  return v
end

function M.format(it, v)
  -- Lua prints -0.0 as "-0.00", which reads like a bug. -0.0 == 0, so this
  -- normalises it without touching any non-zero value.
  if v == 0 then v = 0 end
  return string.format(it.fmt, v)
end

--- Read /settings.cfg. A missing or corrupt file yields defaults: a bad settings
--- file must never keep the player from starting.
function M.load()
  local s = M.defaults()
  local f = fs.open(M.PATH, "r")
  if not f then return s, "no file" end
  local ok, err = pcall(function()
    for line in f.readLine do
      local screen, k, v = line:match("^%s*([%w_]+)%.([%w_]+)%s*=%s*(.-)%s*$")
      if screen and k and M.BY_KEY[k] and s[screen] then
        local n = tonumber(v)
        if n then s[screen][k] = M.clamp(M.BY_KEY[k], n) end
      end
    end
  end)
  f.close()
  if not ok then return M.defaults(), tostring(err) end
  return s, nil
end

function M.save(s)
  local f, err = fs.open(M.PATH, "w")
  if not f then return false, tostring(err) end
  local ok, werr = pcall(function()
    f.writeLine("# hologram view settings, edited by the on-screen panel")
    f.writeLine("# offsets in blocks (|v|<=8), rotations in degrees, scale in (0,4]")
    for _, sc in ipairs(M.SCREENS) do
      for _, it in ipairs(M.ITEMS) do
        f.writeLine(sc.key .. "." .. it.key .. "=" .. string.format("%.4f", s[sc.key][it.key]))
      end
    end
  end)
  f.close()
  if not ok then return false, tostring(werr) end
  return true, nil
end

--- Push one screen's settings onto its hologram. Returns ok, err.
function M.apply(h, v)
  if not h then return false, "no hologram" end
  if not v then return false, "no values" end
  local ok, err = pcall(function()
    h.setOffset(v.ox, v.oy, v.oz)
    h.setRotation(v.yaw, v.pitch, v.roll)
    h.setScale(v.scale)
  end)
  if not ok then return false, tostring(err) end
  return true, nil
end

return M
