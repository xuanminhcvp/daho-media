-- ============================================================
-- helpers.lua — Hàm tiện ích dùng chung cho tất cả module
-- Bao gồm: join_path, read_json, sleep, hexToRgb, to_frames,
--           isMatchingTitle, walk_media_pool, safe_json
-- ============================================================

local ffi = ffi

local M = {}

-- ===== JOIN PATH =====
-- Nối thư mục + tên file, tự thêm separator phù hợp OS
function M.join_path(dir, filename)
    local sep = package.config:sub(1, 1) -- '\\' trên Windows, '/' elsewhere
    if dir:sub(-1) == sep then
        return dir .. filename
    else
        return dir .. sep .. filename
    end
end

-- ===== READ JSON FILE =====
-- Đọc file JSON từ ổ cứng, trả về Lua table
-- Cần truyền json module (dkjson) vào
function M.read_json_file(file_path, json)
    local file = assert(io.open(file_path, "r"))
    local content = file:read("*a")
    file:close()

    local data, pos, err = json.decode(content, 1, nil)
    if err then
        print("Error:", err)
        return nil
    end
    return data
end

-- ===== HEX TO RGB =====
-- Chuyển hex color (#FF00AA) sang {r, g, b} chuẩn DaVinci (0-1)
function M.hexToRgb(hex)
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

-- ===== TO FRAMES =====
-- Chuyển giây → số frame theo frame rate
function M.to_frames(seconds, frameRate)
    return seconds * frameRate
end

-- ===== SLEEP =====
-- Tạm dừng n giây (cross-platform: Windows dùng Sleep, Mac/Linux dùng nanosleep)
function M.sleep(n)
    if ffi.os == "Windows" then
        ffi.C.Sleep(n * 1000)
    else
        local ts = ffi.new("struct timespec")
        ts.tv_sec = math.floor(n)
        ts.tv_nsec = (n - math.floor(n)) * 1e9
        ffi.C.nanosleep(ts, nil)
    end
end

-- ===== TITLE STRINGS =====
-- Danh sách đa ngôn ngữ cho "Fusion Title" type trong Media Pool
local titleStrings = {
    "Título – Fusion",          -- Spanish
    "Título Fusion",            -- Portuguese
    "Generator",                -- English (cũ)
    "Fusion Title",             -- English
    "Titre Fusion",             -- French
    "Титры на стр. Fusion",     -- Russian
    "Fusion Titel",             -- German
    "Titolo Fusion",            -- Italian
    "Fusionタイトル",              -- Japanese
    "Fusion标题",                -- Chinese
    "퓨전 타이틀",                 -- Korean
    "Tiêu đề Fusion",          -- Vietnamese
    "Fusion Titles"             -- Thai
}

-- Build lookup set O(1)
local titleSet = {}
for _, t in ipairs(titleStrings) do
    titleSet[t] = true
end

-- ===== IS MATCHING TITLE =====
-- Kiểm tra type string có phải Fusion Title không (đa ngôn ngữ)
function M.isMatchingTitle(title)
    return titleSet[title] == true
end

-- ===== WALK MEDIA POOL =====
-- Duyệt đệ quy tất cả clip trong Media Pool
-- onClip(clip) trả true để dừng sớm
function M.walk_media_pool(folder, onClip)
    for _, subfolder in ipairs(folder:GetSubFolderList()) do
        local stop = M.walk_media_pool(subfolder, onClip)
        if stop then return true end
    end
    for _, clip in ipairs(folder:GetClipList()) do
        local stop = onClip(clip)
        if stop then return true end
    end
end

-- ===== SAFE JSON =====
-- Encode JSON an toàn, fallback nếu module json chưa load
function M.safe_json(obj, json)
    if json and json.encode then
        return json.encode(obj)
    end
    if obj and obj.message ~= nil then
        local msg = tostring(obj.message):gsub('"', '\\"')
        return '{"message":"' .. msg .. '"}'
    end
    return "{}"
end

-- ===== CREATE HTTP RESPONSE =====
-- Tạo HTTP response string chuẩn cho server
function M.CreateResponse(body)
    local header = "HTTP/1.1 200 OK\r\n"
        .. "Server: ljsocket/0.1\r\n"
        .. "Content-Type: application/json\r\n"
        .. "Content-Length: " .. #body .. "\r\n"
        .. "Connection: close\r\n"
        .. "\r\n"
    return header .. body
end

return M
