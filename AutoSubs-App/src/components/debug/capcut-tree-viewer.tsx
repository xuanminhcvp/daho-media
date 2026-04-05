import { useState, useEffect } from 'react'
import { readDir, readTextFile } from '@tauri-apps/plugin-fs'
import { join, homeDir } from '@tauri-apps/api/path'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { FolderGit2, SplitSquareHorizontal, DatabaseBackup, Clapperboard } from 'lucide-react'
import { loadEffectsSettings, scanCapCutCache, loadPinnedSubtitleTemplateBundles } from '@/services/capcut-cache-scanner'
import type { CapCutEffectsSettings } from '@/services/capcut-cache-scanner'
import { generateCapCutDraft } from '@/services/capcut-draft-service'

// Truy xuất toàn bộ dải liên kết liên quan đến 1 Subtitle
const getFirstSubtitleGroup = (draftData: any) => {
    if (!draftData) return {}
    const textTrack = draftData.tracks?.find((t: any) => t.type === 'text')
    const segment = textTrack?.segments?.[0]

    if (!segment) return {}

    let textTemplate = null
    let textMaterial = null
    let animation = null

    const textTemplates = draftData.materials?.text_templates || []
    const texts = draftData.materials?.texts || []
    const anims = draftData.materials?.material_animations || []

    textTemplate = textTemplates.find((t: any) => t.id === segment.material_id)
    if (!textTemplate) {
        textMaterial = texts.find((t: any) => t.id === segment.material_id)
    } else {
        const txtId = textTemplate.text_info_resources?.[0]?.text_material_id
        if (txtId) textMaterial = texts.find((t: any) => t.id === txtId)

        const animRefs = textTemplate.text_info_resources?.[0]?.extra_material_refs || []
        if (animRefs.length > 0) animation = anims.find((an: any) => an.id === animRefs[0])
    }

    return { segment, textTemplate, textMaterial, animation }
}

export function CapcutJsonAnalyzer() {
    const [drafts, setDrafts] = useState<string[]>([])

    // So sánh song song
    const [leftDraft, setLeftDraft] = useState<string | null>("0403(1)")
    const [rightDraft, setRightDraft] = useState<string | null>(null)

    const [leftData, setLeftData] = useState<any>(null)
    const [rightData, setRightData] = useState<any>(null)
    type AnalyzerEffectSettings = CapCutEffectsSettings & {
        transitionCachePath?: string
        videoEffectCachePath?: string
        videoEffectName?: string
        textTemplateRawJson?: any
        textTemplateTextMaterialRawJson?: any
        textTemplateLinkedMaterialAnimationsRawJson?: any[]
        textTemplateLinkedEffectsRawJson?: any[]
        textTemplateName?: string
        textTemplateCachePath?: string
    }

    /**
     * Luôn đọc lại settings CapCut mới nhất từ store tại thời điểm cần dùng.
     * Lý do:
     * - User có thể đổi template ở panel khác sau khi màn hình "Nội soi" đã mở.
     * - Nếu dùng state cũ trong component, nút "Tạo Draft Test Mini" sẽ tạo draft bằng template cũ.
     */
    const loadLatestEffectSettings = async (): Promise<AnalyzerEffectSettings> => {
        const s: AnalyzerEffectSettings = await loadEffectsSettings()
        try {
            // Nếu có chọn text template thì gắn thêm raw JSON/cached path mới nhất để generate dùng đúng.
            if (s.textTemplateEffectId) {
                let { textTemplates } = await scanCapCutCache(false)
                let found = textTemplates.find(t => t.effectId === s.textTemplateEffectId)

                // Auto-heal cho cache cũ thiếu textMaterialRawJson
                if (found?.rawJson && (!found?.textMaterialRawJson || !Array.isArray(found?.linkedMaterialAnimationsRawJson))) {
                    const refreshed = await scanCapCutCache(true)
                    textTemplates = refreshed.textTemplates
                    found = textTemplates.find(t => t.effectId === s.textTemplateEffectId)
                }
                if (found) {
                    s.textTemplateRawJson = found.rawJson
                    s.textTemplateTextMaterialRawJson = found.textMaterialRawJson
                    s.textTemplateLinkedMaterialAnimationsRawJson = found.linkedMaterialAnimationsRawJson
                    s.textTemplateLinkedEffectsRawJson = found.linkedEffectsRawJson
                    s.textTemplateName = found.displayName
                    s.textTemplateCachePath = found.cachePath
                } else {
                    // Fallback: nếu draft nguồn bị xoá, dùng bundle đã pin từ local store.
                    const pinnedBundles = await loadPinnedSubtitleTemplateBundles()
                    const pinned = pinnedBundles[s.textTemplateEffectId]
                    if (pinned) {
                        s.textTemplateRawJson = pinned.textTemplateRawJson
                        s.textTemplateTextMaterialRawJson = pinned.textMaterialRawJson
                        s.textTemplateLinkedMaterialAnimationsRawJson = pinned.linkedMaterialAnimationsRawJson
                        s.textTemplateLinkedEffectsRawJson = pinned.linkedEffectsRawJson
                        s.textTemplateName = pinned.displayName
                    }
                }
            }
        } catch (error) {
            console.error("Resolve effect error:", error)
        }
        return s
    }

    useEffect(() => {
        loadDraftFolders()
        // Load lần đầu để hiển thị state ban đầu trong UI.
        // Khi bấm nút tạo test sẽ load lại lần nữa để tránh bị stale settings.
        loadLatestEffectSettings()
    }, [])

    useEffect(() => {
        if (leftDraft) loadDraftInfo(leftDraft, 'left')
    }, [leftDraft])

    useEffect(() => {
        if (rightDraft) loadDraftInfo(rightDraft, 'right')
    }, [rightDraft])

    const loadDraftFolders = async () => {
        try {
            const home = await homeDir()
            const draftsDir = await join(home, 'Movies', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft')
            const entries = await readDir(draftsDir)

            const draftNames = entries.filter(e => e.isDirectory).map(e => e.name)
            draftNames.sort((a, b) => b.localeCompare(a))
            setDrafts(draftNames.slice(0, 20))
        } catch (e) {
            console.error(e)
        }
    }

    const loadDraftInfo = async (draftName: string, side: 'left' | 'right') => {
        try {
            const home = await homeDir()
            const draftInfoPath = await join(home, 'Movies', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft', draftName, 'draft_info.json')
            const content = await readTextFile(draftInfoPath)
            const json = JSON.parse(content)
            if (side === 'left') setLeftData(json)
            else setRightData(json)
        } catch (e) {
            if (side === 'left') setLeftData(null)
            else setRightData(null)
        }
    }

    const groupL = getFirstSubtitleGroup(leftData)
    const groupR = getFirstSubtitleGroup(rightData)

    /** Copy JSON pretty vào clipboard để gửi debug nhanh */
    const copyPrettyJson = async (value: any, label: string) => {
        try {
            const formatted = JSON.stringify(value, null, 2)
            await navigator.clipboard.writeText(formatted)
        } catch (err) {
            // Fallback cho môi trường không hỗ trợ clipboard API
            try {
                const ta = document.createElement('textarea')
                ta.value = JSON.stringify(value, null, 2)
                document.body.appendChild(ta)
                ta.select()
                document.execCommand('copy')
                document.body.removeChild(ta)
            } catch (fallbackErr) {
                console.error('[CapCut Analyzer] Copy JSON lỗi:', fallbackErr || err)
                alert(`Không copy được ${label}. Hãy mở DevTools để xem lỗi.`)
                return
            }
        }
        alert(`Đã copy ${label}`)
    }

    /** Copy toàn bộ dữ liệu so sánh hiện tại (1 lần) */
    const copyAllComparison = async () => {
        const payload = {
            leftDraft,
            rightDraft,
            compared_at: new Date().toISOString(),
            sections: {
                segment: {
                    goc_json: groupL.segment ?? null,
                    test_json: groupR.segment ?? null,
                },
                text_template: {
                    goc_json: groupL.textTemplate ?? null,
                    test_json: groupR.textTemplate ?? null,
                },
                text_material: {
                    goc_json: groupL.textMaterial ?? null,
                    test_json: groupR.textMaterial ?? null,
                },
                animation: {
                    goc_json: groupL.animation ?? null,
                    test_json: groupR.animation ?? null,
                },
            }
        }
        await copyPrettyJson(payload, 'Tất Cả So Sánh')
    }

    const renderValue = (val: any) => {
        if (val === undefined) return <span className="text-muted-foreground italic">Không tồn tại</span>
        if (val === null) return <span className="text-purple-400">null</span>
        if (typeof val === 'boolean') return <span className="text-orange-400">{val ? 'true' : 'false'}</span>
        if (typeof val === 'number') return <span className="text-blue-400">{val}</span>
        if (typeof val === 'string') return <span className="text-green-300">"{val}"</span>
        if (Array.isArray(val)) return <span className="text-cyan-400">Array({val.length})</span>
        return <span className="text-cyan-400">Object {'{...}'}</span>
    }

    const DiffSection = ({ title, objL, objR }: { title: string, objL: any, objR: any }) => {
        const allKeys = Array.from(new Set([...Object.keys(objL || {}), ...Object.keys(objR || {})]))
        const topKeys = ['id', 'name', 'type', 'formula_id', 'material_id', 'text_material_id']
        allKeys.sort((a, b) => {
            const aTop = topKeys.indexOf(a)
            const bTop = topKeys.indexOf(b)
            if (aTop !== -1 && bTop !== -1) return aTop - bTop
            if (aTop !== -1) return -1
            if (bTop !== -1) return 1
            return a.localeCompare(b)
        })

        const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())

        // Auto-expand tất cả key dạng object/array để tiện chụp ảnh debug.
        useEffect(() => {
            const autoExpanded = new Set<string>()
            for (const key of allKeys) {
                const valL = objL ? objL[key] : undefined
                const valR = objR ? objR[key] : undefined
                const isComplex = typeof valL === 'object' || typeof valR === 'object'
                if (isComplex) autoExpanded.add(key)
            }
            setExpandedKeys(autoExpanded)
        }, [objL, objR])

        if (!objL && !objR) {
            return (
                <div className="mb-6">
                    <div className="bg-slate-800 text-slate-300 p-2 font-bold text-xs uppercase flex items-center gap-2">
                        {title}
                    </div>
                    <div className="p-4 text-slate-500 italic border-x border-b border-slate-800/50 text-xs">
                        Không tìm thấy Data (ID bị đứt hoặc rách tham chiếu).
                    </div>
                </div>
            )
        }

        return (
            <div className="mb-8 border border-slate-700/80 rounded-md shadow-lg bg-slate-900/40 overflow-hidden">
                <div className="bg-slate-800 text-slate-200 p-2.5 font-bold text-xs flex items-center justify-between border-b border-slate-700 shadow-sm sticky top-0 z-10">
                    <span className="flex items-center gap-2 tracking-wide">{title}</span>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-[10px] px-2"
                            onClick={() => {
                                const next = new Set<string>()
                                for (const key of allKeys) {
                                    const valL = objL ? objL[key] : undefined
                                    const valR = objR ? objR[key] : undefined
                                    if (typeof valL === 'object' || typeof valR === 'object') next.add(key)
                                }
                                setExpandedKeys(next)
                            }}
                        >
                            Mở tất cả
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-[10px] px-2"
                            onClick={() => setExpandedKeys(new Set())}
                        >
                            Thu gọn
                        </Button>
                        <span className="text-[10px] bg-slate-900/50 px-2 rounded-full border border-slate-700 font-mono text-slate-400">
                            {allKeys.length} properties
                        </span>
                    </div>
                </div>

                <div className="flex flex-col">
                    {allKeys.map(key => {
                        const valL = objL ? objL[key] : undefined
                        const valR = objR ? objR[key] : undefined

                        const isMissingL = valL === undefined
                        const isMissingR = valR === undefined
                        const isDiff = !isMissingL && !isMissingR && JSON.stringify(valL) !== JSON.stringify(valR)
                        const isComplex = typeof valL === 'object' || typeof valR === 'object'
                        const isExpanded = expandedKeys.has(key)

                        return (
                            <div key={key} className={`flex flex-col border-b border-slate-800/50 last:border-0 hover:bg-slate-800/60 transition-colors ${isDiff ? 'bg-yellow-900/10' : ''}`}>
                                {/* Main Row */}
                                <div
                                    className={`flex cursor-pointer ${isExpanded ? 'bg-slate-800/50' : ''}`}
                                    onClick={() => {
                                        setExpandedKeys((prev) => {
                                            const next = new Set(prev)
                                            if (isExpanded) next.delete(key)
                                            else next.add(key)
                                            return next
                                        })
                                    }}
                                >
                                    {/* Tool col */}
                                    <div className={`w-[200px] p-2 text-[11px] font-mono font-semibold shrink-0 border-r border-slate-800 flex items-center justify-between ${isDiff ? 'text-yellow-400' : 'text-orange-300/90'}`}>
                                        <span className="truncate pr-1" title={key}>{key}</span>
                                        {isDiff && <span className="text-[9px] bg-yellow-500/20 text-yellow-500 px-1 rounded font-bold">≠ DIFF</span>}
                                    </div>

                                    {/* Left col */}
                                    <div className={`flex-1 min-w-0 w-1/2 p-2 text-[11px] font-mono border-r border-slate-800 break-words whitespace-pre-wrap ${isMissingL ? 'bg-red-950/40' : isDiff ? 'bg-yellow-950/30' : ''}`}>
                                        {renderValue(valL)}
                                        {isMissingL && <span className="ml-2 text-red-400 font-bold bg-red-900/30 border border-red-800 px-1 rounded inline-block mt-1 text-[9px] uppercase shadow-sm">❌ THIẾU BÊN GỐC</span>}
                                    </div>

                                    {/* Right col */}
                                    <div className={`flex-1 min-w-0 w-1/2 p-2 text-[11px] font-mono break-words whitespace-pre-wrap ${isMissingR ? 'bg-red-950/40' : isDiff ? 'bg-yellow-950/30' : ''}`}>
                                        {renderValue(valR)}
                                        {isMissingR && <span className="ml-2 text-red-400 font-bold bg-red-900/30 border border-red-800 px-1 rounded inline-block mt-1 text-[9px] uppercase shadow-sm">❌ THIẾU BÊN TEST</span>}
                                        {isDiff && <span className="ml-2 text-yellow-400/90 font-bold bg-yellow-900/30 border border-yellow-800 px-1.5 rounded inline-block mt-1 text-[9px] uppercase shadow-sm">⚠️ Khác giá trị</span>}
                                    </div>
                                </div>

                                {/* Expanded Detailed Row */}
                                {isExpanded && isComplex && (
                                    <div className="flex bg-[#0a0a0f] border-t border-slate-800 p-2 shadow-inner">
                                        <div className="flex-1 min-w-0 w-1/2 border-r border-slate-800/50 p-2 overflow-x-auto mr-1">
                                            <div className="text-[9px] text-slate-500 mb-2 uppercase font-bold sticky top-0 left-0 flex items-center justify-between gap-2">
                                                <span>GỐC JSON</span>
                                                <span />
                                            </div>
                                            <pre className="text-[10px] font-mono text-slate-300">{JSON.stringify(valL, null, 2)}</pre>
                                        </div>
                                        <div className="flex-1 min-w-0 w-1/2 p-2 overflow-x-auto ml-1">
                                            <div className="text-[9px] text-slate-500 mb-2 uppercase font-bold sticky top-0 left-0 flex items-center justify-between gap-2">
                                                <span>TEST JSON</span>
                                                <span />
                                            </div>
                                            <pre className="text-[10px] font-mono text-slate-300">{JSON.stringify(valR, null, 2)}</pre>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            </div>
        )
    }

    return (
        <div className="flex w-full h-full bg-background overflow-hidden relative">
            {/* Sidebar Trái */}
            <div className="w-64 border-r bg-muted/20 flex flex-col shrink-0">
                <div className="p-4 border-b font-semibold flex items-center gap-2">
                    <FolderGit2 className="w-5 h-5 text-primary" /> Danh Sách Dự Án
                </div>
                <ScrollArea className="flex-1 p-2">
                    {drafts.map(d => (
                        <div key={d} className="mb-2 rounded-md border border-slate-200/70 bg-white/50 p-1.5">
                            {/* Hiển thị full tên dự án để user phân biệt chính xác project cần chọn */}
                            <div
                                className="text-[11px] font-mono leading-tight break-all mb-1"
                                title={d}
                            >
                                {d}
                            </div>
                            <div className="flex gap-1 items-center">
                                <Button
                                    variant={leftDraft === d ? "default" : "outline"}
                                    size="sm"
                                    className="h-6 flex-1 text-[10px]"
                                    onClick={() => setLeftDraft(d)}
                                >
                                    Gốc
                                </Button>
                                <Button
                                    variant={rightDraft === d ? "default" : "outline"}
                                    size="sm"
                                    className="h-6 flex-1 text-[10px]"
                                    onClick={() => setRightDraft(d)}
                                >
                                    Test
                                </Button>
                            </div>
                        </div>
                    ))}
                </ScrollArea>
                <div className="p-4 border-t text-xs text-muted-foreground">
                    Chọn "Gốc" làm mẫu chuẩn, "Test" để so sánh.
                </div>
            </div>

            {/* Màn Hình Kép (Unified) */}
            <div className="flex-1 flex flex-col bg-slate-950 text-slate-200">
                <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between shrink-0 bg-slate-900 z-20 shadow-sm relative">
                    <div className="flex items-center gap-2">
                        <DatabaseBackup className="w-5 h-5 text-indigo-400" />
                        <h2 className="text-lg font-bold text-slate-100">TRUY VẾT LIÊN KẾT NHÓM NGỮ CẢNH (SUBTITLE)</h2>
                    </div>

                    <div className="flex items-center gap-2">
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs"
                            onClick={copyAllComparison}
                        >
                            Copy Tất Cả
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs bg-emerald-900/30 text-emerald-400 border-emerald-800 hover:bg-emerald-800 hover:text-white"
                            onClick={async () => {
                            // Đọc lại settings mới nhất trước khi tạo draft test.
                            // Tránh trường hợp user vừa đổi template nhưng analyzer còn giữ state cũ.
                            const latestFx = await loadLatestEffectSettings()

                            if (!latestFx?.textTemplateRawJson) {
                                alert("Hãy cài đặt Text Template trong phần Tuỳ chỉnh Auto Media trước khi test!")
                                return
                            }
                            try {
                                const testName = `🛠️_Test_Logic_${new Date().getHours()}h${new Date().getMinutes()}`
                                const home = await homeDir()
                                const desktopDir = await join(home, 'Desktop')
                                const desktopEntries = await readDir(desktopDir)
                                const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic'])
                                const desktopImage = desktopEntries.find((entry) => {
                                    if (entry.isDirectory || !entry.name) return false
                                    const lower = entry.name.toLowerCase()
                                    for (const ext of imageExts) {
                                        if (lower.endsWith(ext)) return true
                                    }
                                    return false
                                })

                                if (!desktopImage?.name) {
                                    alert('Không tìm thấy ảnh nào ở Desktop để test. Hãy để sẵn 1 file .jpg/.png rồi thử lại.')
                                    return
                                }

                                const desktopImagePath = await join(desktopDir, desktopImage.name)
                                console.log('[CapCut Analyzer] 🧪 Tạo draft test với template:', {
                                    textTemplateEffectId: latestFx.textTemplateEffectId || '(TRỐNG)',
                                    textTemplateName: latestFx.textTemplateName || '(TRỐNG)',
                                    textTemplateCachePath: latestFx.textTemplateCachePath || '(TRỐNG)',
                                    mode: 'subtitle-only-test (disable transition/video-effect)',
                                })

                                // Test mini chỉ tập trung debug template subtitle:
                                // - Tắt transition + video effect để tránh lỗi render preview "loading" trong CapCut.
                                const miniTestFx: AnalyzerEffectSettings = {
                                    ...latestFx,
                                    transitionEffectId: '',
                                    transitionCachePath: '',
                                    videoEffectId: '',
                                    videoEffectCachePath: '',
                                    videoEffectName: '',
                                }
                                await generateCapCutDraft({
                                    config: {
                                        projectName: testName,
                                        width: 1080,
                                        height: 1920,
                                        fps: 30
                                    },
                                    subtitles: [
                                        { text: "Đây là câu phụ đề Test Template", startTime: 1, endTime: 4 },
                                        { text: "Dùng 100% logic của luồng Auto Media!", startTime: 4.5, endTime: 7 }
                                    ],
                                    imageClips: [
                                        // Dùng ảnh thật trên Desktop để tránh Media Not Found khi mở trong CapCut
                                        { filePath: desktopImagePath, startTime: 0, endTime: 8, type: 'image' }
                                    ],
                                    effectsSettings: miniTestFx
                                })
                                alert(`✅ Đã tạo thành công dự án giả lập: "${testName}"\n\nNó đã được dùng chung 100% logic với AutoMedia, kèm theo 1 ảnh hình nền giả định. Hãy reload thư mục bên trái để thấy nó!`)
                                loadDraftFolders()
                            } catch (error: any) {
                                alert("Lỗi khi tạo draft test: " + error.message)
                            }
                            }}
                        >
                            <Clapperboard className="w-4 h-4 mr-2" />
                            Tạo Draft Test Mini (100% Logic thật)
                        </Button>
                    </div>
                </div>

                {(!leftData && !rightData) ? (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-slate-900 to-slate-950">
                        <div className="flex flex-col items-center">
                            <SplitSquareHorizontal className="w-16 h-16 opacity-10 mb-4" />
                            <p>Hãy chọn Project Gốc (Bản mẫu) và Project Test (Bản lỗi) từ menu bên trái...</p>
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-1 flex-col overflow-hidden">
                        {/* Headers */}
                        <div className="flex border-b border-slate-800 bg-slate-900/80 shadow-md shrink-0 z-20">
                            <div className="w-[200px] p-3 font-bold text-slate-400 text-xs shrink-0 border-r border-slate-700 flex items-center">
                                TRƯỜNG DỮ LIỆU
                            </div>
                            <div className="flex-1 min-w-0 w-1/2 p-3 font-bold text-blue-400 text-sm border-r border-slate-700 flex items-center justify-between">
                                <div className="flex flex-col">
                                    <span className="text-[10px] uppercase text-blue-500/80">CỘT BÊN TRÁI</span>
                                    <span className="break-words mt-0.5" title={leftDraft || ''}>GỐC: {leftDraft}</span>
                                </div>
                            </div>
                            <div className="flex-1 min-w-0 w-1/2 p-3 font-bold text-orange-400 text-sm flex items-center justify-between">
                                <div className="flex flex-col">
                                    <span className="text-[10px] uppercase text-orange-500/80">CỘT BÊN PHẢI</span>
                                    <span className="break-words mt-0.5" title={rightDraft || ''}>TEST: {rightDraft}</span>
                                </div>
                            </div>
                        </div>

                        {/* Panels */}
                        <ScrollArea className="flex-1 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-slate-900 to-slate-950 px-6 py-6 scroll-smooth">
                            <div className="max-w-6xl mx-auto pb-20">
                                <DiffSection title="📍 1. MÔNG NỀN (Segment - Nằm trên Timeline)" objL={groupL.segment} objR={groupR.segment} />
                                <DiffSection title="🎟️ 2. LÕI TEMPLATE (Text Template - Thông số đồ họa)" objL={groupL.textTemplate} objR={groupR.textTemplate} />
                                <DiffSection title="📝 3. NỘI DUNG CHỮ (Text Material - Ký tự & Font)" objL={groupL.textMaterial} objR={groupR.textMaterial} />
                                <DiffSection title="🌟 4. HIỆU ỨNG (Animation - Bay nhảy động)" objL={groupL.animation} objR={groupR.animation} />
                            </div>
                        </ScrollArea>
                    </div>
                )}
            </div>
        </div>
    )
}
