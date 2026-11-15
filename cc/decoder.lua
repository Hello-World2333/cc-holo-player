-- ccv v1 frame decoder. Mirrors node/src/codec.ts applyFrame exactly.
-- Only RAW blocks touch Lua per-pixel code (blit needs a table); MV is pure Java.

local bit32 = bit32
local sub, byte, floor = string.sub, string.byte, math.floor

local MODE_MV, MODE_RAW = 1, 2

local M = {}

--- 0-based linear index table from a byte string.
-- 16 per batch: measured 3x faster than one byte at a time (probe3.log).
local function buildTable(s)
  local n = #s
  local t = {}
  local i, p = 0, 1
  while p + 15 <= n do
    local b1, b2, b3, b4, b5, b6, b7, b8,
          b9, b10, b11, b12, b13, b14, b15, b16 = byte(s, p, p + 15)
    t[i] = b1;     t[i + 1] = b2;  t[i + 2] = b3;  t[i + 3] = b4
    t[i + 4] = b5; t[i + 5] = b6;  t[i + 6] = b7;  t[i + 7] = b8
    t[i + 8] = b9; t[i + 9] = b10; t[i + 10] = b11; t[i + 11] = b12
    t[i + 12] = b13; t[i + 13] = b14; t[i + 14] = b15; t[i + 15] = b16
    i = i + 16; p = p + 16
  end
  while p <= n do
    t[i] = byte(s, p)
    i = i + 1; p = p + 1
  end
  return t
end
M.buildTable = buildTable

--- Decode one FRAME message and draw it.
-- Returns seq, part, parts, drawnBlocks
function M.applyFrame(h, msg, st)
  local seq   = byte(msg, 2) * 256 + byte(msg, 3)
  local part  = byte(msg, 5)
  local parts = byte(msg, 6)
  local bx    = byte(msg, 7)
  local by    = byte(msg, 8)
  local B     = st.block

  local nBitmap = floor((bx * by + 7) / 8)
  local bmOff   = 9                      -- 1-based: 8-byte header
  local p       = bmOff + nBitmap

  h.activateFrameBuffer(st.displayId)

  local drawn, total = 0, bx * by
  local prevId = st.prevId

  for i = 0, total - 1 do
    local byteIdx = bmOff + floor(i / 8)
    if bit32.band(byte(msg, byteIdx), bit32.lshift(1, i % 8)) ~= 0 then
      local mode = byte(msg, p); p = p + 1
      local px = (i % bx) * B
      local py = floor(i / bx) * B
      if mode == MODE_RAW then
        local tbl = buildTable(sub(msg, p, p + B * B - 1))
        p = p + B * B
        h.blit(px, py, B, B, tbl)
      elseif mode == MODE_MV then
        local dx = byte(msg, p) - 128
        local dy = byte(msg, p + 1) - 128
        p = p + 2
        -- Java-side memcpy from prev; zero Lua per-pixel work.
        h.blitFrameBufferArea(px, py, px + dx, py + dy, B, B, prevId)
      else
        error("ccv: unknown block mode " .. tostring(mode))
      end
      drawn = drawn + 1
    end
  end

  -- part/parts are returned so the caller can detect a lost ws message. The
  -- wire format has no redundancy, so a missing part means the display no
  -- longer matches the encoder's model and the frame must be thrown away.
  return seq, part, parts, drawn
end

--- Copy display -> prev so the next frame's MV reads frame N-1.
function M.snapshot(h, st)
  h.activateFrameBuffer(st.prevId)
  h.blitFrameBufferArea(0, 0, 0, 0, st.regionW, st.regionH, st.displayId)
end

return M
