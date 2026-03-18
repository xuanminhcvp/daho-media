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
function M.ImportTitleFromFile(state, helpers, templateName)
    local filePath = TITLES_FOLDER_PATH .. "/" .. templateName .. ".setting"
    print("[AutoSubs] Trying to import title from: " .. filePath)

    local f = io.open(filePath, "r")
    if not f then
        print("[AutoSubs] ⚠ File not found: " .. filePath)
        return nil
    end
    f:close()

    -- Xóa clip cũ cùng tên (cache DaVinci)
    local rootFolder = state.mediaPool:GetRootFolder()
    local oldClips = {}
    helpers.walk_media_pool(rootFolder, function(clip)
        local props = clip:GetClipProperty()
        if props["Clip Name"] == templateName then
            table.insert(oldClips, clip)
        end
    end)
    if #oldClips > 0 then
        print("[AutoSubs] 🗑 Deleting " .. #oldClips .. " old cached clip(s)...")
        state.mediaPool:DeleteClips(oldClips)
    end

    -- Import fresh
    state.mediaPool:SetCurrentFolder(rootFolder)
    local imported = state.mediaPool:ImportMedia({ filePath })
    if not imported or #imported == 0 then
        print("[AutoSubs] ❌ ImportMedia failed for: " .. filePath)
        return nil
    end

    local item = imported[1]
    print("[AutoSubs] ✅ Imported FRESH title: '" .. (item:GetClipProperty()["Clip Name"] or "?") .. "'")
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

return M
