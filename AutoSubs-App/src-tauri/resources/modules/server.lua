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
                            elseif data.func == "Exit" then
                                body = helpers.safe_json({ message = "Server shutting down" }, json)
                                quitServer = true
                            elseif data.func == "Ping" then
                                body = helpers.safe_json({ message = "Pong" }, json)
                            else
                                print("Invalid function name")
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
