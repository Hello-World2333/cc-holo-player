-- HQ audio playback for the CEE Electric Speaker path.
--
-- How the CEE addon wants to be driven
-- ------------------------------------
-- Every speak*() call is a COMPLETE sound. The addon halts whatever was playing
-- at that block position before starting a new one, so feeding audio piece by
-- piece with speakPCM() gives you one tick of sound per call — the old player
-- hit exactly that and documented it as "HQ 想连续只能整轨". Continuous playback
-- therefore means: speakOpen() once, speakAppend() every chunk, speakEnd() once,
-- and the addon plays the whole accumulated track as a single sound.
--
-- That is also why the group handle matters. cee.getSpeakers(pin) returns one
-- handle covering the whole cable run, and the run is dispatched together, so a
-- single speakEnd() starts all speakers on the same tick. Separate handles would
-- start separate sounds and drift apart.
--
-- Why there are also "extra" handles
-- ----------------------------------
-- On the real wall the pin group only covered HALF of the speakers: 16 blocks
-- exist, getCount() reports 8, and the individual handles then split cleanly
-- into handles 1..8 (== the group) and handles 9..16 (the other half). Measured
-- by playing a different pitch on each set and asking the listener, because
-- nothing in the Lua API exposes which speaker belongs to which run.
--
-- Driving only the group therefore leaves half the wall silent. The extras are
-- staged in the same pass and ended immediately after the group inside the same
-- tick, which is what keeps them aligned: the addon schedules staged audio
-- against game time, so every session started in one tick shares a start tick.
--
-- Why playback is deferred until AUDIO_START
-- ------------------------------------------
-- speakOpen/append buffer the track without playing. speakEnd is what starts it.
-- The server sends the track first, then waits for the video encoder's first
-- frame, and only then says "play". Without that, the audio started 1.4-2.9 s
-- before the picture (measured first-frame latency) and every track was visibly
-- out of sync from the first second.
local M = {}

local OGG = "ogg"

-- CEEHqLimits.MAX_APPEND_BYTES. Sending more in one call throws, and the throw
-- aborts the whole session, so chunks are re-sliced here rather than trusted.
local MAX_APPEND = 262144
-- CEEHqLimits.MAX_SESSION_BYTES. Past this the addon cannot buffer the track.
local MAX_SESSION = 16777216

M.STATUS_OK = 0
M.STATUS_NO_SPEAKER = 1
M.STATUS_APPEND_FAILED = 2
M.STATUS_TOO_BIG = 3

-- How many individual handles to look for. CEEHqLimits.MAX_SPEAKERS_PER_TRANSFER
-- is 64, so probing past that is pointless; this is the hard ceiling.
local MAX_HANDLES = 64

--- Find the speaker group. `cfg` may pin it explicitly with {hub, pin} so we do
--- not have to poke at every pin at boot; a pinned handle that turns out to be
--- empty falls back to the scan, because a stale config must not mute the wall.
local function findGroup(cfg, say)
  local candidates = {}
  if cfg.audioHub and cfg.audioPin then
    candidates[#candidates + 1] = { cfg.audioHub, cfg.audioPin }
  end
  for pin = 1, 9 do
    candidates[#candidates + 1] = pin
  end

  local best, bestCount, bestDesc, bestAddr = nil, 0, nil, nil
  for _, c in ipairs(candidates) do
    local ok, g = pcall(cee.getSpeakers, c)
    if ok and g then
      local okc, cnt = pcall(function() return g.getCount() end)
      if okc and type(cnt) == "number" and cnt > bestCount then
        best, bestCount, bestAddr = g, cnt, c
        bestDesc = type(c) == "table" and ("hub %d pin %d"):format(c[1], c[2]) or ("pin " .. c)
      end
    end
  end
  if best then say(("audio: %d speaker(s) on %s"):format(bestCount, bestDesc)) end
  return best, bestCount, bestAddr
end

--- Enumerate the speakers the group does NOT cover.
---
--- Indices are contiguous and start at 1, with the group's own members occupying
--- the first `covered` slots, so the extras are simply the next ones. Probing stops
--- at the first missing index: each getSpeakers() call is a hub lookup that costs
--- real time on CraftOS, and walking all 64 possible slots stalled this at boot
--- for over a minute.
---
--- Returns an empty table when the group already covers everything, which is the
--- normal case on a wall wired as a single run.
local function findExtras(where, covered, say)
  local extras = {}
  if not where then return extras end
  local n = covered + 1
  while n <= MAX_HANDLES do
    local ok, h = pcall(cee.getSpeakers, where, n)
    if not ok or not h then break end
    extras[#extras + 1] = h
    n = n + 1
  end
  if #extras > 0 then
    say(("audio: +%d extra speaker(s) beyond the group (indices %d..%d)")
        :format(#extras, covered + 1, n - 1))
  end
  return extras
end

--- `opts`: { cfg, say, volume }
function M.new(opts)
  local self = {
    group = nil,
    count = 0,
    volume = opts.volume or 1.0,
    say = opts.say or function() end,
    -- session state
    open = false,
    appending = false,
    staged = 0,
    total = 0,
    status = M.STATUS_OK,
    playing = false,
    -- counters for the log
    tracks = 0,
    bytes = 0,
    appends = 0,
  }

  local cfg = opts.cfg or {}
  self.group, self.count, self.addr = findGroup(cfg, self.say)
  -- The pin group covers only part of the wall on this server (16 speakers, 8 in
  -- the group). Stage the rest explicitly, unless the config opts out.
  self.extras = {}
  if self.group and cfg.audioExtras ~= false then
    self.extras = findExtras(self.addr, self.count, self.say)
  elseif self.group then
    self.say("audio: extras disabled by config")
  end
  if self.group then
    -- The line voltage caps the achievable volume; asking above it is clamped
    -- by the addon but reading it makes the log self-explanatory when someone
    -- asks why it is quiet.
    local okV, f = pcall(function() return self.group.getVoltageFactor() end)
    if okV and type(f) == "number" then
      self.say(("audio: voltage factor %.2f"):format(f))
    end
  end

  --- Stop every session this module opened, group and extras alike. A leftover
  --- session keeps its bytes buffered and blocks the next speakOpen.
  local function stopAll()
    if self.group then pcall(function() self.group.speakStop() end) end
    for _, h in ipairs(self.extras) do pcall(function() h.speakStop() end) end
  end

  --- Kill whatever is playing. Called on every new SELECT, because the addon
  --- keeps separate per-position sounds alive otherwise and the previous track
  --- would keep going under the new one.
  function self.stop()
    stopAll()
    self.open, self.appending, self.playing = false, false, false
    self.staged, self.total = 0, 0
  end

  --- True when the server should bother sending a track at all.
  function self.available() return self.group ~= nil end

  --- Server said a track is coming. Open a session so the appends have a target.
  function self.onOpen(totalBytes)
    self.stop()
    self.total = totalBytes
    self.status = M.STATUS_OK
    if not self.group then
      self.status = M.STATUS_NO_SPEAKER
      return self.status
    end
    if totalBytes > MAX_SESSION then
      self.status = M.STATUS_TOO_BIG
      self.say(("audio: track is %d B, over the %d B session cap; muted")
          :format(totalBytes, MAX_SESSION))
      return self.status
    end
    local ok, err = pcall(function() return self.group.speakOpen(OGG, self.volume) end)
    if not ok then
      self.status = M.STATUS_APPEND_FAILED
      self.say("audio: speakOpen failed: " .. tostring(err))
      return self.status
    end
    -- Open the extras BEFORE any append: every session must exist first so the
    -- appends can go out in one sweep and nothing is left half-open.
    for i, h in ipairs(self.extras) do
      local okE, errE = pcall(function() return h.speakOpen(OGG, self.volume) end)
      if not okE then
        -- Drop the extra rather than mute the whole wall: losing one speaker is
        -- better than losing all of them.
        self.say(("audio: extra %d speakOpen failed (%s), dropping it"):format(i, tostring(errE)))
        self.extras[i] = nil
      end
    end
    self.open = true
    self.appending = true
    self.staged = 0
    return self.status
  end

  --- One slice of the track. Re-sliced to MAX_APPEND: the session is all-or
  --- nothing, so a single oversized call would lose the entire track.
  function self.onChunk(bytes)
    if not self.open or self.status ~= M.STATUS_OK then return false end
    local pos, n = 1, #bytes
    while pos <= n do
      local piece = string.sub(bytes, pos, math.min(pos + MAX_APPEND - 1, n))
      local ok, err = pcall(function() return self.group.speakAppend(piece) end)
      if not ok then
        -- Report once and stay muted: retrying a failed append would spam the
        -- server with thousands of doomed calls.
        self.status = M.STATUS_APPEND_FAILED
        self.say("audio: speakAppend failed: " .. tostring(err))
        self.open, self.appending = false, false
        pcall(function() self.group.speakStop() end)
        return false
      end
      -- Fan the piece out to the extras with the same slicing, so every session
      -- holds byte-identical audio. Identical payloads matter: the addon dedups
      -- staged data by content hash, and identical streams are what let the
      -- sessions be aligned against one another.
      for i = #self.extras, 1, -1 do
        local h = self.extras[i]
        local okE, errE = pcall(function() return h.speakAppend(piece) end)
        if not okE then
          self.say(("audio: extra %d speakAppend failed (%s), dropping it"):format(i, tostring(errE)))
          pcall(function() h.speakStop() end)
          table.remove(self.extras, i)
        end
      end
      self.appends = self.appends + 1
      self.staged = self.staged + #piece
      pos = pos + #piece
    end
    return true
  end

  --- The whole track is buffered. Playback still has NOT started.
  function self.onDone()
    self.appending = false
    self.bytes = self.bytes + self.staged
    self.tracks = self.tracks + 1
    return self.status
  end

  --- Play it. This is the call that starts all speakers on the same tick.
  function self.onStart()
    if not self.open or self.status ~= M.STATUS_OK then return false end
    local ok, err = pcall(function() return self.group.speakEnd() end)
    self.open = false
    if not ok then
      self.status = M.STATUS_APPEND_FAILED
      self.say("audio: speakEnd failed: " .. tostring(err))
      return false
    end
    -- End the extras immediately after the group, in this same tick. The addon
    -- schedules playback against game time, so sessions ended together share a
    -- start tick; splitting them across ticks would produce an audible echo.
    local failed = 0
    for i, h in ipairs(self.extras) do
      local okE, errE = pcall(function() return h.speakEnd() end)
      if not okE then
        failed = failed + 1
        self.say(("audio: extra %d speakEnd failed: %s"):format(i, tostring(errE)))
      end
    end
    self.playing = true
    self.say(("audio: playing %d KiB to %d+%d speaker group(s)%s")
        :format(math.floor(self.bytes / 1024), 1, #self.extras,
                failed > 0 and (", " .. failed .. " failed") or ""))
    return true
  end

  --- Is the addon still producing sound? Best-effort: on this server the flag
  --- has been observed to drop while audio is audible, so it is only used for
  --- logging, never for control flow.
  function self.isPlaying()
    if not self.group then return false end
    local ok, v = pcall(function() return self.group.speakIsPlaying() end)
    return ok and v or false
  end

  function self.metrics()
    return {
      tracks = self.tracks,
      bytes = self.bytes,
      appends = self.appends,
      staged = self.staged,
      status = self.status,
      speakers = self.count,
      extras = #self.extras,
    }
  end

  return self
end

return M
