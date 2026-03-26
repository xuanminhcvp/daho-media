-- ============================================================
-- subtitle_renderer.lua — Thêm phụ đề lên timeline
-- AddSubtitles (chính), AddSimpleSubtitles (stories),
-- AddTemplateSubtitles (nhiều template), CheckTrackConflicts,
-- SetCustomColors, ApplyTemplateStyle
-- ============================================================

local M = {}

-- ===== TEMPLATE STYLES =====
-- Preset visual cho từng loại template subtitle
local TEMPLATE_STYLES = {
    ["Location Card"] = {
        font = "Courier New", size = 0.042, bold = false, italic = false,
        red1 = 0.85, green1 = 0.88, blue1 = 0.90,
        red4 = 0.05, green4 = 0.05, blue4 = 0.05,
        clipColor = "Lime",
    },
    ["Impact Number"] = {
        font = "Arial Black", size = 0.09, bold = true, italic = false,
        red1 = 0.96, green1 = 0.75, blue1 = 0.04,
        red4 = 0.25, green4 = 0.18, blue4 = 0.0,
        clipColor = "Yellow",
    },
    ["Death / Violence"] = {
        font = "Arial Black", size = 0.08, bold = true, italic = false,
        red1 = 0.94, green1 = 0.22, blue1 = 0.22,
        red4 = 0.35, green4 = 0.0, blue4 = 0.0,
        clipColor = "Red",
    },
    ["Document / ID Card"] = {
        font = "Courier New", size = 0.05, bold = false, italic = false,
        red1 = 0.02, green1 = 0.71, blue1 = 0.83,
        red4 = 0.0, green4 = 0.22, blue4 = 0.28,
        clipColor = "Cyan",
    },
    ["Quote / Motif"] = {
        font = "Georgia", size = 0.06, bold = false, italic = true,
        red1 = 1.0, green1 = 1.0, blue1 = 1.0,
        red4 = 0.18, green4 = 0.18, blue4 = 0.18,
        clipColor = "Purple",
    },
}

-- Clip color cho Title .setting (đã có style sẵn, chỉ cần phân biệt bằng mắt)
-- ✅ Fix: đủ Title 1–8
local TITLE_CLIP_COLORS = {
    ["Title 1"] = "Yellow",   -- Document / ID Card
    ["Title 2"] = "Orange",   -- Location / Impact
    ["Title 3"] = "Red",      -- Death / Violence
    ["Title 4"] = "Purple",   -- Quote / Motif
    ["Title 5"] = "Cream",    -- Main Title
    ["Title 6"] = "Teal",     -- Chapter / Scene
    ["Title 7"] = "Pink",     -- Fact / Stat Card
    ["Title 8"] = "Lavender", -- Emphasis / Key Text
}

-- ===== SET CUSTOM COLORS =====
-- Áp dụng fill/outline/border color cho TextPlus tool từ speaker config
function M.SetCustomColors(helpers, speaker, tool)
    local color = nil
    if speaker.fill.enabled and speaker.fill.color ~= "" then
        color = helpers.hexToRgb(speaker.fill.color)
        if color then
            tool:SetInput("Enabled1", 1)
            tool:SetInput("Red1", color.r); tool:SetInput("Green1", color.g); tool:SetInput("Blue1", color.b)
        end
    end
    if speaker.outline.enabled and speaker.outline.color ~= "" then
        color = helpers.hexToRgb(speaker.outline.color)
        if color then
            tool:SetInput("Enabled2", 1)
            tool:SetInput("Red2", color.r); tool:SetInput("Green2", color.g); tool:SetInput("Blue2", color.b)
        end
    end
    if speaker.border.enabled and speaker.border.color ~= "" then
        color = helpers.hexToRgb(speaker.border.color)
        if color then
            tool:SetInput("Enabled4", 1)
            tool:SetInput("Red4", color.r); tool:SetInput("Green4", color.g); tool:SetInput("Blue4", color.b)
        end
    end
end

-- ===== APPLY TEMPLATE STYLE =====
-- Set font, size, color cho TextPlus tool theo template type
function M.ApplyTemplateStyle(tool, templateName)
    local style = TEMPLATE_STYLES[templateName]
    if not style then return false end

    print("[AutoSubs] Applying style '" .. templateName .. "': font=" .. style.font .. " size=" .. style.size)
    pcall(function() tool:SetInput("Font", style.font) end)
    pcall(function() tool:SetInput("Size", style.size) end)
    pcall(function()
        tool:SetInput("Red1", style.red1); tool:SetInput("Green1", style.green1); tool:SetInput("Blue1", style.blue1)
    end)
    pcall(function()
        tool:SetInput("Red4", style.red4); tool:SetInput("Green4", style.green4); tool:SetInput("Blue4", style.blue4)
    end)
    return true
end

-- ===== CHECK TRACK CONFLICTS =====
-- Kiểm tra xung đột giữa phụ đề mới và clips đã có trên track
function M.CheckTrackConflicts(state, helpers, filePath, trackIndex)
    local timeline = state.project:GetCurrentTimeline()
    local timelineStart = timeline:GetStartFrame()
    local frame_rate = timeline:GetSetting("timelineFrameRate")

    local data = helpers.read_json_file(filePath, state.json)
    if type(data) ~= "table" then
        return { hasConflicts = false, error = "Could not read subtitle file" }
    end

    local subtitles = data["segments"]
    if not subtitles or #subtitles == 0 then
        return { hasConflicts = false, message = "No subtitles to add" }
    end

    local firstSubStart = helpers.to_frames(subtitles[1]["start"], frame_rate) + timelineStart
    local lastSubEnd = helpers.to_frames(subtitles[#subtitles]["end"], frame_rate) + timelineStart

    trackIndex = tonumber(trackIndex)
    if not trackIndex or trackIndex <= 0 or trackIndex > timeline:GetTrackCount("video") then
        return { hasConflicts = false, trackExists = false }
    end

    local trackName = timeline:GetTrackName("video", trackIndex) or ("Video " .. trackIndex)
    local existingClips = timeline:GetItemListInTrack("video", trackIndex)
    if not existingClips or #existingClips == 0 then
        return { hasConflicts = false, trackName = trackName }
    end

    local conflictingClips = {}
    for _, clip in ipairs(existingClips) do
        local clipStart = clip:GetStart()
        local clipEnd = clip:GetEnd()
        if clipStart < lastSubEnd and clipEnd > firstSubStart then
            table.insert(conflictingClips, {
                start = (clipStart - timelineStart) / frame_rate,
                ["end"] = (clipEnd - timelineStart) / frame_rate,
                name = clip:GetName() or "Unnamed clip"
            })
        end
    end

    return {
        hasConflicts = #conflictingClips > 0,
        conflictingClips = conflictingClips,
        trackName = trackName,
        totalConflicts = #conflictingClips
    }
end

-- ===== ADD SUBTITLES =====
-- Thêm phụ đề chính lên timeline (từ file JSON phụ đề)
function M.AddSubtitles(state, helpers, template_manager, timeline_info, filePath, trackIndex, templateName, conflictMode)
    state.resolve:OpenPage("edit")

    local data = helpers.read_json_file(filePath, state.json)
    if type(data) ~= "table" then
        print("Error reading JSON file")
        return false
    end

    local timeline = state.project:GetCurrentTimeline()
    local timelineStart = timeline:GetStartFrame()
    local timelineEnd = timeline:GetEndFrame()
    local markIn = data["mark_in"]
    local markOut = data["mark_out"]
    local subtitles = data["segments"]
    local speakers = data["speakers"]
    local speakersExist = speakers and #speakers > 0

    if not markIn or not markOut then
        local success, err = pcall(function()
            local markInOut = timeline:GetMarkInOut()
            markIn = (markInOut.audio["in"] and markInOut.audio["in"] + timelineStart) or timelineStart
            markOut = (markInOut.audio["out"] and markInOut.audio["out"] + timelineStart) or timelineEnd
        end)
        if not success then
            markIn = timelineStart
            markOut = timelineEnd
        end
    end

    trackIndex = timeline_info.SanitizeTrackIndex(timeline, trackIndex, markIn, markOut)

    if speakersExist then
        for i, speaker in ipairs(speakers) do
            if speaker.track == nil or speaker.track == "" then
                speaker.track = trackIndex
            else
                speaker.track = timeline_info.SanitizeTrackIndex(timeline, speaker.track, markIn, markOut)
            end
        end
    end

    local rootFolder = state.mediaPool:GetRootFolder()

    if templateName == "" then
        local availableTemplates = template_manager.GetTemplates(state, helpers)
        if #availableTemplates > 0 then
            templateName = availableTemplates[1].value
        end
    end

    local templateItem = nil
    if templateName ~= nil and templateName ~= "" then
        templateItem = template_manager.GetTemplateItem(helpers, rootFolder, templateName)
    end
    if not templateItem then
        templateItem = template_manager.GetTemplateItem(helpers, rootFolder, "Default Template")
    end
    if not templateItem then
        print("Error: Could not find subtitle template")
        return false
    end
    local template_frame_rate = templateItem:GetClipProperty()["FPS"]
    local frame_rate = timeline:GetSetting("timelineFrameRate")

    -- Handle conflict modes
    if conflictMode == "new_track" then
        trackIndex = timeline:GetTrackCount("video") + 1
        timeline:AddTrack("video")
    elseif conflictMode == "replace" then
        local existingClips = timeline:GetItemListInTrack("video", trackIndex)
        if existingClips and #existingClips > 0 then
            local firstSubStart = helpers.to_frames(subtitles[1]["start"], frame_rate) + timelineStart
            local lastSubEnd = helpers.to_frames(subtitles[#subtitles]["end"], frame_rate) + timelineStart
            local clipsToDelete = {}
            for _, clip in ipairs(existingClips) do
                if clip:GetStart() < lastSubEnd and clip:GetEnd() > firstSubStart then
                    table.insert(clipsToDelete, clip)
                end
            end
            for _, clip in ipairs(clipsToDelete) do
                timeline:DeleteClips({clip}, false)
            end
        end
    elseif conflictMode == "skip" then
        local existingClips = timeline:GetItemListInTrack("video", trackIndex)
        if existingClips and #existingClips > 0 then
            local filteredSubtitles = {}
            for _, subtitle in ipairs(subtitles) do
                local subStart = helpers.to_frames(subtitle["start"], frame_rate) + timelineStart
                local subEnd = helpers.to_frames(subtitle["end"], frame_rate) + timelineStart
                local hasConflict = false
                for _, clip in ipairs(existingClips) do
                    if subStart < clip:GetEnd() and subEnd > clip:GetStart() then
                        hasConflict = true
                        break
                    end
                end
                if not hasConflict then
                    table.insert(filteredSubtitles, subtitle)
                end
            end
            subtitles = filteredSubtitles
            if #subtitles == 0 then
                return { success = true, message = "All subtitles skipped", added = 0 }
            end
        end
    end

    -- Build clip list
    local joinThreshold = frame_rate
    local clipList = {}
    for i, subtitle in ipairs(subtitles) do
        local start_frame = helpers.to_frames(subtitle["start"], frame_rate)
        local end_frame = helpers.to_frames(subtitle["end"], frame_rate)
        local timeline_pos = timelineStart + start_frame
        local clip_timeline_duration = end_frame - start_frame

        if i < #subtitles then
            local next_start = timelineStart + helpers.to_frames(subtitles[i + 1]["start"], frame_rate)
            local frames_between = next_start - (timeline_pos + clip_timeline_duration)
            if frames_between < joinThreshold then
                clip_timeline_duration = clip_timeline_duration + frames_between + 1
            end
        end

        local duration = (clip_timeline_duration / frame_rate) * template_frame_rate
        local itemTrack = trackIndex
        if speakersExist then
            local speaker = speakers[tonumber(subtitle["speaker_id"]) + 1]
            if speaker.track ~= nil and speaker.track ~= "" then
                itemTrack = speaker.track
            end
        end

        table.insert(clipList, {
            mediaPoolItem = templateItem,
            mediaType = 1,
            startFrame = 0,
            endFrame = duration,
            recordFrame = timeline_pos,
            trackIndex = itemTrack
        })
    end

    local timelineItems = state.mediaPool:AppendToTimeline(clipList)

    for i, timelineItem in ipairs(timelineItems) do
        local success, err = pcall(function()
            local subtitle = subtitles[i]
            if timelineItem:GetFusionCompCount() > 0 then
                local comp = timelineItem:GetFusionCompByIndex(1)
                local tool = comp:FindToolByID("TextPlus")
                tool:SetInput("StyledText", subtitle["text"])

                if speakersExist then
                    local speaker_id = subtitle["speaker_id"]
                    if speaker_id ~= "?" then
                        M.SetCustomColors(helpers, speakers[tonumber(speaker_id) + 1], tool)
                    end
                end
                timelineItem:SetClipColor("Green")
            end
        end)
        if not success then
            print("Failed to add subtitle: " .. err)
        end
    end

    timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())
end

-- ===== ADD SIMPLE SUBTITLES =====
-- Thêm phụ đề stories (batch, 1 template, font size cố định)
function M.AddSimpleSubtitles(state, helpers, template_manager, clips, templateName, trackIndex, fontSize)
    print(string.format("[AutoSubs] AddSimpleSubtitles: %d clips, template='%s', track=%s, fontSize=%s",
        #clips, tostring(templateName), tostring(trackIndex), tostring(fontSize)))
    if not clips or #clips == 0 then
        return { error = true, message = "No clips provided" }
    end

    state.resolve:OpenPage("edit")
    local timeline = state.project:GetCurrentTimeline()
    if not timeline then
        return { error = true, message = "No active timeline found" }
    end

    local frame_rate = timeline:GetSetting("timelineFrameRate")
    local timelineStart = timeline:GetStartFrame()
    local rootFolder = state.mediaPool:GetRootFolder()

    -- Xử lý trackIndex: kiểm tra track tồn tại hay cần tạo mới
    trackIndex = tonumber(trackIndex) or 0
    local totalTracks = timeline:GetTrackCount("video")
    if trackIndex == 0 then
        -- Track auto → tạo mới
        trackIndex = totalTracks + 1
        timeline:AddTrack("video")
        print(string.format("[AutoSubs] Created new track V%d", trackIndex))
    elseif trackIndex > totalTracks then
        -- Track chỉ định > số track hiện có → tạo thêm cho đủ
        for _ = totalTracks + 1, trackIndex do
            timeline:AddTrack("video")
        end
        print(string.format("[AutoSubs] Extended tracks to V%d", trackIndex))
    end
    print(string.format("[AutoSubs] Using track V%d (total tracks: %d)", trackIndex, timeline:GetTrackCount("video")))

    -- Tìm template
    if not templateName or templateName == "" then templateName = "Default Template" end
    local templateItem = template_manager.GetTemplateItem(helpers, rootFolder, templateName)
    if not templateItem then
        templateItem = template_manager.ImportTitleFromFile(state, helpers, templateName)
    end
    if not templateItem then
        local avail = template_manager.GetTemplates(state, helpers)
        if #avail > 0 then
            templateItem = template_manager.GetTemplateItem(helpers, rootFolder, avail[1].value)
        end
    end
    if not templateItem then
        return { error = true, message = "Template not found: " .. tostring(templateName) }
    end

    local template_frame_rate = templateItem:GetClipProperty()["FPS"] or frame_rate
    fontSize = tonumber(fontSize) or 0.04
    print(string.format("[AutoSubs] Template: '%s', FPS=%s, fontSize=%s", templateName, tostring(template_frame_rate), tostring(fontSize)))

    -- ⭐ Chia clips thành batch nhỏ → AppendToTimeline từng batch
    -- DaVinci phải tạo Fusion comp cho mỗi Text+ → rất nặng RAM
    -- Giảm batch size + sleep giữa các batch để DaVinci "thở"
    local BATCH_SIZE = 15  -- ★ Giảm từ 30 → 15 (tránh RAM spike)
    local BATCH_SLEEP = 1.5  -- ★ Sleep 1.5s giữa các batch
    local addedCount = 0
    local totalBatches = math.ceil(#clips / BATCH_SIZE)

    for batchIdx = 1, totalBatches do
        local batchStart = (batchIdx - 1) * BATCH_SIZE + 1
        local batchEnd = math.min(batchIdx * BATCH_SIZE, #clips)
        local batchClips = {}

        -- Build clipList cho batch này
        local clipList = {}
        for i = batchStart, batchEnd do
            local clipData = clips[i]
            local start_frame = helpers.to_frames(clipData["start"], frame_rate)
            local end_frame = helpers.to_frames(clipData["end"], frame_rate)
            local clip_duration = end_frame - start_frame
            if clip_duration <= 0 then clip_duration = 1 end
            local duration = (clip_duration / frame_rate) * template_frame_rate

            table.insert(clipList, {
                mediaPoolItem = templateItem, mediaType = 1,
                startFrame = 0, endFrame = duration,
                recordFrame = timelineStart + start_frame,
                trackIndex = trackIndex
            })
            table.insert(batchClips, clipData)
        end

        print(string.format("[AutoSubs] Batch %d/%d: clips %d-%d (%d clips)",
            batchIdx, totalBatches, batchStart, batchEnd, #clipList))

        -- AppendToTimeline cho batch này
        local timelineItems = state.mediaPool:AppendToTimeline(clipList)

        if not timelineItems or #timelineItems == 0 then
            print(string.format("[AutoSubs] ⚠️ Batch %d failed! Trying one-by-one...", batchIdx))
            -- Fallback: thử thêm từng clip 1 (chậm nhưng an toàn hơn)
            for ci, singleClip in ipairs(clipList) do
                local singleResult = state.mediaPool:AppendToTimeline({ singleClip })
                if singleResult and #singleResult > 0 then
                    pcall(function()
                        local item = singleResult[1]
                        if item:GetFusionCompCount() > 0 then
                            local comp = item:GetFusionCompByIndex(1)
                            local tool = comp:FindToolByID("TextPlus")
                            if tool then
                                tool:SetInput("StyledText", batchClips[ci]["text"] or "")
                                pcall(function() tool:SetInput("Size", fontSize) end)
                                addedCount = addedCount + 1
                            end
                        end
                        item:SetClipColor("Yellow")
                    end)
                end
            end
        else
            -- Set text cho từng clip trong batch
            for ci, timelineItem in ipairs(timelineItems) do
                pcall(function()
                    if timelineItem:GetFusionCompCount() > 0 then
                        local comp = timelineItem:GetFusionCompByIndex(1)
                        local tool = comp:FindToolByID("TextPlus")
                        if tool then
                            tool:SetInput("StyledText", batchClips[ci]["text"] or "")
                            pcall(function() tool:SetInput("Size", fontSize) end)
                            addedCount = addedCount + 1
                        end
                    end
                    timelineItem:SetClipColor("Yellow")
                end)
            end
            print(string.format("[AutoSubs] Batch %d done: %d/%d clips added ✅", batchIdx, #timelineItems, #clipList))
        end

        -- ★ Sleep giữa batch để DaVinci xử lý Fusion comps (tránh RAM spike)
        if batchIdx < totalBatches then
            print(string.format("[AutoSubs] 💤 Sleep %.1fs trước batch tiếp...", BATCH_SLEEP))
            helpers.sleep(BATCH_SLEEP)
        end
    end

    timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())
    print(string.format("[AutoSubs] AddSimpleSubtitles complete: %d/%d clips added to V%d", addedCount, #clips, trackIndex))
    return { success = true, added = addedCount, total = #clips, trackIndex = trackIndex }
end

-- ===== ADD TEMPLATE SUBTITLES (V2 — Fusion Compositions từ Power Bin) =====
-- Flow mới:
--   1. Tìm Fusion Composition theo tên trong Media Pool (bao gồm Power Bin)
--   2. AppendToTimeline trực tiếp (không cần ImportFusionComp)
--   3. Set text vào TextPlus trong Fusion comp
--   4. Thêm Adjustment Clip ở track dưới (V8)
--   5. Thêm SFX ở audio track (A10)
function M.AddTemplateSubtitles(state, helpers, template_manager, clips, trackIndex)
    print("[AutoSubs] Running AddTemplateSubtitles V2 with " .. #clips .. " clips...")
    if not clips or #clips == 0 then
        return { error = true, message = "No clips provided" }
    end

    local timeline = state.project:GetCurrentTimeline()
    if not timeline then
        return { error = true, message = "No active timeline found" }
    end

    local frame_rate = timeline:GetSetting("timelineFrameRate")
    local timelineStart = timeline:GetStartFrame()
    local rootFolder = state.mediaPool:GetRootFolder()

    -- ═══ TRACK CONFIG ═══
    local titleTrackIdx = tonumber(trackIndex) or 9      -- Title clip (V9)
    local adjustmentTrackIdx = titleTrackIdx - 1          -- Adjustment ngay dưới (V8)
    local sfxTrackIdx = 3                                 -- SFX audio (A3)

    -- ═══ TÌM ASSET TRONG MEDIA POOL + POWER BINS (đệ quy) ═══
    -- walk_media_pool_with_power_bins sẽ dẫn rootFolder (Media Pool) + Power Bin hiện tại
    local assetCache = {} -- cache theo tên
    local function findAsset(name)
        if assetCache[name] then return assetCache[name] end
        local found = nil
        -- Dùng hàm mới: dận cả Power Bins
        helpers.walk_media_pool_with_power_bins(state.mediaPool, function(clip)
            if found then return end -- đã tìm thấy, bỏ qua
            local clipName = clip:GetName() or ""
            if clipName == name then
                found = clip
            end
        end)
        if found then
            assetCache[name] = found
            print("[AutoSubs] ✅ Asset cached: '" .. name .. "'")
        else
            print("[AutoSubs] ⚠️ Asset không tìm thấy: '" .. name .. "'")
        end
        return found
    end

    -- ═══ CACHE ADJUSTMENT CLIP + SFX ═══
    local adjustmentItem = findAsset("Adjustment Clip")
    if adjustmentItem then
        print("[AutoSubs] 📎 Adjustment Clip found: " .. tostring(adjustmentItem:GetName()))
    else
        print("[AutoSubs] ⚠ Adjustment Clip KHÔNG TÌM THẤY trong Media Pool")
    end

    -- Cache SFX items (3 loại: đập xuống, xuất hiện, đánh máy)
    local sfxItems = {}
    for _, sfxName in ipairs({"Cinematic Hit 3.mp3", "Click.mp3", "ComputerDesktop 6103_69_4.WAV"}) do
        local item = findAsset(sfxName)
        if item then
            sfxItems[sfxName] = item
            print("[AutoSubs] 🎵 SFX cached: '" .. sfxName .. "'")
        else
            print("[AutoSubs] ⚠ SFX '" .. sfxName .. "' KHÔNG TÌM THẤY")
        end
    end

    -- ═══ CLIP COLOR MAP (phân biệt trên timeline) ═══
    local CLIP_COLORS = {
        ["xanh to xuất hiện"] = "Teal",
        ["xanh to đập xuống"] = "Teal",
        ["Xanh nhỏ xuất hiện"] = "Cyan",
        ["Xanh nhỏ đánh máy"] = "Cyan",
        ["vàng to xuất hiện"] = "Yellow",
        ["vàng to đập xuống"] = "Orange",
        ["Vàng nhỏ xuất hiện"] = "Yellow",
        ["Vàng nhỏ đánh máy"] = "Cream",
        ["đỏ to xuất hiện"] = "Red",
        ["đỏ to đập xuống"] = "Red",
    }

    -- ═══ VÒNG LẶP CHÍNH — ADD TỪNG CLIP ═══
    local addedCount = 0
    print(string.format("[AutoSubs] AddTemplateSubtitles V2: %d clips → Title V%d + Adj V%d + SFX A%d",
        #clips, titleTrackIdx, adjustmentTrackIdx, sfxTrackIdx))

    for i, clipData in ipairs(clips) do
        local tplName = clipData.template or ""
        local subtitleText = clipData["text"] or ""
        local sfxName = clipData["sfx"] or clipData["sfxName"] or ""

        -- ═══ BƯỚC 1: Tìm Fusion Composition trong Media Pool ═══
        local tplItem = findAsset(tplName)
        if not tplItem then
            -- Fallback: tìm "Default Template" nếu không tìm thấy
            print(string.format("[AutoSubs] ⚠ [%d/%d] Template '%s' KHÔNG TÌM THẤY → thử Default Template", i, #clips, tplName))
            tplItem = findAsset("Default Template")
            if not tplItem then
                tplItem = template_manager.GetTemplateItem(helpers, rootFolder, "Default Template")
            end
        end

        if not tplItem then
            print(string.format("[AutoSubs] ❌ [%d/%d] SKIP — không có template", i, #clips))
            goto continue
        end

        -- ═══ BƯỚC 2: Tính frames ═══
        local tpl_fps = tplItem:GetClipProperty()["FPS"] or frame_rate
        local start_frame = helpers.to_frames(clipData["start"], frame_rate)
        local end_frame = helpers.to_frames(clipData["end"], frame_rate)
        local timeline_pos = timelineStart + start_frame
        local clip_timeline_duration = end_frame - start_frame

        -- Gap joining (giữ nguyên logic cũ)
        if i < #clips then
            local next_start = timelineStart + helpers.to_frames(clips[i + 1]["start"], frame_rate)
            local frames_between = next_start - (timeline_pos + clip_timeline_duration)
            if frames_between < frame_rate then
                clip_timeline_duration = clip_timeline_duration + frames_between + 1
            end
        end

        local duration = (clip_timeline_duration / frame_rate) * tpl_fps

        -- ═══ BƯỚC 3: Append Title Clip (trực tiếp từ Fusion Composition) ═══
        local newClip = {
            mediaPoolItem = tplItem, mediaType = 1,
            startFrame = 0, endFrame = duration,
            recordFrame = timeline_pos,
            trackIndex = titleTrackIdx
        }

        print(string.format("[AutoSubs] [%d/%d] Add: tpl='%s' start=%.2fs end=%.2fs text='%s'",
            i, #clips, tplName, clipData["start"] or 0, clipData["end"] or 0,
            (subtitleText):sub(1, 40)))

        local timelineItems = state.mediaPool:AppendToTimeline({ newClip })
        if timelineItems and #timelineItems > 0 then
            addedCount = addedCount + 1
            local timelineItem = timelineItems[1]

            -- Đặt clip color
            local clipColor = CLIP_COLORS[tplName] or "Green"
            pcall(function() timelineItem:SetClipColor(clipColor) end)

            -- ═══ BƯỚC 4: Set text vào TextPlus ═══
            pcall(function()
                local compCount = timelineItem:GetFusionCompCount()
                if compCount > 0 then
                    local comp = timelineItem:GetFusionCompByIndex(compCount)
                    local tool = comp:FindToolByID("TextPlus")
                    if tool then
                        tool:SetInput("StyledText", subtitleText)
                        print(string.format("[AutoSubs]   ✅ Text set: '%s'", subtitleText:sub(1, 50)))
                    else
                        print("[AutoSubs]   ⚠ TextPlus không tìm thấy trong comp")
                    end
                end
            end)

            -- ═══ BƯỚC 5: Append Adjustment Clip (V8) ═══
            if adjustmentItem then
                pcall(function()
                    local adjClip = {
                        mediaPoolItem = adjustmentItem, mediaType = 1,
                        startFrame = 0, endFrame = duration,
                        recordFrame = timeline_pos,
                        trackIndex = adjustmentTrackIdx
                    }
                    local adjResult = state.mediaPool:AppendToTimeline({ adjClip })
                    if adjResult and #adjResult > 0 then
                        print("[AutoSubs]   📎 Adjustment added V" .. adjustmentTrackIdx)
                    else
                        print("[AutoSubs]   ⚠ Adjustment append FAILED")
                    end
                end)
            end

            -- ═══ BƯỚC 6: Append SFX (A10) ═══
            local sfxToUse = sfxName ~= "" and sfxItems[sfxName] or nil
            -- Nếu frontend không gửi sfxName, tự chọn theo tên template
            if not sfxToUse then
                -- Auto-select SFX theo tên template:
                -- "đập xuống" → Cinematic Hit (slam impact)
                -- "đánh máy" → ComputerDesktop (typewriter sound)
                -- còn lại → Click (xuất hiện)
                if tplName:find("đập xuống") then
                    sfxToUse = sfxItems["Cinematic Hit 3.mp3"]
                elseif tplName:find("đánh máy") then
                    sfxToUse = sfxItems["ComputerDesktop 6103_69_4.WAV"]
                else
                    sfxToUse = sfxItems["Click.mp3"]
                end
            end

            if sfxToUse then
                pcall(function()
                    local sfxClipData = {
                        mediaPoolItem = sfxToUse, mediaType = 2,
                        startFrame = 0, endFrame = -1,
                        recordFrame = timeline_pos,
                        trackIndex = sfxTrackIdx
                    }
                    local sfxResult = state.mediaPool:AppendToTimeline({ sfxClipData })
                    if sfxResult and #sfxResult > 0 then
                        print("[AutoSubs]   🎵 SFX added A" .. sfxTrackIdx)
                    else
                        print("[AutoSubs]   ⚠ SFX append FAILED")
                    end
                end)
            end

            print(string.format("[AutoSubs]   ✅ Clip %d done: color=%s", i, clipColor))
        else
            print(string.format("[AutoSubs]   ❌ Clip %d AppendToTimeline FAILED: tpl='%s'", i, tplName))
        end

        ::continue::
    end

    timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())
    print(string.format("[AutoSubs] AddTemplateSubtitles V2 DONE: %d/%d clips added", addedCount, #clips))
    return { success = true, added = addedCount, total = #clips }
end

return M
