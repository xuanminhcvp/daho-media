// sfx-library-tab.tsx
// Tab SFX trong Post-Production Panel
// Cho phép:
// 1. Chọn thư mục chứa kịch bản (matching.json) → AI phân tích gợi ý SFX cues
// 2. Chọn thư mục SFX cục bộ → quét folder → AI scan metadata (Gemini)
// 3. Load file whisper_words.txt → bắt timing chính xác từng từ
// 4. Smart Auto-Assign: khớp SFX cue → file SFX dựa trên AI metadata
import * as React from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Slider } from "@/components/ui/slider"
import {
    FolderOpen, Sparkles, Check, ChevronDown, ChevronRight, Loader2, StopCircle, Save, Search, Download, Copy, Zap, PlusCircle
} from "lucide-react"
import { open } from "@tauri-apps/plugin-dialog"
import { desktopDir } from "@tauri-apps/api/path"
import {
    analyzeScriptForSFX,
    SfxCue,
} from "@/services/audio-director-service"
import { generateMediaIdeas } from "@/services/idea-generator-service"
import {
    scanAudioFolder,
    scanAndAnalyzeFolder,
    loadAudioItemsFromFolder,
    findNewFiles,
    type ScanProgress,
} from "@/services/audio-library-service"
import { AudioLibraryItem } from "@/types/audio-types"
import { mixSFXTracks, normalizeSfxVolume } from "@/services/audio-ffmpeg-service"
import { addSfxClipsToTimeline } from "@/api/resolve-api"
import { useProject } from "@/contexts/ProjectContext"
import { useTranscript } from "@/contexts/TranscriptContext"
import { join } from "@tauri-apps/api/path"
import { saveFolderPath, getSavedFolder, getAudioScanApiKey } from "@/services/saved-folders-service"
import { getSfxFolderPath } from "@/services/auto-media-storage"
import {
    WhisperWordsFile,
    WhisperWord,
    matchWordsToTimestamps,
} from "@/utils/whisper-words-matcher"

type SfxCueWithUiKey = SfxCue & { _uiKey: string }

function buildCueBaseKey(cue: SfxCue) {
    return [
        cue.sentenceNum,
        cue.sfxCategory,
        cue.triggerWord,
        cue.timeOffset ?? 0,
        cue.reason,
        (cue.searchKeywords ?? []).join("|"),
    ].join("__")
}

function ensureCueUiKeys<T extends SfxCue>(cues: T[]): Array<T & { _uiKey: string }> {
    const seen = new Map<string, number>()

    return cues.map((cue) => {
        if ((cue as any)._uiKey) {
            return cue as T & { _uiKey: string }
        }

        const base = buildCueBaseKey(cue)
        const count = (seen.get(base) ?? 0) + 1
        seen.set(base, count)

        return {
            ...cue,
            _uiKey: `${base}__${count}`,
        }
    })
}

export function SfxLibraryTab() {
    // ======================== PROJECT CONTEXT ========================
    // Dùng chung data với các tab khác thông qua ProjectContext
    const {
        project,
        updateSfxLibrary,
    } = useProject()

    // Lấy data từ context
    const matchingFolder = project.matchingFolder
    const sentences = project.matchingSentences
    const sfxPlan = project.sfxLibrary.sfxPlan
    const sfxFolder = project.sfxLibrary.sfxFolder
    const sfxItems = project.sfxLibrary.sfxItems

    // Lấy transcript filename từ TranscriptContext (đã có sẵn từ session)
    const { subtitles } = useTranscript()

    // ======================== LOCAL STATE (UI transient) ========================

    // Phân tích SFX cues
    const [isAnalyzing, setIsAnalyzing] = React.useState(false)
    const [analyzeProgress, setAnalyzeProgress] = React.useState<string>("")
    const [analyzeError, setAnalyzeError] = React.useState("")
    const [suggestExpanded, setSuggestExpanded] = React.useState(true)

    // Render SFX track
    const [isRendering, setIsRendering] = React.useState(false)
    const [renderProgress, setRenderProgress] = React.useState("")

    // Mức loudness SFX mục tiêu (LUFS) — dùng loudnorm EBU R128
    // Voice thường ~-16 LUFS, SFX nền nên nhỏ hơn: -24 đến -18
    const [sfxTargetLufs, setSfxTargetLufs] = React.useState(-30)

    // Trạng thái "đã lưu" — hiện tick xanh sau khi bấm Save
    const [sfxFolderSaved, setSfxFolderSaved] = React.useState(false)

    // AI Scan SFX metadata
    const [isScanning, setIsScanning] = React.useState(false)
    const [scanProgress, setScanProgress] = React.useState<ScanProgress | null>(null)
    const [newFilesCount, setNewFilesCount] = React.useState(0)
    const abortControllerRef = React.useRef<AbortController | null>(null)

    // Ref giữ bản sao mới nhất của sfxItems — tránh stale closure trong callback
    const sfxItemsRef = React.useRef(sfxItems)
    React.useEffect(() => { sfxItemsRef.current = sfxItems }, [sfxItems])

    // Whisper words file (in-memory — load lại từ path)
    const [whisperWordsFile, setWhisperWordsFile] = React.useState<WhisperWordsFile | null>(null)

    // Search SFX library
    const [searchQuery, setSearchQuery] = React.useState("")
    const [libraryExpanded, setLibraryExpanded] = React.useState(false)

    // Gợi ý SFX keywords để tải
    const [sfxKeywords, setSfxKeywords] = React.useState<string[]>([])
    const [isSuggestingKeywords, setIsSuggestingKeywords] = React.useState(false)
    const [keywordSuggestExpanded, setKeywordSuggestExpanded] = React.useState(true)

    // ======================== AUTO-LOAD THƯ MỤC ĐÃ LƯU ========================
    // Khi mount, tự động load thư mục SFX đã lưu.
    // Nếu chưa từng lưu folder → fallback vào ~/Desktop/Auto_media/sfx
    React.useEffect(() => {
        const loadSavedSfxFolder = async () => {
            if (sfxFolder) return

            // Ưu tiên: folder đã lưu
            let folderToLoad = await getSavedFolder("sfxFolder")

            // Fallback: ~/Desktop/Auto_media/sfx (đường dẫn động theo máy)
            if (!folderToLoad) {
                folderToLoad = await getSfxFolderPath()
                console.log("[SfxLib] Dùng Auto_media fallback:", folderToLoad)
            }

            console.log("[SfxLib] Auto-load thư mục SFX:", folderToLoad)
            try {
                // Quét folder + load metadata từ file JSON trong folder
                const scanned = await scanAudioFolder(folderToLoad, "sfx")
                const folderItems = await loadAudioItemsFromFolder(folderToLoad)

                // TỰ ĐỘNG DỌN DẸP
                const currentPaths = new Set(scanned.map(i => i.filePath));
                const cleanedFolderItems = folderItems.filter(item => currentPaths.has(item.filePath));
                const deletedCount = folderItems.length - cleanedFolderItems.length;
                
                if (deletedCount > 0) {
                    const { saveAudioItemsToFolder } = await import("@/services/audio-library-service");
                    await saveAudioItemsToFolder(folderToLoad, cleanedFolderItems);
                    console.log(`[SfxLib] 🧹 Khởi động: Đã dọn dẹp ${deletedCount} file bị xoá khỏi metadata JSON`);
                }

                const folderMap = new Map(cleanedFolderItems.map(i => [i.filePath, i]))

                // Merge: ưu tiên metadata từ file JSON
                const mergedItems = scanned.map(item => {
                    const existing = folderMap.get(item.filePath)
                    if (existing && existing.aiMetadata) return existing
                    return item
                })

                updateSfxLibrary({ sfxFolder: folderToLoad, sfxItems: mergedItems })

                // Đếm file mới cần quét AI
                const newFiles = findNewFiles(scanned, cleanedFolderItems)
                setNewFilesCount(newFiles.length)
            } catch (error) {
                console.error("[SfxLib] Lỗi auto-load thư mục SFX:", error)
            }
        }
        loadSavedSfxFolder()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // --- Tự động tạo whisper words từ subtitles (đã có sẵn trong session) ---
    const autoLoadWhisperWords = React.useCallback(() => {
        if (!subtitles || subtitles.length === 0) return

        // Subtitles đã có word-level timestamps từ Whisper
        const hasWords = subtitles.some((seg: any) => seg.words && seg.words.length > 0)
        if (!hasWords) {
            console.warn("[SfxLib] ⚠️ Subtitles không có word-level timestamps")
            setWhisperWordsFile(null)
            return
        }

        // Convert subtitles word data → WhisperWordsFile format
        const allWords: WhisperWord[] = []
        for (const seg of subtitles) {
            if (!seg.words || seg.words.length === 0) continue
            for (const word of seg.words) {
                const wordText = (word.word || "").trim()
                if (!wordText) continue
                const start = typeof word.start === "string" ? parseFloat(word.start) : word.start
                const end = typeof word.end === "string" ? parseFloat(word.end) : word.end
                if (!isNaN(start)) {
                    allWords.push({
                        t: Math.round(start * 100) / 100,
                        w: wordText,
                        e: !isNaN(end) ? Math.round(end * 100) / 100 : 0,
                    })
                }
            }
        }

        // Sort theo thời gian
        allWords.sort((a, b) => a.t - b.t)

        // Tính end time cho các word chưa có (e = 0)
        for (let i = 0; i < allWords.length; i++) {
            if (allWords[i].e === 0) {
                allWords[i].e = i < allWords.length - 1 ? allWords[i + 1].t : allWords[i].t + 0.3
            }
        }

        const totalDuration = allWords.length > 0 ? allWords[allWords.length - 1].e : 0

        const whisperFile: WhisperWordsFile = {
            version: 1,
            exportedAt: new Date().toISOString(),
            totalWords: allWords.length,
            totalDuration: Math.round(totalDuration * 100) / 100,
            words: allWords,
        }

        setWhisperWordsFile(whisperFile)
        console.log(`[SfxLib] ✅ Auto-loaded whisper words từ subtitles: ${allWords.length} words (${totalDuration.toFixed(0)}s)`)
    }, [subtitles])

    // Auto-load whisper words khi subtitles có sẵn (từ session restore hoặc sau khi gen subtitle)
    React.useEffect(() => {
        if (subtitles && subtitles.length > 0 && !whisperWordsFile) {
            autoLoadWhisperWords()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [subtitles])

    // ======================== HANDLERS ========================


    // --- Phân tích SFX cues bằng AI (5 batch song song) ---
    const handleAnalyzeSFX = async () => {
        if (!sentences || !matchingFolder) return

        setIsAnalyzing(true)
        setAnalyzeError("")
        updateSfxLibrary({ sfxPlan: null })

        try {
            // Truyền sfxItems (thư viện SFX) + whisperWords (timing chính xác từng từ)
            // Nếu có đủ cả hai → AI chia 5 batch song song, chọn file SFX + trim + exactStartTime
            // Nếu thiếu 1 trong 2 → fallback về prompt cũ (1 request)
            const result = await analyzeScriptForSFX(
                matchingFolder,
                sentences,
                sfxItems,                          // Thư viện SFX đã scan AI
                whisperWordsFile?.words,            // Whisper words (word-level timestamps)
                (msg: string) => setAnalyzeProgress(msg)
            )
            // Lưu kết quả vào ProjectContext
            updateSfxLibrary({
                sfxPlan: {
                    ...result,
                    cues: ensureCueUiKeys(result.cues),
                },
            })
        } catch (error: any) {
            setAnalyzeError(String(error))
        } finally {
            setIsAnalyzing(false)
            setAnalyzeProgress("")
        }
    }

    // --- Gợi ý từ khóa SFX để tải ---
    const handleSuggestKeywords = async () => {
        setIsSuggestingKeywords(true)
        setAnalyzeError("")
        setSfxKeywords([])

        try {
            const keywords = await generateMediaIdeas(
                "sfx",
                (msg: string) => setAnalyzeProgress(msg)
            )
            setSfxKeywords(keywords)
        } catch (error: any) {
            setAnalyzeError("Lỗi gợi ý SFX keywords: " + String(error))
        } finally {
            setIsSuggestingKeywords(false)
            setAnalyzeProgress("")
        }
    }

    // --- Chọn thư mục SFX ---
    const handleSelectSfxFolder = async () => {
        try {
            const desktop = await desktopDir()
            const folder = await open({
                directory: true,
                title: "Chọn thư mục chứa SFX của bạn",
                defaultPath: desktop,
            })
            if (!folder) return

            // Quét folder + load metadata từ file JSON trong folder
            const scanned = await scanAudioFolder(folder as string, "sfx")
            const folderItems = await loadAudioItemsFromFolder(folder as string)

            // TỰ ĐỘNG DỌN DẸP KHI CHỌN FOLDER
            const currentPaths = new Set(scanned.map(i => i.filePath));
            const cleanedFolderItems = folderItems.filter(item => currentPaths.has(item.filePath));
            const deletedCount = folderItems.length - cleanedFolderItems.length;
            
            if (deletedCount > 0) {
                const { saveAudioItemsToFolder } = await import("@/services/audio-library-service");
                await saveAudioItemsToFolder(folder as string, cleanedFolderItems);
                console.log(`[SfxLib] 🧹 Chọn folder: Đã dọn dẹp ${deletedCount} file bị xoá khỏi metadata JSON`);
            }

            const folderMap = new Map(cleanedFolderItems.map(i => [i.filePath, i]))

            // Merge: ưu tiên metadata từ file JSON
            const mergedItems = scanned.map(item => {
                const existing = folderMap.get(item.filePath)
                if (existing && existing.aiMetadata) return existing
                return item
            })

            updateSfxLibrary({ sfxFolder: folder as string, sfxItems: mergedItems })

            // Đếm file mới cần quét AI
            const newFiles = findNewFiles(scanned, cleanedFolderItems)
            setNewFilesCount(newFiles.length)
        } catch (error: any) {
            console.error(error)
        }
    }

    // --- AI Scan SFX metadata (Gemini nghe file → tạo tags/emotion) ---
    const handleScanAI = async () => {
        const savedApiKey = await getAudioScanApiKey()
        if (!sfxFolder || !savedApiKey) {
            if (!savedApiKey) {
                setAnalyzeError("Vui lòng vào Settings nhập Gemini API Key trước khi scan!")
            }
            return
        }

        // Tạo AbortController mới
        const abortController = new AbortController()
        abortControllerRef.current = abortController

        setIsScanning(true)
        setScanProgress(null)
        setAnalyzeError("")

        try {
            const updatedItems = await scanAndAnalyzeFolder(
                sfxFolder,
                "sfx",
                savedApiKey,
                (progress) => setScanProgress(progress),
                abortController.signal,
                // Callback mỗi khi 1 file scan xong → cập nhật UI real-time
                (completedItem) => {
                    const latest = sfxItemsRef.current
                    const updated = latest.map(item =>
                        item.filePath === completedItem.filePath ? completedItem : item
                    )
                    sfxItemsRef.current = updated
                    updateSfxLibrary({ sfxItems: updated })
                }
            )

            updateSfxLibrary({ sfxItems: updatedItems })

            if (!abortController.signal.aborted) {
                setNewFilesCount(0)
            }
        } catch (error) {
            console.error("[SfxLib] Lỗi scan AI:", error)
            setAnalyzeError("Lỗi scan AI: " + String(error))
        } finally {
            setIsScanning(false)
            abortControllerRef.current = null
        }
    }

    // --- Dừng scan AI giữa chừng ---
    const handleStopScan = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort()
            console.log("[SfxLib] ⏹️ User yêu cầu dừng scan SFX")
        }
    }

    // --- Smart Auto-Assign: khớp SFX cue → file SFX dựa trên AI metadata + whisper words ---
    // CHỈ GIỮ CUE CÓ WHISPER TIMING CHÍNH XÁC — bỏ hết cue không khớp
    const handleAutoAssignSFX = () => {
        if (!sfxPlan || sfxItems.length === 0) return;

        let droppedCount = 0;

        const newCues = (sfxPlan.cues as SfxCueWithUiKey[])
            .map(cue => {
                // ====== WHISPER WORDS TIMING: Bắt chính xác thời điểm triggerWord ======
                let exactStartTime: number | undefined;
                if (whisperWordsFile && sentences) {
                    const sentence = sentences.find(s => s.num === cue.sentenceNum);
                    if (sentence) {
                        // Nếu câu quá ngắn (nhiều câu trùng timestamp) → mở rộng phạm vi tìm
                        const sentenceDur = sentence.end - sentence.start;
                        const expandedStart = sentenceDur < 3 ? sentence.start - 5 : sentence.start;
                        const expandedEnd = sentenceDur < 3 ? sentence.end + 10 : sentence.end;

                        const wordMatch = matchWordsToTimestamps(
                            cue.triggerWord,
                            whisperWordsFile.words,
                            expandedStart,
                            expandedEnd
                        );
                        if (wordMatch.success) {
                            exactStartTime = wordMatch.start;
                            console.log(
                                `[SfxLib] ✅ Whisper match: "${cue.triggerWord}" → ${wordMatch.start.toFixed(2)}s [${wordMatch.matchedWords.join(", ")}]`
                            );
                        }
                    }
                }

                // Fallback: nếu whisper fail → dùng sentence.start + timeOffset
                // KHÔNG loại bỏ cue — SFX vẫn được import dù timing không chính xác từng từ
                if (exactStartTime === undefined) {
                    const sentence = sentences?.find(s => s.num === cue.sentenceNum);
                    if (sentence) {
                        exactStartTime = sentence.start + (cue.timeOffset || 0);
                        console.warn(
                            `[SfxLib] ⚠️ Fallback: "${cue.triggerWord}" (câu ${cue.sentenceNum}) → ${exactStartTime.toFixed(1)}s (sentence + offset)`
                        );
                    } else {
                        console.warn(
                            `[SfxLib] ❌ Bỏ cue: "${cue.triggerWord}" (câu ${cue.sentenceNum}) — không tìm được câu`
                        );
                        droppedCount++;
                        return null;
                    }
                }

                // ====== SMART MATCH: Tìm file SFX phù hợp nhất ======
                const matchedItem = smartMatchSfxFile(cue, sfxItems);

                return {
                    ...cue,
                    _uiKey: cue._uiKey, // giữ nguyên key cũ
                    assignedSfxPath: matchedItem?.filePath,
                    assignedSfxName: matchedItem?.fileName,
                    exactStartTime,
                };
            })
            .filter((cue): cue is NonNullable<typeof cue> => cue !== null);

        if (droppedCount > 0) {
            console.log(`[SfxLib] 📊 Kết quả: ${newCues.length} cue giữ lại, ${droppedCount} cue bị loại (không khớp whisper)`);
        }

        updateSfxLibrary({ sfxPlan: { ...sfxPlan, cues: newCues } });
    }

    // --- Render SFX track (hỗ trợ exactStartTime + trim từ AI) ---
    const handleRenderSFX = async () => {
        if (!sfxPlan || !matchingFolder) return;

        setIsRendering(true);
        setRenderProgress("");

        try {
            // Lọc ra các Cue đã gán file
            const validCues = sfxPlan.cues.filter(c => c.assignedSfxPath);

            // Xây dựng config render — ưu tiên exactStartTime + hỗ trợ trim
            const ffmpegCues = validCues.map(c => {
                // Ưu tiên 1: exactStartTime từ AI (whisper words — chính xác từng từ)
                // Ưu tiên 2: sentence.start + timeOffset (ước lượng)
                let startTimeSeconds: number;
                if (c.exactStartTime !== undefined && c.exactStartTime !== null) {
                    startTimeSeconds = c.exactStartTime;
                } else {
                    const sentence = sentences?.find(s => s.num === c.sentenceNum);
                    startTimeSeconds = (sentence?.start || 0) + (c.timeOffset || 0);
                }

                return {
                    filePath: c.assignedSfxPath!,
                    startTimeMs: Math.round(startTimeSeconds * 1000),
                    // Trim SFX: AI gợi ý đoạn cắt phù hợp
                    trimStartSec: c.trimStartSec,
                    trimEndSec: c.trimEndSec,
                };
            });

            const res = await mixSFXTracks({
                outputFolder: matchingFolder,
                cues: ffmpegCues,
                onProgress: (p) => setRenderProgress(p)
            });

            alert(`✅ Render xong! File SFX đã được lưu tại:\n${res.outputPath}\n\nHãy vào DaVinci Resolve để import file này vào Audio Track!`);
        } catch (error: any) {
            alert("Lỗi Render SFX: " + String(error));
        } finally {
            setIsRendering(false);
        }
    }

    // --- Thêm SFX trực tiếp vào DaVinci Resolve timeline (chỉ cue có whisper timing) ---
    const handleAddSfxToTimeline = async () => {
        if (!sfxPlan || !matchingFolder) return;

        // Chỉ lấy cue có exactStartTime (whisper timing chính xác) VÀ đã gán file
        const preciseCues = sfxPlan.cues.filter(
            c => c.assignedSfxPath && c.exactStartTime !== undefined && c.exactStartTime !== null
        );

        if (preciseCues.length === 0) {
            alert("⚠️ Không có cue nào có whisper timing chính xác để thêm vào timeline.");
            return;
        }

        setIsRendering(true);
        setRenderProgress(`Đang giảm volume SFX (-6dB)...`);

        try {
            // Bước 1: Normalize loudness từng file SFX bằng EBU R128 loudnorm
            // (vì Resolve API không set được audio clip volume qua scripting)
            // Tất cả SFX sẽ được đưa về cùng mức LUFS → nghe đều nhau
            const normalizedClips: Array<{ filePath: string; startTime: number; trimStartSec?: number; trimEndSec?: number }> = [];
            const processedPaths = new Map<string, string>(); // cache: original → normalized path

            for (let i = 0; i < preciseCues.length; i++) {
                const c = preciseCues[i];
                const originalPath = c.assignedSfxPath!;

                setRenderProgress(`Normalize loudness: ${i + 1}/${preciseCues.length} (${sfxTargetLufs} LUFS)...`);

                let normalizedPath: string;
                if (processedPaths.has(originalPath)) {
                    // Đã normalize file này rồi — dùng lại
                    normalizedPath = processedPaths.get(originalPath)!;
                } else {
                    // Normalize: tạo file mới trong matchingFolder
                    // LUÔN dùng .wav vì codec pcm_s16le chỉ tương thích WAV container
                    // Tên file chứa mức LUFS để phân biệt khi user thay đổi mức
                    const fileName = originalPath.split(/[/\\]/).pop() || "sfx.wav";
                    const baseName = fileName.replace(/\.[^.]+$/, "");
                    normalizedPath = await join(matchingFolder, `${baseName}_${sfxTargetLufs}lufs.wav`);

                    await normalizeSfxVolume(originalPath, normalizedPath, sfxTargetLufs);
                    processedPaths.set(originalPath, normalizedPath);
                }

                normalizedClips.push({
                    filePath: normalizedPath,
                    startTime: c.exactStartTime!,
                    trimStartSec: c.trimStartSec,
                    trimEndSec: c.trimEndSec,
                });
            }

            // Bước 2: Gửi file đã normalize (loudnorm) cho Resolve
            setRenderProgress(`Đang thêm ${normalizedClips.length} SFX (${sfxTargetLufs} LUFS) vào Resolve...`);

            const result = await addSfxClipsToTimeline(normalizedClips, "SFX - AutoSubs");

            if (result.error) {
                alert("❌ Lỗi: " + (result.message || "Không thể thêm SFX vào timeline"));
            } else {
                alert(`✅ Đã thêm ${result.clipsAdded}/${preciseCues.length} SFX clips (${sfxTargetLufs} LUFS) vào Audio Track A${result.audioTrack} trên DaVinci Resolve!`);
            }
        } catch (error: any) {
            alert("❌ Lỗi: " + String(error));
        } finally {
            setIsRendering(false);
            setRenderProgress("");
        }
    }

    // ======================== FILTER SFX LIBRARY ========================

    const filteredSfxItems = React.useMemo(() => {
        if (!searchQuery.trim()) return sfxItems;
        const q = searchQuery.toLowerCase();
        return sfxItems.filter((item) => {
            if (item.fileName.toLowerCase().includes(q)) return true;
            if (item.aiMetadata) {
                if (item.aiMetadata.description.toLowerCase().includes(q)) return true;
                if (item.aiMetadata.emotion.some(e => e.toLowerCase().includes(q))) return true;
                if (item.aiMetadata.tags.some(t => t.toLowerCase().includes(q))) return true;
            }
            return false;
        });
    }, [sfxItems, searchQuery]);

    // Đếm SFX đã có metadata
    const analyzedCount = sfxItems.filter(i => i.aiMetadata).length;

    // Đếm cues đã gán file
    const assignedCount = sfxPlan?.cues.filter(c => c.assignedSfxPath).length || 0;

    // Đếm cues có whisper timing (exactStartTime từ AI batch)
    const whisperMatchedCount = sfxPlan?.cues.filter(c => c.exactStartTime !== undefined).length || 0;

    // ======================== MANUAL SCAN TOOLS ========================
    const handleRevealInFinder = React.useCallback(async (filePath: string) => {
        try {
            const { Command } = await import('@tauri-apps/plugin-shell');
            await Command.create("exec-sh", ["-c", `open -R "${filePath}"`]).execute();
        } catch (e) {
            console.error("Lỗi khi mở Finder:", e);
        }
    }, []);

    const handleCopyPrompt = React.useCallback(async (_item: AudioLibraryItem) => {
        const prompt = `Phân tích hiệu ứng âm thanh (SFX) này và trả về định dạng JSON chính xác sau (CHỈ TRẢ VỀ JSON, KHÔNG THÊM BẤT KỲ VĂN BẢN NÀO KHÁC):\n{\n  "description": "mô tả ngắn âm thanh (VD: tiếng bùm trầm, gió thổi mạnh)",\n  "tags": ["tag1", "tag2"],\n  "emotion": ["mood1", "mood2"],\n  "intensity": "Cao"\n}`; // "Cao" / "Trung bình" / "Thấp"
        await navigator.clipboard.writeText(prompt);
        // Có thể thêm toast thông báo
    }, []);

    const handlePasteJson = React.useCallback(async (item: AudioLibraryItem) => {
        const jsonStr = window.prompt(`Dán JSON từ Gemini cho file ${item.fileName}:\nVD: {"description":"...","tags":["..."],"emotion":["..."],"intensity":"Cao"}`);
        if (!jsonStr) return;
        try {
            const match = jsonStr.match(/\\{[\\s\\S]*\\}/);
            if (!match) throw new Error("Không tìm thấy dấu {} JSON hợp lệ");
            const parsed = JSON.parse(match[0]);

            const newMeta = {
                description: parsed.description || "Manual",
                tags: Array.isArray(parsed.tags) ? parsed.tags : [],
                emotion: Array.isArray(parsed.emotion) ? parsed.emotion : [],
                intensity: parsed.intensity || "Trung bình",
                timeline: [],
            };

            const newItem: AudioLibraryItem = {
                ...item,
                aiMetadata: newMeta,
                scannedAt: new Date().toISOString()
            };

            const allItems = sfxItems.map(i => i.filePath === item.filePath ? newItem : i);
            
            // Xoá bỏ item cũ khỏi sfxItems state để thay bằng mới (nhưng update bằng hook call custom)
            // Thay vì tự set state, ta gọi updateAudioLibraryItem nếu có hàm đó, hoặc tự save & reload folder
            if (sfxFolder) {
                const { saveAudioItemsToFolder } = await import("@/services/audio-library-service");
                await saveAudioItemsToFolder(sfxFolder, allItems);
                // Dispatch event để reload (có thể setSfxItems trực tiếp)
                // Lưu ý SfxLibraryTab không export trực tiếp setSfxItems ra ngoài mà dùng event,
                // Nhưng ở đây ta có thể dùng trigger "Scan AI" nhẹ hoặc reload:
                window.dispatchEvent(new CustomEvent("sfx-library-updated", { detail: allItems }));
                alert(`✅ Đã cập nhật metadata thủ công cho ${item.fileName}`);
            }
        } catch (e) {
            alert("Lỗi parse JSON: " + String(e));
        }
    }, [sfxItems, sfxFolder]);

    // ======================== RENDER ========================

    return (
        <ScrollArea className="flex-1 min-h-0 h-full">
            <div className="p-4 space-y-4">

                {/* Status dữ liệu kịch bản từ session */}
                <div className="text-xs space-y-0.5">
                    {sentences && sentences.length > 0 ? (
                        <p className="text-green-500">
                            ✅ Kịch bản: {sentences.length} câu (từ session)
                        </p>
                    ) : (
                        <p className="text-yellow-500">
                            ⚠️ Chưa có dữ liệu kịch bản — hãy load session hoặc chạy Matching trước
                        </p>
                    )}
                    {whisperWordsFile ? (
                        <p className="text-green-500">
                            ✅ Whisper Words: {whisperWordsFile.totalWords} words ({whisperWordsFile.totalDuration.toFixed(0)}s)
                        </p>
                    ) : subtitles && subtitles.length > 0 ? (
                        <p className="text-yellow-500">
                            ⚠️ Subtitles không có word-level timestamps
                        </p>
                    ) : null}
                </div>

                {/* ===== SECTION: Thư Viện SFX ===== */}
                <div className="space-y-2 pt-2 border-t">
                    <label className="text-sm font-medium">🎵 Thư Viện SFX</label>

                    {/* Nút chọn thư mục SFX */}
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            className="flex-1 justify-start gap-2 h-9 min-w-0"
                            onClick={handleSelectSfxFolder}
                        >
                            <FolderOpen className="h-4 w-4 shrink-0" />
                            <span className="truncate">
                                {sfxFolder ? sfxFolder.split(/[/\\]/).pop() : "Chọn thư mục SFX trên máy bạn..."}
                            </span>
                        </Button>

                        {/* Nút Save SFX folder */}
                        {sfxFolder && (
                            <Button
                                variant={sfxFolderSaved ? "secondary" : "outline"}
                                size="icon"
                                className={`h-9 w-9 shrink-0 transition-all ${
                                    sfxFolderSaved
                                        ? "bg-green-500/20 border-green-500/40 text-green-400"
                                        : "hover:border-green-500/40 hover:text-green-400"
                                }`}
                                onClick={() => {
                                    saveFolderPath("sfxFolder", sfxFolder)
                                    setSfxFolderSaved(true)
                                    setTimeout(() => setSfxFolderSaved(false), 2000)
                                }}
                                title="Lưu thư mục SFX để dùng lại lần sau"
                            >
                                {sfxFolderSaved ? (
                                    <span className="text-xs">✓</span>
                                ) : (
                                    <Save className="h-3.5 w-3.5" />
                                )}
                            </Button>
                        )}
                    </div>

                    {/* Thống kê SFX library */}
                    {sfxItems.length > 0 && (
                        <div className="flex items-center justify-between">
                            <p className="text-xs text-muted-foreground">
                                🎵 {sfxItems.length} file SFX •{" "}
                                {analyzedCount > 0 && (
                                    <span className="text-green-500">
                                        {analyzedCount} đã phân tích
                                    </span>
                                )}
                                {newFilesCount > 0 && (
                                    <span className="text-yellow-500 ml-1">
                                        • {newFilesCount} file mới
                                    </span>
                                )}
                            </p>

                            {/* Nút Scan AI — chỉ hiện khi có file mới */}
                            {newFilesCount > 0 && (
                                <Button
                                    variant="default"
                                    size="sm"
                                    className="h-7 gap-1 text-xs bg-purple-600 hover:bg-purple-700"
                                    onClick={handleScanAI}
                                    disabled={isScanning}
                                >
                                    {isScanning ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                        <Sparkles className="h-3 w-3" />
                                    )}
                                    Scan AI ({newFilesCount})
                                </Button>
                            )}
                        </div>
                    )}

                    {/* Progress bar + nút Dừng khi đang scan */}
                    {isScanning && scanProgress && (
                        <div className="space-y-1.5">
                            <div className="flex items-center gap-2">
                                <Loader2 className="h-3 w-3 animate-spin text-purple-400 shrink-0" />
                                <p className="text-xs text-purple-400 animate-pulse flex-1 min-w-0 truncate">
                                    {scanProgress.message}
                                </p>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 px-2 gap-1 text-[11px] shrink-0 border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                                    onClick={handleStopScan}
                                >
                                    <StopCircle className="h-3 w-3" />
                                    Dừng
                                </Button>
                            </div>
                            <div className="w-full bg-muted rounded-full h-1.5">
                                <div
                                    className="bg-purple-500 h-1.5 rounded-full transition-all duration-300"
                                    style={{
                                        width: scanProgress.total > 0
                                            ? `${(scanProgress.current / scanProgress.total) * 100}%`
                                            : "0%",
                                    }}
                                />
                            </div>
                        </div>
                    )}

                    {/* === Danh sách SFX library (collapsible) === */}
                    {sfxItems.length > 0 && (
                        <div className="space-y-1.5">
                            <button
                                className="flex items-center gap-1 text-xs font-medium w-full text-left hover:text-primary transition-colors text-muted-foreground"
                                onClick={() => setLibraryExpanded(!libraryExpanded)}
                            >
                                {libraryExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                Xem thư viện SFX ({filteredSfxItems.length})
                            </button>

                            {libraryExpanded && (
                                <>
                                    {/* Thanh tìm kiếm SFX */}
                                    <div className="relative">
                                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                                        <input
                                            type="text"
                                            placeholder="Tìm SFX (tên, tag, mô tả)..."
                                            className="w-full h-7 pl-7 pr-3 rounded-md border border-input bg-background text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                            value={searchQuery}
                                            onChange={(e) => setSearchQuery(e.target.value)}
                                        />
                                    </div>

                                    {/* Danh sách file SFX */}
                                    <div className="space-y-0.5 max-h-40 overflow-y-auto">
                                        {filteredSfxItems.map((item) => (
                                            <SfxFileRow 
                                                key={item.filePath} 
                                                item={item} 
                                                onRevealInFinder={handleRevealInFinder}
                                                onCopyPrompt={handleCopyPrompt}
                                                onPasteJson={handlePasteJson}
                                            />
                                        ))}
                                        {filteredSfxItems.length === 0 && searchQuery && (
                                            <p className="text-[11px] text-muted-foreground text-center py-2">
                                                Không tìm thấy SFX nào khớp "{searchQuery}"
                                            </p>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>

                {/* ===== SECTION: Gợi Ý SFX Để Tải ===== */}
                <div className="space-y-2 pt-2 border-t">
                        <button
                            className="flex items-center gap-1 text-sm font-medium w-full text-left hover:text-primary transition-colors"
                            onClick={() => setKeywordSuggestExpanded(!keywordSuggestExpanded)}
                        >
                            {keywordSuggestExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                            )}
                            <Download className="h-3.5 w-3.5" />
                            Gợi Ý SFX Để Tải
                            {sfxKeywords.length > 0 && (
                                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">
                                    {sfxKeywords.length} keywords
                                </span>
                            )}
                        </button>

                        {keywordSuggestExpanded && (
                            <div className="space-y-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="w-full gap-2"
                                    onClick={handleSuggestKeywords}
                                    disabled={isSuggestingKeywords}
                                >
                                    {isSuggestingKeywords ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <Sparkles className="h-3.5 w-3.5" />
                                    )}
                                    {isSuggestingKeywords
                                        ? "AI đang phân tích..."
                                        : sfxKeywords.length > 0
                                            ? "Gợi ý lại"
                                            : "AI gợi ý ~20 từ khóa SFX cần tải"}
                                </Button>

                                {isSuggestingKeywords && analyzeProgress && (
                                    <p className="text-xs text-blue-400 animate-pulse text-center">
                                        {analyzeProgress}
                                    </p>
                                )}

                                {/* Hiển thị danh sách keywords */}
                                {sfxKeywords.length > 0 && (
                                    <div className="space-y-1">
                                        <p className="text-[11px] text-muted-foreground">
                                            💡 Copy từ khóa → tìm trên{" "}
                                            <a href="https://freesound.org" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Freesound</a>,{" "}
                                            <a href="https://pixabay.com/sound-effects" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Pixabay</a>,{" "}
                                            <a href="https://mixkit.co/free-sound-effects" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Mixkit</a>
                                        </p>

                                        <div className="space-y-0.5 max-h-60 overflow-y-auto">
                                            {sfxKeywords.map((item, idx) => (
                                                <SfxKeywordRow key={`${item}-${idx}`} item={item} index={idx + 1} />
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                {/* ===== SECTION 2: Phân Tích SFX ===== */}
                {sentences && sentences.length > 0 && (
                    <div className="space-y-3 pt-2 border-t">
                        <button
                            className="flex items-center gap-1 text-sm font-medium w-full text-left hover:text-primary transition-colors"
                            onClick={() => setSuggestExpanded(!suggestExpanded)}
                        >
                            {suggestExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                            )}
                            2. Lên Kế Hoạch SFX (Cue Sheet)
                            {sfxPlan && (
                                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/30">
                                    {sfxPlan.cues.length} Cues
                                </span>
                            )}
                        </button>

                        {suggestExpanded && (
                            <div className="space-y-3">
                                <Button
                                    variant="default"
                                    className="w-full gap-2 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 shadow-md text-white"
                                    onClick={handleAnalyzeSFX}
                                    disabled={isAnalyzing}
                                >
                                    {isAnalyzing ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Sparkles className="h-4 w-4" />
                                    )}
                                    {isAnalyzing
                                        ? "Đang lập kế hoạch SFX..."
                                        : sfxPlan
                                            ? "Phân tích lại Kế hoạch SFX"
                                            : "Khởi tạo Phân tích SFX"
                                    }
                                </Button>

                                {isAnalyzing && analyzeProgress && (
                                    <p className="text-xs text-orange-400 animate-pulse text-center">
                                        {analyzeProgress}
                                    </p>
                                )}

                                {analyzeError && (
                                    <p className="text-xs text-red-500 bg-red-500/10 p-2 rounded border border-red-500/20">
                                        ❌ Lỗi: {analyzeError}
                                    </p>
                                )}

                                {/* DANH SÁCH GỢI Ý CUES */}
                                {sfxPlan && sfxPlan.cues.length > 0 && (
                                    <div className="space-y-2 mt-2">

                                        <div className="bg-green-500/10 text-green-500 border border-green-500/20 rounded p-2 text-xs font-medium text-center">
                                            ✅ Đã lên kế hoạch {sfxPlan.cues.length} SFX cues.
                                            {whisperWordsFile
                                                ? " Whisper Words sẵn sàng — timing sẽ chính xác từng từ!"
                                                : " (Load Whisper Words để bắt timing chính xác hơn)"}
                                        </div>

                                        {/* === Slider điều chỉnh mức SFX Volume (LUFS) === */}
                                        <div className="space-y-1.5 pt-1 pb-1">
                                            <div className="flex items-center justify-between">
                                                <label className="text-[11px] text-muted-foreground">🔊 Mức SFX:</label>
                                                <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-muted">
                                                    {sfxTargetLufs} LUFS
                                                    {sfxTargetLufs >= -14 ? " (lớn)" :
                                                     sfxTargetLufs >= -18 ? " (vừa)" :
                                                     sfxTargetLufs >= -22 ? " (nhỏ)" : " (rất nhỏ)"}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-[10px] text-muted-foreground">Nhỏ</span>
                                                <Slider
                                                    min={-30}
                                                    max={-12}
                                                    step={1}
                                                    value={[sfxTargetLufs]}
                                                    onValueChange={(v) => setSfxTargetLufs(v[0])}
                                                    className="flex-1"
                                                />
                                                <span className="text-[10px] text-muted-foreground">Lớn</span>
                                            </div>
                                            <p className="text-[10px] text-muted-foreground">
                                                💡 Voice ~-16 LUFS. SFX nên nhỏ hơn voice 2-8 LUFS để không lấn át giọng nói.
                                            </p>
                                        </div>

                                        {/* === Nút Auto-Assign + Thêm vào Timeline + Render === */}
                                        <div className="flex gap-2 pt-1">
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                className="flex-1"
                                                disabled={sfxItems.length === 0}
                                                onClick={handleAutoAssignSFX}
                                            >
                                                <Zap className="h-4 w-4 mr-1.5" />
                                                Auto-Assign
                                                {whisperWordsFile && (
                                                    <span className="ml-1 text-[9px] opacity-70">(+ Whisper)</span>
                                                )}
                                            </Button>

                                            <Button
                                                variant="default"
                                                size="sm"
                                                className="flex-1 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white"
                                                disabled={whisperMatchedCount === 0 || isRendering}
                                                onClick={handleAddSfxToTimeline}
                                                title={`Thêm ${whisperMatchedCount} SFX có timing chính xác vào Resolve timeline`}
                                            >
                                                {isRendering ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1.5" />}
                                                Vào Timeline ({whisperMatchedCount})
                                            </Button>
                                        </div>

                                        {/* Nút Render file WAV (secondary option) */}
                                        <div className="flex gap-2">
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="flex-1 text-xs"
                                                disabled={assignedCount === 0 || isRendering}
                                                onClick={handleRenderSFX}
                                            >
                                                {isRendering ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1" />}
                                                Render File WAV ({assignedCount})
                                            </Button>
                                        </div>

                                        {/* Thống kê assign */}
                                        {assignedCount > 0 && (
                                            <p className="text-[11px] text-center text-muted-foreground">
                                                {assignedCount}/{sfxPlan.cues.length} cues đã gán file
                                                {whisperMatchedCount > 0 && (
                                                    <span className="text-green-500 ml-1">
                                                        • {whisperMatchedCount} có whisper timing ✓
                                                    </span>
                                                )}
                                            </p>
                                        )}

                                        {isRendering && renderProgress && (
                                            <p className="text-xs text-center text-orange-400 animate-pulse mt-1">{renderProgress}</p>
                                        )}

                                        {/* === Danh sách từng Cue === */}
                                        {sfxPlan.cues.map((cue, idx) => (
                                            <SfxCueItem
                                                key={(cue as SfxCueWithUiKey)._uiKey || idx}
                                                cue={cue}
                                                sentences={sentences}
                                                hasWhisperTiming={cue.exactStartTime !== undefined}
                                            />
                                        ))}
                                    </div>
                                )}

                                {sfxPlan && sfxPlan.cues.length === 0 && (
                                    <p className="text-sm text-muted-foreground text-center py-4 italic">
                                        AI không tìm thấy từ khóa nào thực sự cần thiết phải gán SFX cho kịch bản này.
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </ScrollArea>
    )
}

// ======================== SMART MATCH SFX FILE ========================

/**
 * Tìm file SFX phù hợp nhất cho 1 cue dựa trên AI metadata
 * Ưu tiên: metadata tags → tên file → description → random
 */
function smartMatchSfxFile(cue: SfxCue, sfxItems: AudioLibraryItem[]): AudioLibraryItem | null {
    if (sfxItems.length === 0) return null;

    const keywords = cue.searchKeywords.map(kw => kw.toLowerCase());
    const category = cue.sfxCategory.toLowerCase();

    // Ưu tiên 1: AI metadata tags/emotion khớp searchKeywords hoặc category
    const byMetadata = sfxItems.filter(item => {
        if (!item.aiMetadata) return false;
        const tags = item.aiMetadata.tags.map(t => t.toLowerCase());
        const emotions = item.aiMetadata.emotion.map(e => e.toLowerCase());
        const allMeta = [...tags, ...emotions];

        // Kiểm tra keyword nào khớp
        return keywords.some(kw => allMeta.some(m => m.includes(kw) || kw.includes(m)))
            || allMeta.some(m => m.includes(category));
    });
    if (byMetadata.length > 0) {
        return byMetadata[Math.floor(Math.random() * byMetadata.length)];
    }

    // Ưu tiên 2: Tên file chứa keyword hoặc category
    const byName = sfxItems.filter(item => {
        const name = item.fileName.toLowerCase();
        return keywords.some(kw => name.includes(kw))
            || name.includes(category);
    });
    if (byName.length > 0) {
        return byName[Math.floor(Math.random() * byName.length)];
    }

    // Ưu tiên 3: Description chứa keyword
    const byDesc = sfxItems.filter(item => {
        if (!item.aiMetadata) return false;
        const desc = item.aiMetadata.description.toLowerCase();
        return keywords.some(kw => desc.includes(kw));
    });
    if (byDesc.length > 0) {
        return byDesc[Math.floor(Math.random() * byDesc.length)];
    }

    // Fallback: random
    return sfxItems[Math.floor(Math.random() * sfxItems.length)];
}

// ======================== SUB-COMPONENTS ========================

/**
 * Hiển thị 1 file SFX trong thư viện (compact row)
 */
function SfxFileRow({ 
    item,
    onRevealInFinder,
    onCopyPrompt,
    onPasteJson
}: { 
    item: AudioLibraryItem;
    onRevealInFinder?: (path: string) => void;
    onCopyPrompt?: (item: AudioLibraryItem) => void;
    onPasteJson?: (item: AudioLibraryItem) => void;
}) {
    const meta = item.aiMetadata;
    return (
        <div className={`flex items-center gap-2 px-2 py-1 rounded text-[11px] transition-colors ${
            meta ? "hover:bg-muted/50" : "bg-red-500/5 hover:bg-red-500/10 border border-red-500/10"
        }`}>
            {/* Tên file */}
            <span className="flex-1 min-w-0 truncate text-foreground/80" title={item.fileName}>
                {item.fileName}
            </span>
            {/* Tags (nếu có AI metadata) */}
            {meta && (
                <div className="flex gap-0.5 shrink-0 hidden sm:flex">
                    {meta.tags.slice(0, 3).map((tag, i) => (
                        <span
                            key={i}
                            className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border/30"
                        >
                            {tag}
                        </span>
                    ))}
                </div>
            )}
            {/* Chưa scan -> Hiện công cụ Mở Manual Scan */}
            {!meta && (
                <div className="flex items-center gap-1 shrink-0">
                    <span className="text-[9px] text-red-400/80 mr-1 italic pr-1 border-r border-red-400/30">chưa scan</span>
                    {onRevealInFinder && (
                        <Button
                            variant="ghost" size="sm" className="h-4 w-4 p-0 text-muted-foreground hover:text-blue-400"
                            onClick={() => onRevealInFinder(item.filePath)} title="Mở trong Finder"
                        >
                            <FolderOpen className="h-3 w-3" />
                        </Button>
                    )}
                    {onCopyPrompt && (
                        <Button
                            variant="ghost" size="sm" className="h-4 w-4 p-0 text-muted-foreground hover:text-green-400"
                            onClick={() => onCopyPrompt(item)} title="Copy Prompt gửi Gemini"
                        >
                            <Copy className="h-3 w-3" />
                        </Button>
                    )}
                    {onPasteJson && (
                        <Button
                            variant="ghost" size="sm" className="h-4 w-4 p-0 text-muted-foreground hover:text-orange-400"
                            onClick={() => onPasteJson(item)} title="Nhúng JSON từ Gemini"
                        >
                            <PlusCircle className="h-3 w-3" />
                        </Button>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * Hiển thị 1 SFX cue gợi ý
 */
function SfxCueItem({
    cue,
    sentences,
    hasWhisperTiming
}: {
    cue: SfxCue,
    sentences: { num: number; text: string; start: number; end: number }[],
    hasWhisperTiming: boolean
}) {
    const [copiedKeyword, setCopiedKeyword] = React.useState<string | null>(null)

    // Tìm câu nói chứa Cue
    const sentence = sentences.find(s => s.num === cue.sentenceNum);

    // Hiển thị timing — ưu tiên exactStartTime từ AI batch (chính xác từ whisper words)
    const displayTime = cue.exactStartTime !== undefined
        ? `${cue.exactStartTime.toFixed(2)}s ✓`
        : sentence
            ? `${(sentence.start + (cue.timeOffset || 0)).toFixed(1)}s ~`
            : `Câu ${cue.sentenceNum}`;

    // Màu badge theo category
    const categoryColors: Record<string, string> = {
        impact: "bg-red-500/10 text-red-400 border-red-500/30",
        tension: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
        sub_drop: "bg-purple-500/10 text-purple-400 border-purple-500/30",
        transition: "bg-blue-500/10 text-blue-400 border-blue-500/30",
        emotional: "bg-pink-500/10 text-pink-400 border-pink-500/30",
        reveal: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
        ambient: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
        foley: "bg-slate-500/10 text-slate-400 border-slate-500/30",
    };
    const categoryClass = categoryColors[cue.sfxCategory] || "bg-muted text-muted-foreground border-border/50";

    const handleCopyKeyword = async (keyword: string) => {
        await navigator.clipboard.writeText(keyword);
        setCopiedKeyword(keyword);
        setTimeout(() => setCopiedKeyword(null), 2000);
    }

    return (
        <div className="bg-card/40 border rounded-md p-3 text-sm space-y-2 shadow-sm transition-all hover:bg-card/60">
            {/* Dòng 1: Câu số + Timing + Category badge */}
            <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                    {/* Số câu */}
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border/50">
                        Câu {cue.sentenceNum}
                    </span>
                    {/* Timing chính xác */}
                    <span className={`font-mono text-xs font-semibold px-1.5 py-0.5 rounded ${
                        hasWhisperTiming
                            ? "text-green-400 bg-green-500/10"
                            : "text-orange-400 bg-orange-500/10"
                    }`}>
                        [{displayTime}]
                    </span>
                    {/* triggerWord — từ kích hoạt SFX */}
                    <span className="text-xs text-muted-foreground">🔊 tại</span>
                    <span className="text-xs text-orange-300 font-semibold">"{cue.triggerWord}"</span>
                </div>

                {/* Category badge */}
                <span className={`shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full border ${categoryClass}`}>
                    {cue.sfxCategory}
                </span>
            </div>

            {/* Dòng 2: Nội dung câu */}
            {sentence && (
                <p className="text-xs text-muted-foreground italic leading-relaxed border-l-2 border-muted pl-2 line-clamp-2">
                    {sentence.text}
                </p>
            )}

            {/* Hiển thị file được gán + trim info */}
            {cue.assignedSfxName && (
                <div className="bg-orange-500/10 text-orange-400 border border-orange-500/20 rounded p-1.5 text-xs font-medium mt-2 space-y-0.5">
                    <div className="flex items-center justify-between">
                        <span className="truncate flex-1" title={cue.assignedSfxPath}>🎵 Đã gán: {cue.assignedSfxName}</span>
                    </div>
                    {/* Hiển thị trim nếu AI gợi ý cắt */}
                    {(cue.trimStartSec !== undefined || cue.trimEndSec !== undefined) && (
                        <span className="text-[10px] text-orange-300/70">
                            ✂️ Trim: {cue.trimStartSec?.toFixed(1) ?? "0"}s → {cue.trimEndSec?.toFixed(1) ?? "hết"}s
                        </span>
                    )}
                </div>
            )}

            {/* Keyword Search Tags — chỉ hiện nếu có searchKeywords */}
            <div className="bg-background/50 rounded p-2 mt-1">
                {cue.searchKeywords && cue.searchKeywords.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                        {cue.searchKeywords.map((kw, idx) => (
                            <button
                                key={`${cue.sentenceNum}-${cue.triggerWord}-${kw}-${idx}`}
                                onClick={() => handleCopyKeyword(kw)}
                                className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border transition-colors ${copiedKeyword === kw
                                    ? "bg-green-500/10 text-green-500 border-green-500/30 font-medium"
                                    : "bg-muted text-muted-foreground border-border/50 hover:bg-muted/80 hover:text-foreground"
                                    }`}
                            >
                                {copiedKeyword === kw ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                {kw}
                            </button>
                        ))}
                    </div>
                )}

                <p className="text-[11px] text-muted-foreground">
                    <span className="font-medium">Lý do:</span> {cue.reason}
                </p>
            </div>
        </div>
    )
}

/**
 * Hiển thị 1 keyword SFX gợi ý (compact row)
 * Gồm: số thứ tự, keyword tiếng Anh, nút copy
 */
function SfxKeywordRow({ item, index }: { item: string; index: number }) {
    const [copied, setCopied] = React.useState(false)

    const handleCopy = async () => {
        await navigator.clipboard.writeText(item)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    return (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded text-[11px] hover:bg-muted/50 transition-colors group">
            {/* Số thứ tự */}
            <span className="text-muted-foreground font-mono w-5 text-right shrink-0">
                {index}.
            </span>
            {/* Keyword */}
            <span className="flex-1 min-w-0 font-medium text-foreground">{item}</span>
            {/* Nút copy */}
            <button
                onClick={handleCopy}
                className={`shrink-0 p-1 rounded transition-colors ${
                    copied
                        ? "text-green-500"
                        : "text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
                }`}
                title={`Copy "${item}"`}
            >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </button>
        </div>
    )
}
