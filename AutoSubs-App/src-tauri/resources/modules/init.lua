-- ============================================================
-- init.lua — AutoSubs Init: require modules, setup state, start server
-- Đây là module trung tâm, được gọi từ AutoSubs.lua (entry script)
-- ============================================================

local ffi = ffi

-- ===== REQUIRE HELPERS TRƯỚC (không phụ thuộc gì) =====
local helpers = require("helpers")

-- ===== REQUIRE CÁC MODULE CHỨC NĂNG =====
local timeline_info     = require("timeline_info")
local template_manager  = require("template_manager")
local audio_export      = require("audio_export")
local subtitle_renderer = require("subtitle_renderer")
local media_import      = require("media_import")
local preview_generator = require("preview_generator")
local motion_effects    = require("motion_effects")
local server            = require("server")

-- ===== AUTOSUBS OBJECT =====
local AutoSubs = {
    -- Init: Khởi tạo toàn bộ hệ thống, gọi từ entry script
    Init = function(self, executable_path, resources_folder, dev_mode, resolve_obj)
        -- ===== SHARED STATE =====
        -- Tất cả module đọc/ghi thông qua table `state` này
        local state = {
            DEV_MODE = dev_mode,
            PORT = 56003,

            -- Resolve objects
            resolve = resolve_obj,
            projectManager = nil,
            project = nil,
            mediaPool = nil,

            -- OS paths
            main_app = executable_path,
            resources_path = resources_folder,
            command_open = nil,
            assets_path = nil,

            -- External libraries
            socket = nil,
            json = nil,
            luaresolve = nil,

            -- Export job state
            currentExportJob = {
                active = false, pid = nil, progress = 0,
                cancelled = false, startTime = nil,
                audioInfo = { path = "", markIn = 0, markOut = 0, offset = 0 },
                trackStates = nil
            }
        }

        -- ===== CHECK RESOLVE =====
        if not state.resolve then
            print("[AutoSubs] ERROR: No Resolve object available!")
            return
        end

        -- ===== INIT RESOLVE OBJECTS =====
        state.projectManager = state.resolve:GetProjectManager()
        state.project = state.projectManager:GetCurrentProject()
        state.mediaPool = state.project:GetMediaPool()
        print("[AutoSubs] Connected to Resolve project: " .. (state.project:GetName() or "unknown"))

        -- ===== OS-SPECIFIC FFI DEFS =====
        if ffi.os == "Windows" then
            ffi.cdef [[
                void Sleep(unsigned int ms);
                int ShellExecuteA(void* hwnd, const char* lpOperation, const char* lpFile,
                    const char* lpParameters, const char* lpDirectory, int nShowCmd);
            ]]
            state.command_open = 'start "" "' .. state.main_app .. '"'
        else
            ffi.cdef [[
                int system(const char *command);
                struct timespec { long tv_sec; long tv_nsec; };
                int nanosleep(const struct timespec *req, struct timespec *rem);
            ]]
            if ffi.os == "OSX" then
                state.command_open = 'open ' .. state.main_app
            else
                state.command_open = string.format("'%s' &", state.main_app)
            end
        end

        -- ===== LOAD EXTERNAL LIBRARIES =====
        local modules_path = helpers.join_path(resources_folder, "modules")
        -- PREPEND path (tìm file mới trước file cũ)
        package.path = helpers.join_path(modules_path, "?.lua") .. ";" .. package.path

        -- Clear cached modules (đảm bảo load phiên bản mới nhất)
        package.loaded["ljsocket"] = nil
        package.loaded["dkjson"] = nil
        package.loaded["libavutil"] = nil

        state.socket = require("ljsocket")
        state.json = require("dkjson")
        state.luaresolve = require("libavutil")

        state.assets_path = helpers.join_path(state.resources_path, "AutoSubs")

        -- ===== START HTTP SERVER =====
        server.StartServer(
            state, helpers,
            timeline_info, audio_export, subtitle_renderer,
            template_manager, media_import, preview_generator,
            motion_effects
        )
    end
}

return AutoSubs
