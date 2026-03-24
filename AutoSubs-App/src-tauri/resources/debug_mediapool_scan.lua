-- ============================================================
-- DEBUG: Scan toàn bộ Media Pool để tìm Adjustment Layer + SFX
-- User chạy trong DaVinci Fusion Console → paste log lại
-- ============================================================
print("═══════════════════════════════════════════════")
print("🔍 SCAN MEDIA POOL — tìm tất cả clips")
print("═══════════════════════════════════════════════")

local resolve = resolve or Resolve()
local project = resolve:GetProjectManager():GetCurrentProject()
local mediaPool = project:GetMediaPool()
local rootFolder = mediaPool:GetRootFolder()

-- Đệ quy duyệt toàn bộ folders + clips
local function scanFolder(folder, depth)
    local indent = string.rep("  ", depth)
    local folderName = folder:GetName() or "?"
    print(indent .. "📂 " .. folderName)

    -- Liệt kê clips trong folder
    local clips = folder:GetClipList() or {}
    for _, clip in pairs(clips) do
        local name = clip:GetName() or "?"
        local props = clip:GetClipProperty() or {}
        local clipType = props["Type"] or "?"
        local duration = props["Duration"] or "?"
        print(indent .. "  📎 " .. name .. " [" .. clipType .. "] dur=" .. tostring(duration))
    end

    -- Đệ quy vào sub-folders
    local subs = folder:GetSubFolderList() or {}
    for _, sub in pairs(subs) do
        scanFolder(sub, depth + 1)
    end
end

scanFolder(rootFolder, 0)

print("")
print("═══════════════════════════════════════════════")
print("✅ SCAN XONG — kiểm tra xem có thấy:")
print("  - Adjustment Layer (trong main folder)")
print("  - SFX (trong sfx folder)")
print("═══════════════════════════════════════════════")
