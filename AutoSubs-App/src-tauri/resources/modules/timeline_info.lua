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

return M
