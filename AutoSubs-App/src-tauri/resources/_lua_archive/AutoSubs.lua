-- ============================================================
-- AutoSubsMedia.lua — Entry script cho DaVinci Resolve
-- Có xpcall + file logger để debug lỗi ngay cả khi Console không hiện
-- ============================================================

local DEV_MODE = true

-- ============================================================
-- FILE LOGGER: Ghi log ra Desktop để debug (không phụ thuộc print)
-- ============================================================
local LOG_PATH = os.getenv("HOME") .. "/Desktop/autosubs_resolve.log"

local function log(...)
    local parts = {}
    for i = 1, select("#", ...) do
        parts[#parts + 1] = tostring(select(i, ...))
    end
    local line = os.date("[%Y-%m-%d %H:%M:%S] ") .. table.concat(parts, " ")
    -- Ghi ra file
    local f = io.open(LOG_PATH, "a")
    if f then
        f:write(line, "\n")
        f:close()
    end
    -- Cũng print ra Console (nếu có)
    print(line)
end

-- ============================================================
-- MAIN: Toàn bộ logic được bọc trong xpcall để bắt mọi lỗi
-- ============================================================
local function main()
    log("========== AutoSubsMedia START ==========")

    -- Bước 1: Load FFI (sửa lỗi: dùng pcall require thay vì global)
    log("[Step 1] Loading ffi...")
    local ffi = ffi  -- thử global trước (DaVinci có thể inject sẵn)
    if not ffi then
        log("[Step 1] Global ffi = nil, trying require('ffi')...")
        local ok_ffi, ffi_mod = pcall(require, "ffi")
        if ok_ffi and ffi_mod then
            ffi = ffi_mod
            log("[Step 1] require('ffi') OK")
        else
            log("[Step 1] FATAL: Cannot load ffi! Error:", tostring(ffi_mod))
            error("Cannot load ffi")
        end
    else
        log("[Step 1] Global ffi found OK")
    end

    local os_name = ffi.os
    log("[Step 2] OS:", os_name)

    -- Bước 2: Helper functions
    local function join_path(dir, filename)
        local sep = package.config:sub(1, 1)
        if dir:sub(-1) == sep then
            return dir .. filename
        else
            return dir .. sep .. filename
        end
    end

    -- Bước 3: Xác định paths
    local resources_folder = nil
    local app_executable = nil

    if os_name == "Windows" then
        -- Windows: cần FFI wide string functions
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
    elseif os_name == "OSX" then
        app_executable = "/Applications/AutoSubs.app"
        resources_folder = app_executable .. "/Contents/Resources/resources"
    else
        app_executable = "/usr/bin/autosubs"
        resources_folder = "/usr/lib/autosubs/resources"
    end

    -- DEV_MODE: override path
    if DEV_MODE then
        resources_folder = os.getenv("HOME")
            .. "/Desktop/auto/auto-subs-main/AutoSubs-App/src-tauri/resources"
    end
    log("[Step 3] resources_folder:", resources_folder)
    log("[Step 3] app_executable:", app_executable)

    -- Bước 4: Set package path
    local modules_path = join_path(resources_folder, "modules")
    package.path = package.path .. ";" .. join_path(modules_path, "?.lua")
    log("[Step 4] modules_path:", modules_path)

    -- Clear cached modules
    package.loaded["autosubs_core"] = nil
    package.loaded["ljsocket"] = nil
    package.loaded["dkjson"] = nil
    package.loaded["libavutil"] = nil
    log("[Step 4] Cleared cached modules")

    -- Bước 5: Lấy Resolve object
    log("[Step 5] Checking available globals...")
    log("  Resolve =", tostring(Resolve))
    log("  resolve =", tostring(resolve))
    log("  app     =", tostring(app))
    log("  fusion  =", tostring(fusion))
    log("  fu      =", tostring(fu))
    log("  bmd     =", tostring(bmd))
    log("  comp    =", tostring(comp))

    local resolve_obj = nil

    -- Cách 1: Resolve() function
    if Resolve then
        local ok1, r1 = pcall(Resolve)
        if ok1 and r1 then
            resolve_obj = r1
            log("[Step 5] Got Resolve via Resolve():", tostring(resolve_obj))
        else
            log("[Step 5] Resolve() failed:", tostring(r1))
        end
    end

    -- Cách 2: global resolve
    if not resolve_obj and resolve then
        resolve_obj = resolve
        log("[Step 5] Got Resolve via global 'resolve':", tostring(resolve_obj))
    end

    -- Cách 3: fusion:GetResolve()
    if not resolve_obj and fusion then
        local ok3, r3 = pcall(function() return fusion:GetResolve() end)
        if ok3 and r3 then
            resolve_obj = r3
            log("[Step 5] Got Resolve via fusion:GetResolve():", tostring(resolve_obj))
        end
    end

    -- Cách 4: fu:GetResolve()
    if not resolve_obj and fu then
        local ok4, r4 = pcall(function() return fu:GetResolve() end)
        if ok4 and r4 then
            resolve_obj = r4
            log("[Step 5] Got Resolve via fu:GetResolve():", tostring(resolve_obj))
        end
    end

    -- Cách 5: bmd.scriptapp("Resolve")
    if not resolve_obj and bmd and bmd.scriptapp then
        local ok5, r5 = pcall(bmd.scriptapp, "Resolve")
        if ok5 and r5 then
            resolve_obj = r5
            log("[Step 5] Got Resolve via bmd.scriptapp:", tostring(resolve_obj))
        end
    end

    -- Cách 6: app
    if not resolve_obj and app then
        resolve_obj = app
        log("[Step 5] Got Resolve via global 'app':", tostring(resolve_obj))
    end

    if not resolve_obj then
        log("[Step 5] FATAL: Cannot obtain Resolve object!")
        error("Cannot obtain Resolve object")
    end
    log("[Step 5] Resolve object OK:", tostring(resolve_obj))

    -- Truyền globals
    _G._autosubs_resolve = resolve_obj
    _G.resolve = resolve_obj
    _G.fu = fu
    _G.fusion = fusion
    _G.app = app
    _G.bmd = bmd

    -- Bước 6: Load autosubs_core.lua
    local core_path = join_path(modules_path, "autosubs_core.lua")
    log("[Step 6] Loading core:", core_path)

    -- Kiểm tra file tồn tại
    local test_f = io.open(core_path, "r")
    if not test_f then
        log("[Step 6] FATAL: Core file not found:", core_path)
        error("Core file not found: " .. core_path)
    end
    test_f:close()
    log("[Step 6] Core file exists, dofile()...")

    local AutoSubs = dofile(core_path)
    if not AutoSubs then
        log("[Step 6] FATAL: dofile returned nil!")
        error("autosubs_core returned nil")
    end
    log("[Step 6] dofile OK, AutoSubs loaded")

    -- Bước 7: Init
    log("[Step 7] Calling AutoSubs:Init()...")
    AutoSubs:Init(app_executable, resources_folder, DEV_MODE, resolve_obj)
    log("[Step 7] Init done — server should be running!")

    log("========== AutoSubsMedia READY ==========")
end

-- ============================================================
-- XPCALL: Bọc toàn bộ để bắt mọi lỗi, ghi ra file log
-- ============================================================
log("========== AutoSubsMedia LOADING ==========")
local ok, err = xpcall(main, debug.traceback)
if not ok then
    log("[FATAL ERROR]", tostring(err))
    log("========== AutoSubsMedia CRASHED ==========")
end
