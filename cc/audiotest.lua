-- Real-machine audio self-test.
--
-- Connects to the stream server, picks the first catalog item, and drives the
-- HQ speaker path exactly as wall.lua does. The point is to time the part the
-- Node test cannot: speakAppend over 1.5 MB on a real CraftOS Lua, and whether
-- speakEnd actually starts the sound on all eight speakers.
local out = fs.open("/audiotest.log", "w")
local function log(...)
  local p = {}
  for i = 1, select("#", ...) do p[i] = tostring(select(i, ...)) end
  out.writeLine(string.format("%6dms ", os.epoch("utc") % 100000) .. table.concat(p, " "))
  out.flush()
end

local URL = "ws://127.0.0.1:18756/play?token=dev"
local audMod = dofile("/audio.lua")
local aud = audMod.new({ cfg = { audioHub = 8, audioPin = 4 }, say = log, volume = 1.0 })
log("speakers=" .. tostring(aud.count) .. " available=" .. tostring(aud.available()))

local ws, err = http.websocket(URL)
if not ws then log("connect failed: " .. tostring(err)); out.close(); return end
log("connected")

local t_open, t_first_chunk, t_done, t_start = nil, nil, nil, nil
local chunks, stagedBytes = 0, 0
local frames = 0
local done = false
local deadline = os.epoch("utc") + 40000

while os.epoch("utc") < deadline do
  local ev, p1, p2 = os.pullEvent()
  if ev == "websocket_message" and p1 == URL then
    local t = string.byte(p2, 1)
    if t == 0x18 then
      -- CATALOG: pick the first item so the test needs no keyboard.
      local key = string.sub(p2, 4, 11)
      local len = string.byte(p2, 14) * 256 + string.byte(p2, 15)
      log("catalog first item key=" .. key .. " title=" .. string.sub(p2, 16, 15 + len))
      ws.send(string.char(0x17) .. key, true)
    elseif t == 0x1b then
      t_open = os.epoch("utc")
      local total = string.byte(p2, 2) * 16777216 + string.byte(p2, 3) * 65536
                  + string.byte(p2, 4) * 256 + string.byte(p2, 5)
      local st = aud.onOpen(total)
      log(("OPEN total=%d status=%d"):format(total, st))
      if st ~= 0 then ws.send(string.char(0x1e, st), true) end
    elseif t == 0x1c then
      if not t_first_chunk then t_first_chunk = os.epoch("utc") end
      chunks = chunks + 1
      stagedBytes = stagedBytes + #p2 - 1
      aud.onChunk(string.sub(p2, 2))
    elseif t == 0x1d then
      t_done = os.epoch("utc")
      local st = aud.onDone()
      log(("DONE chunks=%d bytes=%d status=%d append_ms=%d")
          :format(chunks, stagedBytes, st, (t_done - t_open)))
      ws.send(string.char(0x1e, st), true)
    elseif t == 0x1f then
      t_start = os.epoch("utc")
      local ok = aud.onStart()
      log("START ok=" .. tostring(ok) .. " playing=" .. tostring(aud.isPlaying()))
      log(("sync: audio started %dms after OPEN"):format(t_start - t_open))
      done = true
    elseif t == 0x01 then
      log("HELLO")
      ws.send(string.char(0x02), true)
    elseif t == 0x10 then
      frames = frames + 1
      if frames == 1 then log("first FRAME") end
      local part = string.byte(p2, 5)
      local parts = string.byte(p2, 6)
      if part == parts - 1 then
        ws.send(string.char(0x13, 0, 0, 0, 0), true)
      end
    elseif t == 0x30 then
      ws.send(string.char(0x31), true)
    end
  end
end

-- Keep sampling after the start so the log shows the addon's own view of things.
for i = 1, 30 do
  os.sleep(0.2)
  if i % 5 == 0 then
    log(("playing=%s buffered=%s"):format(tostring(aud.isPlaying()), tostring(aud.group.speakBuffered())))
  end
end

log("=== summary")
log("chunks=" .. chunks .. " bytes=" .. stagedBytes .. " frames=" .. frames)
log(("timing: open->done=%s open->start=%s")
    :format(tostring(t_done and (t_done - t_open)), tostring(t_start and (t_start - t_open))))
log("metrics=" .. textutils.serialise(aud.metrics()))
aud.stop()
ws.close()
out.close()
