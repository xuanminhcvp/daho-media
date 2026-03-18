-- ============================================================
-- AutoSubs.lua — Entry script cho DaVinci Resolve
-- Đặt vào: ~/Library/Application Support/.../Fusion/Scripts/Utility/
-- Click từ: Workspace > Scripts > AutoSubs
--
-- Nhiệm vụ duy nhất: Lấy resolve object → gọi init.lua
-- ============================================================

local DEV_MODE = false

-- ===== FILE LOGGER =====
local LOG_PATH = os.getenv("HOME") .. "/Desktop/autosubs_resolve.log"

local function log(...)
    local parts = {}
    for i = 1, select("#", ...) do
        parts[#parts + 1] = tostring(select(i, ...))
    end
    local line = os.date("[%Y-%m-%d %H:%M:%S] ") .. table.concat(parts, " ")
    local f = io.open(LOG_PATH, "a")
    if f then f:write(line, "\n"); f:close() end
    print(line)
end

-- ===== MAIN =====
local function main()
    log("========== AutoSubs START ==========")

    -- Bước 1: Load FFI
    local ffi = ffi
    if not ffi then
        local ok_ffi, ffi_mod = pcall(require, "ffi")
        if ok_ffi and ffi_mod then
            ffi = ffi_mod
        else
            log("[FATAL] Cannot load ffi!")
            error("Cannot load ffi")
        end
    end
    log("[Step 1] OS:", ffi.os)

    -- Bước 2: Xác định paths
    local resources_folder = nil
    local app_executable = nil

    local function join_path(dir, filename)
        local sep = package.config:sub(1, 1)
        if dir:sub(-1) == sep then return dir .. filename
        else return dir .. sep .. filename end
    end

    if ffi.os == "Windows" then
        -- Windows path setup
        ffi.cdef [[
            typedef wchar_t WCHAR;
            int MultiByteToWideChar(unsigned int CodePage, unsigned long dwFlags,
                const char* lpMultiByteStr, int cbMultiByte, WCHAR* lpWideCharStr, int cchWideChar);
            void* _wfopen(const WCHAR* filename, const WCHAR* mode);
            size_t fread(void* buffer, size_t size, size_t count, void* stream);
            int fclose(void* stream);
        ]]
        local storage_path = os.getenv("APPDATA")
            .. "\\Blackmagic Design\\DaVinci Resolve\\Support\\Fusion\\Scripts\\Utility\\AutoSubs"
        local function to_wide_string(str)
            local len = #str + 1
            local buffer = ffi.new("WCHAR[?]", len)
            ffi.C.MultiByteToWideChar(65001, 0, str, -1, buffer, len)
            return buffer
        end
        local function read_file(file_path)
            local wide_path = to_wide_string(file_path)
            local mode = to_wide_string("rb")
            local f = ffi.C._wfopen(wide_path, mode)
            if f == nil then error("Failed to open: " .. file_path) end
            local buf = {}
            local tmp = ffi.new("char[4096]")
            while true do
                local n = ffi.C.fread(tmp, 1, 4096, f)
                if n == 0 then break end
                buf[#buf + 1] = ffi.string(tmp, n)
            end
            ffi.C.fclose(f)
            return table.concat(buf)
        end
        local install_path = assert(read_file(join_path(storage_path, "install_path.txt")))
        app_executable = install_path .. "\\AutoSubs.exe"
        resources_folder = install_path .. "\\resources"
    elseif ffi.os == "OSX" then
        app_executable = "/Applications/AutoSubs_Media.app"
        resources_folder = app_executable .. "/Contents/Resources/resources"
    else
        app_executable = "/usr/bin/autosubs"
        resources_folder = "/usr/lib/autosubs/resources"
    end

    -- DEV_MODE override
    if DEV_MODE then
        resources_folder = os.getenv("HOME")
            .. "/Desktop/auto/auto-subs-main/AutoSubs-App/src-tauri/resources"
    end
    log("[Step 2] resources_folder:", resources_folder)

    -- Bước 3: Set package path
    local modules_path = join_path(resources_folder, "modules")
    package.path = join_path(modules_path, "?.lua") .. ";" .. package.path
    log("[Step 3] modules_path:", modules_path)

    -- Clear cached modules (đảm bảo luôn load phiên bản mới nhất)
    package.loaded["helpers"] = nil
    package.loaded["init"] = nil
    package.loaded["timeline_info"] = nil
    package.loaded["template_manager"] = nil
    package.loaded["audio_export"] = nil
    package.loaded["subtitle_renderer"] = nil
    package.loaded["media_import"] = nil
    package.loaded["preview_generator"] = nil
    package.loaded["motion_effects"] = nil
    package.loaded["server"] = nil
    package.loaded["ljsocket"] = nil
    package.loaded["dkjson"] = nil
    package.loaded["libavutil"] = nil
    log("[Step 3] Cleared module cache")

    -- Bước 4: Lấy Resolve object
    log("[Step 4] Getting resolve object...")
    local resolve_obj = nil

    -- Cách 1: Resolve() function (Lua bản Free inject sẵn)
    if Resolve then
        local ok, r = pcall(Resolve)
        if ok and r then
            resolve_obj = r
            log("[Step 4] ✅ Got resolve via Resolve()")
        end
    end

    -- Cách 2: global resolve
    if not resolve_obj and resolve then
        resolve_obj = resolve
        log("[Step 4] ✅ Got resolve via global 'resolve'")
    end

    -- Cách 3: fusion:GetResolve()
    if not resolve_obj and fusion then
        local ok, r = pcall(function() return fusion:GetResolve() end)
        if ok and r then resolve_obj = r; log("[Step 4] ✅ Got via fusion:GetResolve()") end
    end

    -- Cách 4: fu:GetResolve()
    if not resolve_obj and fu then
        local ok, r = pcall(function() return fu:GetResolve() end)
        if ok and r then resolve_obj = r; log("[Step 4] ✅ Got via fu:GetResolve()") end
    end

    -- Cách 5: bmd.scriptapp("Resolve")
    if not resolve_obj and bmd and bmd.scriptapp then
        local ok, r = pcall(bmd.scriptapp, "Resolve")
        if ok and r then resolve_obj = r; log("[Step 4] ✅ Got via bmd.scriptapp") end
    end

    if not resolve_obj then
        log("[Step 4] FATAL: Cannot obtain Resolve object!")
        error("Cannot obtain Resolve object")
    end
    log("[Step 4] Resolve object:", tostring(resolve_obj))

    -- Truyền globals
    _G._autosubs_resolve = resolve_obj
    _G.resolve = resolve_obj

    -- Bước 5: Load init module
    log("[Step 5] Loading init module...")
    local AutoSubs = require("init")
    log("[Step 5] Init loaded OK")

    -- Bước 6: Start
    log("[Step 6] Starting AutoSubs...")
    AutoSubs:Init(app_executable, resources_folder, DEV_MODE, resolve_obj)
    log("========== AutoSubs READY ==========")
end

-- ===== XPCALL: Bắt mọi lỗi =====
log("========== AutoSubs LOADING ==========")
local ok, err = xpcall(main, debug.traceback)
if not ok then
    log("[FATAL ERROR]", tostring(err))
    log("========== AutoSubs CRASHED ==========")
end
