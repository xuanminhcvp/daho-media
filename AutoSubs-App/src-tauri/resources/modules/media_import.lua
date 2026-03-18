-- ============================================================
-- media_import.lua — Import video/audio/SFX vào timeline
-- AddMediaToTimeline, AddAudioToTimeline, AddSfxClipsToTimeline
-- ============================================================

local M = {}

-- ===== ADD MEDIA TO TIMELINE =====
-- Import video files vào timeline đúng vị trí (text matching)
-- videoOnly: nếu true thì chỉ lấy phần hình, bỏ audio (dùng cho footage)
function M.AddMediaToTimeline(state, helpers, clips, trackIndex, videoOnly)
    print("[AutoSubs Server] Adding " .. #clips .. " media clips to timeline..." .. (videoOnly and " (VIDEO ONLY)" or ""))

    local timeline = state.project:GetCurrentTimeline()
    if not timeline then
        return { error = true, message = "No active timeline found" }
    end

    local frame_rate = timeline:GetSetting("timelineFrameRate")
    local timelineStart = timeline:GetStartFrame()
    local trackIdx = tonumber(trackIndex) or 1

    -- Thu thập file paths
    local filePaths = {}
    for _, clip in ipairs(clips) do
        table.insert(filePaths, clip.filePath)
    end

    -- Import vào Media Pool
    local currentFolder = state.mediaPool:GetCurrentFolder()
    local mediaFolder = state.mediaPool:AddSubFolder(currentFolder, "AutoSubs Media Import")
    if mediaFolder then state.mediaPool:SetCurrentFolder(mediaFolder) end

    local mediaPoolItems = state.mediaPool:ImportMedia(filePaths)
    if not mediaPoolItems or #mediaPoolItems == 0 then
        print("[AutoSubs Server] ❌ ImportMedia failed! 0 items imported.")
        if currentFolder then state.mediaPool:SetCurrentFolder(currentFolder) end
        return { error = true, message = "Failed to import media files" }
    end
    print("[AutoSubs Server] ✅ ImportMedia: " .. #mediaPoolItems .. " items imported to MediaPool")

    -- Tạo mapping fileName → mediaPoolItem
    local mediaItemMap = {}
    local mapCount = 0
    for _, item in ipairs(mediaPoolItems) do
        local props = item:GetClipProperty()
        local itemName = props["File Name"] or props["Clip Name"] or ""
        if itemName == "" then
            itemName = (props["File Path"] or ""):match("([^/\\]+)$") or ""
        end
        if itemName ~= "" then
            mediaItemMap[itemName] = item
            mapCount = mapCount + 1
        end
    end
    print("[AutoSubs Server] Mapped: " .. mapCount .. "/" .. #mediaPoolItems .. " items")

    -- Đặt từng clip lên timeline
    local actualAdded = 0
    print("[AutoSubs Server] Processing " .. #clips .. " clips (trackIdx=" .. trackIdx .. ", videoOnly=" .. tostring(videoOnly) .. ")")
    for i, clip in ipairs(clips) do
        local fileName = clip.filePath:match("([^/\\]+)$") or ""
        local mediaItem = mediaItemMap[fileName]

        if not mediaItem then
            print("[AutoSubs Server] ⚠️ Clip " .. i .. ": '" .. fileName .. "' NOT FOUND in MediaPool map")
        end

        if mediaItem then
            local startTime = tonumber(clip.startTime) or 0
            local endTime = tonumber(clip.endTime) or 0
            local clipDuration = endTime - startTime

            if clipDuration > 0 then
                local timeline_pos = timelineStart + math.floor(startTime * frame_rate)

                -- Detect still image
                local lowerName = fileName:lower()
                local isStillImage = lowerName:match("%.jpe?g$")
                    or lowerName:match("%.png$")
                    or lowerName:match("%.webp$")
                    or lowerName:match("%.bmp$")
                    or lowerName:match("%.tiff?$")
                    or lowerName:match("%.exr$")

                local clipProps = mediaItem:GetClipProperty()
                local clipFPS = tonumber(clipProps["FPS"]) or frame_rate
                if isStillImage or clipFPS <= 0 then
                    clipFPS = frame_rate
                end

                local endFrame = math.floor(clipDuration * clipFPS)

                local newVideoClip = {
                    mediaPoolItem = mediaItem, mediaType = 1,
                    startFrame = 0, endFrame = endFrame,
                    recordFrame = timeline_pos, trackIndex = trackIdx
                }

                if isStillImage or videoOnly then
                    -- ===== Ảnh tĩnh HOẶC Footage (videoOnly) =====
                    -- Ảnh: startFrame=0, endFrame từ clipDuration (OK vì source = clip giả)
                    -- Footage: startFrame/endFrame phải tính từ trimStart/trimEnd (SOURCE frames)
                    --          recordFrame tính từ startTime (TIMELINE frames)
                    local srcStartFrame = 0
                    local srcEndFrame = endFrame

                    if videoOnly and clip.trimStart and clip.trimEnd then
                        -- Footage thật: dùng trim range trên SOURCE clip
                        local trimS = tonumber(clip.trimStart) or 0
                        local trimE = tonumber(clip.trimEnd) or 0
                        if trimE > trimS then
                            srcStartFrame = math.floor(trimS * clipFPS + 0.5)
                            srcEndFrame = math.floor(trimE * clipFPS + 0.5)
                        end
                    end

                    local clipInfo = {
                        mediaPoolItem = mediaItem, mediaType = 1,
                        startFrame = srcStartFrame, endFrame = srcEndFrame,
                        recordFrame = timeline_pos, trackIndex = trackIdx
                    }

                    if videoOnly then
                        print(string.format(
                            "[AutoSubs Server] Clip %d: %s | srcIn=%d srcOut=%d recIn=%d clipFPS=%.1f tlFPS=%.1f",
                            i, fileName, srcStartFrame, srcEndFrame, timeline_pos, clipFPS, frame_rate
                        ))
                    end

                    local result = state.mediaPool:AppendToTimeline({ clipInfo })

                    -- Fallback: nếu mediaType=1 fail → thử bỏ mediaType
                    if (not result or #result == 0) and videoOnly then
                        print("[AutoSubs Server] ⚠️ Clip " .. i .. ": mediaType=1 failed, trying without mediaType...")
                        clipInfo.mediaType = nil
                        result = state.mediaPool:AppendToTimeline({ clipInfo })
                    end

                    if result and #result > 0 then
                        actualAdded = actualAdded + 1
                        local clipColor = videoOnly and "Orange" or "Blue"
                        for _, tItem in ipairs(result) do
                            tItem:SetClipColor(clipColor)

                            -- ===== FOOTAGE: Zoom 110% để che viền đen =====
                            if videoOnly then
                                pcall(function()
                                    local comp = tItem:AddFusionComp()
                                    if comp then
                                        local mediaIn = comp:FindTool("MediaIn1")
                                        local mediaOut = comp:FindTool("MediaOut1")
                                        if mediaIn and mediaOut then
                                            local transform = comp:AddTool("Transform")
                                            if transform then
                                                transform:ConnectInput("Input", mediaIn)
                                                mediaOut:ConnectInput("Input", transform)
                                                transform:SetInput("Size", 1.1)
                                            end
                                        end
                                    end
                                end)
                            end
                        end
                    else
                        if videoOnly then
                            print("[AutoSubs Server] ❌ Clip " .. i .. ": FAILED to append (nil/empty)")
                        end
                    end
                else
                    local newAudioClip = {
                        mediaPoolItem = mediaItem, mediaType = 2,
                        startFrame = 0, endFrame = endFrame,
                        recordFrame = timeline_pos, trackIndex = trackIdx
                    }
                    local result = state.mediaPool:AppendToTimeline({ newVideoClip, newAudioClip })
                    if result and #result > 0 then
                        actualAdded = actualAdded + 1
                        for _, tItem in ipairs(result) do tItem:SetClipColor("Blue") end
                    end
                end
            end
        end
    end

    if currentFolder then state.mediaPool:SetCurrentFolder(currentFolder) end
    timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())
    print("[AutoSubs Server] ✅ AddMediaToTimeline completed: " .. actualAdded .. "/" .. #clips .. " clips added")

    if actualAdded > 0 then
        return { success = true, message = string.format("Added %d/%d clips", actualAdded, #clips), clipsAdded = actualAdded }
    else
        return { error = true, message = "No clips were added", clipsAdded = 0 }
    end
end

-- ===== ADD AUDIO TO TIMELINE =====
-- Import 1 file audio vào audio track mới
function M.AddAudioToTimeline(state, helpers, filePath, trackName)
    print("[AutoSubs] AddAudioToTimeline: " .. filePath)

    local timeline = state.project:GetCurrentTimeline()
    if not timeline then
        return { error = true, message = "No active timeline found" }
    end

    local frame_rate = timeline:GetSetting("timelineFrameRate")
    local timelineStart = timeline:GetStartFrame()

    -- Import vào Media Pool
    local currentFolder = state.mediaPool:GetCurrentFolder()
    local audioFolder = state.mediaPool:AddSubFolder(currentFolder, "AutoSubs Audio")
    if audioFolder then state.mediaPool:SetCurrentFolder(audioFolder) end

    local mediaPoolItems = state.mediaPool:ImportMedia({ filePath })
    if currentFolder then state.mediaPool:SetCurrentFolder(currentFolder) end

    if not mediaPoolItems or #mediaPoolItems == 0 then
        return { error = true, message = "Không import được file audio" }
    end

    local audioItem = mediaPoolItems[1]
    local clipProps = audioItem:GetClipProperty()

    -- Tạo audio track mới
    local newTrackIdx = timeline:GetTrackCount("audio") + 1
    timeline:AddTrack("audio")
    local label = trackName or "BGM - AutoSubs"
    pcall(function() timeline:SetTrackName("audio", newTrackIdx, label) end)

    -- Tính frame info
    local clipFPS = tonumber(clipProps["FPS"]) or frame_rate
    if clipFPS <= 0 then clipFPS = frame_rate end
    local totalFrames = tonumber(clipProps["Frames"]) or 0
    if totalFrames <= 0 then
        local dur = tonumber(clipProps["Duration"]) or 0
        totalFrames = dur > 0 and math.floor(dur * clipFPS) or math.floor(3600 * clipFPS)
    end

    -- Đặt lên timeline
    local audioClip = {
        mediaPoolItem = audioItem, mediaType = 2,
        startFrame = 0, endFrame = totalFrames,
        recordFrame = timelineStart, trackIndex = newTrackIdx
    }
    local timelineItems = state.mediaPool:AppendToTimeline({ audioClip })

    if not timelineItems or #timelineItems == 0 then
        return { error = true, message = "Không thêm được audio lên timeline" }
    end

    pcall(function() timelineItems[1]:SetClipColor("Purple") end)
    timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())

    return {
        success = true, audioTrack = newTrackIdx, trackName = label,
        message = "Đã thêm nhạc nền vào Audio Track A" .. newTrackIdx
    }
end

-- ===== ADD SFX CLIPS TO TIMELINE =====
-- Import nhiều SFX clips vào audio track với timing chính xác
function M.AddSfxClipsToTimeline(state, helpers, clips, trackName)
    print("[AutoSubs] AddSfxClipsToTimeline: " .. #clips .. " clips")

    local timeline = state.project:GetCurrentTimeline()
    if not timeline then
        return { error = true, message = "No active timeline found" }
    end

    if #clips == 0 then
        return { error = true, message = "No SFX clips provided" }
    end

    local frame_rate = timeline:GetSetting("timelineFrameRate")
    local timelineStart = timeline:GetStartFrame()

    -- Thu thập unique file paths
    local uniquePaths = {}
    local pathSet = {}
    for _, clip in ipairs(clips) do
        if not pathSet[clip.filePath] then
            pathSet[clip.filePath] = true
            table.insert(uniquePaths, clip.filePath)
        end
    end

    -- Import vào Media Pool
    local currentFolder = state.mediaPool:GetCurrentFolder()
    local sfxFolder = state.mediaPool:AddSubFolder(currentFolder, "AutoSubs SFX")
    if sfxFolder then state.mediaPool:SetCurrentFolder(sfxFolder) end

    local mediaPoolItems = state.mediaPool:ImportMedia(uniquePaths)
    if currentFolder then state.mediaPool:SetCurrentFolder(currentFolder) end

    if not mediaPoolItems or #mediaPoolItems == 0 then
        return { error = true, message = "Failed to import SFX files" }
    end

    -- Mapping fileName → item
    local mediaItemMap = {}
    for _, item in ipairs(mediaPoolItems) do
        local props = item:GetClipProperty()
        local itemName = props["File Name"] or props["Clip Name"] or ""
        if itemName == "" then
            itemName = (props["File Path"] or ""):match("([^/\\]+)$") or ""
        end
        if itemName ~= "" then mediaItemMap[itemName] = item end
    end

    local targetTrackIdx = 1
    local label = trackName or "SFX - AutoSubs"
    local addedCount = 0

    for i, clip in ipairs(clips) do
        local fileName = clip.filePath:match("([^/\\]+)$") or ""
        local mediaItem = mediaItemMap[fileName]

        if mediaItem then
            local startTime = tonumber(clip.startTime) or 0
            local timeline_pos = timelineStart + math.floor(startTime * frame_rate)

            local clipProps = mediaItem:GetClipProperty()
            local clipFPS = tonumber(clipProps["FPS"]) or frame_rate
            if clipFPS <= 0 then clipFPS = frame_rate end

            local sfxStartFrame = 0
            local sfxEndFrame = -1
            if clip.trimStartSec or clip.trimEndSec then
                sfxStartFrame = math.floor((tonumber(clip.trimStartSec) or 0) * clipFPS)
                if clip.trimEndSec then
                    sfxEndFrame = math.floor(tonumber(clip.trimEndSec) * clipFPS)
                end
            end

            local result = state.mediaPool:AppendToTimeline({{
                mediaPoolItem = mediaItem, mediaType = 2,
                startFrame = sfxStartFrame, endFrame = sfxEndFrame,
                recordFrame = timeline_pos, trackIndex = targetTrackIdx
            }})
            if result and #result > 0 then
                addedCount = addedCount + 1
                pcall(function() result[1]:SetClipColor("Orange") end)
            end
        end
    end

    timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())
    return {
        success = true, audioTrack = targetTrackIdx,
        clipsAdded = addedCount,
        message = string.format("Added %d/%d SFX clips", addedCount, #clips)
    }
end

return M
