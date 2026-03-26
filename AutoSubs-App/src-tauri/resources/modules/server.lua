-- ============================================================
-- server.lua — HTTP server + router xử lý request từ Tauri app
-- StartServer, LaunchApp, send_exit_via_socket
-- ============================================================

local ffi = ffi

local M = {}

-- ===== LAUNCH APP =====
-- Mở app desktop AutoSubs
function M.LaunchApp(state)
    if ffi.os == "Windows" then
        local SW_SHOW = 5
        local shell32 = ffi.load("Shell32")
        local result_open = shell32.ShellExecuteA(nil, "open", state.main_app, nil, nil, SW_SHOW)
        if result_open > 32 then
            print("AutoSubs launched successfully.")
        else
            print("Failed to launch AutoSubs. Error code:", result_open)
        end
    else
        local result_open = ffi.C.system(state.command_open)
        if result_open == 0 then
            print("AutoSubs launched successfully.")
        else
            print("Failed to launch AutoSubs. Error code:", result_open)
        end
    end
end

-- ===== SEND EXIT VIA SOCKET =====
-- Gửi lệnh Exit đến server cũ để shutdown instance trước
local function send_exit_via_socket(state)
    local ok = pcall(function()
        local info = assert(state.socket.find_first_address("127.0.0.1", state.PORT))
        local client = assert(state.socket.create(info.family, info.socket_type, info.protocol))
        assert(client:set_option("nodelay", true, "tcp"))
        client:set_blocking(true)
        assert(client:connect(info))

        local body = '{"func":"Exit"}'
        local req = string.format(
            "POST / HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s",
            state.PORT, #body, body
        )
        assert(client:send(req))
        client:close()
    end)
    if not ok then
        print("Failed to send Exit via socket")
    end
end

-- ===== START SERVER =====
-- HTTP server chính — lắng nghe request từ Tauri app
function M.StartServer(state, helpers, timeline_info, audio_export, subtitle_renderer,
                        template_manager, media_import, preview_generator, motion_effects)
    local socket = state.socket
    local json = state.json
    local luaresolve = state.luaresolve

    local info = assert(socket.find_first_address("127.0.0.1", state.PORT))
    local server = assert(socket.create(info.family, info.socket_type, info.protocol))

    server:set_blocking(false)
    assert(server:set_option("nodelay", true, "tcp"))
    assert(server:set_option("reuseaddr", true))

    -- Bind (gửi Exit cho server cũ nếu port đang bận)
    local success, err = pcall(function() assert(server:bind(info)) end)
    if not success then
        send_exit_via_socket(state)
        helpers.sleep(0.5)
        assert(server:bind(info))
    end

    assert(server:listen())
    print("AutoSubs server is listening on port: ", state.PORT)

    -- Launch app nếu production mode
    if not state.DEV_MODE then
        M.LaunchApp(state)
    end

    -- ===== SERVER LOOP =====
    local quitServer = false
    while not quitServer do
        local client, err = server:accept()
        if client then
            local peername, peer_err = client:get_peer_name()
            if peername then
                assert(client:set_blocking(false))
                local str, err = client:receive()
                if str then
                    -- Đọc toàn bộ HTTP request (headers + body)
                    local request = str
                    local header_body_separator = "\r\n\r\n"
                    if client.settimeout then client:settimeout(0.2) end
                    while true do
                        local sep_start, sep_end = string.find(request, header_body_separator, 1, true)
                        if sep_end then
                            local headers = string.sub(request, 1, sep_start - 1)
                            local body_start_idx = sep_end + 1
                            local cl = string.match(headers, "[Cc]ontent%-[Ll]ength:%s*(%d+)")
                            if cl then
                                local needed = tonumber(cl) or 0
                                local current = #request - (body_start_idx - 1)
                                if current >= needed then break end
                            else
                                break
                            end
                        end
                        local chunk, rerr, partial = client:receive(1024)
                        if chunk and #chunk > 0 then
                            request = request .. chunk
                        elseif partial and #partial > 0 then
                            request = request .. partial
                        else
                            break
                        end
                    end
                    if client.settimeout then client:settimeout(0) end

                    -- Parse JSON body
                    local _, sep_end = string.find(request, header_body_separator, 1, true)
                    local content = nil
                    if sep_end then content = string.sub(request, sep_end + 1) end
                    print("Received request:", content)

                    local data, pos, jerr = nil, nil, nil
                    if content and #content > 0 then
                        local ok, r1, r2, r3 = pcall(json.decode, content, 1, nil)
                        if ok then data, pos, jerr = r1, r2, r3
                        else jerr = r1 end
                    end

                    -- ===== ROUTER: Xử lý từng function =====
                    local body = nil
                    success, err = pcall(function()
                        if data ~= nil then
                            if data.func == "GetTimelineInfo" then
                                body = helpers.safe_json(
                                    timeline_info.GetTimelineInfo(state, helpers, template_manager), json)
                            elseif data.func == "JumpToTime" then
                                timeline_info.JumpToTime(state, helpers, luaresolve, data.seconds)
                                body = helpers.safe_json({ message = "Jumped to time" }, json)
                            elseif data.func == "ExportAudio" then
                                local result = audio_export.ExportAudio(state, helpers, data.outputDir, data.inputTracks)
                                body = helpers.safe_json(result, json)
                            elseif data.func == "GetExportProgress" then
                                local result = audio_export.GetExportProgress(state, helpers, luaresolve, timeline_info)
                                body = helpers.safe_json(result, json)
                            elseif data.func == "CancelExport" then
                                local result = audio_export.CancelExport(state, timeline_info)
                                body = helpers.safe_json(result, json)
                            elseif data.func == "CheckTrackConflicts" then
                                local result = subtitle_renderer.CheckTrackConflicts(state, helpers, data.filePath, data.trackIndex)
                                body = helpers.safe_json(result, json)
                            elseif data.func == "AddSubtitles" then
                                local result = subtitle_renderer.AddSubtitles(
                                    state, helpers, template_manager, timeline_info,
                                    data.filePath, data.trackIndex, data.templateName, data.conflictMode)
                                body = helpers.safe_json({ message = "Job completed", result = result }, json)
                            elseif data.func == "GeneratePreview" then
                                local result = preview_generator.GeneratePreview(
                                    state, helpers, template_manager, subtitle_renderer,
                                    data.speaker, data.templateName, data.exportPath)
                                body = helpers.safe_json(result, json)
                            elseif data.func == "GetTrackClipNumbers" then
                                local result = timeline_info.GetTrackClipNumbers(state, data.trackIndex)
                                body = helpers.safe_json(result, json)
                            elseif data.func == "SeekToTime" then
                                local result = timeline_info.SeekToTime(state, data.seconds)
                                body = helpers.safe_json(result, json)
                            elseif data.func == "AddMediaToTimeline" then
                                local result = media_import.AddMediaToTimeline(state, helpers, data.clips, data.trackIndex, data.videoOnly)
                                body = helpers.safe_json(result, json)
                            elseif data.func == "AddAudioToTimeline" then
                                local result = media_import.AddAudioToTimeline(state, helpers, data.filePath, data.trackName)
                                body = helpers.safe_json(result, json)
                            elseif data.func == "AddSfxClipsToTimeline" then
                                local result = media_import.AddSfxClipsToTimeline(state, helpers, data.clips, data.trackName)
                                body = helpers.safe_json(result, json)
                            elseif data.func == "AddRefImagesToTimeline" then
                                -- Import ảnh tham khảo thực tế V4 + SFX tự động + Ken Burns + Dissolve
                                local result = media_import.AddRefImagesToTimeline(state, helpers, data.clips, data.sfxClips)
                                body = helpers.safe_json(result, json)
                            elseif data.func == "AddTemplateSubtitles" then
                                local result = subtitle_renderer.AddTemplateSubtitles(
                                    state, helpers, template_manager, data.clips, data.trackIndex)
                                body = helpers.safe_json(result, json)
                            elseif data.func == "AddSimpleSubtitles" then
                                local result = subtitle_renderer.AddSimpleSubtitles(
                                    state, helpers, template_manager,
                                    data.clips, data.templateName, data.trackIndex, data.fontSize)
                                body = helpers.safe_json(result, json)
                            elseif data.func == "CreateTemplateSet" then
                                local result = template_manager.CreateTemplateSet(state, helpers, data.templateNames)
                                body = helpers.safe_json(result, json)
                            elseif data.func == "ApplyMotionEffects" then
                                local result = motion_effects.ApplyMotionEffects(
                                    state, data.trackIndex, data.effectType, data.intensity, data.fadeDuration)
                                body = helpers.safe_json(result, json)

                            elseif data.func == "SetupTimelineTracks" then
                                -- Tạo đủ 7V+5A tracks + đặt tên chuẩn (chỉ AddTrack + SetTrackName)
                                local result = timeline_info.SetupTimelineTracks(state, helpers)
                                body = helpers.safe_json(result, json)

                            -- ======================== AUTO COLOR ROUTES ========================

                            elseif data.func == "AutoColorScan" then
                                -- Quét toàn bộ video track trên timeline → trả danh sách clip
                                print("[AutoColor] Scanning timeline...")
                                local ok2, scanResult = pcall(function()
                                    -- Refresh project
                                    state.project = state.projectManager:GetCurrentProject()
                                    local tl = state.project:GetCurrentTimeline()
                                    if not tl then
                                        return { error = true, message = "Không có timeline đang mở" }
                                    end

                                    local fps = tonumber(tl:GetSetting("timelineFrameRate")) or 24
                                    local tlStart = tl:GetStartFrame()
                                    local tlName = tl:GetName() or ""
                                    local trackCount = tl:GetTrackCount("video")

                                    print(string.format("[AutoColor] Timeline '%s', %d video tracks, fps=%s", tlName, trackCount, fps))

                                    local clips = {}
                                    for trackIdx = 1, trackCount do
                                        local items = tl:GetItemListInTrack("video", trackIdx)
                                        if items then
                                            for itemIdx, item in ipairs(items) do
                                                local clipName = item:GetName() or string.format("Clip_%d_%d", trackIdx, itemIdx)
                                                local startFrame = item:GetStart()
                                                local endFrame = item:GetEnd()
                                                local durFrames = endFrame - startFrame

                                                -- Lấy đường dẫn source media
                                                local mediaPath = ""
                                                local mpi = item:GetMediaPoolItem()
                                                if mpi then
                                                    mediaPath = mpi:GetClipProperty("File Path") or ""
                                                end

                                                -- Phân loại clip type
                                                local nameLower = string.lower(clipName)
                                                local itemType = "video_clip"
                                                if string.find(nameLower, "fusion") or string.find(nameLower, "text%+") or string.find(nameLower, "title") then
                                                    itemType = "fusion_title"
                                                elseif string.find(nameLower, "generator") or string.find(nameLower, "solid") then
                                                    itemType = "generator"
                                                elseif string.find(nameLower, "adjustment") then
                                                    itemType = "adjustment_layer"
                                                elseif mediaPath == "" then
                                                    itemType = "compound_clip"
                                                end

                                                -- Kiểm tra clip đã có grade chưa (> 1 node = đã chỉnh)
                                                local hasGrade = false
                                                pcall(function()
                                                    local numNodes = item:GetNumNodes()
                                                    if numNodes and numNodes > 1 then hasGrade = true end
                                                end)

                                                -- Skip fusion_title, generator, adjustment_layer
                                                if itemType ~= "fusion_title" and itemType ~= "generator" and itemType ~= "adjustment_layer" then
                                                    table.insert(clips, {
                                                        name = clipName,
                                                        trackIndex = trackIdx,
                                                        itemIndex = itemIdx - 1, -- 0-based cho frontend
                                                        startFrame = startFrame,
                                                        endFrame = endFrame,
                                                        durationFrames = durFrames,
                                                        startSec = math.floor((startFrame - tlStart) / fps * 100 + 0.5) / 100,
                                                        endSec = math.floor((endFrame - tlStart) / fps * 100 + 0.5) / 100,
                                                        durationSec = math.floor(durFrames / fps * 100 + 0.5) / 100,
                                                        mediaPath = mediaPath,
                                                        type = itemType,
                                                        hasExistingGrade = hasGrade,
                                                    })
                                                else
                                                    print(string.format("[AutoColor] Skip %s: %s", itemType, clipName))
                                                end
                                            end
                                        end
                                    end

                                    print(string.format("[AutoColor] ✅ Tìm thấy %d clip có thể chỉnh màu", #clips))
                                    return {
                                        clips = clips,
                                        totalClips = #clips,
                                        frameRate = fps,
                                        timelineStart = tlStart / fps,
                                        timelineName = tlName,
                                    }
                                end)
                                if ok2 then
                                    body = helpers.safe_json(scanResult, json)
                                else
                                    print("[AutoColor] ❌ Scan lỗi: " .. tostring(scanResult))
                                    body = helpers.safe_json({ error = true, message = "Scan lỗi: " .. tostring(scanResult) }, json)
                                end

                            elseif data.func == "AutoColorApplyCDL" then
                                -- Apply CDL correction vào 1 clip
                                print("[AutoColor] ========== APPLY CDL (single) ==========")
                                local ok2, applyResult = pcall(function()
                                    local tl = state.project:GetCurrentTimeline()
                                    if not tl then return { error = true, message = "Không có timeline" } end

                                    local trackIdx = tonumber(data.trackIndex)
                                    local itemIdx = tonumber(data.itemIndex) -- 0-based từ frontend
                                    local cdl = data.cdl or {}

                                    print(string.format("[AutoColor] Track=%d, ItemIdx=%d (0-based)", trackIdx, itemIdx))

                                    local items = tl:GetItemListInTrack("video", trackIdx)
                                    if not items then
                                        return { error = true, message = "Track " .. tostring(trackIdx) .. " không có clip" }
                                    end
                                    print(string.format("[AutoColor] Track %d có %d items", trackIdx, #items))

                                    -- Lua arrays 1-based, frontend gửi 0-based → +1
                                    local item = items[itemIdx + 1]
                                    if not item then
                                        return { error = true, message = string.format("Clip index %d không tồn tại (track %d có %d clip)", itemIdx, trackIdx, #items) }
                                    end

                                    local clipName = item:GetName() or "Unknown"
                                    print(string.format("[AutoColor] Clip: '%s'", clipName))

                                    -- Debug: kiểm tra SetCDL method có tồn tại không
                                    print(string.format("[AutoColor] DEBUG item type: %s", type(item)))
                                    print(string.format("[AutoColor] DEBUG item.SetCDL type: %s", type(item.SetCDL)))
                                    print(string.format("[AutoColor] DEBUG item.GetCDL type: %s", type(item.GetCDL)))

                                    local slope = cdl.slope or {1,1,1}
                                    local offset = cdl.offset or {0,0,0}
                                    local power = cdl.power or {1,1,1}
                                    local sat = cdl.saturation or 1.0

                                    -- Log giá trị CDL gửi vào
                                    print(string.format("[AutoColor] CDL Input: Slope=[%.3f,%.3f,%.3f] Offset=[%.4f,%.4f,%.4f] Power=[%.3f,%.3f,%.3f] Sat=%.3f",
                                        slope[1], slope[2], slope[3],
                                        offset[1], offset[2], offset[3],
                                        power[1], power[2], power[3], sat))

                                    -- DaVinci Resolve API yêu cầu CDL dạng STRING "R G B"
                                    -- KHÔNG dùng nested table {R=x, G=y, B=z} (sẽ gây lỗi màu đỏ!)
                                    local slopeStr = string.format("%.4f %.4f %.4f", slope[1], slope[2], slope[3])
                                    local offsetStr = string.format("%.5f %.5f %.5f", offset[1], offset[2], offset[3])
                                    local powerStr = string.format("%.4f %.4f %.4f", power[1], power[2], power[3])
                                    local satStr = string.format("%.4f", sat)

                                    local cdlMap = {
                                        NodeIndex = cdl.nodeIndex or 1,
                                        Slope = slopeStr,
                                        Offset = offsetStr,
                                        Power = powerStr,
                                        Saturation = satStr,
                                    }

                                    print(string.format("[AutoColor] SetCDL map: NodeIndex=%d, Slope='%s', Offset='%s', Power='%s', Sat='%s'",
                                        cdlMap.NodeIndex, slopeStr, offsetStr, powerStr, satStr))
                                    local result = item:SetCDL(cdlMap)
                                    print(string.format("[AutoColor] SetCDL returned: type=%s, value=%s", type(result), tostring(result)))

                                    -- Verify: thử đọc lại CDL sau khi set
                                    pcall(function()
                                        local readback = item:GetCDL()
                                        if readback then
                                            print("[AutoColor] GetCDL readback: " .. tostring(readback))
                                            -- Nếu readback là table, log chi tiết
                                            if type(readback) == "table" then
                                                for k, v in pairs(readback) do
                                                    if type(v) == "table" then
                                                        local parts = {}
                                                        for kk, vv in pairs(v) do
                                                            table.insert(parts, tostring(kk) .. "=" .. tostring(vv))
                                                        end
                                                        print(string.format("[AutoColor]   %s = {%s}", tostring(k), table.concat(parts, ", ")))
                                                    else
                                                        print(string.format("[AutoColor]   %s = %s", tostring(k), tostring(v)))
                                                    end
                                                end
                                            end
                                        else
                                            print("[AutoColor] GetCDL returned nil")
                                        end
                                    end)

                                    if result then
                                        print(string.format("[AutoColor] ✅ Applied CDL to '%s'", clipName))
                                        return { success = true, message = "Đã apply CDL cho '" .. clipName .. "'" }
                                    else
                                        print(string.format("[AutoColor] ⚠️ SetCDL thất bại cho '%s'", clipName))
                                        return { error = true, message = "SetCDL thất bại cho '" .. clipName .. "'" }
                                    end
                                end)
                                if ok2 then
                                    body = helpers.safe_json(applyResult, json)
                                else
                                    print("[AutoColor] ❌ ApplyCDL lỗi: " .. tostring(applyResult))
                                    body = helpers.safe_json({ error = true, message = "Lỗi: " .. tostring(applyResult) }, json)
                                end

                            elseif data.func == "AutoColorApplyBatch" then
                                -- Apply CDL cho nhiều clip cùng lúc
                                print("[AutoColor] ========== BATCH APPLY CDL ==========")
                                local ok2, batchResult = pcall(function()
                                    local tl = state.project:GetCurrentTimeline()
                                    if not tl then return { results = {}, applied = 0, failed = 0, skipped = 0, total = 0 } end

                                    local clipsData = data.clips or {}
                                    print(string.format("[AutoColor] Batch: %d clips to process", #clipsData))
                                    local results = {}
                                    local applied, failed, skipped = 0, 0, 0

                                    -- Debug clip đầu tiên: kiểm tra SetCDL method
                                    if #clipsData > 0 then
                                        local firstTrack = tonumber(clipsData[1].trackIndex)
                                        local firstItems = tl:GetItemListInTrack("video", firstTrack)
                                        if firstItems and #firstItems > 0 then
                                            local firstItem = firstItems[1]
                                            print(string.format("[AutoColor] DEBUG first item type: %s", type(firstItem)))
                                            print(string.format("[AutoColor] DEBUG first item.SetCDL: %s", type(firstItem.SetCDL)))
                                            print(string.format("[AutoColor] DEBUG first item.GetCDL: %s", type(firstItem.GetCDL)))
                                            -- Liệt kê các method có sẵn trên timeline item
                                            local methods = {}
                                            pcall(function()
                                                for k, v in pairs(getmetatable(firstItem) or {}) do
                                                    if type(v) == "function" then
                                                        table.insert(methods, tostring(k))
                                                    end
                                                end
                                            end)
                                            if #methods > 0 then
                                                print("[AutoColor] DEBUG available methods: " .. table.concat(methods, ", "))
                                            end
                                        end
                                    end

                                    for i, clipInfo in ipairs(clipsData) do
                                        local trackIdx = tonumber(clipInfo.trackIndex)
                                        local itemIdx = tonumber(clipInfo.itemIndex)
                                        local cdl = clipInfo.cdl

                                        if not cdl then
                                            table.insert(results, { index = i - 1, status = "skipped", reason = "Không có CDL" })
                                            skipped = skipped + 1
                                        else
                                            local items = tl:GetItemListInTrack("video", trackIdx)
                                            local item = items and items[itemIdx + 1]
                                            if not item then
                                                print(string.format("[AutoColor] [%d] ❌ Clip not found: track=%d, idx=%d", i, trackIdx, itemIdx))
                                                table.insert(results, { index = i - 1, status = "failed", message = "Clip not found" })
                                                failed = failed + 1
                                            else
                                                local clipName = item:GetName() or "Unknown"
                                                local slope = cdl.slope or {1,1,1}
                                                local offset = cdl.offset or {0,0,0}
                                                local power = cdl.power or {1,1,1}
                                                local sat = cdl.saturation or 1.0

                                                print(string.format("[AutoColor] [%d] '%s' Slope=[%.3f,%.3f,%.3f] Offset=[%.4f,%.4f,%.4f] Power=[%.3f,%.3f,%.3f] Sat=%.3f",
                                                    i, clipName,
                                                    slope[1], slope[2], slope[3],
                                                    offset[1], offset[2], offset[3],
                                                    power[1], power[2], power[3], sat))

                                                -- DaVinci Resolve API: CDL dùng STRING "R G B" (không phải nested table!)
                                                local slopeStr = string.format("%.4f %.4f %.4f", slope[1], slope[2], slope[3])
                                                local offsetStr = string.format("%.5f %.5f %.5f", offset[1], offset[2], offset[3])
                                                local powerStr = string.format("%.4f %.4f %.4f", power[1], power[2], power[3])
                                                local satStr = string.format("%.4f", sat)

                                                local cdlMap = {
                                                    NodeIndex = cdl.nodeIndex or 1,
                                                    Slope = slopeStr,
                                                    Offset = offsetStr,
                                                    Power = powerStr,
                                                    Saturation = satStr,
                                                }

                                                local ok3, setResult = pcall(function() return item:SetCDL(cdlMap) end)
                                                print(string.format("[AutoColor] [%d] SetCDL pcall: ok=%s, result type=%s, value=%s",
                                                    i, tostring(ok3), type(setResult), tostring(setResult)))

                                                -- Verify readback cho clip đầu tiên
                                                if i == 1 then
                                                    pcall(function()
                                                        local rb = item:GetCDL()
                                                        print(string.format("[AutoColor] [1] GetCDL verify: type=%s, value=%s", type(rb), tostring(rb)))
                                                        if type(rb) == "table" then
                                                            for k, v in pairs(rb) do
                                                                if type(v) == "table" then
                                                                    local parts = {}
                                                                    for kk, vv in pairs(v) do parts[#parts+1] = kk.."="..tostring(vv) end
                                                                    print(string.format("[AutoColor]   %s={%s}", k, table.concat(parts, ",")))
                                                                else
                                                                    print(string.format("[AutoColor]   %s=%s", k, tostring(v)))
                                                                end
                                                            end
                                                        end
                                                    end)
                                                end

                                                if ok3 and setResult then
                                                    table.insert(results, { index = i - 1, status = "applied" })
                                                    applied = applied + 1
                                                else
                                                    local errMsg = ok3 and "SetCDL returned false/nil" or tostring(setResult)
                                                    print(string.format("[AutoColor] [%d] ⚠️ FAILED: %s", i, errMsg))
                                                    table.insert(results, { index = i - 1, status = "failed", message = errMsg })
                                                    failed = failed + 1
                                                end
                                            end
                                        end
                                    end

                                    print(string.format("[AutoColor] ========== Batch done: %d applied, %d failed, %d skipped ==========", applied, failed, skipped))
                                    return { results = results, applied = applied, failed = failed, skipped = skipped, total = #clipsData }
                                end)
                                if ok2 then
                                    body = helpers.safe_json(batchResult, json)
                                else
                                    print("[AutoColor] ❌ Batch lỗi: " .. tostring(batchResult))
                                    body = helpers.safe_json({ results = {}, applied = 0, failed = 0, skipped = 0, total = 0 }, json)
                                end

                            elseif data.func == "AutoColorBackup" then
                                -- Duplicate timeline làm backup
                                print("[AutoColor] Creating backup...")
                                local ok2, backupResult = pcall(function()
                                    local tl = state.project:GetCurrentTimeline()
                                    if not tl then return { error = true, message = "Không có timeline" } end

                                    local origName = tl:GetName()
                                    local backupName = origName .. "_AUTOCOLOR_BACKUP"
                                    local mp = state.project:GetMediaPool()

                                    -- Thử DuplicateTimeline (DaVinci 18+)
                                    local newTl = nil
                                    pcall(function()
                                        newTl = mp:DuplicateTimeline(tl, backupName)
                                    end)
                                    if newTl then
                                        state.project:SetCurrentTimeline(tl) -- quay lại timeline gốc
                                        print("[AutoColor] ✅ Backup: " .. backupName)
                                        return { success = true, backupName = backupName }
                                    else
                                        print("[AutoColor] ⚠️ DuplicateTimeline không khả dụng")
                                        return { success = false, message = "DuplicateTimeline không khả dụng. Hãy duplicate thủ công." }
                                    end
                                end)
                                if ok2 then
                                    body = helpers.safe_json(backupResult, json)
                                else
                                    body = helpers.safe_json({ error = true, message = tostring(backupResult) }, json)
                                end

                            elseif data.func == "AutoColorGetCurrentFrame" then
                                -- Lấy thông tin clip tại playhead
                                print("[AutoColor] Getting current frame...")
                                local ok2, frameResult = pcall(function()
                                    local tl = state.project:GetCurrentTimeline()
                                    if not tl then return { error = true, message = "Không có timeline" } end

                                    local currentTc = tl:GetCurrentTimecode()
                                    local trackCount = tl:GetTrackCount("video")

                                    -- Duyệt từ track cao → thấp, tìm clip có media path
                                    for trackIdx = trackCount, 1, -1 do
                                        local items = tl:GetItemListInTrack("video", trackIdx)
                                        if items then
                                            for _, item in ipairs(items) do
                                                local mpi = item:GetMediaPoolItem()
                                                if mpi then
                                                    local mediaPath = mpi:GetClipProperty("File Path") or ""
                                                    if mediaPath ~= "" then
                                                        return {
                                                            mediaPath = mediaPath,
                                                            clipName = item:GetName() or "Unknown",
                                                            timecode = currentTc,
                                                            trackIndex = trackIdx,
                                                        }
                                                    end
                                                end
                                            end
                                        end
                                    end
                                    return { error = true, message = "Không tìm thấy clip tại playhead" }
                                end)
                                if ok2 then
                                    body = helpers.safe_json(frameResult, json)
                                else
                                    body = helpers.safe_json({ error = true, message = tostring(frameResult) }, json)
                                end

                            elseif data.func == "Exit" then
                                body = helpers.safe_json({ message = "Server shutting down" }, json)
                                quitServer = true
                            elseif data.func == "Ping" then
                                body = helpers.safe_json({ message = "Pong" }, json)
                            else
                                print("Invalid function name: " .. tostring(data.func))
                                body = helpers.safe_json({ message = "Unknown function: " .. tostring(data.func) }, json)
                            end
                        else
                            -- Fallback: detect Exit từ raw string
                            local has_exit = false
                            if content and string.find(content, '"func"%s*:%s*"Exit"') then
                                has_exit = true
                            elseif str and string.find(str, '"func"%s*:%s*"Exit"') then
                                has_exit = true
                            end
                            if has_exit then
                                body = helpers.safe_json({ message = "Server shutting down" }, json)
                                quitServer = true
                            else
                                body = helpers.safe_json({ message = "Invalid JSON data" }, json)
                            end
                        end
                    end)

                    -- Đảm bảo luôn có body
                    if body == nil then
                        body = helpers.safe_json({ message = "OK" }, json)
                    end

                    if not success then
                        body = helpers.safe_json({
                            message = "Job failed with error: " .. tostring(err)
                        }, json)
                        print("Error:", err)
                    end

                    -- Gửi HTTP response
                    local response = helpers.CreateResponse(body)
                    if state.DEV_MODE then print(response) end
                    local sent, sendErr = client:send(response)
                    if not sent then print("Send failed:", sendErr or "unknown") end

                    client:close()
                elseif err == "closed" then
                    client:close()
                elseif err ~= "timeout" then
                    print("Socket recv error:", err or "unknown")
                    client:close()
                end
            end
        elseif err ~= "timeout" then
            print("Accept error:", err or "unknown")
        end
        helpers.sleep(0.1)
    end

    print("Shutting down AutoSubs Link server...")
    server:close()
    print("Server shut down.")
end

return M
