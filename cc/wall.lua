-- cc-video-wall player for a single VoidPower hologram.
-- Reads /wall.cfg, connects to the ccv stream server, decodes and draws.

local decoder = dofile("/decoder.lua")
local settings = dofile("/settings.lua")

local CFG_PATH = "/wall.cfg"

local function say(...)
  local parts = {}
  for i = 1, select("#", ...) do parts[i] = tostring(select(i, ...)) end
  local line = table.concat(parts, " ")
  print(line)
  if _G.LOGFILE then
    local f = fs.open(_G.LOGFILE, "a")
    if f then f.writeLine(line); f.close() end
  end
end

local function loadCfg()
  if not fs.exists(CFG_PATH) then
    error("missing " .. CFG_PATH .. '  (expected textutils.serialise format without "return")')
  end
  local f = fs.open(CFG_PATH, "r")
  local txt = f.readAll(); f.close()
  local fn, err = load("return " .. txt, "cfg", "t")
  if not fn then error("bad " .. CFG_PATH .. ": " .. tostring(err)) end
  return fn()
end

local cfg = loadCfg()
if cfg.log then
  _G.LOGFILE = "/wall.log"
  if fs.exists(_G.LOGFILE) then fs.delete(_G.LOGFILE) end
end

-- ---------- find the hologram ----------
local h = peripheral.find("hologram")
if not h then error("no hologram peripheral attached") end

local function findMethods()
  -- peripheral.find gives us the wrapped object; verify the methods we need exist.
  for _, name in ipairs({ "resize", "setColorMapping", "blit", "activateFrameBuffer",
                          "blitFrameBufferArea", "allocateFrameBuffer",
                          "releaseAllFrameBuffer", "sync" }) do
    if type(h[name]) ~= "function" then
      error("hologram is missing method: " .. name)
    end
  end
end
findMethods()

-- ---------- view settings + control panel ----------
-- Two holograms, two independent transforms:
--   main = the video wall, found as a normal side-attached peripheral
--   ctl  = the control screen, which hangs off a CEE data-hub pin and is only
--          reachable through cee.getPeripheral, not peripheral.getNames()
local view, viewErr = settings.load()
say("settings loaded" .. (viewErr and (" (" .. viewErr .. ")") or ""))

local ctlHolo = nil
local ctlWhere = "none"
if cfg.ctlHub and cfg.ctlPin then
  local ok, res = pcall(cee.getPeripheral, { cfg.ctlHub, cfg.ctlPin })
  if ok and res then
    ctlHolo, ctlWhere = res, ("hub %d pin %d"):format(cfg.ctlHub, cfg.ctlPin)
  else
    ctlWhere = ("hub %d pin %d unavailable (%s)"):format(
      cfg.ctlHub, cfg.ctlPin, tostring(ok and "empty" or res))
  end
end
say("control screen: " .. ctlWhere)

-- Called on every edit so the holograms and the file can never disagree.
local function pushScreen(screenKey)
  local target = (screenKey == "main") and h or ctlHolo
  if not target then return end
  local ok, err = settings.apply(target, view[screenKey])
  if not ok then say(("apply %s failed: %s"):format(screenKey, tostring(err))) end
end

pushScreen("main")
if ctlHolo then pushScreen("ctl") end

local gui = nil
if ctlHolo and cfg.gui ~= false then
  local guiMod = dofile("/gui.lua")
  gui = guiMod.new({
    h = ctlHolo,
    settings = settings,
    values = view,
    onChange = function(screenKey) pushScreen(screenKey) end,
  })
  local ok, err = gui.init()
  if not ok then
    say("control screen init failed: " .. tostring(err))
    gui = nil
  else
    gui.draw()
    say("control panel ready (Q hides)")
  end
end

-- ---------- state ----------
local st = {
  block = 16,
  bx = 0, by = 0,
  regionW = 0, regionH = 0,
  prevId = -1,
  displayId = -1,
}

local function setupFromHello(msg)
  local version = string.byte(msg, 2)
  local block   = string.byte(msg, 3)
  local fps     = string.byte(msg, 4)
  local wallW   = string.byte(msg, 5) * 256 + string.byte(msg, 6)
  local wallH   = string.byte(msg, 7) * 256 + string.byte(msg, 8)
  local rx      = string.byte(msg, 9) * 256 + string.byte(msg, 10)
  local ry      = string.byte(msg, 11) * 256 + string.byte(msg, 12)
  local rw      = string.byte(msg, 13) * 256 + string.byte(msg, 14)
  local rh      = string.byte(msg, 15) * 256 + string.byte(msg, 16)

  if version ~= 1 then error("protocol version mismatch: server=" .. version .. " client=1") end

  st.block   = block
  st.regionW = rw
  st.regionH = rh
  st.bx = math.ceil(rw / block)
  st.by = math.ceil(rh / block)

  -- One hologram holds one buffer, so region must be the whole wall.
  if rx ~= 0 or ry ~= 0 or rw ~= wallW or rh ~= wallH then
    error(("region %d,%d %dx%d does not cover wall %dx%d (single-screen build)"):format(rx, ry, rw, rh, wallW, wallH))
  end

  h.resize(wallW, wallH)
  -- 2-bit channels -> full 8-bit, in place.
  h.setColorMapping(0, 85, 170, 255)

  h.releaseAllFrameBuffer()
  st.displayId = -1   -- -1 means "the display buffer"
  st.prevId = h.allocateFrameBuffer(rw, rh)
  if st.prevId < 0 then error("allocateFrameBuffer failed (slots full?)") end
  h.activateFrameBuffer(st.displayId)

  say(("hello v%d %dx%d block=%d region=%d,%d %dx%d fps=%d prev=%d")
      :format(version, wallW, wallH, block, rx, ry, rw, rh, fps, st.prevId))
  return fps
end

-- ---------- main loop ----------
local url = cfg.url
if not url then error("cfg.url missing") end
-- `name` selects the video. It used to be a silent no-op: the server falls back
-- to the first directory it finds, so an unset/ignored name played the wrong
-- film with no warning anywhere — the config said one thing and the screen
-- showed another. Fold it into the URL unless it is already there.
if cfg.name and not url:find("video=", 1, true) then
  url = url .. (url:find("?", 1, true) and "&" or "?") .. "video=" .. tostring(cfg.name)
end

local function connect()
  say("connecting " .. url)
  local ws, err = http.websocket(url)
  if not ws then error("websocket failed: " .. tostring(err)) end
  return ws
end

--- Send a binary control message.
-- CC's Lua handle exposes only send/close/receive/getResponseHeaders — there is
-- no sendBinary, and sendBinary/sendText are Java-internal. The frame type is
-- chosen by the second argument: send(msg, true) = binary, send(msg) = text.
-- Sending a control message as text is not harmless: the server's ws library
-- validates the TEXT payload as UTF-8 and rewrites bytes >= 0x80 to U+FFFD,
-- which was observed as a bogus "ack status=191 decode=48384ms" (48384 = 0xBD00,
-- part of the replacement character).
local function sendBin(ws, s)
  pcall(ws.send, s, true)
end

local function sendAck(ws, seq, decodeMs)
  sendBin(ws, string.char(0x13, math.floor(seq / 256) % 256, seq % 256, 0,
                          math.floor(decodeMs / 256) % 256, decodeMs % 256))
end

-- If no FRAME arrives for this long, assume the stream is wedged and reconnect.
-- This is not paranoia: the credit window is the only thing making the server
-- send, so a single lost websocket message deadlocks BOTH ends silently. If the
-- lost message happens to be a frame's LAST part, nothing ever arrives to trip
-- the out-of-order check, os.pullEvent() blocks forever, no ACK is sent, the
-- server's in-flight window stays full, and the wall freezes with no log line.
--
-- os.clock() cannot be used here: OSAPI.clock() is an int incremented once per
-- server tick, so it stalls exactly when the server lags. os.epoch is wall time.
-- Two clocks are needed, and the pair is the whole point:
--   * wall clock (os.epoch) notices that time passed at all;
--   * tick clock (os.clock) proves WE were running during that time.
-- The server here stalls for ~11 s at a time ("Can't keep up!"), and while it is
-- stalled the computer does not tick either — so a wall-clock-only watchdog
-- fires on every lag spike and reconnects for no reason (observed: "no frame for
-- 5706ms" three seconds into a healthy stream). A wedged socket is different:
-- the computer keeps ticking, frames keep not arriving, and os.clock advances.
local STALL_MS    = 5000   -- wall clock
local STALL_TICKS = 3.0    -- game seconds of actual execution

local function nowMs()
  local ok, t = pcall(os.epoch, "utc")
  if ok and type(t) == "number" then return t end
  return math.floor(os.clock() * 1000)   -- very old CraftOS fallback
end

local function runOnce(ws)
  local curSeq, nextPart, frameParts = -1, 0, 0
  local broken = false
  local frameStart = 0
  local stats = { frames = 0, mv = 0, raw = 0, bytes = 0, decoded = 0 }
  local runStart = os.clock()
  local lastFrameAt = nowMs()
  local lastFrameClock = os.clock()

  -- 1 Hz liveness tick. os.startTimer survives a wedged socket; a websocket
  -- event never will, which is why the watchdog cannot be event-driven.
  -- `watchdog` must be declared BEFORE armTimer closes over it: a later
  -- `local watchdog` would leave the closure writing to a global, so
  -- `p1 == watchdog` would never match and the timer would fire unnoticed.
  local watchdog
  local function armTimer()
    pcall(os.cancelTimer, watchdog)
    watchdog = os.startTimer(1)
  end
  armTimer()

  while true do
    local ev, p1, p2, p3 = os.pullEvent()

    if ev == "timer" and p1 == watchdog then
      armTimer()
      local wallGap  = nowMs() - lastFrameAt
      local clockGap = os.clock() - lastFrameClock
      if wallGap > STALL_MS and clockGap > STALL_TICKS then
        say(("no frame for %dms (%.1fs of game time), reconnecting")
            :format(wallGap, clockGap))
        return "stalled"
      end

    elseif ev == "websocket_message" and p1 == url then
      -- CC:T pushes websocket_message as (address, message, isBinary) — verified
      -- against cc-tweaked-1.21.1-forge-1.120.0.jar (WebsocketHandler).
      local msg = p2
      local t = string.byte(msg, 1)
      if t == 0x01 then
        stats.msgs = 0
        setupFromHello(msg)
        -- Tell the server we finished resizing/allocating. Without this the
        -- server streams immediately and the very first frame is lost while
        -- resize() is still running.
        sendBin(ws, string.char(0x02))
      elseif t == 0x10 then
        local t0 = os.clock()
        lastFrameAt = nowMs()
        lastFrameClock = os.clock()
        stats.msgs = (stats.msgs or 0) + 1
        local seq, part, parts, drawn = decoder.applyFrame(h, msg, st)
        stats.decoded = stats.decoded + drawn
        stats.bytes = stats.bytes + #msg
        if seq ~= curSeq or part == 0 then
          curSeq, nextPart, frameParts = seq, 0, parts
          frameStart = t0
          broken = false
        end
        if part ~= nextPart then
          -- A websocket message went missing (or arrived out of order). Blocks
          -- already written are unrecoverable: the display no longer matches the
          -- server's model, so redraw from scratch rather than run ahead corrupt.
          broken = true
        end
        nextPart = part + 1
        if part == parts - 1 then
          sendAck(ws, seq, math.floor((os.clock() - frameStart) * 1000))
          if broken then
            say("lost part in seq=" .. tostring(seq) .. ", resyncing")
            return "resync"
          end
          decoder.snapshot(h, st)
          h.sync()
          stats.frames = stats.frames + 1
          local ms = math.floor((os.clock() - frameStart) * 1000)
          if stats.frames == 1 or stats.frames % 20 == 0 then
            local el = os.clock() - runStart
            say(("frames=%d %.1ffps blocks=%d %.1fKB/s last=%dms")
                :format(stats.frames, stats.frames / el, stats.decoded, stats.bytes / 1024 / el, ms))
          end
        end
      elseif t == 0x14 then
        local cmd = string.byte(msg, 2)
        say("control cmd=" .. cmd)
        if cmd == 4 then return "stop" end
      elseif t == 0x30 then
        sendBin(ws, string.char(0x31))
      end

    elseif ev == "websocket_closed" and p1 == url then
      return "closed"

    elseif gui and (ev == "key" or ev == "char") then
      -- Shares the video's event loop: editing must not stall the stream, and
      -- there is no second process to race with.
      if not gui.visible then
        if (ev == "char" and p1 == "q") or (ev == "key" and p1 == keys.tab) then
          gui.show()
        end
      else
        local res = (ev == "key") and gui.handleKey(p1) or gui.handleChar(p1)
        if res == "close" then
          gui.hide()
        elseif res then
          gui.draw()
        end
      end

    elseif ev == "peripheral_detach" or ev == "peripheral" then
      -- hologram went away; re-find it next round
      return "peripheral"
    end
  end
end

while true do
  local ok, ws = pcall(connect)
  if not ok or not ws then
    say("connect error: " .. tostring(ws))
    sleep(2)
  else
    local ok2, why = pcall(runOnce, ws)
    pcall(ws.close)
    if not ok2 then
      say("run error: " .. tostring(why))
      sleep(2)
    elseif why == "stop" then
      say("stopped by server")
      break
    elseif why == "resync" then
      -- reconnect: the server restarts at frame 0, which is a full key frame
      sleep(1)
    else
      say("disconnected (" .. tostring(why) .. "), reconnecting")
      sleep(2)
    end
  end
  -- the hologram may have been re-placed while we were away
  h = peripheral.find("hologram")
  if not h then
    say("hologram gone, waiting")
    sleep(3)
  end
  -- A reconnect re-resizes the video hologram, and resize() is not guaranteed to
  -- preserve the block-entity transform, so re-assert both screens from the file.
  pushScreen("main")
  if ctlHolo then pushScreen("ctl") end
end
