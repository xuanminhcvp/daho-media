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

-- ===== ADD REF IMAGES TO TIMELINE =====
-- Import ảnh tham khảo thực tế lên Track V4 với hiệu ứng:
--   + Full-frame (priority "high" + type portrait/headline/evidence)
--   + Overlay (~90% opacity, nhỏ hơn): ảnh nhẹ, nền 3D vẫn thấy
--   + Ken Burns nhẹ: zoom 100% → 105%
--   + Cross Dissolve transition 0.3s
-- Fix theo ChatGPT: verify AddTrack, unlock/enable V4, map khép, fallback endFrame=1
function M.AddRefImagesToTimeline(state, helpers, clips, sfxClips)
    print("[RefImages] ====== AddRefImagesToTimeline START (" .. #clips .. " clips) ======")

    local project   = state.project
    local mediaPool = state.mediaPool

    if not project or not mediaPool then
        return { error = true, message = "Project or MediaPool is nil" }
    end

    local timeline = project:GetCurrentTimeline()
    if not timeline then
        return { error = true, message = "No active timeline found" }
    end

    local frame_rate    = tonumber(timeline:GetSetting("timelineFrameRate")) or 24
    local timelineStart = tonumber(timeline:GetStartFrame()) or 0
    local trackIdx      = 4  -- Track V4 cố định cho ref images

    -- ----------------------------------------------------------------
    -- FIX 1: Verify V4 tồn tại thật sau mỗi AddTrack()
    --        AddTrack() trả về Bool, không verify dễ bị fail âm thầm
    -- ----------------------------------------------------------------
    local function ensureVideoTrack(tl, wantedIndex)
        local currentCount = tonumber(tl:GetTrackCount("video")) or 0
        print(string.format("[RefImages] Video tracks hiện tại: %d, cần: %d", currentCount, wantedIndex))
        while currentCount < wantedIndex do
            local ok = tl:AddTrack("video")
            print(string.format("[RefImages] AddTrack(video) => %s", tostring(ok)))
            -- Re-read ngay sau AddTrack — không giả định thành công
            currentCount = tonumber(tl:GetTrackCount("video")) or 0
            print(string.format("[RefImages] Video tracks sau add: %d", currentCount))
            if currentCount >= wantedIndex then break end
            if not ok then
                return false, string.format("AddTrack(video) thất bại khi tạo V%d", wantedIndex)
            end
        end
        return currentCount >= wantedIndex, nil
    end

    local okTrack, trackErr = ensureVideoTrack(timeline, trackIdx)
    if not okTrack then
        return { error = true, message = trackErr or "Không tạo được video track V4" }
    end

    -- Reacquire timeline sau khi thêm track (đề phòng state thay đổi)
    timeline = project:GetCurrentTimeline()
    if not timeline then
        return { error = true, message = "Timeline mất sau AddTrack" }
    end

    -- ----------------------------------------------------------------
    -- FIX 2: Unlock + Enable V4 trước khi append
    --        AppendToTimeline âm thầm fail nếu track bị locked/disabled
    -- ----------------------------------------------------------------
    local isEnabled = timeline:GetIsTrackEnabled("video", trackIdx)
    local isLocked  = timeline:GetIsTrackLocked("video", trackIdx)
    print(string.format("[RefImages] V%d: enabled=%s, locked=%s",
        trackIdx, tostring(isEnabled), tostring(isLocked)))

    if isEnabled == false then
        local enOk = timeline:SetTrackEnable("video", trackIdx, true)
        print(string.format("[RefImages] SetTrackEnable(video,%d,true) => %s", trackIdx, tostring(enOk)))
    end
    if isLocked == true then
        local ulOk = timeline:SetTrackLock("video", trackIdx, false)
        print(string.format("[RefImages] SetTrackLock(video,%d,false) => %s", trackIdx, tostring(ulOk)))
    end

    -- ----------------------------------------------------------------
    -- 3) Thu thập file paths
    -- ----------------------------------------------------------------
    local filePaths = {}
    for _, clip in ipairs(clips or {}) do
        if clip.filePath and clip.filePath ~= "" then
            table.insert(filePaths, clip.filePath)
            print("[RefImages] filePath: " .. clip.filePath)
        end
    end

    if #filePaths == 0 then
        return { error = true, message = "Không có file path hợp lệ" }
    end

    -- ----------------------------------------------------------------
    -- 4) Import vào Media Pool (subfolder riêng)
    -- ----------------------------------------------------------------
    local currentFolder = mediaPool:GetCurrentFolder()
    local refFolder     = mediaPool:AddSubFolder(currentFolder, "AutoSubs Ref Images")
    if refFolder then mediaPool:SetCurrentFolder(refFolder) end

    local mediaPoolItems = mediaPool:ImportMedia(filePaths)
    if not mediaPoolItems or #mediaPoolItems == 0 then
        if currentFolder then mediaPool:SetCurrentFolder(currentFolder) end
        return { error = true, message = "ImportMedia() trả về 0 items" }
    end
    print("[RefImages] ImportMedia OK: " .. #mediaPoolItems .. " items")

    -- ----------------------------------------------------------------
    -- FIX 3: Build map theo CẢ File Name VÀ File Path
    --        Tránh miss khi Resolve trả về tên clip khác với filename gốc
    -- ----------------------------------------------------------------
    local mediaItemMapByName = {}
    local mediaItemMapByPath = {}

    for _, item in ipairs(mediaPoolItems) do
        local props    = item:GetClipProperty() or {}
        local itemName = props["File Name"] or props["Clip Name"] or ""
        local itemPath = props["File Path"] or ""
        if itemName == "" and itemPath ~= "" then
            itemName = itemPath:match("([^/\\]+)$") or ""
        end
        if itemName ~= "" then mediaItemMapByName[itemName] = item end
        if itemPath ~= "" then mediaItemMapByPath[itemPath] = item end
        print(string.format("[RefImages]   Item: name='%s' fps='%s' frames='%s'",
            itemName, tostring(props["FPS"]), tostring(props["Frames"])))
    end

    -- ----------------------------------------------------------------
    -- 5) Append từng ảnh lên V4
    -- ----------------------------------------------------------------
    local actualAdded = 0
    local failures    = {}

    for i, clip in ipairs(clips or {}) do
        local filePath = clip.filePath or ""
        local fileName = filePath:match("([^/\\]+)$") or ""

        -- Tìm item theo path trước, fallback theo name
        local mediaItem = mediaItemMapByPath[filePath] or mediaItemMapByName[fileName]

        if not mediaItem then
            local msg = string.format("Không tìm được MediaPoolItem cho '%s'", fileName)
            print("[RefImages] ❌ " .. msg)
            table.insert(failures, msg)
        else
            local startTime   = tonumber(clip.startTime) or 0
            local endTime     = tonumber(clip.endTime)   or 0
            local duration    = endTime - startTime
            local priority    = clip.priority or "medium"
            local clipType    = clip.imageType or "event"
            local isFullFrame = (priority == "high" and
                (clipType == "portrait" or clipType == "headline" or clipType == "evidence"))

            if duration <= 0 then
                local msg = string.format("Duration <= 0 cho '%s'", fileName)
                print("[RefImages] ❌ " .. msg)
                table.insert(failures, msg)
            else
                -- Detect ảnh tĩnh — y chang AddMediaToTimeline
                local lowerName    = fileName:lower()
                local isStillImage = lowerName:match("%.jpe?g$")
                    or lowerName:match("%.png$")
                    or lowerName:match("%.webp$")
                    or lowerName:match("%.bmp$")
                    or lowerName:match("%.tiff?$")

                -- Lấy FPS clip, override về frame_rate nếu là ảnh tĩnh
                local clipProps = mediaItem:GetClipProperty()
                local clipFPS   = tonumber(clipProps["FPS"]) or frame_rate
                if isStillImage or clipFPS <= 0 then clipFPS = frame_rate end

                local recFrame        = timelineStart + math.floor(startTime * frame_rate)
                local requestedFrames = math.max(1, math.floor(duration * clipFPS))

                print(string.format("[RefImages] Clip %d: '%s' | %.2fs→%.2fs | rec=%d end=%d | V%d | still=%s",
                    i, fileName, startTime, endTime, recFrame, requestedFrames, trackIdx, tostring(isStillImage)))

                local clipInfo = {
                    mediaPoolItem = mediaItem,
                    mediaType     = 1,  -- video only
                    startFrame    = 0,
                    endFrame      = requestedFrames,
                    recordFrame   = recFrame,
                    trackIndex    = trackIdx,
                }

                print(string.format("[RefImages] Clip %d: APPENDING. Name: '%s', startFrame=%d, endFrame=%d, recordFrame=%d, trackIndex=%d",
                    i, fileName, clipInfo.startFrame, clipInfo.endFrame, clipInfo.recordFrame, clipInfo.trackIndex))

                local result = mediaPool:AppendToTimeline({ clipInfo })

                -- Fallback 1: Thử bỏ mediaType (Giống như bên AddMediaToTimeline)
                if not result or #result == 0 then
                    print("[RefImages]   ⚠️ Lần 1 fail (mediaType=1) — thử fallback mediaType=nil...")
                    clipInfo.mediaType = nil
                    result = mediaPool:AppendToTimeline({ clipInfo })
                end

                -- Fallback 2: Thử endFrame=1 nếu still image quá lớn
                if not result or #result == 0 then
                    print("[RefImages]   ⚠️ Lần 2 fail — thử fallback endFrame=1, mediaType=nil...")
                    clipInfo.endFrame = 1
                    result = mediaPool:AppendToTimeline({ clipInfo })
                end

                if result and #result > 0 then
                    actualAdded = actualAdded + 1
                    local tItem = result[1]
                    print("[RefImages]   ✅ AppendToTimeline OK: " .. (tItem:GetName() or "?"))

                    pcall(function() tItem:SetClipColor("Pink") end)

                    -- ===== Fusion Effects: Dim + White Border + Ken Burns =====
                    -- Node graph:
                    --   MediaIn1 → imgTransform → borderMerge → finalMerge → MediaOut1
                    --   bgWhite  → whiteTransform ↗             ↑
                    --   bgDim  ──────────────────────────────────┘
                    pcall(function()
                        print("[Fusion]   ── Bắt đầu AddFusionComp ──")
                        local comp = tItem:AddFusionComp()
                        if not comp then
                            print("[Fusion]   ❌ STEP 0: AddFusionComp() trả về nil")
                            return
                        end
                        print("[Fusion]   ✅ STEP 0: AddFusionComp OK")

                        local mediaIn  = comp:FindTool("MediaIn1")
                        local mediaOut = comp:FindTool("MediaOut1")
                        print("[Fusion]   MediaIn1 = " .. tostring(mediaIn ~= nil)
                            .. " | MediaOut1 = " .. tostring(mediaOut ~= nil))
                        if not mediaIn  then print("[Fusion]   ❌ STEP 0b: MediaIn1 nil") end
                        if not mediaOut then print("[Fusion]   ❌ STEP 0b: MediaOut1 nil") end
                        if not (mediaIn and mediaOut) then return end

                        -- ─── STEP 1: BLACK DIM OVERLAY ────────────────────────────────
                        print("[Fusion]   STEP 1: tạo bgDim (Background black 65% alpha)...")
                        local bgDim = comp:AddTool("Background")
                        if not bgDim then
                            print("[Fusion]   ❌ STEP 1: AddTool('Background') bgDim nil")
                            return
                        end
                        local ok1, err1 = pcall(function()
                            bgDim:SetInput("TopLeftRed",   0)
                            bgDim:SetInput("TopLeftGreen", 0)
                            bgDim:SetInput("TopLeftBlue",  0)
                            bgDim:SetInput("TopLeftAlpha", 0.65)
                        end)
                        if not ok1 then
                            print("[Fusion]   ❌ STEP 1: SetInput bgDim lỗi: " .. tostring(err1))
                        else
                            print("[Fusion]   ✅ STEP 1: bgDim OK (black, alpha=0.65)")
                        end

                        -- ─── STEP 2: WHITE BORDER BACKGROUND ──────────────────────────
                        print("[Fusion]   STEP 2: tạo bgWhite (Background white)...")
                        local bgWhite = comp:AddTool("Background")
                        if not bgWhite then
                            print("[Fusion]   ❌ STEP 2: AddTool('Background') bgWhite nil")
                            return
                        end
                        local ok2, err2 = pcall(function()
                            bgWhite:SetInput("TopLeftRed",   1)
                            bgWhite:SetInput("TopLeftGreen", 1)
                            bgWhite:SetInput("TopLeftBlue",  1)
                            bgWhite:SetInput("TopLeftAlpha", 1)
                        end)
                        if not ok2 then
                            print("[Fusion]   ❌ STEP 2: SetInput bgWhite lỗi: " .. tostring(err2))
                        else
                            print("[Fusion]   ✅ STEP 2: bgWhite OK (white, alpha=1.0)")
                        end

                        -- Tính kích thước
                        local framesizeS = isFullFrame and 1.04 or 0.78
                        local framesizeE = isFullFrame and 1.09 or 0.83
                        local imgsizeS   = isFullFrame and 0.97 or 0.72
                        local imgsizeE   = isFullFrame and 1.02 or 0.77
                        local totalF     = math.max(1, requestedFrames - 1)
                        print(string.format("[Fusion]   Sizes: whiteFrame=%.2f→%.2f | img=%.2f→%.2f | totalFrames=%d",
                            framesizeS, framesizeE, imgsizeS, imgsizeE, totalF))

                        -- ─── STEP 3: TRANSFORM CHO VIỀN TRẮNG ────────────────────────
                        print("[Fusion]   STEP 3: tạo whiteTransform...")
                        local whiteTransform = comp:AddTool("Transform")
                        if not whiteTransform then
                            print("[Fusion]   ❌ STEP 3: AddTool('Transform') whiteTransform nil")
                            return
                        end
                        local ok3, err3 = pcall(function()
                            whiteTransform:ConnectInput("Input", bgWhite)
                            whiteTransform:SetInput("Size", framesizeS, 0)
                            whiteTransform:SetInput("Size", framesizeE, totalF)
                        end)
                        if not ok3 then
                            print("[Fusion]   ❌ STEP 3: whiteTransform lỗi: " .. tostring(err3))
                        else
                            print("[Fusion]   ✅ STEP 3: whiteTransform OK")
                        end

                        -- ─── STEP 4: IMAGE TRANSFORM + KEN BURNS ─────────────────────
                        print("[Fusion]   STEP 4: tạo imgTransform (Ken Burns)...")
                        local imgTransform = comp:AddTool("Transform")
                        if not imgTransform then
                            print("[Fusion]   ❌ STEP 4: AddTool('Transform') imgTransform nil")
                            return
                        end
                        local ok4, err4 = pcall(function()
                            imgTransform:ConnectInput("Input", mediaIn)
                            imgTransform:SetInput("Size", imgsizeS, 0)
                            imgTransform:SetInput("Size", imgsizeE, totalF)
                        end)
                        if not ok4 then
                            print("[Fusion]   ❌ STEP 4: imgTransform lỗi: " .. tostring(err4))
                        else
                            print("[Fusion]   ✅ STEP 4: imgTransform OK")
                        end

                        -- ─── STEP 5: MERGE ảnh LÊN viền trắng ───────────────────────
                        print("[Fusion]   STEP 5: tạo borderMerge (img over white)...")
                        local borderMerge = comp:AddTool("Merge")
                        if not borderMerge then
                            print("[Fusion]   ❌ STEP 5: AddTool('Merge') borderMerge nil")
                            return
                        end
                        local ok5, err5 = pcall(function()
                            borderMerge:ConnectInput("Background", whiteTransform)
                            borderMerge:ConnectInput("Foreground", imgTransform)
                            borderMerge:SetInput("Blend", 1.0)
                        end)
                        if not ok5 then
                            print("[Fusion]   ❌ STEP 5: borderMerge lỗi: " .. tostring(err5))
                        else
                            print("[Fusion]   ✅ STEP 5: borderMerge OK")
                        end

                        -- ─── STEP 6: MERGE (ảnh+viền) LÊN nền tối ───────────────────
                        print("[Fusion]   STEP 6: tạo finalMerge (framed img over dim)...")
                        local finalMerge = comp:AddTool("Merge")
                        if not finalMerge then
                            print("[Fusion]   ❌ STEP 6: AddTool('Merge') finalMerge nil")
                            return
                        end
                        local ok6, err6 = pcall(function()
                            finalMerge:ConnectInput("Background", bgDim)
                            finalMerge:ConnectInput("Foreground", borderMerge)
                            finalMerge:SetInput("Blend", 1.0)
                        end)
                        if not ok6 then
                            print("[Fusion]   ❌ STEP 6: finalMerge lỗi: " .. tostring(err6))
                        else
                            print("[Fusion]   ✅ STEP 6: finalMerge OK")
                        end

                        -- ─── STEP 7: KẾT NỐI RA MEDIAOUT ────────────────────────────
                        local ok7, err7 = pcall(function()
                            mediaOut:ConnectInput("Input", finalMerge)
                        end)
                        if not ok7 then
                            print("[Fusion]   ❌ STEP 7: MediaOut ConnectInput lỗi: " .. tostring(err7))
                        else
                            print("[Fusion]   ✅ STEP 7: MediaOut connected OK")
                        end

                        -- ─── STEP 8: CROSS DISSOLVE TRANSITION ───────────────────────
                        local dissolveFrames = math.floor(0.3 * frame_rate)
                        local ok8, err8 = pcall(function()
                            timeline:AddTransition("Dissolve", "video", trackIdx, recFrame, dissolveFrames)
                        end)
                        if not ok8 then
                            print("[Fusion]   ⚠️ STEP 8: AddTransition lỗi (có thể bỏ qua): " .. tostring(err8))
                        else
                            print("[Fusion]   ✅ STEP 8: Cross Dissolve " .. dissolveFrames .. "f OK")
                        end

                        print(string.format("[Fusion]   ✅✅ DONE: Dim+Border+KenBurns | %s | img=%.2f→%.2f | frame=%.2f→%.2f",
                            isFullFrame and "FULL-FRAME" or "overlay",
                            imgsizeS, imgsizeE, framesizeS, framesizeE))
                    end)
                else
                    local msg = string.format("AppendToTimeline fail TẤT CẢ fallback cho '%s' (V%d rec=%d)",
                        fileName, trackIdx, recFrame)
                    print("[RefImages]   ❌ " .. msg)
                    
                    pcall(function()
                        local mpProps = mediaItem:GetClipProperty()
                        print("[RefImages]      Dump MediaItem Properties: FPS=" .. tostring(mpProps["FPS"]) .. " | Duration=" .. tostring(mpProps["Duration"]) .. " | Type=" .. tostring(mpProps["Type"]))
                    end)

                    pcall(function()
                        local trackItems = timeline:GetItemListInTrack("video", trackIdx) or {}
                        print(string.format("[RefImages]      V%d hiện có %d item(s)", trackIdx, #trackItems))
                    end)
                    table.insert(failures, msg)
                end
            end
        end
    end

    -- Reset folder về gốc SAU KHI xử lý xong
    if currentFolder then mediaPool:SetCurrentFolder(currentFolder) end

    -- Reset folder về folder gốc SAU KHI xử lý xong tất cả clips
    -- (giống pattern AddMediaToTimeline — dòng 186)
    if currentFolder then state.mediaPool:SetCurrentFolder(currentFolder) end

    -- ===== Import SFX kèm theo (nếu có) =====
    local sfxAdded = 0
    if sfxClips and #sfxClips > 0 then
        print("[RefImages] 🔊 Adding " .. #sfxClips .. " SFX clips...")
        local sfxResult = M.AddSfxClipsToTimeline(state, helpers, sfxClips, "SFX RefImg - AutoSubs")
        sfxAdded = sfxResult.clipsAdded or 0
        if sfxResult.error then
            print("[RefImages] ⚠️ SFX Import Error: " .. tostring(sfxResult.message))
        else
            print("[RefImages] ✅ SFX Import OK: " .. tostring(sfxAdded) .. " added. Msg: " .. tostring(sfxResult.message))
        end
    end

    print(string.format("[RefImages] ====== DONE: %d/%d ảnh + %d SFX ======", actualAdded, #clips, sfxAdded))

    return {
        success     = true,
        clipsAdded  = actualAdded,
        sfxAdded    = sfxAdded,
        message     = string.format("Đã import %d ảnh + %d SFX lên Track V4", actualAdded, sfxAdded)
    }
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
    print("[SFX] AddSfxClipsToTimeline: " .. #clips .. " clips")

    local timeline = state.project:GetCurrentTimeline()
    if not timeline then
        print("[SFX] ❌ No active timeline found")
        return { error = true, message = "No active timeline found" }
    end

    if #clips == 0 then
        print("[SFX] ❌ No SFX clips provided")
        return { error = true, message = "No SFX clips provided" }
    end

    local frame_rate = math.floor(tonumber(timeline:GetSetting("timelineFrameRate")) or 24)
    local timelineStart = tonumber(timeline:GetStartFrame()) or 3600

    -- Thu thập unique file paths
    local uniquePaths = {}
    local pathSet = {}
    for _, clip in ipairs(clips) do
        if not pathSet[clip.filePath] then
            pathSet[clip.filePath] = true
            table.insert(uniquePaths, clip.filePath)
            print("[SFX] Unique Path: " .. clip.filePath)
        end
    end

    -- Import vào Media Pool
    local currentFolder = state.mediaPool:GetCurrentFolder()
    local sfxFolder = state.mediaPool:AddSubFolder(currentFolder, "AutoSubs SFX")
    if sfxFolder then state.mediaPool:SetCurrentFolder(sfxFolder) end

    local mediaPoolItems = state.mediaPool:ImportMedia(uniquePaths)
    if currentFolder then state.mediaPool:SetCurrentFolder(currentFolder) end

    -- Tự động tìm lại MP item nếu ImportMedia bị fail (thường do file đã bị import trước đó)
    if not mediaPoolItems or #mediaPoolItems == 0 then
        print("[SFX] ⚠️ ImportMedia returned nil/empty. Thử tìm fallback trong Media Pool...")
        mediaPoolItems = {}
        if helpers.walk_media_pool then
            for _, path in ipairs(uniquePaths) do
                local filename = path:match("([^/\\]+)$") or path
                local foundItem = nil
                helpers.walk_media_pool(state.mediaPool:GetRootFolder(), function(clip)
                    local props = clip:GetClipProperty()
                    local cpPath = props["File Path"] or ""
                    local cpName = props["File Name"] or props["Clip Name"] or ""
                    if cpPath == path or cpName == filename then
                        foundItem = clip
                        return true -- stop
                    end
                end)
                if foundItem then
                    table.insert(mediaPoolItems, foundItem)
                    print("[SFX] ✅ Tìm thấy file trong MP: " .. filename)
                end
            end
        end
        if #mediaPoolItems == 0 then
            print("[SFX] ❌ Failed to import SFX files and also not found in Media Pool")
            return { error = true, message = "Failed to import SFX files" }
        end
    end
    print("[SFX] ✅ ImportMedia OK: " .. #mediaPoolItems .. " items")

    -- Mapping fileName → item
    local mediaItemMap = {}
    for _, item in ipairs(mediaPoolItems) do
        local props = item:GetClipProperty()
        local itemName = props["File Name"] or props["Clip Name"] or ""
        if itemName == "" then
            itemName = (props["File Path"] or ""):match("([^/\\]+)$") or ""
        end
        if itemName ~= "" then mediaItemMap[itemName] = item end
        print("[SFX]    Mapped Item: " .. itemName)
    end

    local label = trackName or "SFX - AutoSubs"
    
    -- Thêm 1 Audio Track mới ở dưới rùng để nhét toàn bộ SFX vào
    local currentTrackCount = tonumber(timeline:GetTrackCount("audio")) or 0
    local addOk = timeline:AddTrack("audio")
    print(string.format("[SFX] 🎵 currentTrackCount=%d, AddTrack(audio)=%s", currentTrackCount, tostring(addOk)))
    
    local targetTrackIdx = currentTrackCount + 1
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
            local sfxEndFrame = tonumber(clipProps["Frames"]) or -1
            if clip.trimStartSec or clip.trimEndSec then
                sfxStartFrame = math.floor((tonumber(clip.trimStartSec) or 0) * clipFPS)
                if clip.trimEndSec then
                    sfxEndFrame = math.floor(tonumber(clip.trimEndSec) * clipFPS)
                end
            end

            print(string.format("[SFX] Appending '%s' at recFrame=%d, track=%d, startF=%d, endF=%d", fileName, timeline_pos, targetTrackIdx, sfxStartFrame, sfxEndFrame))

            local result = state.mediaPool:AppendToTimeline({{
                mediaPoolItem = mediaItem, mediaType = 2,
                startFrame = sfxStartFrame, endFrame = sfxEndFrame,
                recordFrame = timeline_pos, trackIndex = targetTrackIdx
            }})
            
            if result and #result > 0 then
                addedCount = addedCount + 1
                pcall(function() result[1]:SetClipColor("Orange") end)
                print("[SFX]   ✅ Append OK")
            else
                print("[SFX]   ❌ Append FAILED for " .. fileName)
            end
        else
            print("[SFX] ❌ MediaItem not found for fileName: " .. fileName)
        end
    end

    timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())
    print("[SFX] ====== DONE AddSfxClips: " .. addedCount .. " added")
    return {
        success = true, audioTrack = targetTrackIdx,
        clipsAdded = addedCount,
        message = string.format("Added %d/%d SFX clips", addedCount, #clips)
    }
end

return M
