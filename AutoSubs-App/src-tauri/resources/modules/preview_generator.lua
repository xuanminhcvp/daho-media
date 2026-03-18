-- ============================================================
-- preview_generator.lua — Tạo preview subtitle, extract frame
-- ExtractFrame, GeneratePreview
-- ============================================================

local M = {}

-- ===== EXTRACT FRAME =====
-- Render 1 frame từ Fusion comp ra file PNG
function M.ExtractFrame(helpers, comp, exportDir, templateFrameRate)
    comp:Lock()
    local mySaver = comp:AddTool("Saver")
    local outputPath = ""

    if mySaver ~= nil then
        local name = mySaver.Name
        local settings = mySaver:SaveSettings()
        settings.Tools[name].Inputs.Clip.Value["Filename"] = helpers.join_path(exportDir, "subtitle-preview-0.png")
        settings.Tools[name].Inputs.Clip.Value["FormatID"] = "PNGFormat"
        settings.Tools[name].Inputs["OutputFormat"]["Value"] = "PNGFormat"
        mySaver:LoadSettings(settings)

        local mediaOut = comp:FindToolByID("MediaOut")
        mySaver:SetInput("Input", mediaOut)

        local frameToExtract = math.floor(comp:GetAttrs().COMPN_GlobalEnd / 2)
        local success = comp:Render({
            Start = frameToExtract,
            End = frameToExtract,
            Tool = mySaver,
            Wait = true
        })

        local outputFilename = "subtitle-preview-" .. frameToExtract .. ".png"
        outputPath = helpers.join_path(exportDir, outputFilename)

        if success then
            print("Frame " .. frameToExtract .. " saved to " .. outputPath)
        else
            print("Failed to save frame " .. frameToExtract)
        end
    end

    comp:Unlock()
    return outputPath
end

-- ===== GENERATE PREVIEW =====
-- Tạo subtitle preview: thêm template lên track tạm, render frame, xóa
function M.GeneratePreview(state, helpers, template_manager, subtitle_renderer, speaker, templateName, exportDir)
    local timeline = state.project:GetCurrentTimeline()
    local rootFolder = state.mediaPool:GetRootFolder()

    if templateName == "" then
        local avail = template_manager.GetTemplates(state, helpers)
        if #avail > 0 then templateName = avail[1].value end
    end

    local templateItem = nil
    if templateName ~= nil and templateName ~= "" then
        templateItem = template_manager.GetTemplateItem(helpers, rootFolder, templateName)
    end
    if not templateItem then
        templateItem = template_manager.GetTemplateItem(helpers, rootFolder, "Default Template")
    end
    if not templateItem then
        return ""
    end

    local templateFrameRate = templateItem:GetClipProperty()["FPS"]

    timeline:AddTrack("video")
    local trackIndex = timeline:GetTrackCount("video")

    local newClip = {
        mediaPoolItem = templateItem,
        startFrame = 0,
        endFrame = templateFrameRate * 2,
        recordFrame = 0,
        trackIndex = trackIndex
    }
    local timelineItems = state.mediaPool:AppendToTimeline({ newClip })
    local timelineItem = timelineItems[1]

    local outputPath = nil
    local success, err = pcall(function()
        if timelineItem:GetFusionCompCount() > 0 then
            local comp = timelineItem:GetFusionCompByIndex(1)
            local tool = comp:FindToolByID("TextPlus")
            tool:SetInput("StyledText", "Example Subtitle Text")
            subtitle_renderer.SetCustomColors(helpers, speaker, tool)
            outputPath = M.ExtractFrame(helpers, comp, exportDir, templateFrameRate)
        end
    end)

    timeline:DeleteClips(timelineItems)
    timeline:DeleteTrack("video", trackIndex)
    return outputPath
end

return M
