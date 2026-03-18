-- ============================================================
-- audio_export.lua — Export audio, tracking progress, cancel
-- ExportAudio, GetExportProgress, CancelExport,
-- GetClipBoundaries, GetIndividualClips
-- ============================================================

local M = {}

-- ===== GET CLIP BOUNDARIES =====
-- Tìm frame bắt đầu sớm nhất và kết thúc muộn nhất trên các track đã chọn
function M.GetClipBoundaries(timeline, selectedTracks)
    local earliestStart = nil
    local latestEnd = nil

    for trackIndex, _ in pairs(selectedTracks) do
        local clips = timeline:GetItemListInTrack("audio", trackIndex)
        if clips then
            for _, clip in ipairs(clips) do
                local clipStart = clip:GetStart()
                local clipEnd = clip:GetEnd()
                if earliestStart == nil or clipStart < earliestStart then
                    earliestStart = clipStart
                end
                if latestEnd == nil or clipEnd > latestEnd then
                    latestEnd = clipEnd
                end
            end
        end
    end

    return earliestStart, latestEnd
end

-- ===== GET INDIVIDUAL CLIPS =====
-- Trả về mảng clip segments đã merge overlap, sorted theo thời gian
function M.GetIndividualClips(timeline, selectedTracks)
    local allClips = {}
    local timelineStart = timeline:GetStartFrame()
    local frameRate = timeline:GetSetting("timelineFrameRate")

    for trackIndex, _ in pairs(selectedTracks) do
        local clips = timeline:GetItemListInTrack("audio", trackIndex)
        if clips then
            for _, clip in ipairs(clips) do
                local clipStart = clip:GetStart()
                local clipEnd = clip:GetEnd()
                table.insert(allClips, {
                    startFrame = clipStart,
                    endFrame = clipEnd,
                    start = (clipStart - timelineStart) / frameRate,
                    ["end"] = (clipEnd - timelineStart) / frameRate,
                    name = clip:GetName() or "Unnamed"
                })
            end
        end
    end

    -- Sort theo start time
    table.sort(allClips, function(a, b) return a.startFrame < b.startFrame end)

    -- Merge overlap
    local mergedClips = {}
    for _, clip in ipairs(allClips) do
        if #mergedClips == 0 then
            table.insert(mergedClips, clip)
        else
            local lastClip = mergedClips[#mergedClips]
            if clip.startFrame <= lastClip.endFrame then
                lastClip.endFrame = math.max(lastClip.endFrame, clip.endFrame)
                lastClip["end"] = math.max(lastClip["end"], clip["end"])
                lastClip.name = lastClip.name .. " + " .. clip.name
            else
                table.insert(mergedClips, clip)
            end
        end
    end

    return mergedClips
end

-- ===== GET EXPORT PROGRESS =====
-- Kiểm tra tiến độ export (render) đang chạy
function M.GetExportProgress(state, helpers, luaresolve, timeline_info)
    if not state.currentExportJob.active then
        return { active = false, progress = 0, message = "No export in progress" }
    end

    if state.currentExportJob.cancelled then
        return { active = false, progress = state.currentExportJob.progress, cancelled = true, message = "Export was cancelled" }
    end

    if state.currentExportJob.pid then
        local renderInProgress = false
        local success, result = pcall(function()
            return state.project:IsRenderingInProgress()
        end)
        if success then renderInProgress = result end

        if renderInProgress then
            local timeline = state.project:GetCurrentTimeline()
            local currentTimecode = timeline:GetCurrentTimecode()
            local frameRate = timeline:GetSetting("timelineFrameRate")
            local playheadPosition = luaresolve:frame_from_timecode(currentTimecode, frameRate)

            local markIn = state.currentExportJob.audioInfo.markIn
            local markOut = state.currentExportJob.audioInfo.markOut
            state.currentExportJob.progress = math.floor(((playheadPosition - markIn) / (markOut - markIn)) * 100 + 0.5)

            return {
                active = true,
                progress = state.currentExportJob.progress,
                message = "Export in progress...",
                pid = state.currentExportJob.pid
            }
        else
            state.currentExportJob.active = false
            timeline_info.ResetTracks(state)

            if state.currentExportJob.cancelled then
                return { active = false, progress = state.currentExportJob.progress, cancelled = true, message = "Export was cancelled" }
            else
                state.currentExportJob.progress = 100
                return {
                    active = false, progress = 100, completed = true,
                    message = "Export completed successfully",
                    audioInfo = state.currentExportJob.audioInfo
                }
            end
        end
    else
        state.currentExportJob.active = false
        return { active = false, progress = 0, error = true, message = "Export job lost - no process ID available" }
    end
end

-- ===== CANCEL EXPORT =====
-- Hủy render đang chạy
function M.CancelExport(state, timeline_info)
    if not state.currentExportJob.active then
        return { success = false, message = "No export in progress to cancel" }
    end

    if state.currentExportJob.pid then
        local success, err = pcall(function()
            state.project:StopRendering()
        end)
        timeline_info.ResetTracks(state)

        if success then
            state.currentExportJob.cancelled = true
            state.currentExportJob.active = false
            return { success = true, message = "Export cancelled successfully" }
        else
            return { success = false, message = "Failed to cancel export: " .. (err or "unknown error") }
        end
    else
        return { success = false, message = "No render job to cancel" }
    end
end

-- ===== EXPORT AUDIO =====
-- Export audio từ track đã chọn ra file WAV
function M.ExportAudio(state, helpers, outputDir, inputTracks)
    if state.project:IsRenderingInProgress() then
        return { error = true, message = "Another export is already in progress" }
    end

    -- Kiểm tra timeline hợp lệ
    local timeline = state.project:GetCurrentTimeline()
    if not timeline then
        return { error = true, message = "No current timeline" }
    end

    -- Reset job state
    state.currentExportJob = {
        active = true, pid = nil, progress = 0, cancelled = false,
        startTime = os.time(), audioInfo = nil
    }

    local audioInfo = { timeline = "" }
    local trackStates = {}
    local audioTracks = timeline:GetTrackCount("audio")

    -- Lưu trạng thái track hiện tại
    for i = 1, audioTracks do
        trackStates[i] = timeline:GetIsTrackEnabled("audio", i)
    end

    -- Build set track đã chọn
    local selected = {}

    -- Log inputTracks nhận được từ frontend
    if inputTracks and #inputTracks > 0 then
        for i, v in ipairs(inputTracks) do
            print("[AutoSubs] inputTracks[" .. i .. "] = " .. tostring(v))
            local n = tonumber(v)
            if n then selected[n] = true end
        end
    else
        -- ★ GUARD: inputTracks rỗng → KHÔNG disable hết track!
        -- Fallback sang track 2 (default track chứa giọng đọc)
        print("[AutoSubs] ⚠️ inputTracks rỗng! Fallback sang track 2 mặc định")
        selected[2] = true
    end

    -- Log track nào sẽ được enable
    for i = 1, audioTracks do
        print("[AutoSubs] track A" .. i .. " selected = " .. tostring(selected[i] == true))
    end

    -- Chỉ bật track đã chọn, tắt các track còn lại
    for i = 1, audioTracks do
        local enable = selected[i] == true
        local ok = timeline:SetTrackEnable("audio", i, enable)
        print("[AutoSubs] SetTrackEnable A" .. i .. " = " .. tostring(enable) .. " -> " .. tostring(ok))
    end

    -- ★ DEBUG: Kiểm tra trạng thái thực tế ngay trước render
    print("[AutoSubs] === Track states before AddRenderJob ===")
    for i = 1, audioTracks do
        print("[AutoSubs]   A" .. i .. " enabled = " .. tostring(timeline:GetIsTrackEnabled("audio", i)))
    end
    state.currentExportJob.trackStates = trackStates

    -- Tìm clip boundaries
    local clipStart, clipEnd = M.GetClipBoundaries(timeline, selected)
    local individualClips = M.GetIndividualClips(timeline, selected)
    state.currentExportJob.individualClips = individualClips
    print("[AutoSubs] Found " .. #individualClips .. " individual clip(s)")
    if clipStart and clipEnd then
        local fps = tonumber(timeline:GetSetting("timelineFrameRate")) or 25
        local durationSec = (clipEnd - clipStart) / fps
        print("[AutoSubs] clipStart = " .. tostring(clipStart))
        print("[AutoSubs] clipEnd   = " .. tostring(clipEnd))
        print("[AutoSubs] fps       = " .. tostring(fps))
        print("[AutoSubs] duration  = " .. string.format("%.2f", durationSec) .. "s")
        state.currentExportJob.clipBoundaries = { start = clipStart, ["end"] = clipEnd }
    else
        print("[AutoSubs] No clip boundaries found, will use whole timeline")
    end

    -- ★ Xóa tất cả render jobs cũ để tránh tích lũy
    state.project:DeleteAllRenderJobs()

    -- Chuyển sang Deliver page
    state.resolve:OpenPage("deliver")

    -- Load preset Audio Only
    state.project:LoadRenderPreset('Audio Only')

    -- ★ FIX: Ép format/codec rõ ràng, không phụ thuộc preset
    state.project:SetCurrentRenderMode(1)  -- 1 = Single clip
    state.project:SetCurrentRenderFormatAndCodec("wav", "LinearPCM")

    -- ★ FIX: Dùng đúng key API: ExportAudio/ExportVideo (không phải IsExportAudio/IsExportVideo)
    local renderSettings = {
        TargetDir = outputDir,
        CustomName = "autosubs-exported-audio",
        ExportVideo = false,   -- ★ Key đúng theo DaVinci API doc
        ExportAudio = true,    -- ★ Key đúng theo DaVinci API doc
        AudioBitDepth = 24,
        AudioSampleRate = 44100
    }

    -- Chỉ set MarkIn/MarkOut nếu có boundaries hợp lệ
    if clipStart and clipEnd and clipEnd > clipStart then
        renderSettings.MarkIn = clipStart
        renderSettings.MarkOut = clipEnd
    end

    -- ★ DEBUG: Log toàn bộ render settings trước khi apply
    print("[AutoSubs] ==== RENDER SETTINGS ===")
    for k, v in pairs(renderSettings) do
        print("[AutoSubs]   " .. tostring(k) .. " = " .. tostring(v))
    end
    print("[AutoSubs] ===========================")

    local setOk = state.project:SetRenderSettings(renderSettings)
    print("[AutoSubs] SetRenderSettings = " .. tostring(setOk))

    -- Thêm render job
    local pid = state.project:AddRenderJob()
    if not pid then
        -- ★ Restore track states nếu AddRenderJob thất bại
        for i = 1, audioTracks do
            timeline:SetTrackEnable("audio", i, trackStates[i])
        end
        state.currentExportJob.active = false
        return { error = true, message = "AddRenderJob failed" }
    end
    state.currentExportJob.pid = pid

    -- Bắt đầu render
    local started = state.project:StartRendering(pid)
    if not started then
        -- ★ Restore track states nếu StartRendering thất bại
        for i = 1, audioTracks do
            timeline:SetTrackEnable("audio", i, trackStates[i])
        end
        state.currentExportJob.active = false
        return { error = true, message = "StartRendering failed" }
    end

    -- Lấy thông tin render job (để tính offset)
    local success, err = pcall(function()
        local renderJobList = state.project:GetRenderJobList()
        local rs = renderJobList[#renderJobList]
        local frameRate = tonumber(timeline:GetSetting("timelineFrameRate")) or 25
        local markIn = rs["MarkIn"] or (clipStart or timeline:GetStartFrame())
        local baseOffset = (markIn - timeline:GetStartFrame()) / frameRate

        local segments = {}
        for _, clip in ipairs(state.currentExportJob.individualClips or {}) do
            table.insert(segments, {
                start = clip.start - baseOffset,
                ["end"] = clip["end"] - baseOffset,
                timelineStart = clip.start,
                timelineEnd = clip["end"],
                name = clip.name
            })
        end

        audioInfo = {
            path = helpers.join_path(rs["TargetDir"], rs["OutputFilename"]),
            markIn = markIn,
            markOut = rs["MarkOut"] or (clipEnd or timeline:GetEndFrame()),
            offset = baseOffset,
            segments = segments
        }
        dump(audioInfo)
        state.currentExportJob.audioInfo = audioInfo
        print("[AutoSubs] Export started with PID: " .. tostring(pid))
    end)

    if not success then
        state.currentExportJob.active = false
        return { error = true, message = "Failed to get render job info: " .. (err or "unknown error") }
    end

    return { started = true, message = "Export started successfully.", pid = state.currentExportJob.pid }
end

return M
