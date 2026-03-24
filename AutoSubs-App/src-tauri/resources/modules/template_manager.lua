-- ============================================================
-- template_manager.lua — Quản lý template Fusion Title trong Media Pool
-- GetTemplates, ImportTitleFromFile, GetTemplateItem,
-- GetTemplateItemByFolder, CreateTemplateSet
-- ============================================================

local M = {}

-- ===== PATH: Folder chứa .setting templates trên macOS =====
local TITLES_FOLDER_PATH = os.getenv("HOME")
    .. "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Templates/Edit/Titles/AutoSubs"

-- ===== GET TEMPLATES =====
-- Lấy danh sách tất cả Text+ template trong Media Pool
function M.GetTemplates(state, helpers)
    local rootFolder = state.mediaPool:GetRootFolder()
    local t = {}
    local hasDefault = false

    helpers.walk_media_pool(rootFolder, function(clip)
        local props = clip:GetClipProperty()
        local clipType = props["Type"]
        if helpers.isMatchingTitle(clipType) then
            local clipName = props["Clip Name"]
            table.insert(t, { label = clipName, value = clipName })
            if clipName == "Default Template" then
                hasDefault = true
            end
        end
    end)

    -- Import Default Template nếu chưa có
    if not hasDefault and tonumber(state.resolve:GetVersion()[1]) >= 19 then
        print("Default template not found. Importing default template...")
        local ok = pcall(function()
            state.mediaPool:ImportFolderFromFile(helpers.join_path(state.assets_path, "subtitle-template.drb"))
            table.insert(t, { label = "Default Template", value = "Default Template" })
        end)
    end

    return t
end

-- ===== IMPORT TITLE FROM FILE =====
-- Import .setting file từ hệ thống vào Media Pool (xóa cache cũ trước)
-- ⭐ Debug chi tiết để bắt lỗi import
function M.ImportTitleFromFile(state, helpers, templateName)
    local filePath = TITLES_FOLDER_PATH .. "/" .. templateName .. ".setting"
    print("[AutoSubs] ═══════════════════════════════════════")
    print("[AutoSubs] 📁 ImportTitleFromFile: '" .. templateName .. "'")
    print("[AutoSubs]   Path: " .. filePath)

    -- ① Kiểm tra file tồn tại + đọc size + header
    local f = io.open(filePath, "r")
    if not f then
        print("[AutoSubs]   ❌ FILE NOT FOUND — io.open() trả về nil")
        print("[AutoSubs]   💡 Kiểm tra: ls \"" .. TITLES_FOLDER_PATH .. "/\"")
        return nil
    end

    -- Đọc file size
    local content = f:read("*a")
    f:close()
    local fileSize = #content
    print("[AutoSubs]   📏 File size: " .. fileSize .. " bytes")

    if fileSize == 0 then
        print("[AutoSubs]   ❌ FILE RỖNG (0 bytes) — file bị corrupt!")
        return nil
    end

    -- Log header (100 ký tự đầu) để kiểm tra format
    local header = content:sub(1, 100):gsub("\n", "\\n"):gsub("\r", "\\r")
    print("[AutoSubs]   📄 Header(100): " .. header)

    -- Kiểm tra format .setting hợp lệ (phải chứa "Composition" hoặc "MediaIn")
    if not content:find("Composition") and not content:find("MediaIn") and not content:find("TextPlus") then
        print("[AutoSubs]   ⚠️ File KHÔNG chứa 'Composition'/'MediaIn'/'TextPlus' — có thể sai format!")
    else
        print("[AutoSubs]   ✅ Format check OK — tìm thấy keyword Fusion hợp lệ")
    end

    -- ② Log trạng thái DaVinci
    local drVersion = state.resolve:GetVersion()
    if drVersion then
        print("[AutoSubs]   🎬 DaVinci version: " .. tostring(drVersion[1]) .. "." .. tostring(drVersion[2]) .. "." .. tostring(drVersion[3]))
    end

    -- ③ Xóa clip cũ cùng tên (cache DaVinci)
    local rootFolder = state.mediaPool:GetRootFolder()
    local oldClips = {}
    helpers.walk_media_pool(rootFolder, function(clip)
        local props = clip:GetClipProperty()
        if props["Clip Name"] == templateName then
            table.insert(oldClips, clip)
        end
    end)
    if #oldClips > 0 then
        print("[AutoSubs]   🗑 Xóa " .. #oldClips .. " clip cũ trùng tên '" .. templateName .. "'...")
        local delOK = state.mediaPool:DeleteClips(oldClips)
        print("[AutoSubs]   🗑 DeleteClips result: " .. tostring(delOK))
    else
        print("[AutoSubs]   (Không có clip cũ trùng tên)")
    end

    -- ④ Set current folder = root trước khi import
    local setFolderOK = state.mediaPool:SetCurrentFolder(rootFolder)
    print("[AutoSubs]   📂 SetCurrentFolder(root): " .. tostring(setFolderOK))
    print("[AutoSubs]   📂 Current folder: " .. tostring(rootFolder:GetName()))

    -- ⑤ Import .setting file
    print("[AutoSubs]   🔄 Gọi mediaPool:ImportMedia({'" .. filePath .. "'})...")
    local importOK, imported = pcall(function()
        return state.mediaPool:ImportMedia({ filePath })
    end)

    -- Log kết quả chi tiết
    if not importOK then
        print("[AutoSubs]   ❌ ImportMedia EXCEPTION: " .. tostring(imported))
        return nil
    end

    if imported == nil then
        print("[AutoSubs]   ❌ ImportMedia trả về nil (không rõ lý do)")
        print("[AutoSubs]   💡 Có thể: file format không compatible với DaVinci version này")
        print("[AutoSubs]   💡 Thử: mở file bằng Fusion → File → Save As → lưu lại")
        return nil
    end

    if type(imported) ~= "table" then
        print("[AutoSubs]   ❌ ImportMedia trả về type='" .. type(imported) .. "' thay vì table")
        print("[AutoSubs]   Giá trị: " .. tostring(imported))
        return nil
    end

    if #imported == 0 then
        print("[AutoSubs]   ❌ ImportMedia trả về table RỖNG (#imported == 0)")
        print("[AutoSubs]   💡 DaVinci nhận file nhưng từ chối import — có thể:")
        print("[AutoSubs]   💡   1. File .setting tạo từ DaVinci version khác (incompatible)")
        print("[AutoSubs]   💡   2. File bị corrupt hoặc thiếu node Composition")
        print("[AutoSubs]   💡   3. MediaPool đang bị lock bởi process khác")
        return nil
    end

    -- ⑥ Thành công! Log clip properties
    local item = imported[1]
    local props = item:GetClipProperty()
    print("[AutoSubs]   ✅ IMPORT THÀNH CÔNG!")
    print("[AutoSubs]   ✅ Clip Name: " .. tostring(props["Clip Name"]))
    print("[AutoSubs]   ✅ Type: " .. tostring(props["Type"]))
    print("[AutoSubs]   ✅ FPS: " .. tostring(props["FPS"]))
    print("[AutoSubs] ═══════════════════════════════════════")
    return item
end

-- ===== GET TEMPLATE ITEM =====
-- Tìm template theo tên clip trong Media Pool (đệ quy)
function M.GetTemplateItem(helpers, folder, templateName)
    local found = nil
    helpers.walk_media_pool(folder, function(clip)
        local props = clip:GetClipProperty()
        if props["Clip Name"] == templateName then
            found = clip
            return true
        end
    end)
    return found
end

-- ===== GET TEMPLATE ITEM BY FOLDER =====
-- Tìm template bằng tên folder → lấy Fusion Title đầu tiên bên trong
function M.GetTemplateItemByFolder(helpers, rootFolder, templateName)
    -- Thử clip name trước
    local found = M.GetTemplateItem(helpers, rootFolder, templateName)
    if found then return found end

    -- Tìm folder tên trùng
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
        return nil
    end

    -- Scan folder cho Fusion Title
    local firstFusionTitle = nil
    local firstAnyClip = nil
    helpers.walk_media_pool(targetFolder, function(clip)
        local props = clip:GetClipProperty()
        local clipType = props["Type"] or "?"
        if helpers.isMatchingTitle(clipType) and not firstFusionTitle then
            firstFusionTitle = clip
        end
        if not firstAnyClip then
            firstAnyClip = clip
        end
    end)

    return firstFusionTitle or firstAnyClip
end

-- ===== CREATE TEMPLATE SET =====
-- Tạo nhiều template folder (mỗi cái chứa 1 copy Default Template)
function M.CreateTemplateSet(state, helpers, templateNames)
    print("[AutoSubs] Creating template set...")
    local rootFolder = state.mediaPool:GetRootFolder()
    local currentFolder = state.mediaPool:GetCurrentFolder()

    -- Đảm bảo Default Template tồn tại
    local defaultTpl = M.GetTemplateItem(helpers, rootFolder, "Default Template")
    if not defaultTpl then
        pcall(function()
            state.mediaPool:SetCurrentFolder(rootFolder)
            state.mediaPool:ImportFolderFromFile(helpers.join_path(state.assets_path, "subtitle-template.drb"))
        end)
        defaultTpl = M.GetTemplateItem(helpers, rootFolder, "Default Template")
    end

    if not defaultTpl then
        return { error = true, message = "Cannot find or import Default Template" }
    end

    local results = {}
    local drbPath = helpers.join_path(state.assets_path, "subtitle-template.drb")

    for _, name in ipairs(templateNames) do
        local existing = M.GetTemplateItemByFolder(helpers, rootFolder, name)
        if existing then
            table.insert(results, { name = name, status = "exists" })
        else
            local subfolder = state.mediaPool:AddSubFolder(rootFolder, name)
            if subfolder then
                state.mediaPool:SetCurrentFolder(subfolder)
                local ok = pcall(function()
                    state.mediaPool:ImportFolderFromFile(drbPath)
                end)
                if ok then
                    table.insert(results, { name = name, status = "created" })
                else
                    table.insert(results, { name = name, status = "error", message = "Import failed" })
                end
            else
                table.insert(results, { name = name, status = "error", message = "Folder creation failed" })
            end
        end
    end

    if currentFolder then state.mediaPool:SetCurrentFolder(currentFolder) end
    return { success = true, results = results }
end

-- ===== APPLY CUSTOM TEMPLATE TO TIMELINE ITEM =====
-- Strategy (theo ChatGPT analysis):
--   ImportFusionComp() CHỈ hỗ trợ file .comp (Fusion Composition)
--   KHÔNG hỗ trợ file .setting (MacroOperator template)
--
-- Flow:
--   1. Tìm file .comp trước (đã convert từ .setting bằng convert_settings_to_comp.lua)
--   2. Nếu có .comp → dùng ImportFusionComp() (đường chính, đúng format)
--   3. Nếu không có .comp → báo fail, dùng programmatic style ở caller
--
-- Return: true nếu apply thành công, false nếu fail
function M.ApplySettingToTimelineItem(state, timelineItem, templateName)
    print("[AutoSubs] 🎨 ApplySettingToTimelineItem: '" .. templateName .. "'")

    -- ═══ TÌM FILE .comp (ưu tiên — format đúng cho ImportFusionComp) ═══
    local compPath = TITLES_FOLDER_PATH .. "/" .. templateName .. ".comp"
    local settingPath = TITLES_FOLDER_PATH .. "/" .. templateName .. ".setting"

    -- Kiểm tra .comp trước
    local compFile = io.open(compPath, "r")
    if compFile then
        local compContent = compFile:read("*a")
        compFile:close()
        print("[AutoSubs]   📄 Tìm thấy file .comp: " .. #compContent .. " bytes")

        -- Debug: comp count TRƯỚC import
        local countBefore = timelineItem:GetFusionCompCount()
        print("[AutoSubs]   📊 Comp count TRƯỚC import: " .. tostring(countBefore))

        -- Dùng ImportFusionComp với file .comp (format đúng)
        print("[AutoSubs]   🔧 ImportFusionComp (.comp)...")
        local ok, err = pcall(function()
            local result = timelineItem:ImportFusionComp(compPath)
            print("[AutoSubs]   📋 Return type: " .. type(result) .. " = " .. tostring(result))
            if result then
                return true
            end
            return false
        end)

        -- Debug: comp count SAU import
        local countAfter = timelineItem:GetFusionCompCount()
        print("[AutoSubs]   📊 Comp count SAU import: " .. tostring(countAfter))

        if ok and err then
            if countAfter > countBefore then
                print("[AutoSubs]   ✅ Comp count TĂNG " .. countBefore .. " → " .. countAfter .. " (THÀNH CÔNG!)")
            else
                print("[AutoSubs]   ⚠ Comp count KHÔNG TĂNG — có thể .comp cũng không đúng format")
            end

            -- Debug: dump tool list của comp cuối cùng
            local comp = timelineItem:GetFusionCompByIndex(countAfter)
            if comp then
                local tools = comp:GetToolList(false) or {}
                local toolCount = 0
                for _ in pairs(tools) do toolCount = toolCount + 1 end
                print("[AutoSubs]   🔧 Tools trong comp (index " .. countAfter .. "): " .. toolCount)
                for _, tool in pairs(tools) do
                    local attrs = tool:GetAttrs() or {}
                    print("[AutoSubs]     → " .. tostring(attrs.TOOLS_Name) .. " [" .. tostring(attrs.TOOLS_RegID) .. "]")
                end
            end

            return true
        else
            print("[AutoSubs]   ❌ ImportFusionComp(.comp) failed: " .. tostring(err))
        end
    else
        print("[AutoSubs]   ⚠ Không có file .comp: " .. compPath)
    end

    -- ═══ KHÔNG CÒN THỬ .setting NỮA ═══
    -- (ImportFusionComp KHÔNG hỗ trợ .setting MacroOperator format)
    -- Kiểm tra .setting tồn tại để thông báo cho user
    local settingFile = io.open(settingPath, "r")
    if settingFile then
        settingFile:close()
        print("[AutoSubs]   ⚠ File .setting TỒN TẠI nhưng ImportFusionComp không hỗ trợ MacroOperator format")
        print("[AutoSubs]   💡 Cần convert .setting → .comp bằng script: convert_settings_to_comp.lua")
        print("[AutoSubs]   💡 Chạy script trong DaVinci Fusion Console để tạo file .comp")
    else
        print("[AutoSubs]   ❌ Không có cả .comp lẫn .setting cho '" .. templateName .. "'")
    end

    print("[AutoSubs]   ❌ APPLY FAIL → sẽ dùng programmatic style")
    return false
end

-- ===== GET SETTING FILE PATH =====
-- Trả về path đầy đủ tới file .comp hoặc .setting nếu tồn tại
-- Ưu tiên .comp trước
function M.GetSettingFilePath(templateName)
    -- Thử .comp trước
    local compPath = TITLES_FOLDER_PATH .. "/" .. templateName .. ".comp"
    local f1 = io.open(compPath, "r")
    if f1 then
        f1:close()
        return compPath
    end
    -- Fallback .setting
    local settingPath = TITLES_FOLDER_PATH .. "/" .. templateName .. ".setting"
    local f2 = io.open(settingPath, "r")
    if f2 then
        f2:close()
        return settingPath
    end
    return nil
end

return M
