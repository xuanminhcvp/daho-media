---These are global variables given to us by the Resolve embedded LuaJIT environment
---I disable the undefined global warnings for them to stop my editor from complaining
---@diagnostic disable: undefined-global
local ffi = ffi
-- resolve: ưu tiên lấy từ global (truyền từ entry script), fallback gọi Resolve()
local resolve = _G._autosubs_resolve or (Resolve and Resolve()) or nil

local DEV_MODE = false

-- Server Port
local PORT = 56003

-- Load external libraries
local socket = nil
local json = nil
local luaresolve = nil

-- OS SPECIFIC CONFIGURATION
local assets_path
local resources_path
local main_app
local command_open

-- Load Resolve objects (khởi tạo ngay nếu resolve có sẵn, hoặc trong Init)
local projectManager = resolve and resolve:GetProjectManager() or nil
local project = projectManager and projectManager:GetCurrentProject() or nil
local mediaPool = project and project:GetMediaPool() or nil

-- Global state for export operations
local currentExportJob = {
    active = false,
    pid = nil,
    progress = 0,
    cancelled = false,
    startTime = nil,
    audioInfo = {
        path = "",
        markIn = 0,  -- mark in (frames) - may display in UI as timecode
        markOut = 0, -- mark out (frames) - may display in UI as timecode
        offset = 0   -- offset on timeline in seconds (regardless of timeline start)
    },
    trackStates = nil
}

-- Function to read a JSON file
local function read_json_file(file_path)
    local file = assert(io.open(file_path, "r")) -- Open file for reading
    local content = file:read("*a")              -- Read the entire file content
    file:close()

    -- Parse the JSON content
    local data, pos, err = json.decode(content, 1, nil)

    if err then
        print("Error:", err)
        return nil
    end

    return data -- Return the decoded Lua table
end

local function join_path(dir, filename)
    local sep = package.config:sub(1, 1) -- returns '\\' on Windows, '/' elsewhere
    -- Remove trailing separator from dir, if any
    if dir:sub(-1) == sep then
        return dir .. filename
    else
        return dir .. sep .. filename
    end
end

-- Convert hex color to RGB (Davinci Resolve uses 0-1 range)
function hexToRgb(hex)
    local r, g, b = hex:match("^#?(%x%x)(%x%x)(%x%x)$")
    if r then
        return {
            r = tonumber(r, 16) / 255,
            g = tonumber(g, 16) / 255,
            b = tonumber(b, 16) / 255
        }
    else
        return nil
    end
end

-- Convert seconds to frames based on the timeline frame rate
function to_frames(seconds, frameRate)
    return seconds * frameRate
end

-- Pause execution for a specified number of seconds (platform-independent)
function sleep(n)
    if ffi.os == "Windows" then
        ffi.C.Sleep(n * 1000)
    else
        local ts = ffi.new("struct timespec")
        ts.tv_sec = math.floor(n)
        ts.tv_nsec = (n - math.floor(n)) * 1e9
        ffi.C.nanosleep(ts, nil)
    end
end

function CreateResponse(body)
    local header = "HTTP/1.1 200 OK\r\n" .. "Server: ljsocket/0.1\r\n" .. "Content-Type: application/json\r\n" ..
        "Content-Length: " .. #body .. "\r\n" .. "Connection: close\r\n" .. "\r\n"

    local response = header .. body
    return response
end

-- input of time in seconds
function JumpToTime(seconds)
    local timeline = project:GetCurrentTimeline()
    local frameRate = timeline:GetSetting("timelineFrameRate")
    local frames = to_frames(seconds, frameRate) + timeline:GetStartFrame() + 1
    local timecode = luaresolve:timecode_from_frame_auto(frames, frameRate)
    timeline:SetCurrentTimecode(timecode)
end

-- List of title strings to search for
local titleStrings = {
    "Título – Fusion", -- Spanish
    "Título Fusion", -- Portuguese
    "Generator", -- English (older versions)
    "Fusion Title", -- English
    "Titre Fusion", -- French
    "Титры на стр. Fusion", -- Russian
    "Fusion Titel", -- German
    "Titolo Fusion", -- Italian
    "Fusionタイトル", -- Japanese
    "Fusion标题", -- Chinese
    "퓨전 타이틀", -- Korean
    "Tiêu đề Fusion", -- Vietnamese
    "Fusion Titles" -- Thai
}

-- Helper function to check if a string is in the titleStrings list
-- Build quick lookup set for titleStrings for O(1) membership checks
local titleSet = {}
for _, t in ipairs(titleStrings) do
    titleSet[t] = true
end

local function isMatchingTitle(title)
    return titleSet[title] == true
end

local function walk_media_pool(folder, onClip)
    -- Recurse into subfolders first
    for _, subfolder in ipairs(folder:GetSubFolderList()) do
        local stop = walk_media_pool(subfolder, onClip)
        if stop then return true end
    end

    -- Visit all clips in this folder
    for _, clip in ipairs(folder:GetClipList()) do
        local stop = onClip(clip)
        if stop then return true end
    end
end

-- Get a list of all Text+ templates in the media pool
function GetTemplates()
    local rootFolder = mediaPool:GetRootFolder()
    local t = {}
    local hasDefault = false

    walk_media_pool(rootFolder, function(clip)
        local props = clip:GetClipProperty()
        local clipType = props["Type"]
        if isMatchingTitle(clipType) then
            local clipName = props["Clip Name"]
            table.insert(t, { label = clipName, value = clipName })
            if clipName == "Default Template" then
                hasDefault = true
            end
        end
    end)

    -- Add default template to mediapool if not available
    if not hasDefault and tonumber(resolve:GetVersion()[1]) >= 19 then
        print("Default template not found. Importing default template...")
        local ok = pcall(function()
            mediaPool:ImportFolderFromFile(join_path(assets_path, "subtitle-template.drb"))
            -- Append the default template to the list
            table.insert(t, { label = "Default Template", value = "Default Template" })
        end)
    end

    return t
end


-- ============================================
-- PATH: Folder chứa .setting templates trên macOS
-- DaVinci Resolve đọc từ thư mục này để hiển thị trong Effects Library → Titles
-- ============================================
local TITLES_FOLDER_PATH = os.getenv("HOME") .. "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Templates/Edit/Titles/AutoSubs"

-- ============================================
-- ImportTitleFromFile: Import .setting file từ folder hệ thống vào Media Pool
-- Dùng khi template chưa có sẵn trong Media Pool
-- @param templateName: tên template (không có .setting), ví dụ "Title 1", "Title 2"
-- @return: MediaPoolItem nếu thành công, nil nếu thất bại
-- ============================================
function ImportTitleFromFile(templateName)
    -- Ghép đường dẫn đầy đủ đến file .setting
    local filePath = TITLES_FOLDER_PATH .. "/" .. templateName .. ".setting"
    print("[AutoSubs] Trying to import title from: " .. filePath)

    -- Kiểm tra file có tồn tại không bằng cách thử open
    local f = io.open(filePath, "r")
    if not f then
        print("[AutoSubs] ⚠ File not found: " .. filePath)
        return nil
    end
    f:close()

    -- ===== XOÁ CLIP CŨ CÙNG TÊN TRONG MEDIA POOL =====
    -- DaVinci Resolve cache clip theo filename/path.
    -- Nếu không xoá clip cũ → import sẽ trả về clip cached với style cũ.
    -- Phải DeleteClips trước rồi import fresh mới đảm bảo dùng file mới nhất.
    local rootFolder = mediaPool:GetRootFolder()
    local oldClips = {}
    walk_media_pool(rootFolder, function(clip)
        local props = clip:GetClipProperty()
        if props["Clip Name"] == templateName then
            table.insert(oldClips, clip)
        end
    end)
    if #oldClips > 0 then
        print("[AutoSubs] 🗑 Deleting " .. #oldClips .. " old cached clip(s) named '" .. templateName .. "' from Media Pool...")
        local deleteOk = mediaPool:DeleteClips(oldClips)
        if deleteOk then
            print("[AutoSubs] ✅ Old clips deleted successfully")
        else
            print("[AutoSubs] ⚠ DeleteClips returned false — may still be cached")
        end
    end

    -- Import fresh từ file .setting mới nhất
    mediaPool:SetCurrentFolder(rootFolder)
    local imported = mediaPool:ImportMedia({ filePath })
    if not imported or #imported == 0 then
        print("[AutoSubs] ❌ ImportMedia failed for: " .. filePath)
        return nil
    end

    -- Trả về item đầu tiên import được
    local item = imported[1]
    local props = item:GetClipProperty()
    print("[AutoSubs] ✅ Imported FRESH title: '" .. (props["Clip Name"] or "?") .. "' from " .. filePath)
    return item
end

-- Find the template item with the specified name using media pool traversal
function GetTemplateItem(folder, templateName)
    local found = nil
    walk_media_pool(folder, function(clip)
        local props = clip:GetClipProperty()
        if props["Clip Name"] == templateName then
            found = clip
            return true -- early stop traversal
        end
    end)
    return found
end

-- ============================================
-- GetTemplateItemByFolder: Tìm template bằng TÊN FOLDER
-- Nếu không tìm thấy clip theo tên, sẽ tìm FOLDER có tên trùng rồi
-- lấy Fusion Title đầu tiên bên trong folder đó (kể cả subfolder con)
-- ============================================
function GetTemplateItemByFolder(rootFolder, templateName)
    -- Bước 1: Thử tìm bằng tên clip trước (nhanh nhất)
    local found = GetTemplateItem(rootFolder, templateName)
    if found then return found end

    -- Bước 2: Tìm folder có tên khớp
    local function findFolderByName(parent, name)
        for _, subfolder in ipairs(parent:GetSubFolderList()) do
            if subfolder:GetName() == name then
                return subfolder
            end
            local deeper = findFolderByName(subfolder, name)
            if deeper then return deeper end
        end
        return nil
    end

    local targetFolder = findFolderByName(rootFolder, templateName)
    if not targetFolder then
        print("[AutoSubs] Folder '" .. templateName .. "' not found in Media Pool")
        return nil
    end

    -- ===== DEBUG: Liệt kê TẤT CẢ clip trong folder (kể cả subfolder) và Type của chúng =====
    print("[AutoSubs] Scanning folder '" .. templateName .. "' for any usable clip...")
    local firstFusionTitle = nil
    local firstAnyClip = nil

    walk_media_pool(targetFolder, function(clip)
        local props = clip:GetClipProperty()
        local clipType = props["Type"] or "?"
        local clipName = props["Clip Name"] or "?"
        print("[AutoSubs]   Found clip: '" .. clipName .. "' (Type='" .. clipType .. "')")

        -- Ưu tiên 1: Fusion Title (các loại text animation)
        if isMatchingTitle(clipType) and not firstFusionTitle then
            firstFusionTitle = clip
        end

        -- Ưu tiên 2: Bất kỳ clip nào (fallback)
        if not firstAnyClip then
            firstAnyClip = clip
        end

        -- Không dừng sớm để in đủ log tất cả clips
    end)

    -- Chọn clip tốt nhất
    local titleItem = firstFusionTitle or firstAnyClip

    if firstFusionTitle then
        local props = firstFusionTitle:GetClipProperty()
        print("[AutoSubs] Using Fusion Title: '" .. (props["Clip Name"] or "?") .. "' for template '" .. templateName .. "'")
    elseif firstAnyClip then
        local props = firstAnyClip:GetClipProperty()
        print("[AutoSubs] WARNING: No Fusion Title found — using fallback clip: '" .. (props["Clip Name"] or "?") .. "' (Type='" .. (props["Type"] or "?") .. "')")
    else
        print("[AutoSubs] ERROR: Folder '" .. templateName .. "' is completely empty!")
    end

    return titleItem
end

-- ============================================
-- CreateTemplateSet: Tạo 5 template folder trong Media Pool
-- Mỗi folder chứa 1 bản copy của Default Template (import từ .drb)
-- User sau đó vào DaVinci Resolve để customize mỗi template riêng
-- @param templateNames: mảng string tên template cần tạo
-- ============================================
function CreateTemplateSet(templateNames)
    print("[AutoSubs] Creating template set...")
    local rootFolder = mediaPool:GetRootFolder()
    local currentFolder = mediaPool:GetCurrentFolder()

    -- Đảm bảo Default Template tồn tại trước
    local defaultTpl = GetTemplateItem(rootFolder, "Default Template")
    if not defaultTpl then
        print("[AutoSubs] Importing Default Template from .drb...")
        pcall(function()
            mediaPool:SetCurrentFolder(rootFolder)
            mediaPool:ImportFolderFromFile(join_path(assets_path, "subtitle-template.drb"))
        end)
        defaultTpl = GetTemplateItem(rootFolder, "Default Template")
    end

    if not defaultTpl then
        return { error = true, message = "Cannot find or import Default Template" }
    end

    local results = {}
    local drbPath = join_path(assets_path, "subtitle-template.drb")

    for _, name in ipairs(templateNames) do
        -- Kiểm tra folder đã tồn tại chưa (bằng GetTemplateItemByFolder)
        local existing = GetTemplateItemByFolder(rootFolder, name)
        if existing then
            print("[AutoSubs] Template '" .. name .. "' already exists — skipping")
            table.insert(results, { name = name, status = "exists" })
        else
            -- Tạo subfolder mới trong root
            print("[AutoSubs] Creating folder '" .. name .. "'...")
            local subfolder = mediaPool:AddSubFolder(rootFolder, name)
            if subfolder then
                -- Import .drb vào subfolder
                mediaPool:SetCurrentFolder(subfolder)
                local ok = pcall(function()
                    mediaPool:ImportFolderFromFile(drbPath)
                end)
                if ok then
                    -- Kiểm tra import thành công
                    local imported = GetTemplateItemByFolder(rootFolder, name)
                    if imported then
                        print("[AutoSubs] ✅ Template '" .. name .. "' created successfully!")
                        table.insert(results, { name = name, status = "created" })
                    else
                        print("[AutoSubs] ⚠ Folder created but no template inside for '" .. name .. "'")
                        table.insert(results, { name = name, status = "error", message = "Import failed" })
                    end
                else
                    print("[AutoSubs] ❌ Failed to import .drb into folder '" .. name .. "'")
                    table.insert(results, { name = name, status = "error", message = "Import failed" })
                end
            else
                print("[AutoSubs] ❌ Could not create folder '" .. name .. "' (may already exist?)")
                table.insert(results, { name = name, status = "error", message = "Folder creation failed" })
            end
        end
    end

    -- Quay lại folder gốc
    if currentFolder then
        mediaPool:SetCurrentFolder(currentFolder)
    end

    print("[AutoSubs] Template set creation done.")
    return { success = true, results = results }
end

function GetTimelineInfo()
    -- Get project and media pool
    project = projectManager:GetCurrentProject()
    mediaPool = project:GetMediaPool()

    -- Get timeline info
    local timelineInfo = {}
    local success, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        timelineInfo = {
            name = timeline:GetName(),
            timelineId = timeline:GetUniqueId(),
            timelineStart = timeline:GetStartFrame() / timeline:GetSetting("timelineFrameRate"),
            -- Tên project hiện tại đang mở trong DaVinci Resolve
            projectName = project:GetName() or "unknown"
        }
    end)
    if not success then
        print("Error retrieving timeline info:", err)
        timelineInfo = {
            timelineId = "",
            name = "No timeline selected"
        }
    else -- get tracks and templates
        timelineInfo["outputTracks"] = GetVideoTracks()
        timelineInfo["inputTracks"] = GetAudioTracks()
        timelineInfo["templates"] = GetTemplates()
    end
    return timelineInfo
end

-- Get a list of possible output tracks for subtitles
function GetVideoTracks()
    local tracks = {}
    local createNewTrack = {
        value = "0",
        label = "Add to New Track"
    }
    table.insert(tracks, createNewTrack)

    local success, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        local trackCount = timeline:GetTrackCount("video")
        for i = 1, trackCount do
            local track = {
                value = tostring(i),
                label = timeline:GetTrackName("video", i)
            }
            table.insert(tracks, track)
        end
    end)
    return tracks
end

function GetAudioTracks()
    local tracks = {}
    local success, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        local trackCount = timeline:GetTrackCount("audio")
        for i = 1, trackCount do
            local track = {
                value = tostring(i),
                label = timeline:GetTrackName("audio", i)
            }
            table.insert(tracks, track)
        end
    end)
    return tracks
end

function ResetTracks()
    resolve:OpenPage("edit")
    local timeline = project:GetCurrentTimeline()
    local audioTracks = timeline:GetTrackCount("audio")
    for i = 1, audioTracks do
        timeline:SetTrackEnable("audio", i, currentExportJob.trackStates[i])
    end
    currentExportJob.clipBoundaries = nil
end

function CheckTrackEmpty(trackIndex, markIn, markOut)
    trackIndex = tonumber(trackIndex)
    local timeline = project:GetCurrentTimeline()
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

-- Get the current export progress
function GetExportProgress()
    if not currentExportJob.active then
        return {
            active = false,
            progress = 0,
            message = "No export in progress"
        }
    end

    if currentExportJob.cancelled then
        return {
            active = false,
            progress = currentExportJob.progress,
            cancelled = true,
            message = "Export was cancelled"
        }
    end

    -- Check if render is still in progress
    if currentExportJob.pid then
        local renderInProgress = false
        local success, result = pcall(function()
            return project:IsRenderingInProgress()
        end)

        if success then
            renderInProgress = result
        end

        if renderInProgress then
            -- Progress check using playhead position compared to 'mark in' and 'mark out' points (better than job status)
            local timeline = project:GetCurrentTimeline()
            local currentTimecode = timeline:GetCurrentTimecode()
            local frameRate = timeline:GetSetting("timelineFrameRate")

            -- Playhead position in frames
            local playheadPosition = luaresolve:frame_from_timecode(currentTimecode, frameRate)

            -- Get mark in and out from audioInfo (already in frames)
            local markIn = currentExportJob.audioInfo.markIn
            local markOut = currentExportJob.audioInfo.markOut

            -- Calculate progress percentage
            currentExportJob.progress = math.floor(((playheadPosition - markIn) / (markOut - markIn)) * 100 + 0.5)

            return {
                active = true,
                progress = currentExportJob.progress,
                message = "Export in progress...",
                pid = currentExportJob.pid
            }
        else
            -- Export completed - check if it was cancelled or completed normally
            currentExportJob.active = false

            -- Reset track states and open edit page
            ResetTracks()

            if currentExportJob.cancelled then
                return {
                    active = false,
                    progress = currentExportJob.progress,
                    cancelled = true,
                    message = "Export was cancelled"
                }
            else
                -- Normal completion
                currentExportJob.progress = 100
                return {
                    active = false,
                    progress = 100,
                    completed = true,
                    message = "Export completed successfully",
                    audioInfo = currentExportJob.audioInfo
                }
            end
        end
    else
        -- No PID available - something went wrong
        currentExportJob.active = false
        return {
            active = false,
            progress = 0,
            error = true,
            message = "Export job lost - no process ID available"
        }
    end
end

-- Cancel the current export operation
function CancelExport()
    if not currentExportJob.active then
        return {
            success = false,
            message = "No export in progress to cancel"
        }
    end

    if currentExportJob.pid then
        local success, err = pcall(function()
            project:StopRendering()
        end)

        -- reset tracks to original state and return to edit page
        ResetTracks()

        if success then
            currentExportJob.cancelled = true
            currentExportJob.active = false
            return {
                success = true,
                message = "Export cancelled successfully"
            }
        else
            return {
                success = false,
                message = "Failed to cancel export: " .. (err or "unknown error")
            }
        end
    else
        return {
            success = false,
            message = "No render job to cancel"
        }
    end
end

-- Helper function to find clip boundaries on selected audio tracks
function GetClipBoundaries(timeline, selectedTracks)
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

-- Helper function to get individual clips with their boundaries (for segment-based transcription)
-- Returns a sorted array of clip segments: { { start, end, name }, ... }
function GetIndividualClips(timeline, selectedTracks)
    local allClips = {}
    local timelineStart = timeline:GetStartFrame()
    local frameRate = timeline:GetSetting("timelineFrameRate")
    
    for trackIndex, _ in pairs(selectedTracks) do
        local clips = timeline:GetItemListInTrack("audio", trackIndex)
        if clips then
            for _, clip in ipairs(clips) do
                local clipStart = clip:GetStart()
                local clipEnd = clip:GetEnd()
                local clipName = clip:GetName() or "Unnamed"
                
                table.insert(allClips, {
                    startFrame = clipStart,
                    endFrame = clipEnd,
                    -- Convert to seconds relative to timeline start
                    start = (clipStart - timelineStart) / frameRate,
                    ["end"] = (clipEnd - timelineStart) / frameRate,
                    name = clipName
                })
            end
        end
    end
    
    -- Sort by start time
    table.sort(allClips, function(a, b) return a.startFrame < b.startFrame end)
    
    -- Merge overlapping clips (in case clips from different tracks overlap)
    local mergedClips = {}
    for _, clip in ipairs(allClips) do
        if #mergedClips == 0 then
            table.insert(mergedClips, clip)
        else
            local lastClip = mergedClips[#mergedClips]
            -- If this clip overlaps or is adjacent to the last one, merge them
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

-- Export audio from selected tracks
-- inputTracks is a table of track indices to export
function ExportAudio(outputDir, inputTracks)
    -- Check if another export is already in progress
    if project:IsRenderingInProgress() then
        return {
            error = true,
            message = "Another export is already in progress"
        }
    end

    -- Initialize export job state
    currentExportJob = {
        active = true,
        pid = nil,
        progress = 0,
        cancelled = false,
        startTime = os.time(),
        audioInfo = nil
    }

    local audioInfo = {
        timeline = ""
    }

    local trackStates = {}
    local timeline;
    local audioTracks;
    -- mute all tracks except the selected one
    timeline = project:GetCurrentTimeline()
    audioTracks = timeline:GetTrackCount("audio")

    -- Save track states
    for i = 1, audioTracks do
        local state = timeline:GetIsTrackEnabled("audio", i)
        trackStates[i] = state
    end

    -- Build a set of selected track indices for O(1) membership checks
    local selected = {}
    for _, v in ipairs(inputTracks) do
        local n = tonumber(v)
        if n then selected[n] = true end
    end

    -- Enable only the tracks that are present in the selection set
    for i = 1, audioTracks do
        local isEnabled = selected[i] == true
        timeline:SetTrackEnable("audio", i, isEnabled)
    end

    -- save track states for later use
    currentExportJob.trackStates = trackStates

    -- Find clip boundaries on selected tracks to only export the relevant portion
    local clipStart, clipEnd = GetClipBoundaries(timeline, selected)
    
    -- Get individual clips for segment-based transcription
    local individualClips = GetIndividualClips(timeline, selected)
    currentExportJob.individualClips = individualClips
    print("[AutoSubs] Found " .. #individualClips .. " individual clip(s) for transcription")
    
    if clipStart and clipEnd then
        print("[AutoSubs] Found clip boundaries: " .. clipStart .. " - " .. clipEnd)
        currentExportJob.clipBoundaries = { start = clipStart, ["end"] = clipEnd }
    else
        print("[AutoSubs] No clips found on selected tracks, using full timeline")
    end

    resolve:OpenPage("deliver")

    project:LoadRenderPreset('Audio Only')
    
    -- Build render settings
    local renderSettings = {
        TargetDir = outputDir,
        CustomName = "autosubs-exported-audio",
        RenderMode = "Single clip",
        IsExportVideo = false,
        IsExportAudio = true,
        AudioBitDepth = 24,
        AudioSampleRate = 44100
    }
    
    -- If we found clip boundaries, set the render range to only that portion
    if clipStart and clipEnd then
        renderSettings.MarkIn = clipStart
        renderSettings.MarkOut = clipEnd
        print("[AutoSubs] Setting render range in settings: " .. clipStart .. " - " .. clipEnd)
    end
    
    project:SetRenderSettings(renderSettings)

    local success, err = pcall(function()
        local pid = project:AddRenderJob()
        currentExportJob.pid = pid
        project:StartRendering(pid)

        local renderJobList = project:GetRenderJobList()
        local renderSettings = renderJobList[#renderJobList]

        local baseOffset = (renderSettings["MarkIn"] - timeline:GetStartFrame()) / timeline:GetSetting("timelineFrameRate")
        
        -- Calculate relative offsets for each clip segment (relative to the exported audio start)
        local segments = {}
        for _, clip in ipairs(currentExportJob.individualClips or {}) do
            table.insert(segments, {
                start = clip.start - baseOffset,  -- Start time within the exported audio
                ["end"] = clip["end"] - baseOffset,  -- End time within the exported audio
                timelineStart = clip.start,  -- Absolute start on timeline (for subtitle placement)
                timelineEnd = clip["end"],
                name = clip.name
            })
        end
        
        audioInfo = {
            path = join_path(renderSettings["TargetDir"], renderSettings["OutputFilename"]),
            markIn = renderSettings["MarkIn"],
            markOut = renderSettings["MarkOut"],
            offset = baseOffset,
            segments = segments  -- Individual clip segments for segment-based transcription
        }
        dump(audioInfo)
        currentExportJob.audioInfo = audioInfo

        print("Export started with PID: " .. pid)
    end)

    -- Handle export start result
    if not success then
        currentExportJob.active = false
        return {
            error = true,
            message = "Failed to start export: " .. (err or "unknown error")
        }
    else
        -- Export started successfully - return immediately
        return {
            started = true,
            message = "Export started successfully. Use GetExportProgress to monitor progress.",
            pid = currentExportJob.pid
        }
    end
end

function SanitizeTrackIndex(timeline, trackIndex, markIn, markOut)
    -- Only create a new track if trackIndex is explicitly "0" (new track), empty/nil, or invalid
    -- Respect user's track selection regardless of whether the track is empty
    if trackIndex == "0" or trackIndex == "" or trackIndex == nil or tonumber(trackIndex) > timeline:GetTrackCount("video") then
        trackIndex = timeline:GetTrackCount("video") + 1
        timeline:AddTrack("video")
    end

    return tonumber(trackIndex)
end

function SetCustomColors(speaker, tool)
    local color = nil
    -- Set custom colors for each speaker if enabled
    if speaker.fill.enabled and speaker.fill.color ~= "" then
        color = hexToRgb(speaker.fill.color)
        if color ~= nil then
            tool:SetInput("Enabled1", 1)
            tool:SetInput("Red1", color.r)
            tool:SetInput("Green1", color.g)
            tool:SetInput("Blue1", color.b)
        end
    end

    if speaker.outline.enabled and speaker.outline.color ~= "" then
        color = hexToRgb(speaker.outline.color)
        if color ~= nil then
            tool:SetInput("Enabled2", 1)
            tool:SetInput("Red2", color.r)
            tool:SetInput("Green2", color.g)
            tool:SetInput("Blue2", color.b)
        end
    end

    if speaker.border.enabled and speaker.border.color ~= "" then
        color = hexToRgb(speaker.border.color)
        if color ~= nil then
            tool:SetInput("Enabled4", 1)
            tool:SetInput("Red4", color.r)
            tool:SetInput("Green4", color.g)
            tool:SetInput("Blue4", color.b)
        end
    end
end

-- Check for existing clips on a track that would conflict with new subtitles
-- Returns conflict info: { hasConflicts, conflictingClips: [{start, end, name}], trackName }
function CheckTrackConflicts(filePath, trackIndex)
    local timeline = project:GetCurrentTimeline()
    local timelineStart = timeline:GetStartFrame()
    local frame_rate = timeline:GetSetting("timelineFrameRate")
    
    -- Read the subtitle data to get time ranges
    local data = read_json_file(filePath)
    if type(data) ~= "table" then
        return { hasConflicts = false, error = "Could not read subtitle file" }
    end
    
    local subtitles = data["segments"]
    if not subtitles or #subtitles == 0 then
        return { hasConflicts = false, message = "No subtitles to add" }
    end
    
    -- Get the time range of new subtitles
    local firstSubStart = to_frames(subtitles[1]["start"], frame_rate) + timelineStart
    local lastSubEnd = to_frames(subtitles[#subtitles]["end"], frame_rate) + timelineStart
    
    -- Validate track index
    trackIndex = tonumber(trackIndex)
    if not trackIndex or trackIndex <= 0 or trackIndex > timeline:GetTrackCount("video") then
        return { hasConflicts = false, trackExists = false, message = "Track does not exist" }
    end
    
    -- Get track name
    local trackName = timeline:GetTrackName("video", trackIndex) or ("Video " .. trackIndex)
    
    -- Get existing clips on the track
    local existingClips = timeline:GetItemListInTrack("video", trackIndex)
    if not existingClips or #existingClips == 0 then
        return { hasConflicts = false, trackName = trackName, message = "Track is empty" }
    end
    
    -- Find clips that overlap with the new subtitle range
    local conflictingClips = {}
    for _, clip in ipairs(existingClips) do
        local clipStart = clip:GetStart()
        local clipEnd = clip:GetEnd()
        
        -- Check if clip overlaps with subtitle range
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
        subtitleRange = {
            start = (firstSubStart - timelineStart) / frame_rate,
            ["end"] = (lastSubEnd - timelineStart) / frame_rate
        },
        totalConflicts = #conflictingClips
    }
end

-- Add subtitles to the timeline using the specified template
-- conflictMode: "replace" (delete existing), "skip" (write around conflicts), "new_track" (use new track), nil (default/old behavior)
function AddSubtitles(filePath, trackIndex, templateName, conflictMode)
    resolve:OpenPage("edit")

    local data = read_json_file(filePath)
    if type(data) ~= "table" then
        print("Error reading JSON file")
        return false
    end

    ---@type { mark_in: integer, mark_out: integer, segments: table, speakers: table }
    data = data

    local timeline = project:GetCurrentTimeline()
    local timelineStart = timeline:GetStartFrame()
    local timelineEnd = timeline:GetEndFrame()

    local markIn = data["mark_in"]
    local markOut = data["mark_out"]
    local subtitles = data["segments"]
    local speakers = data["speakers"]

    local speakersExist = false
    if speakers and #speakers > 0 then
        speakersExist = true
    end

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

    trackIndex = SanitizeTrackIndex(timeline, trackIndex, markIn, markOut)

    -- Sanitize speaker tracks
    if speakersExist then
        for i, speaker in ipairs(speakers) do
            if speaker.track == nil or speaker.track == "" then
                speaker.track = trackIndex
            else
                speaker.track = SanitizeTrackIndex(timeline, speaker.track, markIn, markOut)
            end
        end
    end

    local rootFolder = mediaPool:GetRootFolder()

    if templateName == "" then
        local availableTemplates = GetTemplates()
        if #availableTemplates > 0 then
            templateName = availableTemplates[1].value
        end
    end

    -- Get template and frame rate (with safety guards)
    local templateItem = nil
    if templateName ~= nil and templateName ~= "" then
        templateItem = GetTemplateItem(rootFolder, templateName)
    end
    if not templateItem then
        -- Fallback to Default Template if not found
        templateItem = GetTemplateItem(rootFolder, "Default Template")
    end
    if not templateItem then
        print("Error: Could not find subtitle template '" .. tostring(templateName) .. "' in media pool.")
        return false
    end
    local template_frame_rate = templateItem:GetClipProperty()["FPS"]

    -- Get Timeline Frame rate
    local frame_rate = timeline:GetSetting("timelineFrameRate")

    -- Handle conflict modes
    if conflictMode == "new_track" then
        -- Force creation of a new track regardless of current state
        trackIndex = timeline:GetTrackCount("video") + 1
        timeline:AddTrack("video")
        print("[AutoSubs] Created new track: " .. trackIndex)
    elseif conflictMode == "replace" then
        -- Delete existing clips in the subtitle time range on the selected track
        local existingClips = timeline:GetItemListInTrack("video", trackIndex)
        if existingClips and #existingClips > 0 then
            local firstSubStart = to_frames(subtitles[1]["start"], frame_rate) + timelineStart
            local lastSubEnd = to_frames(subtitles[#subtitles]["end"], frame_rate) + timelineStart
            
            local clipsToDelete = {}
            for _, clip in ipairs(existingClips) do
                local clipStart = clip:GetStart()
                local clipEnd = clip:GetEnd()
                -- Check if clip overlaps with subtitle range
                if clipStart < lastSubEnd and clipEnd > firstSubStart then
                    table.insert(clipsToDelete, clip)
                end
            end
            
            -- Delete conflicting clips
            for _, clip in ipairs(clipsToDelete) do
                timeline:DeleteClips({clip}, false) -- false = don't ripple delete
            end
            print("[AutoSubs] Deleted " .. #clipsToDelete .. " conflicting clips")
        end
    elseif conflictMode == "skip" then
        -- Filter subtitles to skip ones that would overlap with existing clips
        local existingClips = timeline:GetItemListInTrack("video", trackIndex)
        if existingClips and #existingClips > 0 then
            local filteredSubtitles = {}
            for _, subtitle in ipairs(subtitles) do
                local subStart = to_frames(subtitle["start"], frame_rate) + timelineStart
                local subEnd = to_frames(subtitle["end"], frame_rate) + timelineStart
                
                local hasConflict = false
                for _, clip in ipairs(existingClips) do
                    local clipStart = clip:GetStart()
                    local clipEnd = clip:GetEnd()
                    if subStart < clipEnd and subEnd > clipStart then
                        hasConflict = true
                        break
                    end
                end
                
                if not hasConflict then
                    table.insert(filteredSubtitles, subtitle)
                end
            end
            
            print("[AutoSubs] Skipped " .. (#subtitles - #filteredSubtitles) .. " conflicting subtitles")
            subtitles = filteredSubtitles
            
            if #subtitles == 0 then
                print("[AutoSubs] All subtitles skipped due to conflicts")
                return { success = true, message = "All subtitles skipped due to existing content", added = 0 }
            end
        end
    end

    -- If within 1 second, join the subtitles
    local joinThreshold = frame_rate
    local clipList = {}
    for i, subtitle in ipairs(subtitles) do
        -- print("Adding subtitle: ", subtitle["text"])
        local start_frame = to_frames(subtitle["start"], frame_rate)
        local end_frame = to_frames(subtitle["end"], frame_rate)
        local timeline_pos = timelineStart + start_frame
        local clip_timeline_duration = end_frame - start_frame

        if i < #subtitles then
            local next_start = timelineStart + to_frames(subtitles[i + 1]["start"], frame_rate)
            local frames_between = next_start - (timeline_pos + clip_timeline_duration)
            -- if gap between clips is less than threshold, join them
            if frames_between < joinThreshold then
                clip_timeline_duration = clip_timeline_duration + frames_between + 1
            end
        end

        -- Resolve uses frame rate of clip for startFrame and endFrame, so we need to convert clip_timeline_duration to template frame rate
        local duration = (clip_timeline_duration / frame_rate) * template_frame_rate

        -- If speakers exists then check for custom track
        local itemTrack = trackIndex
        if speakersExist then
            local speaker = speakers[tonumber(subtitle["speaker_id"]) + 1]
            if speaker.track ~= nil and speaker.track ~= "" then
                itemTrack = speaker.track
            end
        end

        local newClip = {
            mediaPoolItem = templateItem, -- source MediaPoolItem to add to timeline
            mediaType = 1,                -- media type 1 is video
            startFrame = 0,               -- start frame means within the clip
            endFrame = duration,          -- end frame means within the clip
            recordFrame = timeline_pos,   -- record frame means where in the timeline the clip should be placed
            trackIndex = itemTrack        -- track the clip should be placed on
        }

        table.insert(clipList, newClip)
    end

    -- Note: Seems to be faster to add all clips at once then add one by one (which arguably looks cooler)
    local timelineItems = mediaPool:AppendToTimeline(clipList)

    -- Append all clips to the timeline
    for i, timelineItem in ipairs(timelineItems) do
        local success, err = pcall(function()
            local subtitle = subtitles[i]
            local subtitleText = subtitle["text"]

            -- Skip if text is not TextPlus (TODO: Add support for other types of text if possible)
            if timelineItem:GetFusionCompCount() > 0 then
                local comp = timelineItem:GetFusionCompByIndex(1)
                local tool = comp:FindToolByID("TextPlus")
                tool:SetInput("StyledText", subtitleText)

                -- Set text colors if available
                if speakersExist then
                    local speaker_id = subtitle["speaker_id"]
                    if speaker_id ~= "?" then
                        local speaker = speakers[tonumber(speaker_id) + 1]
                        SetCustomColors(speaker, tool)
                    end
                end

                -- Set the clip color to symbolize that the subtitle was added
                timelineItem:SetClipColor("Green")
            end
        end)

        if not success then
            print("Failed to add subtitle to timeline: " .. err)
        end
    end

    -- Update timeline by moving playhead position
    timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())
end


-- ============================================
-- AddSimpleSubtitles: Thêm phụ đề stories lên timeline
-- Nhận batch clips (tối đa 50) từ frontend, mỗi clip có {text, start, end}
-- Dùng 1 template duy nhất + fontSize cố định
-- @param clips: [{text, start, end}, ...] — mảng phụ đề
-- @param templateName: tên template (VD: "Subtitle Default")
-- @param trackIndex: track video đích ("0" = tạo track mới)
-- @param fontSize: kích thước font (VD: 0.04)
-- ============================================
function AddSimpleSubtitles(clips, templateName, trackIndex, fontSize)
    print(string.format("[AutoSubs] AddSimpleSubtitles: %d clips, template='%s', track=%s, fontSize=%s",
        #clips, tostring(templateName), tostring(trackIndex), tostring(fontSize)))

    if not clips or #clips == 0 then
        return { error = true, message = "No clips provided" }
    end

    resolve:OpenPage("edit")

    local timeline = project:GetCurrentTimeline()
    if not timeline then
        return { error = true, message = "No active timeline found" }
    end

    local frame_rate = timeline:GetSetting("timelineFrameRate")
    local timelineStart = timeline:GetStartFrame()
    local rootFolder = mediaPool:GetRootFolder()

    -- Xử lý track: "0" = tạo track mới
    trackIndex = tonumber(trackIndex) or 0
    if trackIndex == 0 then
        trackIndex = timeline:GetTrackCount("video") + 1
        timeline:AddTrack("video")
        print("[AutoSubs] Tạo track mới: V" .. trackIndex)
    end

    -- Tìm template trong Media Pool
    if not templateName or templateName == "" then
        templateName = "Default Template"
    end
    local templateItem = GetTemplateItem(rootFolder, templateName)
    if not templateItem then
        -- Fallback 1: thử import từ file .setting (VD: "Subtitle Default.setting")
        print("[AutoSubs] Template không có trong Media Pool — thử import từ file...")
        templateItem = ImportTitleFromFile(templateName)
    end
    if not templateItem then
        -- Fallback 2: tìm bất kỳ template nào
        local availableTemplates = GetTemplates()
        if #availableTemplates > 0 then
            templateItem = GetTemplateItem(rootFolder, availableTemplates[1].value)
        end
    end
    if not templateItem then
        print("[AutoSubs] ERROR: Không tìm thấy template '" .. tostring(templateName) .. "'")
        return { error = true, message = "Template not found: " .. tostring(templateName) }
    end

    local template_frame_rate = templateItem:GetClipProperty()["FPS"] or frame_rate
    fontSize = tonumber(fontSize) or 0.04

    -- ⭐ Tạo danh sách clips để append cùng lúc (nhanh hơn từng clip)
    local clipList = {}
    for i, clipData in ipairs(clips) do
        local start_frame = to_frames(clipData["start"], frame_rate)
        local end_frame = to_frames(clipData["end"], frame_rate)
        local timeline_pos = timelineStart + start_frame
        local clip_timeline_duration = end_frame - start_frame

        -- Đảm bảo tối thiểu 1 frame
        if clip_timeline_duration <= 0 then
            clip_timeline_duration = 1
        end

        -- Convert duration sang frame rate của template
        local duration = (clip_timeline_duration / frame_rate) * template_frame_rate

        local newClip = {
            mediaPoolItem = templateItem,
            mediaType = 1,
            startFrame = 0,
            endFrame = duration,
            recordFrame = timeline_pos,
            trackIndex = trackIndex
        }
        table.insert(clipList, newClip)
    end

    -- ⚡ Append tất cả clips cùng lúc (batch)
    local timelineItems = mediaPool:AppendToTimeline(clipList)
    if not timelineItems or #timelineItems == 0 then
        print("[AutoSubs] WARNING: AppendToTimeline trả về rỗng!")
        return { error = true, message = "AppendToTimeline failed" }
    end

    -- Set text + font size cho từng clip đã thêm
    local addedCount = 0
    for i, timelineItem in ipairs(timelineItems) do
        local success, err = pcall(function()
            local clipData = clips[i]
            local subtitleText = clipData["text"] or ""

            if timelineItem:GetFusionCompCount() > 0 then
                local comp = timelineItem:GetFusionCompByIndex(1)
                local tool = comp:FindToolByID("TextPlus")

                if tool then
                    -- Set nội dung phụ đề
                    tool:SetInput("StyledText", subtitleText)

                    -- Set font size cố định (user chọn từ dropdown)
                    pcall(function() tool:SetInput("Size", fontSize) end)

                    addedCount = addedCount + 1
                else
                    print(string.format("[AutoSubs] Clip %d: TextPlus NOT FOUND", i))
                end
            else
                print(string.format("[AutoSubs] Clip %d: No Fusion comp", i))
            end

            -- Đánh màu clip vàng để phân biệt phụ đề trên timeline
            timelineItem:SetClipColor("Yellow")
        end)

        if not success then
            print(string.format("[AutoSubs] Clip %d lỗi: %s", i, tostring(err)))
        end
    end

    -- Refresh timeline
    timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())

    print(string.format("[AutoSubs] AddSimpleSubtitles done: %d/%d clips added", addedCount, #clips))
    return {
        success = true,
        added = addedCount,
        total = #clips,
        trackIndex = trackIndex
    }
end

-- ============================================
-- SeekToTime: Di chuyển playhead đến vị trí (giây) trên timeline
-- Dùng để preview — bấm vào số câu → nhảy đến vị trí đó
-- ============================================
function SeekToTime(seconds)
    local timeline = project:GetCurrentTimeline()
    if not timeline then
        return { error = true, message = "No active timeline found" }
    end

    local frame_rate = timeline:GetSetting("timelineFrameRate")
    local timelineStart = timeline:GetStartFrame()
    local targetFrame = timelineStart + math.floor(tonumber(seconds) * frame_rate)

    -- Chuyển frame thành timecode string DaVinci hiểu
    -- Format: HH:MM:SS:FF
    local totalFrames = targetFrame
    local fps = math.floor(frame_rate)
    local ff = totalFrames % fps
    local totalSeconds = math.floor(totalFrames / fps)
    local ss = totalSeconds % 60
    local totalMinutes = math.floor(totalSeconds / 60)
    local mm = totalMinutes % 60
    local hh = math.floor(totalMinutes / 60)

    local timecode = string.format("%02d:%02d:%02d:%02d", hh, mm, ss, ff)
    timeline:SetCurrentTimecode(timecode)

    print(string.format("[AutoSubs] Seek to %.2fs → frame %d → %s", seconds, targetFrame, timecode))
    return { success = true, timecode = timecode }
end

-- ============================================
-- GetTrackClipNumbers: Quét track trên timeline
-- Trả về danh sách số từ tên clip + time ranges (giây)
-- Frontend dùng time ranges để phát hiện khoảng trắng = câu thiếu
-- ============================================
function GetTrackClipNumbers(trackIndex)
    print("[AutoSubs Server] Quét track V" .. trackIndex .. " trên timeline...")

    local timeline = project:GetCurrentTimeline()
    if not timeline then
        print("No active timeline found!")
        return { error = true, message = "No active timeline found" }
    end

    local trackIdx = tonumber(trackIndex) or 1
    local frame_rate = timeline:GetSetting("timelineFrameRate")
    local timelineStart = timeline:GetStartFrame()
    local trackItems = timeline:GetItemListInTrack("video", trackIdx)

    if not trackItems or #trackItems == 0 then
        print("  Track V" .. trackIdx .. " trống, không có clip nào")
        return { clipNumbers = {}, clipRanges = {}, totalClips = 0 }
    end

    local clipNumbers = {}
    local clipRanges = {}
    for _, item in ipairs(trackItems) do
        local itemName = item:GetName() or ""
        -- Trích số đầu tiên từ tên clip (VD: "videoscene_28" → 28)
        local num = itemName:match("(%d+)")
        if num then
            table.insert(clipNumbers, tonumber(num))
        end

        -- Lấy vị trí thời gian (giây) của clip trên timeline
        local startFrame = item:GetStart()
        local endFrame = item:GetEnd()
        local startSec = (startFrame - timelineStart) / frame_rate
        local endSec = (endFrame - timelineStart) / frame_rate
        table.insert(clipRanges, {
            start = math.floor(startSec * 100) / 100,  -- 2 chữ số thập phân
            endTime = math.floor(endSec * 100) / 100,
            name = itemName
        })
    end

    print(string.format("  Tìm thấy %d clips trên track V%d (có số: %d)",
        #trackItems, trackIdx, #clipNumbers))

    return { clipNumbers = clipNumbers, clipRanges = clipRanges, totalClips = #trackItems }
end

-- ============================================
-- TEMPLATE_STYLES: Preset visual style cho từng loại template
-- Mỗi template type có font, size, fill color, outline color riêng biệt
-- AddTemplateSubtitles() sẽ gọi ApplyTemplateStyle() sau khi thêm clip
-- User có thể override bằng cách tự sửa template trong Media Pool
-- ============================================
local TEMPLATE_STYLES = {
    -- Location Card: chữ nhỏ, monospace, trắng xám — phong cách phim tài liệu
    ["Location Card"] = {
        font = "Courier New",
        size = 0.042,
        bold = false,
        italic = false,
        -- Fill color: trắng xám nhạt (elegant)
        red1 = 0.85, green1 = 0.88, blue1 = 0.90,
        -- Outline color: đen nhạt
        red4 = 0.05, green4 = 0.05, blue4 = 0.05,
        -- Clip color trên timeline để phân biệt bằng mắt
        clipColor = "Lime",
    },
    -- Impact Number: chữ lớn, bold, vàng gold — gây ấn tượng mạnh
    ["Impact Number"] = {
        font = "Arial Black",
        size = 0.09,
        bold = true,
        italic = false,
        -- Fill color: vàng gold nổi bật
        red1 = 0.96, green1 = 0.75, blue1 = 0.04,
        -- Outline color: nâu đậm
        red4 = 0.25, green4 = 0.18, blue4 = 0.0,
        clipColor = "Yellow",
    },
    -- Death / Violence: chữ đỏ, bold — cảnh báo nguy hiểm
    ["Death / Violence"] = {
        font = "Arial Black",
        size = 0.08,
        bold = true,
        italic = false,
        -- Fill color: đỏ máu
        red1 = 0.94, green1 = 0.22, blue1 = 0.22,
        -- Outline color: đỏ đậm
        red4 = 0.35, green4 = 0.0, blue4 = 0.0,
        clipColor = "Red",
    },
    -- Document / ID Card: monospace, cyan — phong cách hồ sơ mật
    ["Document / ID Card"] = {
        font = "Courier New",
        size = 0.05,
        bold = false,
        italic = false,
        -- Fill color: cyan tươi
        red1 = 0.02, green1 = 0.71, blue1 = 0.83,
        -- Outline color: cyan đậm
        red4 = 0.0, green4 = 0.22, blue4 = 0.28,
        clipColor = "Cyan",
    },
    -- Quote / Motif: serif italic, trắng — trích dẫn trang trọng
    ["Quote / Motif"] = {
        font = "Georgia",
        size = 0.06,
        bold = false,
        italic = true,
        -- Fill color: trắng tinh
        red1 = 1.0, green1 = 1.0, blue1 = 1.0,
        -- Outline color: xám nhạt
        red4 = 0.18, green4 = 0.18, blue4 = 0.18,
        clipColor = "Purple",
    },
}

-- ============================================
-- TITLE_CLIP_COLORS: Clip color trên timeline cho các Title .setting đã có sẵn style
-- Khi template là "Title 1", "Title 2"... thì KHÔNG cần apply style
-- vì file .setting đã chứa đầy đủ font, màu, animation
-- Chỉ cần set clip color để dễ phân biệt bằng mắt trên timeline
-- ============================================
local TITLE_CLIP_COLORS = {
    ["Title 1"] = "Yellow",    -- Document/ID Card: vàng gold
    ["Title 2"] = "Orange",    -- Location/Impact: vàng tươi
    ["Title 3"] = "Red",       -- Death/Violence: đỏ crimson
    ["Title 4"] = "Purple",    -- Quote/Motif: trắng xanh lạnh
}

-- ============================================
-- ApplyTemplateStyle: Set visual properties cho TextPlus Fusion tool
-- Dựa vào tên template type → apply font, size, color tương ứng
-- Dùng pcall() cho từng input để không crash nếu font không tồn tại
-- @param tool: TextPlus Fusion tool
-- @param templateName: tên template type (VD: "Impact Number")
-- ============================================
function ApplyTemplateStyle(tool, templateName)
    local style = TEMPLATE_STYLES[templateName]
    if not style then
        print("[AutoSubs] No custom style for template '" .. tostring(templateName) .. "' — keeping defaults")
        return false
    end

    print("[AutoSubs] Applying style '" .. templateName .. "': font=" .. style.font .. " size=" .. style.size)

    -- Set font family (pcall vì font có thể không tồn tại trên máy user)
    local fontOk = pcall(function() tool:SetInput("Font", style.font) end)
    if not fontOk then
        print("[AutoSubs] WARNING: Font '" .. style.font .. "' not available — keeping default font")
    end

    -- Set text size (0.0 → 1.0, thường dùng 0.03 ~ 0.15)
    pcall(function() tool:SetInput("Size", style.size) end)

    -- Set fill color (Shading Element 1 = main text color)
    pcall(function()
        tool:SetInput("Red1", style.red1)
        tool:SetInput("Green1", style.green1)
        tool:SetInput("Blue1", style.blue1)
    end)

    -- Set outline color (Shading Element 4 = stroke/outline)
    pcall(function()
        tool:SetInput("Red4", style.red4)
        tool:SetInput("Green4", style.green4)
        tool:SetInput("Blue4", style.blue4)
    end)

    return true
end

-- ============================================
-- AddTemplateSubtitles: Thêm nhiều câu với nhiều template khác nhau cùng lúc
-- @param clips: mảng obj có {start, end, text, template}
-- ============================================
function AddTemplateSubtitles(clips, trackIndex)
    print("[AutoSubs] Running AddTemplateSubtitles with " .. #clips .. " clips...")
    if not clips or #clips == 0 then
        return { error = true, message = "No clips provided" }
    end

    local timeline = project:GetCurrentTimeline()
    if not timeline then
        return { error = true, message = "No active timeline found" }
    end

    local frame_rate = timeline:GetSetting("timelineFrameRate")
    local timelineStart = timeline:GetStartFrame()
    local rootFolder = mediaPool:GetRootFolder()

    -- ===== DEBUG: Liệt kê tất cả template trong Media Pool để so sánh =====
    print("[AutoSubs] DEBUG - Scanning Media Pool for all templates...")
    local allTemplates = {}
    walk_media_pool(rootFolder, function(clip)
        local props = clip:GetClipProperty()
        local clipType = props["Type"]
        if isMatchingTitle(clipType) then
            local clipName = props["Clip Name"]
            table.insert(allTemplates, clipName)
            print("[AutoSubs] Media Pool template found: '" .. clipName .. "'")
        end
    end)
    print("[AutoSubs] Total templates in Media Pool: " .. #allTemplates)

    -- Cache map for template loading to avoid O(N^2) lookups
    local templateCache = {}
    local function GetCachedTpl(tplName)
        if not tplName or tplName == "" then tplName = "Default Template" end
        if not templateCache[tplName] then
            -- Title 1-4: LUÔN import fresh từ file .setting
            -- (ImportTitleFromFile đã xoá clip cũ cùng tên trước khi import)
            local isTitleSetting = (tplName == "Title 1" or tplName == "Title 2"
                                 or tplName == "Title 3" or tplName == "Title 4")

            local t = nil
            if isTitleSetting then
                print("[AutoSubs] Force fresh import for: '" .. tplName .. "'")
                t = ImportTitleFromFile(tplName)
            else
                -- Template thường: tìm Media Pool trước
                t = GetTemplateItemByFolder(rootFolder, tplName)
                if not t then
                    print("[AutoSubs] Not in Media Pool — trying file: '" .. tplName .. "'")
                    t = ImportTitleFromFile(tplName)
                end
            end

            -- Bước 3: Vẫn không có → fallback về Default Template
            if not t then
                print("[AutoSubs] WARNING: Template '" .. tplName .. "' NOT FOUND anywhere. Falling back to Default Template.")
                t = GetTemplateItem(rootFolder, "Default Template")
                -- Thử import Default Template từ file nếu cũng không có trong Media Pool
                if not t then
                    t = ImportTitleFromFile("Title 1")
                end
            else
                local props = t:GetClipProperty()
                print("[AutoSubs] Found template: '" .. tplName .. "' → clip '" .. (props["Clip Name"] or "?") .. "' (FPS=" .. tostring(props["FPS"]) .. ")")
            end

            templateCache[tplName] = t
        end
        return templateCache[tplName]
    end


    local addedCount = 0
    for i, clipData in ipairs(clips) do
        -- DEBUG: In tên template mỗi clip yêu cầu
        local requestedTpl = clipData.template or "(nil)"
        print(string.format("[AutoSubs] Clip %d: template='%s' text='%s'",
            i, requestedTpl, (clipData["text"] or ""):sub(1, 40)))

        local tplItem = GetCachedTpl(clipData.template)
        if not tplItem then
            print("[AutoSubs] ERROR: No template found at all for clip " .. i)
            return { error = true, message = "Missing default templates in Media Pool" }
        end
        
        local tplProps = tplItem:GetClipProperty()
        local tpl_fps = tplProps["FPS"] or frame_rate
        local tplClipName = tplProps["Clip Name"] or "unknown"
        print(string.format("[AutoSubs] Clip %d: Using template '%s' (FPS=%s)", i, tplClipName, tostring(tpl_fps)))

        local start_frame = to_frames(clipData["start"], frame_rate)
        local end_frame = to_frames(clipData["end"], frame_rate)
        local timeline_pos = timelineStart + start_frame
        local clip_timeline_duration = end_frame - start_frame

        -- Nối khoảng hở (gap joining) nếu quá gần
        if i < #clips then
            local next_start = timelineStart + to_frames(clips[i + 1]["start"], frame_rate)
            local frames_between = next_start - (timeline_pos + clip_timeline_duration)
            if frames_between < frame_rate then -- 1 giây
                clip_timeline_duration = clip_timeline_duration + frames_between + 1
            end
        end

        local duration = (clip_timeline_duration / frame_rate) * tpl_fps

        local newClip = {
            mediaPoolItem = tplItem,
            mediaType = 1,
            startFrame = 0,
            endFrame = duration,
            recordFrame = timeline_pos,
            trackIndex = tonumber(trackIndex) or 1
        }
        
        -- ⭐ GỌI APPEND CHO TỪNG CLIP riêng lẻ
        local timelineItems = mediaPool:AppendToTimeline({ newClip })
        if timelineItems and #timelineItems > 0 then
            addedCount = addedCount + 1
            local timelineItem = timelineItems[1]
            -- Kiểm tra tên clip thực tế đã thêm lên timeline
            local addedName = timelineItem:GetName() or "unknown"
            print(string.format("[AutoSubs] Clip %d added to timeline: '%s'", i, addedName))
            pcall(function()
                local subtitleText = clipData["text"]
                local templateName = clipData.template or "Default Template"

                -- DEBUG: Kiểm tra Fusion comp structure
                local fusionCount = timelineItem:GetFusionCompCount()
                print(string.format("[AutoSubs] Clip %d: FusionCompCount=%d, template='%s'",
                    i, fusionCount, templateName))

                if fusionCount > 0 then
                    local comp = timelineItem:GetFusionCompByIndex(1)
                    local tool = comp:FindToolByID("TextPlus")

                    if tool then
                        -- ===== AUTO-RESIZE: Tự giảm size & xuống dòng khi text dài =====
                        -- Size mặc định: Title 1,4 = 0.05 | Title 2,3 = 0.18
                        local textLen = #(subtitleText or "")

                        -- Bảng ngưỡng: {maxChars, sizeFactor}
                        -- sizeFactor nhân với size hiện tại của template
                        local TITLE_SIZE_DEFAULTS = {
                            ["Title 1"] = 0.05, ["Title 2"] = 0.18,
                            ["Title 3"] = 0.18, ["Title 4"] = 0.05,
                        }
                        local baseSize = TITLE_SIZE_DEFAULTS[templateName]

                        if baseSize and textLen > 0 then
                            local newSize = baseSize
                            local finalText = subtitleText

                            if baseSize >= 0.15 then
                                -- Title 2, 3 (chữ to): nhạy hơn vì dễ tràn
                                if textLen > 25 then
                                    -- Quá dài → xuống dòng ở khoảng trắng giữa
                                    local midPoint = math.floor(textLen / 2)
                                    local bestBreak = midPoint
                                    -- Tìm khoảng trắng gần giữa nhất
                                    for j = midPoint, 1, -1 do
                                        if finalText:sub(j, j) == " " then
                                            bestBreak = j
                                            break
                                        end
                                    end
                                    finalText = finalText:sub(1, bestBreak - 1) .. "\n" .. finalText:sub(bestBreak + 1)
                                end
                                if textLen > 20 then newSize = baseSize * 0.75
                                elseif textLen > 15 then newSize = baseSize * 0.85
                                end
                            else
                                -- Title 1, 4 (chữ nhỏ): ít nhạy hơn
                                if textLen > 50 then
                                    local midPoint = math.floor(textLen / 2)
                                    local bestBreak = midPoint
                                    for j = midPoint, 1, -1 do
                                        if finalText:sub(j, j) == " " then
                                            bestBreak = j
                                            break
                                        end
                                    end
                                    finalText = finalText:sub(1, bestBreak - 1) .. "\n" .. finalText:sub(bestBreak + 1)
                                end
                                if textLen > 40 then newSize = baseSize * 0.8
                                elseif textLen > 30 then newSize = baseSize * 0.9
                                end
                            end

                            -- Set text (có thể đã thêm \n)
                            tool:SetInput("StyledText", finalText)
                            -- Set size (có thể đã giảm)
                            if newSize ~= baseSize then
                                pcall(function() tool:SetInput("Size", newSize) end)
                                print(string.format("[AutoSubs] Clip %d: 📏 Auto-resize: %d chars → size %.4f (was %.4f)",
                                    i, textLen, newSize, baseSize))
                            end
                        else
                            -- Không có trong bảng size → set text bình thường
                            tool:SetInput("StyledText", subtitleText)
                        end

                        print(string.format("[AutoSubs] Clip %d: ✅ TextPlus set text='%s'",
                            i, (subtitleText or ""):sub(1, 30)))
                    else
                        -- TextPlus không tìm thấy — thử tìm tất cả tools trong comp
                        print(string.format("[AutoSubs] Clip %d: ⚠️ TextPlus NOT FOUND in comp!", i))
                        local toolList = comp:GetToolList()
                        if toolList then
                            for idx, t in ipairs(toolList) do
                                print(string.format("[AutoSubs]   Tool %d: ID='%s' Name='%s'",
                                    idx, tostring(t:GetAttrs().TOOLS_RegID or "?"), tostring(t.Name or "?")))
                            end
                        end
                    end

                    -- Clip color: giữ nguyên màu mặc định của title, không đổi
                else
                    print(string.format("[AutoSubs] Clip %d: ⚠️ No Fusion comp! Template may not be a Fusion Title.", i))
                end
            end)
        else
            print("[AutoSubs] WARNING: AppendToTimeline returned nil/empty for clip " .. i)
        end
    end

    print("[AutoSubs] AddTemplateSubtitles done. Added: " .. addedCount .. "/" .. #clips)

    -- ===== SFX: Thêm hit-sfx.WAV cho Title 2 và Title 3 =====
    -- SFX xuất hiện cùng lúc với title, tự kết thúc theo độ dài file audio
    local SFX_PATH = "/Users/may1/Desktop/hit-sfx.WAV"
    local SFX_TEMPLATES = { ["Title 2"] = true, ["Title 3"] = true }

    -- Đếm xem có clip nào cần SFX không
    local sfxClips = {}
    for i, clipData in ipairs(clips) do
        if SFX_TEMPLATES[clipData.template] then
            table.insert(sfxClips, { index = i, clipData = clipData })
        end
    end

    if #sfxClips > 0 then
        print(string.format("[AutoSubs] SFX: %d clips cần hit-sfx.WAV", #sfxClips))

        -- Import SFX file vào Media Pool (chỉ 1 lần)
        local sfxItem = nil
        -- Tìm xem đã có trong Media Pool chưa
        walk_media_pool(rootFolder, function(clip)
            local props = clip:GetClipProperty()
            local clipName = props["File Name"] or props["Clip Name"] or ""
            if clipName:lower():find("hit%-sfx") then
                sfxItem = clip
            end
        end)

        -- Nếu chưa có → import
        if not sfxItem then
            local importedItems = mediaPool:ImportMedia({ SFX_PATH })
            if importedItems and #importedItems > 0 then
                sfxItem = importedItems[1]
                print("[AutoSubs] SFX: ✅ Imported hit-sfx.WAV vào Media Pool")
            else
                print("[AutoSubs] SFX: ❌ Không thể import " .. SFX_PATH)
            end
        else
            print("[AutoSubs] SFX: ♻️ Đã có hit-sfx.WAV trong Media Pool")
        end

        -- Thêm SFX lên audio track cho từng clip Title 2/3
        if sfxItem then
            local sfxProps = sfxItem:GetClipProperty()
            local sfx_fps = sfxProps["FPS"] or frame_rate
            -- Audio track = video track + 1 (hoặc tối thiểu A1)
            local audioTrackIdx = math.max(1, (tonumber(trackIndex) or 1))
            local sfxAddedCount = 0

            for _, entry in ipairs(sfxClips) do
                local cd = entry.clipData
                local start_frame = to_frames(cd["start"], frame_rate)
                local timeline_pos = timelineStart + start_frame

                -- SFX ngắn — để tự kết thúc theo độ dài file gốc
                local sfxClipData = {
                    mediaPoolItem = sfxItem,
                    mediaType = 2,        -- 2 = Audio only
                    startFrame = 0,
                    endFrame = -1,        -- -1 = toàn bộ file audio
                    recordFrame = timeline_pos,
                    trackIndex = audioTrackIdx
                }

                local sfxResult = mediaPool:AppendToTimeline({ sfxClipData })
                if sfxResult and #sfxResult > 0 then
                    sfxAddedCount = sfxAddedCount + 1
                    print(string.format("[AutoSubs] SFX: ✅ Clip %d — added hit-sfx at frame %d (A%d)",
                        entry.index, timeline_pos, audioTrackIdx))
                else
                    print(string.format("[AutoSubs] SFX: ⚠️ Clip %d — AppendToTimeline failed", entry.index))
                end
            end

            print(string.format("[AutoSubs] SFX done: %d/%d clips added", sfxAddedCount, #sfxClips))
        end
    end

    timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())
    return { success = true, added = addedCount }
end

-- ============================================
-- AddAudioToTimeline: Import 1 file audio vào AUDIO TRACK MỚI trên timeline
-- File audio (VD: final_bgm_ducked.wav) được đặt ở vị trí 0s (đầu timeline)
-- Tạo track audio mới để user có thể xoá/tạo lại nếu không ưng
-- @param filePath: đường dẫn tuyệt đối tới file audio
-- @param trackName: tên track (VD: "BGM - Auto") — optional
-- ============================================
function AddAudioToTimeline(filePath, trackName)
    print("[AutoSubs] AddAudioToTimeline: " .. filePath)

    local timeline = project:GetCurrentTimeline()
    if not timeline then
        return { error = true, message = "No active timeline found" }
    end

    local frame_rate = timeline:GetSetting("timelineFrameRate")
    local timelineStart = timeline:GetStartFrame()

    -- 1. Import file vào Media Pool
    local currentFolder = mediaPool:GetCurrentFolder()
    local audioFolder = mediaPool:AddSubFolder(currentFolder, "AutoSubs Audio")
    if audioFolder then
        mediaPool:SetCurrentFolder(audioFolder)
    end

    local mediaPoolItems = mediaPool:ImportMedia({ filePath })

    -- Quay lại folder gốc
    if currentFolder then mediaPool:SetCurrentFolder(currentFolder) end

    if not mediaPoolItems or #mediaPoolItems == 0 then
        return { error = true, message = "Không import được file audio vào Media Pool" }
    end

    local audioItem = mediaPoolItems[1]
    local clipProps = audioItem:GetClipProperty()
    print("[AutoSubs] Imported audio: " .. (clipProps["Clip Name"] or "unknown"))

    -- 2. Tạo audio track mới
    local audioTrackCount = timeline:GetTrackCount("audio")
    local newTrackIdx = audioTrackCount + 1
    timeline:AddTrack("audio")

    -- Đặt tên cho track mới (nếu DaVinci hỗ trợ)
    local label = trackName or "BGM - AutoSubs"
    pcall(function()
        timeline:SetTrackName("audio", newTrackIdx, label)
    end)

    print("[AutoSubs] Created audio track A" .. newTrackIdx .. " (" .. label .. ")")

    -- 3. Đặt file audio lên track mới tại vị trí 0s (đầu timeline)
    local clipFPS = tonumber(clipProps["FPS"]) or frame_rate
    if clipFPS <= 0 then clipFPS = frame_rate end

    -- Lấy tổng số frame của audio file
    local totalFrames = tonumber(clipProps["Frames"]) or 0
    if totalFrames <= 0 then
        -- Fallback: tính từ duration
        local duration = tonumber(clipProps["Duration"]) or 0
        if duration > 0 then
            totalFrames = math.floor(duration * clipFPS)
        else
            totalFrames = math.floor(3600 * clipFPS) -- 1 giờ max
        end
    end

    local audioClip = {
        mediaPoolItem = audioItem,
        mediaType = 2,                  -- 2 = Audio only
        startFrame = 0,                 -- Từ đầu file audio
        endFrame = totalFrames,         -- Toàn bộ file
        recordFrame = timelineStart,    -- Đặt ở đầu timeline
        trackIndex = newTrackIdx        -- Track audio mới
    }

    local timelineItems = mediaPool:AppendToTimeline({ audioClip })

    if not timelineItems or #timelineItems == 0 then
        return { error = true, message = "Không thêm được audio lên timeline" }
    end

    -- Đánh dấu clip
    pcall(function()
        timelineItems[1]:SetClipColor("Purple")
    end)

    -- Refresh timeline
    timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())

    print("[AutoSubs] ✅ Audio added to track A" .. newTrackIdx)
    return {
        success = true,
        audioTrack = newTrackIdx,
        trackName = label,
        message = "Đã thêm nhạc nền vào Audio Track A" .. newTrackIdx
    }
end

-- ============================================
-- AddSfxClipsToTimeline: Import nhiều file SFX vào AUDIO TRACK mới trên timeline
-- Mỗi clip được đặt đúng vị trí (startTime giây) — chỉ nhận cue có whisper timing chính xác
-- Hỗ trợ trim: nếu có trimStartSec/trimEndSec → cắt đoạn SFX trước khi đặt lên timeline
-- @param clips: mảng {filePath, startTime, trimStartSec?, trimEndSec?}
-- @param trackName: tên audio track (VD: "SFX - AutoSubs")
-- ============================================
function AddSfxClipsToTimeline(clips, trackName)
    print("[AutoSubs] AddSfxClipsToTimeline: " .. #clips .. " clips")

    local timeline = project:GetCurrentTimeline()
    if not timeline then
        return { error = true, message = "No active timeline found" }
    end

    if #clips == 0 then
        return { error = true, message = "No SFX clips provided" }
    end

    local frame_rate = timeline:GetSetting("timelineFrameRate")
    local timelineStart = timeline:GetStartFrame()

    -- 1. Thu thập tất cả file paths (unique) để import cùng lúc
    local uniquePaths = {}
    local pathSet = {}
    for _, clip in ipairs(clips) do
        if not pathSet[clip.filePath] then
            pathSet[clip.filePath] = true
            table.insert(uniquePaths, clip.filePath)
        end
    end

    -- 2. Import tất cả SFX files vào Media Pool
    local currentFolder = mediaPool:GetCurrentFolder()
    local sfxFolder = mediaPool:AddSubFolder(currentFolder, "AutoSubs SFX")
    if sfxFolder then
        mediaPool:SetCurrentFolder(sfxFolder)
    end

    print("[AutoSubs] Importing " .. #uniquePaths .. " unique SFX files to Media Pool...")
    local mediaPoolItems = mediaPool:ImportMedia(uniquePaths)

    -- Quay lại folder gốc
    if currentFolder then mediaPool:SetCurrentFolder(currentFolder) end

    if not mediaPoolItems or #mediaPoolItems == 0 then
        return { error = true, message = "Failed to import SFX files to Media Pool" }
    end

    -- 3. Tạo mapping fileName → mediaPoolItem
    local mediaItemMap = {}
    for _, item in ipairs(mediaPoolItems) do
        local props = item:GetClipProperty()
        local itemName = props["File Name"] or props["Clip Name"] or ""
        if itemName == "" then
            local itemPath = props["File Path"] or ""
            itemName = itemPath:match("([^/\\]+)$") or ""
        end
        if itemName ~= "" then
            mediaItemMap[itemName] = item
            print("[AutoSubs]   Mapped SFX: " .. itemName)
        end
    end

    -- 4. Dùng audio track chỉ định (mặc định Track 1 — không tạo track mới)
    local targetTrackIdx = 1
    local label = trackName or "SFX - AutoSubs"

    print("[AutoSubs] Using audio track A" .. targetTrackIdx .. " (" .. label .. ")")

    -- 5. Đặt từng SFX clip lên timeline đúng vị trí
    local addedCount = 0
    local skippedCount = 0

    for i, clip in ipairs(clips) do
        local fileName = clip.filePath:match("([^/\\]+)$") or ""
        local mediaItem = mediaItemMap[fileName]

        if not mediaItem then
            print(string.format("[AutoSubs] ⚠️ SFX %d: Không tìm thấy '%s' trong Media Pool", i, fileName))
            skippedCount = skippedCount + 1
        else
            local startTime = tonumber(clip.startTime) or 0
            local timeline_pos = timelineStart + math.floor(startTime * frame_rate)

            -- Lấy thông tin clip
            local clipProps = mediaItem:GetClipProperty()
            local clipFPS = tonumber(clipProps["FPS"]) or frame_rate
            if clipFPS <= 0 then clipFPS = frame_rate end

            -- Tính startFrame và endFrame cho trim
            local sfxStartFrame = 0
            local sfxEndFrame = -1  -- -1 = toàn bộ file

            if clip.trimStartSec or clip.trimEndSec then
                local trimStart = tonumber(clip.trimStartSec) or 0
                sfxStartFrame = math.floor(trimStart * clipFPS)

                if clip.trimEndSec then
                    local trimEnd = tonumber(clip.trimEndSec)
                    sfxEndFrame = math.floor(trimEnd * clipFPS)
                end

                print(string.format("[AutoSubs] SFX %d: ✂️ Trim: frame %d → %s (FPS=%s)",
                    i, sfxStartFrame, tostring(sfxEndFrame), tostring(clipFPS)))
            end

            local sfxClipData = {
                mediaPoolItem = mediaItem,
                mediaType = 2,                -- 2 = Audio only
                startFrame = sfxStartFrame,   -- Trim start
                endFrame = sfxEndFrame,       -- Trim end (-1 = full)
                recordFrame = timeline_pos,   -- Vị trí trên timeline
                trackIndex = targetTrackIdx      -- Audio track mới
            }

            local result = mediaPool:AppendToTimeline({ sfxClipData })
            if result and #result > 0 then
                addedCount = addedCount + 1
                -- Đánh dấu clip màu cam để phân biệt SFX
                pcall(function()
                    result[1]:SetClipColor("Orange")
                end)
                print(string.format("[AutoSubs] ✅ SFX %d: '%s' @ %.2fs (frame %d) → A%d",
                    i, fileName, startTime, timeline_pos, targetTrackIdx))
            else
                print(string.format("[AutoSubs] ⚠️ SFX %d: AppendToTimeline failed for '%s'", i, fileName))
                skippedCount = skippedCount + 1
            end
        end
    end

    -- Refresh timeline
    timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())

    print(string.format("[AutoSubs] SFX done: %d added, %d skipped, track A%d", addedCount, skippedCount, targetTrackIdx))
    return {
        success = true,
        audioTrack = targetTrackIdx,
        clipsAdded = addedCount,
        skippedCount = skippedCount,
        message = string.format("Added %d/%d SFX clips to Audio Track A%d (%s)", addedCount, #clips, targetTrackIdx, label)
    }
end

-- ============================================
-- AddMediaToTimeline: Import video files vào timeline đúng vị trí
-- Nhận danh sách clips: [{filePath, startTime, endTime}] + trackIndex
-- Mỗi file được import vào Media Pool rồi đặt lên timeline
-- startTime/endTime tính bằng giây (từ text matching)
-- ============================================
function AddMediaToTimeline(clips, trackIndex)
    print("[AutoSubs Server] Adding " .. #clips .. " media clips to timeline...")

    -- Lấy thông tin timeline hiện tại
    local timeline = project:GetCurrentTimeline()
    if not timeline then
        print("No active timeline found!")
        return { error = true, message = "No active timeline found" }
    end

    local frame_rate = timeline:GetSetting("timelineFrameRate")
    local timelineStart = timeline:GetStartFrame()
    local trackIdx = tonumber(trackIndex) or 1

    print("  Frame rate: " .. frame_rate)
    print("  Timeline start: " .. timelineStart)
    print("  Target track: " .. trackIdx)

    -- Bước 1: Thu thập tất cả file paths để import cùng lúc
    -- (Clip mới import lên track được chọn, clip cũ giữ nguyên ở track cũ)
    local filePaths = {}
    for i, clip in ipairs(clips) do
        table.insert(filePaths, clip.filePath)
    end

    -- Bước 2: Import tất cả files vào Media Pool
    local mediaStorage = resolve:GetMediaStorage()
    local currentFolder = mediaPool:GetCurrentFolder()

    -- Tạo folder riêng trong Media Pool để tổ chức
    local mediaFolder = mediaPool:AddSubFolder(currentFolder, "AutoSubs Media Import")
    if mediaFolder then
        mediaPool:SetCurrentFolder(mediaFolder)
    end

    print("  Importing " .. #filePaths .. " files to Media Pool...")
    local mediaPoolItems = mediaPool:ImportMedia(filePaths)

    if not mediaPoolItems or #mediaPoolItems == 0 then
        print("Failed to import media files!")
        -- Quay lại folder gốc
        if currentFolder then mediaPool:SetCurrentFolder(currentFolder) end
        return { error = true, message = "Failed to import media files to Media Pool" }
    end

    print("  Imported " .. #mediaPoolItems .. " items to Media Pool")

    -- ⭐ Bước 2.5: Tạo mapping fileName → mediaPoolItem
    -- QUAN TRỌNG: ImportMedia() KHÔNG đảm bảo thứ tự trả về = thứ tự input!
    -- Phải map bằng tên file để tránh gán sai clip
    local mediaItemMap = {}
    for _, item in ipairs(mediaPoolItems) do
        local props = item:GetClipProperty()
        -- Lấy tên file từ clip property
        local itemName = props["File Name"] or props["Clip Name"] or ""
        -- Fallback: lấy File Path rồi trích tên file
        if itemName == "" then
            local itemPath = props["File Path"] or ""
            itemName = itemPath:match("([^/\\]+)$") or ""
        end
        if itemName ~= "" then
            mediaItemMap[itemName] = item
            print("    Mapped: " .. itemName)
        end
    end

    -- Bước 3: Đặt từng clip lên timeline ĐÚNG vị trí
    local actualAdded = 0
    local preparedCount = 0

    print("  Appending clips to timeline...")

    for i, clip in ipairs(clips) do
        -- Trích tên file từ đường dẫn đầy đủ
        local fileName = clip.filePath:match("([^/\\]+)$") or ""
        local mediaItem = mediaItemMap[fileName]

        if not mediaItem then
            print(string.format("  ⚠️ Clip %d: Không tìm thấy MediaPoolItem cho '%s'", i, fileName))
        else
            local startTime = tonumber(clip.startTime) or 0
            local endTime = tonumber(clip.endTime) or 0
            local clipDuration = endTime - startTime

            if clipDuration > 0 then
                -- Tính vị trí trên timeline (frame)
                local timeline_pos = timelineStart + math.floor(startTime * frame_rate)
                -- Tính thời lượng clip trên timeline (frame) 
                local timeline_duration = math.floor(clipDuration * frame_rate)

                -- ⭐ Phát hiện file ảnh tĩnh (still image)
                -- Ảnh tĩnh có FPS = 0 hoặc rất nhỏ → phải dùng timeline frame_rate
                local lowerName = fileName:lower()
                local isStillImage = lowerName:match("%.jpe?g$")
                    or lowerName:match("%.png$")
                    or lowerName:match("%.webp$")
                    or lowerName:match("%.bmp$")
                    or lowerName:match("%.tiff?$")
                    or lowerName:match("%.exr$")

                -- Lấy frame rate gốc của media file
                local clipProps = mediaItem:GetClipProperty()
                local clipFPS = tonumber(clipProps["FPS"]) or frame_rate

                -- Ảnh tĩnh: LUÔN dùng timeline frame_rate (FPS gốc = 0 sẽ gây lỗi)
                -- Video: dùng FPS gốc của clip (DaVinci yêu cầu vậy)
                if isStillImage or clipFPS <= 0 then
                    clipFPS = frame_rate
                    print(string.format("  Clip %d: 📷 Still image detected → using timeline FPS=%s", i, tostring(frame_rate)))
                end

                -- endFrame tính theo FPS (gốc cho video, timeline cho ảnh)
                -- Trim video: chỉ lấy đoạn đầu vừa đúng thời lượng câu
                local endFrame = math.floor(clipDuration * clipFPS)

                -- Clip Video
                local newVideoClip = {
                    mediaPoolItem = mediaItem,
                    mediaType = 1,              -- 1 = Video
                    startFrame = 0,
                    endFrame = endFrame,
                    recordFrame = timeline_pos,
                    trackIndex = trackIdx       -- Track đích (ví dụ V1)
                }

                if isStillImage then
                    -- ⭐ Ảnh tĩnh: chỉ thêm video, KHÔNG thêm audio (ảnh không có audio)
                    local timelineItems = mediaPool:AppendToTimeline({ newVideoClip })
                    if timelineItems and #timelineItems > 0 then
                        actualAdded = actualAdded + 1
                        -- Đánh dấu màu xanh
                        for _, tItem in ipairs(timelineItems) do
                            tItem:SetClipColor("Blue")
                        end
                    end
                else
                    -- Video: thêm cả video + audio
                    local newAudioClip = {
                        mediaPoolItem = mediaItem,
                        mediaType = 2,              -- 2 = Audio
                        startFrame = 0,
                        endFrame = endFrame,
                        recordFrame = timeline_pos,
                        trackIndex = trackIdx       -- Track đích (ví dụ A1 cùng số với V1)
                    }

                    -- ⭐ GỌI APPEND CHO TỪNG CLIP để DaVinci tôn trọng `recordFrame`
                    local timelineItems = mediaPool:AppendToTimeline({ newVideoClip, newAudioClip })
                    if timelineItems and #timelineItems > 0 then
                        actualAdded = actualAdded + 1
                        -- Đánh dấu màu xanh
                        for _, tItem in ipairs(timelineItems) do
                            tItem:SetClipColor("Blue")
                        end
                    end
                end

                preparedCount = preparedCount + 1
                print(string.format("  Clip %d: %s -> %.2fs-%.2fs @ frame %d (endFrame=%d, FPS=%s, still=%s)",
                    i, fileName, startTime, endTime, timeline_pos, endFrame, tostring(clipFPS), tostring(isStillImage or false)))
            else
                print(string.format("  Clip %d: Skipped (invalid duration: %.2fs)", i, clipDuration))
            end
        end
    end

    if actualAdded > 0 then
        print("  ✅ Successfully added " .. actualAdded .. " clips to timeline!")
    else
        print("  ❌ No clips were added to the timeline.")
        if currentFolder then mediaPool:SetCurrentFolder(currentFolder) end
        return {
            error = true,
            message = "AppendToTimeline failed! Prepared clips but none were added.",
            clipsAdded = 0
        }
    end

    -- Quay lại folder gốc trong Media Pool
    if currentFolder then mediaPool:SetCurrentFolder(currentFolder) end

    -- Refresh timeline
    timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())

    return {
        success = true,
        message = string.format("Added %d/%d clips to timeline on track %d", actualAdded, #clips, trackIdx),
        clipsAdded = actualAdded
    }
end

function ExtractFrame(comp, exportDir, templateFrameRate)
    -- Lock the composition to prevent redraws and pop-ups during scripting [15, 16]
    comp:Lock()

    -- Access the Saver tool by its name (assuming it exists in the comp)
    local mySaver = comp:AddTool("Saver")

    local outputPath = ""

    if mySaver ~= nil then
        -- Set the output filename for the Saver tool [6, 7]
        -- Make sure to provide a full path and desired image format extension
        local name = mySaver.Name
        local settings = mySaver:SaveSettings()
        settings.Tools[name].Inputs.Clip.Value["Filename"] = join_path(exportDir, "subtitle-preview-0.png")
        settings.Tools[name].Inputs.Clip.Value["FormatID"] = "PNGFormat"
        settings.Tools[name].Inputs["OutputFormat"]["Value"] = "PNGFormat"
        mySaver:LoadSettings(settings)

        -- Set the input for the Saver tool to the MediaOut tool
        local mediaOut = comp:FindToolByID("MediaOut")
        mySaver:SetInput("Input", mediaOut)

        -- Define the frame number you want to extract
        local frameToExtract = math.floor(comp:GetAttrs().COMPN_GlobalEnd / 2)

        -- Trigger the render for only the specified frame through the Saver tool [1, 13, 14]
        local success = comp:Render({
            Start = frameToExtract, -- Start rendering at this frame
            End = frameToExtract,   -- End rendering at this frame
            Tool = mySaver,         -- Render up to this specific Saver tool [13]
            Wait = true             -- Wait for the render to complete before continuing the script [19]
        })

        local outputFilename = "subtitle-preview-" .. frameToExtract .. ".png"
        outputPath = join_path(exportDir, outputFilename)

        if success then
            print("Frame " .. frameToExtract .. " successfully saved by " .. mySaver.Name .. " to " .. outputPath)
        else
            print("Failed to save frame " .. frameToExtract)
        end
    else
        print("Saver tool 'MySaver' not found in the composition.")
    end

    -- Unlock the composition after changes are complete [15, 20]
    comp:Unlock()

    return outputPath
end

-- place example subtitle on timeline with theme and export frame
function GeneratePreview(speaker, templateName, exportDir)
    local timeline = project:GetCurrentTimeline()
    local rootFolder = mediaPool:GetRootFolder()

    -- Choose a template if none provided
    if templateName == "" then
        local availableTemplates = GetTemplates()
        if #availableTemplates > 0 then
            templateName = availableTemplates[1].value
        end
    end

    -- Resolve the template item with fallbacks
    local templateItem = nil
    if templateName ~= nil and templateName ~= "" then
        templateItem = GetTemplateItem(rootFolder, templateName)
    end
    if not templateItem then
        templateItem = GetTemplateItem(rootFolder, "Default Template")
    end
    if not templateItem then
        print("Error: Could not find subtitle template '" .. tostring(templateName) .. "' in media pool.")
        return ""
    end

    local templateFrameRate = templateItem:GetClipProperty()["FPS"]

    -- Only add a track after we have a valid template
    timeline:AddTrack("video")
    local trackIndex = timeline:GetTrackCount("video")

    local newClip = {
        mediaPoolItem = templateItem,     -- source MediaPoolItem to add to timeline
        startFrame = 0,                   -- start frame means within the clip
        endFrame = templateFrameRate * 2, -- end frame means within the clip
        recordFrame = 0,                  -- record frame means where in the timeline the clip should be placed
        trackIndex = trackIndex           -- track the clip should be placed on
    }
    local timelineItems = mediaPool:AppendToTimeline({ newClip })
    local timelineItem = timelineItems[1]

    local outputPath = nil
    local success, err = pcall(function()
        -- Set timeline position to middle of clip
        if timelineItem:GetFusionCompCount() > 0 then
            local comp = timelineItem:GetFusionCompByIndex(1)
            local tool = comp:FindToolByID("TextPlus")
            tool:SetInput("StyledText", "Example Subtitle Text")
            SetCustomColors(speaker, tool)

            outputPath = ExtractFrame(comp, exportDir, templateFrameRate)
        end
    end)
    if not success then
        print("Failed to set timeline position: " .. err)
    end
    timeline:DeleteClips(timelineItems)
    timeline:DeleteTrack("video", trackIndex)

    return outputPath
end

-- Minimal JSON helper to avoid crashes if `json` is unavailable
local function safe_json(obj)
    if json and json.encode then
        return json.encode(obj)
    end
    if obj and obj.message ~= nil then
        local msg = tostring(obj.message):gsub('"', '\\"')
        return '{"message":"' .. msg .. '"}'
    end
    return "{}"
end

function LaunchApp()
    if ffi.os == "Windows" then
        -- Windows
        local SW_SHOW = 5 -- Show the window

        -- Call ShellExecuteA from Shell32.dll
        local shell32 = ffi.load("Shell32")
        local result_open = shell32.ShellExecuteA(nil, "open", main_app, nil, nil, SW_SHOW)

        if result_open > 32 then
            print("AutoSubs launched successfully.")
        else
            print("Failed to launch AutoSubs. Error code:", result_open)
            return
        end
    else
        -- MacOS & Linux
        local result_open = ffi.C.system(command_open)

        if result_open == 0 then
            print("AutoSubs launched successfully.")
        else
            print("Failed to launch AutoSubs. Error code:", result_open)
            return
        end
    end
end

-- Send a small HTTP POST to 127.0.0.1:PORT with {"func":"Exit"}
local function send_exit_via_socket()
    local ok = pcall(function()
        local info = assert(socket.find_first_address("127.0.0.1", PORT))
        local client = assert(socket.create(info.family, info.socket_type, info.protocol))
        assert(client:set_option("nodelay", true, "tcp"))
        client:set_blocking(true)

        assert(client:connect(info))

        local body = "{\"func\":\"Exit\"}"
        local req = string.format(
            "POST / HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s",
            PORT, #body, body
        )

        assert(client:send(req))
        client:close()
    end)
    if not ok then
        print("Failed to send Exit via socket")
    end
end

function StartServer()
    -- Set up server socket configuration
    local info = assert(socket.find_first_address("127.0.0.1", PORT))
    local server = assert(socket.create(info.family, info.socket_type, info.protocol))

    -- Set socket options
    server:set_blocking(false)
    assert(server:set_option("nodelay", true, "tcp"))
    assert(server:set_option("reuseaddr", true))

    -- Bind and listen
    local success, err = pcall(function()
        assert(server:bind(info))
    end)

    if not success then
        send_exit_via_socket()
        sleep(0.5)
        assert(server:bind(info))
    end

    assert(server:listen())
    print("AutoSubs server is listening on port: ", PORT)
    print("Press Ctrl+C to stop the server")

    -- Launch app if not in dev mode
    if not DEV_MODE then
        LaunchApp()
    end

    -- Server loop with signal handling
    local quitServer = false
    while not quitServer do
        -- Server loop to handle client connections
        local client, err = server:accept()
        if client then
            local peername, peer_err = client:get_peer_name()
            if peername then
                assert(client:set_blocking(false))
                -- Try to receive data (example HTTP request)
                local str, err = client:receive()
                if str then
                    -- Accumulate the full HTTP request (headers + body). Start with what we have.
                    local request = str
                    local header_body_separator = "\r\n\r\n"
                    -- Temporarily allow short blocking reads to finish the HTTP request, then return to non-blocking
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
                                if current >= needed then
                                    break
                                end
                            else
                                -- No Content-Length: assume no body or already complete
                                break
                            end
                        end
                        local chunk, rerr, partial = client:receive(1024)
                        if chunk and #chunk > 0 then
                            request = request .. chunk
                        elseif partial and #partial > 0 then
                            request = request .. partial
                        else
                            -- timeout or other read error; stop accumulating
                            break
                        end
                    end
                    if client.settimeout then client:settimeout(0) end

                    -- Extract body content after headers, if present
                    local _, sep_end = string.find(request, header_body_separator, 1, true)
                    local content = nil
                    if sep_end then
                        content = string.sub(request, sep_end + 1)
                    end
                    print("Received request:", content)

                    -- Parse the JSON content safely (avoid crashes if body is missing/partial)
                    local data, pos, jerr = nil, nil, nil
                    if content and #content > 0 then
                        local ok, r1, r2, r3 = pcall(json.decode, content, 1, nil)
                        if ok then
                            data, pos, jerr = r1, r2, r3
                        else
                            jerr = r1
                        end
                    end

                    -- Initialize body for response
                    local body = nil

                    -- success already defined above
                    success, err = pcall(function()
                        if data ~= nil then
                            if data.func == "GetTimelineInfo" then
                                print("[AutoSubs Server] Retrieving Timeline Info...")
                                local timelineInfo = GetTimelineInfo()
                                body = json.encode(timelineInfo)
                            elseif data.func == "JumpToTime" then
                                print("[AutoSubs Server] Jumping to time...")
                                JumpToTime(data.seconds)
                                body = json.encode({
                                    message = "Jumped to time"
                                })
                            elseif data.func == "ExportAudio" then
                                print("[AutoSubs Server] Exporting audio...")
                                local audioInfo = ExportAudio(data.outputDir, data.inputTracks)
                                body = json.encode(audioInfo)
                            elseif data.func == "GetExportProgress" then
                                print("[AutoSubs Server] Getting export progress...")
                                local progressInfo = GetExportProgress()
                                body = json.encode(progressInfo)
                            elseif data.func == "CancelExport" then
                                print("[AutoSubs Server] Cancelling export...")
                                local cancelResult = CancelExport()
                                body = json.encode(cancelResult)
                            elseif data.func == "CheckTrackConflicts" then
                                print("[AutoSubs Server] Checking track conflicts...")
                                local conflictInfo = CheckTrackConflicts(data.filePath, data.trackIndex)
                                body = json.encode(conflictInfo)
                            elseif data.func == "AddSubtitles" then
                                print("[AutoSubs Server] Adding subtitles to timeline...")
                                local result = AddSubtitles(data.filePath, data.trackIndex, data.templateName, data.conflictMode)
                                body = json.encode({
                                    message = "Job completed",
                                    result = result
                                })
                            elseif data.func == "GeneratePreview" then
                                print("[AutoSubs Server] Generating preview...")
                                local previewPath = GeneratePreview(data.speaker, data.templateName, data.exportPath)
                                body = json.encode(previewPath)
                            elseif data.func == "GetTrackClipNumbers" then
                                -- Quét track timeline → trả về danh sách số clip
                                print("[AutoSubs Server] Getting track clip numbers...")
                                local result = GetTrackClipNumbers(data.trackIndex)
                                body = safe_json(result)
                            elseif data.func == "SeekToTime" then
                                -- Di chuyển playhead đến vị trí (giây)
                                local result = SeekToTime(data.seconds)
                                body = safe_json(result)
                            elseif data.func == "AddMediaToTimeline" then
                                -- Import video files vào timeline đúng vị trí text matching
                                print("[AutoSubs Server] Adding media to timeline...")
                                local result = AddMediaToTimeline(data.clips, data.trackIndex)
                                body = safe_json(result)
                            elseif data.func == "AddAudioToTimeline" then
                                -- Import 1 file audio vào audio track mới
                                print("[AutoSubs Server] Adding audio to new track...")
                                local result = AddAudioToTimeline(data.filePath, data.trackName)
                                body = safe_json(result)
                            elseif data.func == "AddSfxClipsToTimeline" then
                                -- Import nhiều SFX clips vào audio track mới với timing chính xác
                                print("[AutoSubs Server] Adding SFX clips to timeline...")
                                local result = AddSfxClipsToTimeline(data.clips, data.trackName)
                                body = safe_json(result)
                            elseif data.func == "AddTemplateSubtitles" then
                                -- Import các Template Titles vào timeline
                                print("[AutoSubs Server] Adding Template Subtitles...")
                                local result = AddTemplateSubtitles(data.clips, data.trackIndex)
                                body = safe_json(result)
                            elseif data.func == "AddSimpleSubtitles" then
                                -- Import phụ đề stories lên timeline (batch)
                                print("[AutoSubs Server] Adding Simple Subtitles...")
                                local result = AddSimpleSubtitles(data.clips, data.templateName, data.trackIndex, data.fontSize)
                                body = safe_json(result)
                            elseif data.func == "CreateTemplateSet" then
                                -- Tạo 5 template folder trong Media Pool
                                print("[AutoSubs Server] Creating Template Set...")
                                local result = CreateTemplateSet(data.templateNames)
                                body = safe_json(result)
                            elseif data.func == "Exit" then
                                body = safe_json({ message = "Server shutting down" })
                                quitServer = true
                            elseif data.func == "Ping" then
                                body = safe_json({ message = "Pong" })
                            else
                                print("Invalid function name")
                            end
                        else
                            -- Fallback: if JSON parse failed, detect Exit command by substring
                            -- Check both the parsed body `content` and the raw request `str`
                            local has_exit = false
                            if content and string.find(content, '"func"%s*:%s*"Exit"') then
                                has_exit = true
                            elseif str and string.find(str, '"func"%s*:%s*"Exit"') then
                                has_exit = true
                            end
                            if has_exit then
                                body = safe_json({ message = "Server shutting down" })
                                quitServer = true
                            else
                                body = safe_json({ message = "Invalid JSON data" })
                                print("Invalid JSON data")
                            end
                        end
                    end)

                    -- Ensure we always return a body to avoid response builder crashes
                    if body == nil then
                        body = safe_json({ message = "OK" })
                    end

                    if not success then
                        body = safe_json({
                            message = "Job failed with error: " .. tostring(err)
                        })
                        print("Error:", err)
                    end

                    -- Send HTTP response content (don't assert to avoid crashing on client disconnect)
                    local response = CreateResponse(body)
                    if DEV_MODE then print(response) end
                    local sent, sendErr = client:send(response)
                    if not sent then
                        print("Send failed:", sendErr or "unknown")
                    end

                    -- Close connection
                    client:close()
                elseif err == "closed" then
                    client:close()
                elseif err ~= "timeout" then
                    -- Don't crash the server on unexpected client receive errors
                    print("Socket recv error:", err or "unknown")
                    client:close()
                end
            end
        elseif err ~= "timeout" then
            -- Don't crash the server on unexpected accept errors
            print("Accept error:", err or "unknown")
        end
        sleep(0.1)
    end

    print("Shutting down AutoSubs Link server...")
    server:close()
    print("Server shut down.")
end

local AutoSubs = {
    Init = function(self, executable_path, resources_folder, dev_mode, resolve_obj)
        DEV_MODE = dev_mode

        -- Nhận resolve object từ entry script
        -- (Resolve() chỉ khả dụng ở script chính, không có trong module require)
        resolve = resolve_obj or (Resolve and Resolve()) or nil
        if not resolve then
            print("[AutoSubs] ERROR: No Resolve object available!")
            return
        end

        -- Khởi tạo Resolve objects
        projectManager = resolve:GetProjectManager()
        project = projectManager:GetCurrentProject()
        mediaPool = project:GetMediaPool()
        print("[AutoSubs] Connected to Resolve project: " .. (project:GetName() or "unknown"))

        if ffi.os == "Windows" then
            -- Define Windows API functions using FFI to prevent terminal opening
            ffi.cdef [[
                void Sleep(unsigned int ms);
                int ShellExecuteA(void* hwnd, const char* lpOperation, const char* lpFile, const char* lpParameters, const char* lpDirectory, int nShowCmd);
            ]]

            main_app = executable_path
            resources_path = resources_folder
            command_open = 'start "" "' .. main_app .. '"'
        else
            ffi.cdef [[
                int system(const char *command);
                struct timespec { long tv_sec; long tv_nsec; };
                int nanosleep(const struct timespec *req, struct timespec *rem);
            ]]

            if ffi.os == "OSX" then
                main_app = executable_path
                resources_path = resources_folder
                command_open = 'open ' .. main_app
            else -- Linux
                main_app = executable_path
                resources_path = resources_folder
                command_open = string.format("'%s' &", main_app)
            end
        end

        -- PREPEND path (đặt trước để tìm file mới trước file cũ)
        local modules_path = join_path(resources_folder, "modules")
        package.path = join_path(modules_path, "?.lua") .. ";" .. package.path

        -- Clear cached modules (đảm bảo load đúng phiên bản từ source mới)
        package.loaded["ljsocket"] = nil
        package.loaded["dkjson"] = nil
        package.loaded["libavutil"] = nil

        socket = require("ljsocket")
        json = require("dkjson")
        luaresolve = require("libavutil")

        assets_path = join_path(resources_path, "AutoSubs")
        StartServer()
    end
}

return AutoSubs
