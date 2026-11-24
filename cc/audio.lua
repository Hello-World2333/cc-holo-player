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
-- single speakEnd() starts all speakers on the same tick. Eight separate handles
-- would start eight independent sounds and drift apart.
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

  local best, bestCount, bestWhere = nil, 0, nil
  for _, c in ipairs(candidates) do
    local ok, g = pcall(cee.getSpeakers, c)
    if ok and g then
      local okc, cnt = pcall(function() return g.getCount() end)
      if okc and type(cnt) == "number" and cnt > bestCount then
        best, bestCount = g, cnt
        bestWhere = type(c) == "table" and ("hub %d pin %d"):format(c[1], c[2]) or ("pin " .. c)
      end
    end
  end
  if best then say(("audio: %d speaker(s) on %s"):format(bestCount, bestWhere)) end
  return best, bestCount
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

  self.group, self.count = findGroup(opts.cfg or {}, self.say)
  if self.group then
    -- The line voltage caps the achievable volume; asking above it is clamped
    -- by the addon but reading it makes the log self-explanatory when someone
    -- asks why it is quiet.
    local okV, f = pcall(function() return self.group.getVoltageFactor() end)
    if okV and type(f) == "number" then
      self.say(("audio: voltage factor %.2f"):format(f))
    end
  end

  local function stopGroup()
    if self.group then pcall(function() self.group.speakStop() end) end
  end

  --- Kill whatever is playing. Called on every new SELECT, because the addon
  --- keeps separate per-position sounds alive otherwise and the previous track
  --- would keep going under the new one.
  function self.stop()
    stopGroup()
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
    self.playing = true
    self.say(("audio: playing %d KiB"):format(math.floor(self.bytes / 1024)))
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
    }
  end

  return self
end

return M
