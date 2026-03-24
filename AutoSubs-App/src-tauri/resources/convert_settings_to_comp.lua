-- ============================================================
-- SCRIPT CHẠY 1 LẦN TRONG DAVINCI FUSION CONSOLE
-- Mục đích: Convert file .setting (MacroOperator) → .comp (Fusion Composition)
-- bằng cách: Insert template từ Effects Library → Export comp → Xóa clip
-- ============================================================
-- Cách dùng: Copy toàn bộ script này, paste vào DaVinci Fusion Console, Enter
-- ============================================================

print("═══════════════════════════════════════════════")
print("🔄 BẮT ĐẦU CONVERT .setting → .comp")
print("═══════════════════════════════════════════════")

local resolve = resolve or Resolve()
if not resolve then
    print("❌ Không tìm thấy Resolve object!")
    return
end

local project = resolve:GetProjectManager():GetCurrentProject()
if not project then
    print("❌ Không có project nào đang mở!")
    return
end

local timeline = project:GetCurrentTimeline()
if not timeline then
    print("❌ Không có timeline nào đang mở!")
    return
end

-- Thư mục output cho .comp files
local OUTPUT_DIR = "/Users/may1/Documents/src_code/autosubs_documentary/AutoSubs-App/src-tauri/resources/Titles"

-- Danh sách template cần convert
local TITLES = { "Title 1", "Title 2", "Title 3", "Title 4", "Title 5", "Title 6", "Title 7", "Title 8" }

local successCount = 0
local failCount = 0

for _, titleName in ipairs(TITLES) do
    print("")
    print("───────────────────────────────────────")
    print("📋 Processing: " .. titleName)
    
    -- Bước 1: Insert template từ Effects Library vào timeline
    local item = timeline:InsertFusionTitleIntoTimeline(titleName)
    
    if item then
        -- Bước 2: Kiểm tra comp
        local compCount = item:GetFusionCompCount()
        print("  ✅ Insert thành công! Comp count: " .. tostring(compCount))
        
        if compCount > 0 then
            -- Log comp info
            local comp = item:GetFusionCompByIndex(1)
            if comp then
                local tools = comp:GetToolList(false) or {}
                local toolCount = 0
                for _ in pairs(tools) do toolCount = toolCount + 1 end
                print("  📊 Tools trong comp: " .. toolCount)
                
                -- Log tên từng tool
                for _, tool in pairs(tools) do
                    local attrs = tool:GetAttrs() or {}
                    print("    → " .. tostring(attrs.TOOLS_Name) .. " [" .. tostring(attrs.TOOLS_RegID) .. "]")
                end
            end
            
            -- Bước 3: Export comp ra file .comp
            local outPath = OUTPUT_DIR .. "/" .. titleName .. ".comp"
            local exportOk = item:ExportFusionComp(outPath, 1)
            
            if exportOk then
                print("  ✅ Exported: " .. outPath)
                successCount = successCount + 1
                
                -- Verify file tồn tại
                local f = io.open(outPath, "r")
                if f then
                    local content = f:read("*a")
                    f:close()
                    print("  📏 File size: " .. #content .. " bytes")
                    print("  📄 Header: " .. string.sub(content, 1, 100))
                else
                    print("  ⚠ File exported nhưng không đọc được!")
                end
            else
                print("  ❌ Export FAILED!")
                failCount = failCount + 1
            end
        else
            print("  ⚠ Không có Fusion comp sau insert!")
            failCount = failCount + 1
        end
        
        -- Bước 4: Xóa clip vừa insert (không cần giữ trên timeline)
        -- Lưu ý: DeleteClips có thể không khả dụng trên mọi version
        local deleteOk = pcall(function()
            timeline:DeleteClips({item})
        end)
        if deleteOk then
            print("  🗑 Đã xóa clip khỏi timeline")
        else
            print("  ⚠ Không xóa được clip — hãy xóa thủ công trên timeline")
        end
    else
        print("  ❌ InsertFusionTitleIntoTimeline FAILED!")
        print("  💡 Kiểm tra: template '" .. titleName .. "' có nằm trong Effects Library không?")
        print("  💡 Path: ~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Templates/Edit/Titles/AutoSubs/")
        failCount = failCount + 1
    end
end

print("")
print("═══════════════════════════════════════════════")
print("🏁 KẾT QUẢ: " .. successCount .. " thành công, " .. failCount .. " thất bại")
print("═══════════════════════════════════════════════")

if successCount > 0 then
    print("")
    print("📁 Files .comp đã tạo tại: " .. OUTPUT_DIR)
    print("👉 Bây giờ reload Lua script AutoSubs để dùng .comp thay vì .setting")
end
