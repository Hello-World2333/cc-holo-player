--- On-hologram settings panel for the control screen.
--
-- Drawn straight onto a VoidPower hologram (fill / drawText), not onto a CC
-- terminal: the control screen is itself a hologram on a data-hub pin.
--
-- Two details drive the code below:
--
--  * Chinese only renders when the text contains LITERAL "\\uXXXX" escapes, not
--    UTF-8. PvoidPower's ParamUtils.unicodeToStr matches the regex
--    (\\u(\p{XDigit}{4})) and does parseInt(...,16) on the group, so a real
--    multi-byte character is passed through untouched and comes out as the
--    "unknown glyph" box. setUnicodeMode(true) is what enables the conversion.
--
--  * Pixels are one byte of packed RRGGBBAA, 2 bits per channel (the same format
--    the video path uses). Alpha 0 is invisible, so even "black" needs A=3.
--    Colors below are written in hex with the channel layout in the comment.

local M = {}

M.W, M.H = 480, 270

-- Font metrics, measured on the real peripheral: drawText(x, y) puts the glyph
-- top at y+5, the glyph is 11 px tall, and the advance is 8 px per ASCII cell
-- and 16 px per full-width (CJK) character.
local GLYPH_DY   = 5
local ADV_ASCII  = 8
local ADV_CJK    = 16
local ROW_H      = 18

local COL = {
  bg       = 0x03,   -- R0 G0 B0 A3  opaque black
  bar      = 0x0F,   -- R0 G0 B3 A3  blue
  barSel   = 0x5F,   -- R1 G1 B3 A3  bright blue
  text     = 0xFF,   -- R3 G3 B3 A3  white
  dim      = 0xAB,   -- R2 G2 B2 A3  light grey
  hint     = 0x57,   -- R1 G1 B1 A3  grey
  value    = 0xF3,   -- R3 G3 B0 A3  yellow
  rowSel   = 0x0B,   -- R0 G0 B2 A3  dark blue
}

local function text(surface, x, top, s, color)
  surface.h.drawText(x, top - GLYPH_DY, s, color)
end

--- Pixel width of an escape string. Counts "\\u" sequences as full width.
local function measure(s)
  local n, i = 0, 1
  while i <= #s do
    if s:sub(i, i + 1) == "\\u" then n = n + ADV_CJK; i = i + 6
    else n = n + ADV_ASCII; i = i + 1 end
  end
  return n
end

--- @param o { h=table, settings=table, values=table, onChange=fn }
function M.new(o)
  local self = {
    h = o.h,
    settings = o.settings,
    values = o.values,       -- the whole per-screen value table
    onChange = o.onChange,   -- fn(screenKey, itemKey, value)
    screen = 1,              -- index into settings.SCREENS
    sel = 1,
    msg = nil,
    msgUntil = 0,
    visible = true,
    ready = false,
  }

  function self.screenKey() return self.settings.SCREENS[self.screen].key end

  --- Hide the panel. The screen is blanked because the control hologram is not
  --- double-buffered: leaving the old frame up would look like a frozen UI.
  function self.hide()
    self.visible = false
    if not self.ready then return end
    pcall(function()
      self.h.clear(COL.bg)
      self.h.sync()
    end)
  end

  function self.show()
    self.visible = true
    self.draw()
  end
  function self.vals() return self.values[self.screenKey()] end

  function self.setMessage(s)
    self.msg = s
    self.msgUntil = os.clock() + 3
  end

  --- Create the drawing surface. Called once; resize() reallocates and loses
  --- the contents, so it must not happen on every redraw.
  function self.init()
    local ok, err = pcall(function()
      self.h.resize(M.W, M.H)
      self.h.setColorMapping(0, 85, 170, 255)
      self.h.setUnicodeMode(true)
      self.h.releaseAllFrameBuffer()
      self.h.activateFrameBuffer(-1)
    end)
    if not ok then return false, tostring(err) end
    self.ready = true
    return true, nil
  end

  local function persist()
    local ok, err = self.settings.save(self.values)
    if not ok then self.setMessage("save failed") end
    return ok, err
  end
  self.persist = persist

  function self.adjust(delta)
    local it = self.settings.ITEMS[self.sel]
    local v = self.vals()
    local before = v[it.key]
    local after = self.settings.clamp(it, before + delta)
    if after == before then
      -- Hitting a range end must not look like a dead key.
      self.setMessage("limit")
      return false
    end
    v[it.key] = after
    if self.onChange then self.onChange(self.screenKey(), it.key, after) end
    persist()
    return true
  end

  function self.resetCurrent()
    local it = self.settings.ITEMS[self.sel]
    local d = self.settings.defaults()[self.screenKey()][it.key]
    self.vals()[it.key] = d
    if self.onChange then self.onChange(self.screenKey(), it.key, d) end
    persist()
    self.setMessage("reset")
    return true
  end

  function self.resetScreen()
    local d = self.settings.defaults()[self.screenKey()]
    local v = self.vals()
    for k, val in pairs(d) do
      v[k] = val
      if self.onChange then self.onChange(self.screenKey(), k, val) end
    end
    persist()
    self.setMessage("default")
    return true
  end

  --- Arrow keys and Tab. Returns "changed" | "screen" | nil.
  --- Split from handleChar because the `keys` table's punctuation names are not
  --- worth depending on; only the names bios.lua itself uses are safe.
  function self.handleKey(code)
    local items = self.settings.ITEMS
    if code == keys.up then
      self.sel = (self.sel - 2) % #items + 1
      return "changed"
    elseif code == keys.down then
      self.sel = self.sel % #items + 1
      return "changed"
    elseif code == keys.left then
      return self.adjust(-items[self.sel].coarse) and "changed" or nil
    elseif code == keys.right then
      return self.adjust(items[self.sel].coarse) and "changed" or nil
    elseif code == keys.tab then
      self.screen = self.screen % #self.settings.SCREENS + 1
      self.sel = 1
      return "screen"
    end
    return nil
  end

  --- Typed characters. Returns "changed" | "close" | nil.
  function self.handleChar(ch)
    local items = self.settings.ITEMS
    if ch == "[" then
      return self.adjust(-items[self.sel].fine) and "changed" or nil
    elseif ch == "]" then
      return self.adjust(items[self.sel].fine) and "changed" or nil
    elseif ch == "r" then
      return self.resetCurrent() and "changed" or nil
    elseif ch == "0" then
      return self.resetScreen() and "changed" or nil
    elseif ch == "q" then
      return "close"
    end
    return nil
  end

  function self.draw()
    if not self.ready then return end
    local h = self.h
    local w = M.W
    local items = self.settings.ITEMS
    local v = self.vals()

    h.clear(COL.bg)

    -- title bar
    h.fill(0, 0, w, 22, COL.bar)
    text(self, 10, 6, "\\u8BBE\\u7F6E", COL.text)   -- 设置

    -- screen tabs
    local tx = 168
    for i, sc in ipairs(self.settings.SCREENS) do
      local active = (i == self.screen)
      local tw = measure(sc.label) + 24
      h.fill(tx, 3, tw, 16, active and COL.barSel or COL.bg)
      text(self, tx + 12, 6, sc.label, active and COL.text or COL.hint)
      tx = tx + tw + 8
    end

    -- rows
    local y = 40
    for i, it in ipairs(items) do
      local selected = (i == self.sel)
      if selected then h.fill(16, y - 4, w - 32, ROW_H - 2, COL.rowSel) end
      text(self, 28, y, it.label, selected and COL.text or COL.dim)
      text(self, 250, y, self.settings.format(it, v[it.key]),
           selected and COL.value or COL.dim)
      y = y + ROW_H
    end

    -- footer
    h.fill(0, M.H - 26, w, 26, COL.bg)
    if self.msg and os.clock() < self.msgUntil then
      text(self, 12, M.H - 20, self.msg, COL.value)
    else
      text(self, 12, M.H - 20,
           "Up/Dn  L/R  [ ] fine  R=reset  0=default  Tab=screen  Q=hide", COL.hint)
    end

    h.sync()
  end

  return self
end

return M
