// post-production-panel.tsx
// Panel chính cho tính năng Hậu Kỳ Âm Thanh (Post-Production)
// Chứa 7 sub-tab, mỗi sub-tab là component riêng biệt
// Nút Auto Media đã chuyển lên titlebar.tsx

import * as React from "react"
import { Music, Zap, Type, Layers, Subtitles, Clapperboard, Film, ImageIcon, RefreshCw, Palette } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MusicLibraryTab } from "@/components/postprod/music-library-tab"
import { SfxLibraryTab } from "@/components/postprod/sfx-library-tab"
import { HighlightTextTab } from "@/components/postprod/highlight-text-tab"
import { TemplateAssignmentTab } from "@/components/postprod/template-assignment-tab"
import { SubtitleTab } from "@/components/postprod/subtitle-tab"
import { EffectsTab } from "@/components/postprod/effects-tab"
import { FootageTab } from "@/components/postprod/footage-tab"
import { ReferenceImagesTab } from "@/components/postprod/reference-images-tab"
import { AutoColorTab } from "@/components/postprod/auto-color-tab"
import { PostProdTab } from "@/types/audio-types"
import { useProject } from "@/contexts/ProjectContext"
import { getSavedFolder } from "@/services/saved-folders-service"
import { loadMatchingScript } from "@/services/audio-director-service"

export function PostProductionPanel() {
    // Sub-tab đang active — mặc định là "music" (Nhạc Nền)
    const [activeSubTab, setActiveSubTab] = React.useState<PostProdTab>("music")


    // ProjectContext để auto-load matching folder đã lưu
    const {
        project,
        setMatchingFolder: setSharedMatchingFolder,
        setMatchingSentences: setSharedMatchingSentences,
        updateMusicLibrary,
        updateSfxLibrary,
        updateHighlightText,
    } = useProject()

    // ======================== AUTO-LOAD MATCHING FOLDER ĐÃ LƯU ========================
    // Khi PostProduction panel mount, tự động load matching folder đã lưu
    // để tất cả sub-tabs (Music, SFX, Highlight) đều có sẵn data
    React.useEffect(() => {
        const loadSavedMatchingFolder = async () => {
            // Chỉ load nếu chưa có matching folder nào được chọn
            if (project.matchingFolder) return
            const saved = await getSavedFolder("matchingFolder")
            if (!saved) return

            console.log("[PostProd] Auto-load matching folder đã lưu:", saved)
            setSharedMatchingFolder(saved)

            try {
                // Load matching.json + các kết quả cache
                const loaded = await loadMatchingScript(saved)
                if (loaded) {
                    setSharedMatchingSentences(loaded.sentences)
                    // Khôi phục các kết quả cache cho từng tab
                    updateMusicLibrary({ directorResult: loaded.aiDirectorResult || null })
                    updateSfxLibrary({ sfxPlan: loaded.aiSfxPlanResult || null })
                    updateHighlightText({ highlightPlan: loaded.aiHighlightPlanResult || null })
                } else {
                    setSharedMatchingSentences(null)
                }
            } catch (error) {
                console.error("[PostProd] Lỗi auto-load matching folder:", error)
            }
        }
        loadSavedMatchingFolder()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    return (
        <div className="flex flex-col h-full min-w-0">
            {/* Header — Tiêu đề + Reload */}
            <div className="shrink-0 px-4 pt-4 pb-2 border-b flex items-start justify-between">
                <div>
                    <h3 className="text-lg font-semibold flex items-center gap-2">
                        <Music className="h-5 w-5 text-primary" />
                        Hậu Kỳ Âm Thanh
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1">
                        AI tự động chọn nhạc nền, SFX và ducking cho video
                    </p>
                </div>
                {/* Nút Reload */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="outline"
                            size="icon"
                            className="h-7 w-7 border-border hover:bg-muted"
                            onClick={() => window.location.reload()}
                        >
                            <RefreshCw className="h-4 w-4 text-muted-foreground hover:text-foreground" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">Tải lại toàn bộ giao diện (Hot Reload)</TooltipContent>
                </Tooltip>
            </div>

            {/* Sub-tab bar — 4 tab nhỏ nằm ngang */}
            <div className="shrink-0 flex items-center gap-1 px-3 pt-2 pb-1 border-b bg-card/50">
                {/* Tab Nhạc Nền */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeSubTab === "music" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-7 px-2.5 gap-1 text-xs"
                            onClick={() => setActiveSubTab("music")}
                        >
                            <Music className="h-3.5 w-3.5" />
                            Nhạc Nền
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Quản lý thư viện nhạc nền & gán cho từng cảnh</TooltipContent>
                </Tooltip>

                {/* Tab SFX */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeSubTab === "sfx" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-7 px-2.5 gap-1 text-xs"
                            onClick={() => setActiveSubTab("sfx")}
                        >
                            <Zap className="h-3.5 w-3.5" />
                            SFX
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Gán hiệu ứng âm thanh cho từng câu</TooltipContent>
                </Tooltip>

                {/* Tab Highlight Text */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeSubTab === "highlight" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-7 px-2.5 gap-1 text-xs"
                            onClick={() => setActiveSubTab("highlight")}
                        >
                            <Type className="h-3.5 w-3.5" />
                            Highlight
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Text nổi bật (call-out) cho câu quan trọng</TooltipContent>
                </Tooltip>

                {/* Tab Add Title — Import title vào DaVinci timeline */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeSubTab === "templates" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-7 px-2.5 gap-1 text-xs"
                            onClick={() => setActiveSubTab("templates")}
                        >
                            <Layers className="h-3.5 w-3.5" />
                            Add Title
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">AI chọn câu cần text on screen → import Title vào DaVinci timeline</TooltipContent>
                </Tooltip>

                {/* Tab Phụ Đề — phụ đề stories import lên DaVinci */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeSubTab === "subtitles" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-7 px-2.5 gap-1 text-xs"
                            onClick={() => setActiveSubTab("subtitles")}
                        >
                            <Subtitles className="h-3.5 w-3.5" />
                            Phụ Đề
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Tạo phụ đề stories → import lên DaVinci timeline</TooltipContent>
                </Tooltip>

                {/* Tab Hiệu Ứng — Ken Burns, Shake cho ảnh tĩnh */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeSubTab === "effects" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-7 px-2.5 gap-1 text-xs"
                            onClick={() => setActiveSubTab("effects")}
                        >
                            <Clapperboard className="h-3.5 w-3.5" />
                            Hiệu Ứng
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Thêm hiệu ứng chuyển động cho ảnh tĩnh (Ken Burns, Shake)</TooltipContent>
                </Tooltip>

                {/* Tab Footage — video clip minh hoạ từ Envato */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeSubTab === "footage" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-7 px-2.5 gap-1 text-xs"
                            onClick={() => setActiveSubTab("footage")}
                        >
                            <Film className="h-3.5 w-3.5" />
                            Footage
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">AI gợi ý footage minh hoạ từ thư viện → import lên Track V2</TooltipContent>
                </Tooltip>

                {/* Tab Ref Images — ảnh tham khảo thực tế */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeSubTab === "refImages" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-7 px-2.5 gap-1 text-xs"
                            onClick={() => setActiveSubTab("refImages")}
                        >
                            <ImageIcon className="h-3.5 w-3.5" />
                            Ref Images
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">AI gợi ý ảnh thực tế minh hoạ → import lên Track V4</TooltipContent>
                </Tooltip>

                {/* Tab Auto Color — Tự động chỉnh màu */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeSubTab === "autoColor" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-7 px-2.5 gap-1 text-xs"
                            onClick={() => setActiveSubTab("autoColor")}
                        >
                            <Palette className="h-3.5 w-3.5 text-purple-500" />
                            <span className="font-medium text-purple-600 dark:text-purple-400">Auto Color</span>
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">AI DaVinci Colorist — tự động phân tích và chỉnh màu clip</TooltipContent>
                </Tooltip>

                {/* Tab Ducking — TẠM ẨN (chưa dùng) */}
                {/* <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant={activeSubTab === "ducking" ? "secondary" : "ghost"}
                            size="sm"
                            className="h-7 px-2.5 gap-1 text-xs"
                            onClick={() => setActiveSubTab("ducking")}
                        >
                            <Volume2 className="h-3.5 w-3.5" />
                            Ducking
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Cấu hình auto ducking — nhạc lùi khi có giọng nói</TooltipContent>
                </Tooltip> */}
            </div>

            {/* Sub-tab content — Nội dung từng tab */}
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                {activeSubTab === "music" && <MusicLibraryTab />}
                {activeSubTab === "sfx" && <SfxLibraryTab />}
                {activeSubTab === "highlight" && <HighlightTextTab />}
                {activeSubTab === "templates" && <TemplateAssignmentTab />}
                {activeSubTab === "subtitles" && <SubtitleTab />}
                {activeSubTab === "effects" && <EffectsTab />}
                {activeSubTab === "footage" && <FootageTab />}
                {activeSubTab === "refImages" && <ReferenceImagesTab />}
                {activeSubTab === "autoColor" && <AutoColorTab />}
                {/* Ducking content — TẠM ẨN */}
            </div>
        </div>
    )
}
