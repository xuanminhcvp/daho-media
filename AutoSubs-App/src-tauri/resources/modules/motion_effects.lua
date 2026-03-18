-- ============================================================
-- motion_effects.lua — Hiệu ứng chuyển động cho ảnh tĩnh
-- Ken Burns (slow zoom + pan), Camera Shake nhẹ
-- Áp dụng qua Fusion Transform node + keyframe animation
--
-- QUAN TRỌNG: Ảnh trên timeline ban đầu KHÔNG có Fusion comp
-- → Phải gọi clip:AddFusionComp() trước khi thêm hiệu ứng
-- ============================================================

local M = {}

-- ===== APPLY MOTION EFFECTS =====
-- Duyệt tất cả clips trên track chỉ định → thêm Fusion Transform keyframe
-- Hiệu ứng: Ken Burns (zoom chậm 1.0 → 1.05) + Shake nhẹ (xoay random)
--
-- @param state          - Resolve state (project, mediaPool...)
-- @param trackIndex     - Track cần áp dụng (mặc định V1)
-- @param effectType     - "kenburns" | "shake" | "both"
-- @param intensity      - "subtle" | "medium" | "strong" (mặc định "subtle")
-- @param fadeDuration   - Thời lượng fade in/out (giây), 0 = không fade
function M.ApplyMotionEffects(state, trackIndex, effectType, intensity, fadeDuration)
    state.resolve:OpenPage("edit")
    local timeline = state.project:GetCurrentTimeline()
    if not timeline then
        return { error = true, message = "No active timeline found" }
    end

    trackIndex = tonumber(trackIndex) or 1
    effectType = effectType or "both"
    intensity = intensity or "subtle"
    fadeDuration = tonumber(fadeDuration) or 0  -- 0 = không fade

    -- Cấu hình cường độ — dùng ZOOM RATE (per second)
    -- Tốc độ cố định: clip dài hay ngắn đều zoom cùng tốc độ
    -- Ví dụ subtle: 0.5%/giây → clip 10s zoom 1.0→1.05, clip 5s zoom 1.0→1.025
    local config = {
        subtle = { zoomRatePerSec = 0.005, shakeAngle = 0.15, panRatePerSec = 0.001 },
        medium = { zoomRatePerSec = 0.010, shakeAngle = 0.30, panRatePerSec = 0.002 },
        strong = { zoomRatePerSec = 0.015, shakeAngle = 0.50, panRatePerSec = 0.003 },
    }
    local cfg = config[intensity] or config["subtle"]

    local trackCount = timeline:GetTrackCount("video")
    if trackIndex > trackCount then
        return { error = true, message = string.format("Track V%d does not exist (total: %d)", trackIndex, trackCount) }
    end

    local clips = timeline:GetItemListInTrack("video", trackIndex)
    if not clips or #clips == 0 then
        return { error = true, message = string.format("Track V%d has no clips", trackIndex) }
    end

    local frame_rate = tonumber(timeline:GetSetting("timelineFrameRate")) or 24
    local appliedCount = 0
    local errorCount = 0
    local totalClips = #clips

    print(string.format("[AutoSubs] ApplyMotionEffects: %d clips on V%d, effect='%s', intensity='%s', fade=%.1fs",
        totalClips, trackIndex, effectType, intensity, fadeDuration))

    for i, clip in ipairs(clips) do
        local ok, err = pcall(function()
            local clipDuration = clip:GetDuration()  -- tính bằng frames
            if clipDuration <= 0 then return end

            -- ===== BƯỚC 1: Lấy hoặc tạo Fusion comp =====
            -- Ảnh trên timeline KHÔNG có Fusion comp mặc định
            -- Phải gọi AddFusionComp() để tạo mới
            local comp = nil
            if clip:GetFusionCompCount() > 0 then
                comp = clip:GetFusionCompByIndex(1)
            end

            if not comp then
                -- Tạo Fusion comp mới cho clip ảnh
                comp = clip:AddFusionComp()
                if not comp then
                    print(string.format("[AutoSubs] Clip %d: AddFusionComp() failed — skip", i))
                    errorCount = errorCount + 1
                    return
                end
                print(string.format("[AutoSubs] Clip %d: Created new Fusion comp", i))
            end

            -- ===== BƯỚC 2: Tìm MediaIn tool (source ảnh) =====
            local mediaIn = comp:FindTool("MediaIn1")
            if not mediaIn then
                print(string.format("[AutoSubs] Clip %d: No MediaIn1 found — skip", i))
                errorCount = errorCount + 1
                return
            end

            -- ===== BƯỚC 3: Thêm Transform tool =====
            -- Tạo Transform node → nối giữa MediaIn và MediaOut
            local transform = comp:AddTool("Transform")
            if not transform then
                print(string.format("[AutoSubs] Clip %d: Cannot add Transform tool — skip", i))
                errorCount = errorCount + 1
                return
            end

            -- Kết nối ban đầu: MediaIn → Transform
            local mediaOut = comp:FindTool("MediaOut1")
            transform:ConnectInput("Input", mediaIn)

            -- ===== Nếu có Fade → chèn Background + Merge =====
            -- Node graph: MediaIn → Transform → Merge(FG) + Background → Merge(BG) → MediaOut
            -- Nếu không có Fade: MediaIn → Transform → MediaOut
            local mergeNode = nil
            if fadeDuration > 0 and mediaOut then
                -- Tạo Background node (màu đen)
                local bg = comp:AddTool("Background")
                if bg then
                    bg:SetInput("TopLeftRed", 0)
                    bg:SetInput("TopLeftGreen", 0)
                    bg:SetInput("TopLeftBlue", 0)
                    bg:SetInput("TopLeftAlpha", 1)
                end

                -- Tạo Merge node
                mergeNode = comp:AddTool("Merge")
                if mergeNode and bg then
                    -- Background (đen) → Merge.Background
                    mergeNode:ConnectInput("Background", bg)
                    -- Transform (ảnh) → Merge.Foreground
                    mergeNode:ConnectInput("Foreground", transform)
                    -- Merge → MediaOut
                    mediaOut:ConnectInput("Input", mergeNode)
                else
                    -- Fallback: không có merge → nối thẳng
                    mediaOut:ConnectInput("Input", transform)
                end
            elseif mediaOut then
                -- Không fade → nối thẳng Transform → MediaOut
                mediaOut:ConnectInput("Input", transform)
            end

            -- ===== BƯỚC 4: KEN BURNS — zoom + pan (tốc độ cố định) =====
            if effectType == "kenburns" or effectType == "both" then
                -- Tính zoomEnd dựa trên duration: tốc độ cố định bất kể clip dài/ngắn
                local clipDurationSec = clipDuration / frame_rate
                local zoomEnd = 1.0 + (cfg.zoomRatePerSec * clipDurationSec)
                local panEnd = 0.5 + (cfg.panRatePerSec * clipDurationSec)
                transform:AddModifier("Size", "BezierSpline")
                local sizeSpline = transform.Size:GetConnectedOutput():GetTool()
                if sizeSpline then
                    sizeSpline:SetKeyFrames({
                        [0] = { 1.0 },
                        [clipDuration - 1] = { zoomEnd },
                    })
                end

                -- Pan: Center.X dịch nhẹ sang phải
                -- Center là XY path, mặc định (0.5, 0.5) = giữa
                transform:AddModifier("Center", "XYPath")
                -- Tìm XYPath tool vừa tạo
                local toolList = comp:GetToolList(false, "XYPath")
                if toolList and #toolList > 0 then
                    local xyPath = toolList[#toolList]  -- lấy tool mới nhất
                    -- Animate X: 0.5 → 0.5 + panX
                    xyPath:AddModifier("X", "BezierSpline")
                    local xSpline = xyPath.X:GetConnectedOutput():GetTool()
                    if xSpline then
                        xSpline:SetKeyFrames({
                            [0] = { 0.5 },
                            [clipDuration - 1] = { panEnd },
                        })
                    end
                end
            end

            -- ===== BƯỚC 5: CAMERA SHAKE — xoay nhẹ random =====
            if effectType == "shake" or effectType == "both" then
                -- Xoay Angle nhỏ: tạo keyframe mỗi ~0.25 giây
                -- Giá trị random trong [-shakeAngle, +shakeAngle]
                local shakeInterval = math.max(1, math.floor(frame_rate / 4))

                transform:AddModifier("Angle", "BezierSpline")
                local angleSpline = transform.Angle:GetConnectedOutput():GetTool()
                if angleSpline then
                    local keyframes = {}
                    for f = 0, clipDuration - 1, shakeInterval do
                        local angle = (math.random() * 2 - 1) * cfg.shakeAngle
                        keyframes[f] = { angle }
                    end
                    -- Về 0 ở frame cuối
                    keyframes[clipDuration - 1] = { 0 }
                    angleSpline:SetKeyFrames(keyframes)
                end
            end

            -- ===== BƯỚC 6: FADE IN/OUT — chuyển cảnh mượt =====
            -- Keyframe Merge.Blend: 0→1 (fade in), 1→0 (fade out)
            -- fadeDuration tính bằng giây → chuyển sang frames
            if fadeDuration > 0 and mergeNode then
                local fadeFrames = math.floor(fadeDuration * frame_rate)
                -- Đảm bảo fade không dài hơn 1/3 clip
                fadeFrames = math.min(fadeFrames, math.floor(clipDuration / 3))

                mergeNode:AddModifier("Blend", "BezierSpline")
                local blendSpline = mergeNode.Blend:GetConnectedOutput():GetTool()
                if blendSpline then
                    blendSpline:SetKeyFrames({
                        [0] = { 0 },                              -- Đầu clip: ẩn (đen)
                        [fadeFrames] = { 1 },                     -- Fade in xong
                        [clipDuration - 1 - fadeFrames] = { 1 },  -- Giữ hiển thị
                        [clipDuration - 1] = { 0 },               -- Fade out (đen)
                    })
                end
            end

            appliedCount = appliedCount + 1
        end)

        if not ok then
            print(string.format("[AutoSubs] Clip %d error: %s", i, tostring(err)))
            errorCount = errorCount + 1
        end

        -- Log tiến độ mỗi 10 clips
        if i % 10 == 0 then
            print(string.format("[AutoSubs] Progress: %d/%d clips processed", i, totalClips))
        end
    end

    -- Refresh timeline để thấy thay đổi
    timeline:SetCurrentTimecode(timeline:GetCurrentTimecode())

    print(string.format("[AutoSubs] ✅ ApplyMotionEffects done: %d/%d applied, %d errors",
        appliedCount, totalClips, errorCount))

    return {
        success = true,
        applied = appliedCount,
        total = totalClips,
        errors = errorCount,
        trackIndex = trackIndex,
        effectType = effectType,
        intensity = intensity,
    }
end

return M
