-- ============================================================
-- timeline_info.lua — Lấy thông tin timeline, video/audio tracks
-- Cung cấp: GetTimelineInfo, GetVideoTracks, GetAudioTracks,
--            ResetTracks, CheckTrackEmpty, JumpToTime
-- ============================================================

local M = {}

-- ===== GET TIMELINE INFO =====
-- Trả về thông tin timeline hiện tại (tên, ID, tracks, templates)
function M.GetTimelineInfo(state, helpers, template_manager)
    state.project = state.projectManager:GetCurrentProject()
    state.mediaPool = state.project:GetMediaPool()

    local timelineInfo = {}
    local success, err = pcall(function()
        local timeline = state.project:GetCurrentTimeline()
        timelineInfo = {
            name = timeline:GetName(),
            timelineId = timeline:GetUniqueId(),
            timelineStart = timeline:GetStartFrame() / timeline:GetSetting("timelineFrameRate"),
            projectName = state.project:GetName() or "unknown"
        }
    end)

    if not success then
        print("Error retrieving timeline info:", err)
        timelineInfo = {
            timelineId = "",
            name = "No timeline selected"
        }
    else
        timelineInfo["outputTracks"] = M.GetVideoTracks(state)
        timelineInfo["inputTracks"] = M.GetAudioTracks(state)
        timelineInfo["templates"] = template_manager.GetTemplates(state, helpers)
    end
    return timelineInfo
end

-- ===== GET VIDEO TRACKS =====
-- Danh sách video tracks + option "Add to New Track"
function M.GetVideoTracks(state)
    local tracks = {}
    table.insert(tracks, { value = "0", label = "Add to New Track" })

    local success, err = pcall(function()
        local timeline = state.project:GetCurrentTimeline()
        local trackCount = timeline:GetTrackCount("video")
        for i = 1, trackCount do
            table.insert(tracks, {
                value = tostring(i),
                label = timeline:GetTrackName("video", i)
            })
        end
    end)
    return tracks
end

-- ===== GET AUDIO TRACKS =====
-- Danh sách audio tracks hiện có
function M.GetAudioTracks(state)
    local tracks = {}
    local success, err = pcall(function()
        local timeline = state.project:GetCurrentTimeline()
        local trackCount = timeline:GetTrackCount("audio")
        for i = 1, trackCount do
            table.insert(tracks, {
                value = tostring(i),
                label = timeline:GetTrackName("audio", i)
            })
        end
    end)
    return tracks
end

-- ===== RESET TRACKS =====
-- Khôi phục trạng thái enable/disable của audio tracks
function M.ResetTracks(state)
    state.resolve:OpenPage("edit")
    local timeline = state.project:GetCurrentTimeline()
    local audioTracks = timeline:GetTrackCount("audio")
    for i = 1, audioTracks do
        timeline:SetTrackEnable("audio", i, state.currentExportJob.trackStates[i])
    end
    state.currentExportJob.clipBoundaries = nil
end

-- ===== CHECK TRACK EMPTY =====
-- Kiểm tra xem track video có clip nào trong khoảng markIn-markOut không
function M.CheckTrackEmpty(state, trackIndex, markIn, markOut)
    trackIndex = tonumber(trackIndex)
    local timeline = state.project:GetCurrentTimeline()
    local trackItems = timeline:GetItemListInTrack("video", trackIndex)
    for i, item in ipairs(trackItems) do
        local itemStart = item:GetStart()
        local itemEnd = item:GetEnd()
        if (itemStart <= markIn and itemEnd >= markIn) or (itemStart <= markOut and itemEnd >= markOut) then
            return false
        end
        if itemStart > markOut then
            break
        end
    end
    return #trackItems == 0
end

-- ===== JUMP TO TIME =====
-- Di chuyển playhead đến vị trí (giây) trên timeline
function M.JumpToTime(state, helpers, luaresolve, seconds)
    local timeline = state.project:GetCurrentTimeline()
    local frameRate = timeline:GetSetting("timelineFrameRate")
    local frames = helpers.to_frames(seconds, frameRate) + timeline:GetStartFrame() + 1
    local timecode = luaresolve:timecode_from_frame_auto(frames, frameRate)
    timeline:SetCurrentTimecode(timecode)
end

-- ===== SEEK TO TIME =====
-- Di chuyển playhead (dùng cho preview, bấm vào số câu → nhảy đến vị trí)
function M.SeekToTime(state, seconds)
    local timeline = state.project:GetCurrentTimeline()
    if not timeline then
        return { error = true, message = "No active timeline found" }
    end

    local frame_rate = timeline:GetSetting("timelineFrameRate")
    local timelineStart = timeline:GetStartFrame()
    local targetFrame = timelineStart + math.floor(tonumber(seconds) * frame_rate)

    local fps = math.floor(frame_rate)
    local ff = targetFrame % fps
    local totalSeconds = math.floor(targetFrame / fps)
    local ss = totalSeconds % 60
    local totalMinutes = math.floor(totalSeconds / 60)
    local mm = totalMinutes % 60
    local hh = math.floor(totalMinutes / 60)

    local timecode = string.format("%02d:%02d:%02d:%02d", hh, mm, ss, ff)
    timeline:SetCurrentTimecode(timecode)

    print(string.format("[AutoSubs] Seek to %.2fs → frame %d → %s", seconds, targetFrame, timecode))
    return { success = true, timecode = timecode }
end

-- ===== SANITIZE TRACK INDEX =====
-- Tạo track mới nếu trackIndex = "0" hoặc vượt quá số track hiện có
function M.SanitizeTrackIndex(timeline, trackIndex, markIn, markOut)
    if trackIndex == "0" or trackIndex == "" or trackIndex == nil
       or tonumber(trackIndex) > timeline:GetTrackCount("video") then
        trackIndex = timeline:GetTrackCount("video") + 1
        timeline:AddTrack("video")
    end
    return tonumber(trackIndex)
end

-- ===== GET TRACK CLIP NUMBERS =====
-- Quét track → trả về danh sách số từ tên clip + time ranges
function M.GetTrackClipNumbers(state, trackIndex)
    print("[AutoSubs Server] Quét track V" .. trackIndex .. " trên timeline...")

    local timeline = state.project:GetCurrentTimeline()
    if not timeline then
        return { error = true, message = "No active timeline found" }
    end

    local trackIdx = tonumber(trackIndex) or 1
    local frame_rate = timeline:GetSetting("timelineFrameRate")
    local timelineStart = timeline:GetStartFrame()
    local trackItems = timeline:GetItemListInTrack("video", trackIdx)

    if not trackItems or #trackItems == 0 then
        return { clipNumbers = {}, clipRanges = {}, totalClips = 0 }
    end

    local clipNumbers = {}
    local clipRanges = {}
    for _, item in ipairs(trackItems) do
        local itemName = item:GetName() or ""
        local num = itemName:match("(%d+)")
        if num then
            table.insert(clipNumbers, tonumber(num))
        end

        local startFrame = item:GetStart()
        local endFrame = item:GetEnd()
        local startSec = (startFrame - timelineStart) / frame_rate
        local endSec = (endFrame - timelineStart) / frame_rate
        table.insert(clipRanges, {
            start = math.floor(startSec * 100) / 100,
            endTime = math.floor(endSec * 100) / 100,
            name = itemName
        })
    end

    return { clipNumbers = clipNumbers, clipRanges = clipRanges, totalClips = #trackItems }
end

-- ===== SETUP TIMELINE TRACKS =====
-- Tự động tạo đủ 7 Video + 5 Audio tracks và đặt tên chuẩn
-- AN TOÀN: chỉ dùng AddTrack + SetTrackName, KHÔNG xoá track/clip
function M.SetupTimelineTracks(state, helpers, data)
    print("[AutoSubs] ========== SetupTimelineTracks START ==========")

    -- Refresh project state
    state.project = state.projectManager:GetCurrentProject()
    local timeline = state.project:GetCurrentTimeline()
    if not timeline then
        print("[AutoSubs] ❌ Không có timeline đang mở")
        return { error = true, message = "Không có timeline đang mở. Vui lòng tạo hoặc mở timeline trước." }
    end

    local tlName = timeline:GetName() or "Unknown"
    print("[AutoSubs] Timeline: " .. tlName)

    -- ═══ AUTO-CONFIGURE PROJECT SETTINGS ═══
    if data and data.config then
        local cfg = data.config
        if cfg.width and cfg.height then
            local pcallOk = pcall(function()
                timeline:SetSetting("timelineResolutionWidth", tostring(cfg.width))
                timeline:SetSetting("timelineResolutionHeight", tostring(cfg.height))
                
                -- Support DaVinci 18+ useVerticalResolution flag if explicitly needed
                if cfg.useVertical == true then
                     timeline:SetSetting("useVerticalResolution", "1")
                elseif cfg.useVertical == false then
                     timeline:SetSetting("useVerticalResolution", "0")
                end
                print(string.format("[AutoSubs] Set Timeline Resolution to %dx%d (Vertical: %s)", cfg.width, cfg.height, tostring(cfg.useVertical)))
            end)
            if not pcallOk then print("[AutoSubs] ⚠️ Set Resolution failed, ignoring.") end
        end
    end

    -- ═══ CẤU HÌNH TRACK CHUẨN ═══
    local VIDEO_TRACKS = {
        { index = 1, name = "Video AI" },
        { index = 2, name = "Ảnh Thực Tế" },
        { index = 3, name = "Adjustment Layer" },
        { index = 4, name = "Text Onscreen" },
        { index = 5, name = "Số Chương" },
        { index = 6, name = "Tên Chương" },
        { index = 7, name = "Footage B-roll" },
    }

    local AUDIO_TRACKS = {
        { index = 1, name = "SFX Video AI" },
        { index = 2, name = "VO (Voice)" },
        { index = 3, name = "SFX Text" },
        { index = 4, name = "SFX Ảnh Ref" },
        { index = 5, name = "Nhạc Nền" },
    }

    local WANT_VIDEO = #VIDEO_TRACKS  -- 7
    local WANT_AUDIO = #AUDIO_TRACKS  -- 5

    -- ═══ BƯỚC 1: Thêm Video Tracks nếu thiếu ═══
    local currentVideo = tonumber(timeline:GetTrackCount("video")) or 0
    print(string.format("[AutoSubs] Video tracks hiện có: %d, cần: %d", currentVideo, WANT_VIDEO))

    while currentVideo < WANT_VIDEO do
        local ok = timeline:AddTrack("video")
        currentVideo = tonumber(timeline:GetTrackCount("video")) or currentVideo
        print(string.format("[AutoSubs]   AddTrack(video) => %s | total=%d", tostring(ok), currentVideo))
        if not ok then
            print("[AutoSubs]   ⚠️ AddTrack(video) thất bại, dừng lại")
            break
        end
    end

    -- ═══ BƯỚC 2: Thêm Audio Tracks nếu thiếu (TẤT CẢ MONO) ═══
    local currentAudio = tonumber(timeline:GetTrackCount("audio")) or 0
    print(string.format("[AutoSubs] Audio tracks hiện có: %d, cần: %d", currentAudio, WANT_AUDIO))

    while currentAudio < WANT_AUDIO do
        -- Tất cả audio dùng mono (tránh lỗi 2.0 stereo nghe 2 tai)
        local ok = timeline:AddTrack("audio", "mono")
        currentAudio = tonumber(timeline:GetTrackCount("audio")) or currentAudio
        print(string.format("[AutoSubs]   AddTrack(audio, mono) => %s | total=%d", tostring(ok), currentAudio))
        if not ok then
            print("[AutoSubs]   ⚠️ AddTrack(audio) thất bại, dừng lại")
            break
        end
    end

    -- ═══ BƯỚC 3: Đặt tên cho Video Tracks ═══
    local renamedVideo = 0
    for _, t in ipairs(VIDEO_TRACKS) do
        if t.index <= currentVideo then
            local ok = timeline:SetTrackName("video", t.index, t.name)
            -- Read-back để xác nhận API thực sự ghi tên hay silently no-op
            local readBack = timeline:GetTrackName("video", t.index) or "(nil)"
            local matched = (readBack == t.name)
            print(string.format("[AutoSubs]   V%d set='%s' ok=%s | readBack='%s' match=%s",
                t.index, t.name, tostring(ok), readBack, tostring(matched)))
            if ok and matched then renamedVideo = renamedVideo + 1 end
        end
    end

    -- ═══ BƯỚC 4: Đặt tên cho Audio Tracks ═══
    local renamedAudio = 0
    for _, t in ipairs(AUDIO_TRACKS) do
        if t.index <= currentAudio then
            local ok = timeline:SetTrackName("audio", t.index, t.name)
            -- Read-back để xác nhận
            local readBack = timeline:GetTrackName("audio", t.index) or "(nil)"
            local matched = (readBack == t.name)
            print(string.format("[AutoSubs]   A%d set='%s' ok=%s | readBack='%s' match=%s",
                t.index, t.name, tostring(ok), readBack, tostring(matched)))
            if ok and matched then renamedAudio = renamedAudio + 1 end
        end
    end

    -- Refresh timeline display
    timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())

    local msg = string.format("Đã setup %dV + %dA tracks (renamed %dV + %dA)",
        currentVideo, currentAudio, renamedVideo, renamedAudio)
    print("[AutoSubs] ✅ " .. msg)
    print("[AutoSubs] ========== SetupTimelineTracks DONE ==========")

    return {
        success = true,
        videoTracks = currentVideo,
        audioTracks = currentAudio,
        renamedVideo = renamedVideo,
        renamedAudio = renamedAudio,
        message = msg,
    }
end

return M
