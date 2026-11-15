--- Media library picker for the control screen.
--
-- A cover grid on the same hologram the settings panel uses, modelled on the
-- previous-generation player: 128x72 covers, three columns, page up/down, arrows
-- to move, ENTER to play, TAB to switch panels.
--
-- Three costs drive the design:
--
--  * `blit` needs a Lua table, so one cover is ~9216 table entries + a Java draw.
--    Painting all six covers of a page in one go stalls video decoding for ~40ms,
--    which is most of a frame's 50ms budget. So covers are painted from a job
--    queue, at most one per call, and the queue only exists while this panel is
--    visible.
--
--  * Converted tables are cached per page and dropped on page change. A page is
--    six tables (~440KB); keeping all 31 would be ~2.3MB of Lua tables for covers
--    the user cannot even see.
--
--  * Titles are Chinese, and the hologram only renders CJK when the text is a
--    literal "\uXXXX" escape (ParamUtils.unicodeToStr matches that regex). The
--    wire format carries raw UTF-8, so escaping happens here, once.

local M = {}

local GLYPH_DY  = 5
local ADV_ASCII = 8
local ADV_CJK   = 16
local THUMB_W, THUMB_H = 128, 72
local LABEL_H   = 14
local TOP       = 34
local GAP       = 8

local COL = {
  bg      = 0x03,
  bar     = 0x0F,
  text    = 0xFF,
  dim     = 0xAB,
  hint    = 0x57,
  value   = 0xF3,
  sel     = 0x5F,
  card    = 0x07,   -- R0 G0 B1 A3, the empty-cover placeholder
}

local function text(self, x, top, s, color)
  self.h.drawText(x, top - GLYPH_DY, s, color)
end

local function measure(s)
  local n, i = 0, 1
  while i <= #s do
    if s:sub(i, i + 1) == "\\u" then n = n + ADV_CJK; i = i + 6
    else n = n + ADV_ASCII; i = i + 1 end
  end
  return n
end

--- Escape non-ASCII to literal \uXXXX, then truncate to a pixel width.
-- Truncation happens on codepoints, not bytes: cutting mid-sequence would emit a
-- broken escape and the hologram renders a box.
local function fitTitle(s, maxpx)
  local out, w = {}, 0
  for _, cp in utf8.codes(s) do
    local cw = (cp < 0x2E80) and ADV_ASCII or ADV_CJK
    if w + cw > maxpx then break end
    if cp < 0x80 then
      out[#out + 1] = string.char(cp)
    elseif cp <= 0xFFFF then
      out[#out + 1] = string.format("\\u%04X", cp)
    end
    w = w + cw
  end
  return table.concat(out)
end

local function fmtTime(ms)
  local s = math.floor(ms / 1000)
  return string.format("%d:%02d", math.floor(s / 60), s % 60)
end

--- @param o { h=table, send=fn(bytes), request=Fetch }
function M.new(o)
  local self = {
    h = o.h,
    send = o.send,           -- fn(bytes): put a raw message on the ws
    items = {},              -- catalog: { key, title, durationMs }
    byKey = {},
    thumbs = {},             -- key -> packed string (9216 bytes)
    tables = {},             -- key -> converted Lua table (current page only)
    wanted = {},             -- key -> true once requested, so we ask once
    jobs = {},               -- queue of { key, x, y }
    sel = 1,
    page = 1,
    visible = false,
    ready = false,
    dirty = true,
    catalogueVer = 0,
    msg = nil,
    msgUntil = 0,
  }

  function self.setMessage(s)
    self.msg = s
    self.msgUntil = os.clock() + 3
  end

  --- Grid geometry for the current screen size. Recomputed rather than cached so
  --- a hologram resize cannot leave stale layout behind.
  function self.metrics()
    local W, H = M.W, M.H
    local cols = math.max(1, math.floor((W - GAP * 2 + GAP) / (THUMB_W + GAP)))
    local cellH = THUMB_H + LABEL_H + GAP
    local rows = math.max(1, math.floor((H - 20 - TOP - GAP) / cellH))
    local totalW = cols * THUMB_W + (cols - 1) * GAP
    return cols, rows, math.floor((W - totalW) / 2), TOP, cellH
  end

  function self.perPage()
    local cols, rows = self.metrics()
    return cols * rows
  end

  function self.pages()
    return math.max(1, math.ceil(#self.items / self.perPage()))
  end

  --- Replace the catalog. Keeps the selection if that item still exists, because
  --- a hot reload happens while the user is looking at the grid and jumping back
  --- to item 1 would be surprising.
  function self.setCatalog(items)
    local keepKey = self.items[self.sel] and self.items[self.sel].key
    self.items = items
    self.byKey = {}
    for i, it in ipairs(items) do self.byKey[it.key] = { item = it, index = i } end
    self.catalogueVer = self.catalogueVer + 1
    self.tables = {}
    self.jobs = {}
    self.sel = 1
    if keepKey and self.byKey[keepKey] then self.sel = self.byKey[keepKey].index end
    if self.sel > #self.items then self.sel = math.max(1, #self.items) end
    self.page = math.max(1, math.floor((self.sel - 1) / self.perPage()) + 1)
    self.dirty = true
    if self.visible then self.requestPage() end
  end

  function self.addThumb(key, pixels)
    if not self.byKey[key] then return end
    self.thumbs[key] = pixels
    self.tables[key] = nil
    self.dirty = true
  end

  --- Ask the server for the covers on the current page that we do not have.
  function self.requestPage()
    local cols, rows = self.metrics()
    local first = (self.page - 1) * cols * rows
    for slot = 1, cols * rows do
      local it = self.items[first + slot]
      if it and not self.thumbs[it.key] and not self.wanted[it.key] then
        self.wanted[it.key] = true
        self.send(string.char(0x1A) .. it.key)   -- THUMB_REQ
      end
    end
  end

  function self.init()
    local ok, err = pcall(function()
      self.h.resize(M.W, M.H)
      self.h.setColorMapping(0, 85, 170, 255)
      -- unicodeMode must stay on: the escapes above are only decoded when it is.
      self.h.setUnicodeMode(true)
      self.h.releaseAllFrameBuffer()
      self.h.activateFrameBuffer(-1)
    end)
    if not ok then return false, tostring(err) end
    self.ready = true
    return true, nil
  end

  function self.show()
    self.visible = true
    self.dirty = true
    self.requestPage()
    self.draw()
  end

  function self.hide()
    self.visible = false
    self.jobs = {}
    if not self.ready then return end
    pcall(function()
      self.h.clear(COL.bg)
      self.h.sync()
    end)
  end

  --- Move the cursor by `dx`/`dy` cells, wrapping across pages.
  function self.move(dx, dy)
    local cols, rows = self.metrics()
    local per = cols * rows
    local n = #self.items
    if n == 0 then return false end
    local slot = (self.sel - 1) % per
    local col, row = slot % cols, math.floor(slot / cols)
    col = col + dx
    row = row + dy
    if col < 0 then col = cols - 1 elseif col >= cols then col = 0 end
    if row < 0 then row = rows - 1 elseif row >= rows then row = 0 end
    local newIndex = (self.page - 1) * per + row * cols + col + 1
    if newIndex > n then
      -- Landing past the last item: clamp to it when on the final page, else wrap
      -- back a page. Clamping feels better than a dead key.
      if self.page >= self.pages() then newIndex = n else newIndex = newIndex - per end
      if newIndex < 1 then newIndex = 1 end
    end
    if newIndex == self.sel then return false end
    self.sel = newIndex
    local newPage = math.max(1, math.floor((newIndex - 1) / per) + 1)
    if newPage ~= self.page then
      self.page = newPage
      self.tables = {}
      self.jobs = {}
      self.requestPage()
    end
    self.dirty = true
    return true
  end

  function self.flip(delta)
    if #self.items == 0 then return false end
    local per = self.perPage()
    local target = self.page + delta
    if target < 1 or target > self.pages() then return false end
    self.page = target
    self.sel = math.min((target - 1) * per + 1, #self.items)
    self.tables = {}
    self.jobs = {}
    self.requestPage()
    self.dirty = true
    return true
  end

  function self.selected()
    return self.items[self.sel]
  end

  --- Called by wall.lua on key events while this panel is visible.
  -- Returns "play" (caller sends SELECT), "settings" (switch panel), "close",
  -- or a redraw signal.
  function self.handleKey(key)
    if key == keys.up then return self.move(0, -1) and "redraw" or nil end
    if key == keys.down then return self.move(0, 1) and "redraw" or nil end
    if key == keys.left then return self.move(-1, 0) and "redraw" or nil end
    if key == keys.right then return self.move(1, 0) and "redraw" or nil end
    if key == keys.pageUp then return self.flip(-1) and "redraw" or nil end
    if key == keys.pageDown then return self.flip(1) and "redraw" or nil end
    if key == keys.enter then
      if #self.items == 0 then return nil end
      return "play"
    end
    if key == keys.tab then return "settings" end
    return nil
  end

  --- Typed characters.
  --
  -- Letters are handled here, not in handleKey, to match gui.lua: it already takes
  -- "[", "]", "r", "0" and "q" from char events. `keys.q` does exist (tKeys[81]),
  -- but splitting the two panels across different event types is how you end up
  -- with one panel whose close key silently does nothing. char is also the right
  -- choice for letters generally, since a key event reports the physical key and
  -- a non-US layout would not produce keys.q for the key labelled Q.
  function self.handleChar(ch)
    if ch == "q" or ch == "Q" then return "close" end
    return nil
  end

  --- Convert a packed cover into the table `blit` needs, cached.
  local function tableView(self, key)
    local t = self.tables[key]
    if t then return t end
    local s = self.thumbs[key]
    if not s then return nil end
    local n = #s
    local out = {}
    local i, p = 0, 1
    while p + 15 <= n do
      local b1, b2, b3, b4, b5, b6, b7, b8,
            b9, b10, b11, b12, b13, b14, b15, b16 = string.byte(s, p, p + 15)
      out[i] = b1;     out[i + 1] = b2;  out[i + 2] = b3;  out[i + 3] = b4
      out[i + 4] = b5; out[i + 5] = b6;  out[i + 6] = b7;  out[i + 7] = b8
      out[i + 8] = b9; out[i + 9] = b10; out[i + 10] = b11; out[i + 11] = b12
      out[i + 12] = b13; out[i + 13] = b14; out[i + 14] = b15; out[i + 15] = b16
      i = i + 16; p = p + 16
    end
    while p <= n do
      out[i] = string.byte(s, p); i = i + 1; p = p + 1
    end
    self.tables[key] = out
    return out
  end

  function self.draw()
    if not self.ready or not self.visible then return end
    local h = self.h
    local W, H = M.W, M.H
    local cols, rows, x0, y0, cellH = self.metrics()

    h.clear(COL.bg)
    h.fill(0, 0, W, 22, COL.bar)
    text(self, 10, 6, "\\u5A92\\u4F53\\u5E93", COL.text)   -- 媒体库
    local pageNo = self.page
    local label = string.format("  %d/%d  (%d)", pageNo, self.pages(), #self.items)
    text(self, 10 + measure("\\u5A92\\u4F53\\u5E93") + 8, 6, label, COL.dim)

    self.jobs = {}
    local first = (pageNo - 1) * cols * rows
    for slot = 1, cols * rows do
      local index = first + slot
      local it = self.items[index]
      if it then
        local col = (slot - 1) % cols
        local row = math.floor((slot - 1) / cols)
        local x = x0 + col * (THUMB_W + GAP)
        local y = y0 + row * cellH
        local selected = (index == self.sel)
        if selected then
          h.fill(x - 2, y - 2, THUMB_W + 4, THUMB_H + 4, COL.sel)
        end
        h.fill(x, y, THUMB_W, THUMB_H, COL.card)
        -- Defer the actual draw: see the module header for why.
        self.jobs[#self.jobs + 1] = { key = it.key, x = x, y = y }
        text(self, x, y + THUMB_H + 3, fitTitle(it.title, THUMB_W),
             selected and COL.text or COL.dim)
        text(self, x, y + THUMB_H + 3, "", COL.dim)
        local dur = fmtTime(it.durationMs)
        text(self, x + THUMB_W - measure(dur), y + THUMB_H + 3, dur,
             selected and COL.value or COL.hint)
      end
    end

    if #self.items == 0 then
      text(self, x0, y0 + 20, "\\u5A92\\u4F53\\u5E93\\u4E3A\\u7A7A", COL.dim)  -- 媒体库为空
    end

    h.fill(0, H - 26, W, 26, COL.bg)
    if self.msg and os.clock() < self.msgUntil then
      text(self, 12, H - 20, self.msg, COL.value)
    else
      text(self, 12, H - 20,
           "Arrows  PgUp/PgDn  Enter=play  Tab=settings  Q=hide", COL.hint)
    end

    h.sync()
    self.dirty = false
  end

  --- Paint queued covers, bounded by a time budget.
  -- Returns true if anything was painted.
  function self.paintThumbs(budgetMs)
    if not self.ready or not self.visible or #self.jobs == 0 then return 0 end
    local started = os.epoch("utc")
    local painted = 0
    while #self.jobs > 0 do
      local job = table.remove(self.jobs, 1)
      local tbl = tableView(self, job.key)
      if tbl then
        local ok = pcall(function()
          self.h.blit(job.x, job.y, THUMB_W, THUMB_H, tbl)
        end)
        -- A failed blit means the hologram went away; stop rather than burn the
        -- budget on a doomed call for every remaining cover.
        if not ok then break end
        painted = painted + 1
      end
      if os.epoch("utc") - started >= budgetMs then break end
    end
    if painted > 0 then pcall(function() self.h.sync() end) end
    return painted
  end

  self.M = M
  return self
end

M.W, M.H = 480, 270

return M
