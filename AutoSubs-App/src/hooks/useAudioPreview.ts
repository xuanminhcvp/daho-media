// useAudioPreview.ts
// Custom hook quản lý việc preview (nghe thử) nhạc nền
// - Chỉ phát 1 bài tại 1 thời điểm
// - Hỗ trợ play / pause / stop
// - Tracking thời gian hiện tại + tổng thời gian
// - Dùng HTML5 Audio API + Tauri asset protocol để đọc file local

import { useState, useRef, useCallback, useEffect } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"

export interface AudioPreviewState {
    /** Đường dẫn file đang phát (null = không phát gì) */
    currentFilePath: string | null
    /** Đang phát hay đang tạm dừng */
    isPlaying: boolean
    /** Thời gian hiện tại (giây) */
    currentTime: number
    /** Tổng thời lượng (giây) */
    duration: number
}

export interface UseAudioPreviewReturn {
    /** State hiện tại */
    state: AudioPreviewState
    /** Bấm play/pause cho 1 file — nếu file khác đang phát thì dừng bài cũ */
    togglePlay: (filePath: string) => void
    /** Dừng hẳn (stop) */
    stop: () => void
    /** Seek đến vị trí cụ thể (giây) */
    seek: (time: number) => void
}

/**
 * Hook quản lý audio preview
 * Dùng 1 instance Audio duy nhất, tái sử dụng cho các file khác nhau
 */
export function useAudioPreview(): UseAudioPreviewReturn {
    // State chính
    const [state, setState] = useState<AudioPreviewState>({
        currentFilePath: null,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
    })

    // Ref giữ Audio element — không tạo mới mỗi lần render
    const audioRef = useRef<HTMLAudioElement | null>(null)
    // Ref giữ animation frame ID để cleanup
    const rafRef = useRef<number | null>(null)

    // Hàm cập nhật thời gian liên tục (dùng requestAnimationFrame cho mượt)
    const updateTime = useCallback(() => {
        const audio = audioRef.current
        if (audio && !audio.paused) {
            setState((prev) => ({
                ...prev,
                currentTime: audio.currentTime,
                duration: audio.duration || 0,
            }))
            rafRef.current = requestAnimationFrame(updateTime)
        }
    }, [])

    // Cleanup khi component unmount
    useEffect(() => {
        return () => {
            // Dừng phát nhạc
            if (audioRef.current) {
                audioRef.current.pause()
                audioRef.current.src = ""
            }
            // Huỷ animation frame
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current)
            }
        }
    }, [])

    /**
     * Toggle play/pause cho 1 file cụ thể:
     * - Nếu file đó đang phát → pause
     * - Nếu file đó đang pause → resume
     * - Nếu file khác đang phát → dừng bài cũ, phát bài mới
     */
    const togglePlay = useCallback(
        (filePath: string) => {
            // Tạo audio element nếu chưa có
            if (!audioRef.current) {
                audioRef.current = new Audio()
            }
            const audio = audioRef.current

            // Nếu đang phát chính file này → toggle pause/play
            if (state.currentFilePath === filePath) {
                if (audio.paused) {
                    audio.play()
                    setState((prev) => ({ ...prev, isPlaying: true }))
                    rafRef.current = requestAnimationFrame(updateTime)
                } else {
                    audio.pause()
                    setState((prev) => ({ ...prev, isPlaying: false }))
                    if (rafRef.current) cancelAnimationFrame(rafRef.current)
                }
                return
            }

            // Nếu file khác → dừng bài cũ, load bài mới
            if (rafRef.current) cancelAnimationFrame(rafRef.current)

            // Chuyển file path thành URL asset cho Tauri webview
            const assetUrl = convertFileSrc(filePath)
            audio.src = assetUrl
            audio.currentTime = 0

            // Khi đã load đủ metadata (biết duration) → phát
            audio.onloadedmetadata = () => {
                setState({
                    currentFilePath: filePath,
                    isPlaying: true,
                    currentTime: 0,
                    duration: audio.duration || 0,
                })
                audio.play()
                rafRef.current = requestAnimationFrame(updateTime)
            }

            // Khi phát xong → reset về trạng thái dừng
            audio.onended = () => {
                setState((prev) => ({
                    ...prev,
                    isPlaying: false,
                    currentTime: 0,
                }))
                if (rafRef.current) cancelAnimationFrame(rafRef.current)
            }

            // Xử lý lỗi (file không đọc được, codec không hỗ trợ...)
            audio.onerror = () => {
                console.error("[AudioPreview] Không thể phát file:", filePath)
                setState({
                    currentFilePath: null,
                    isPlaying: false,
                    currentTime: 0,
                    duration: 0,
                })
            }
        },
        [state.currentFilePath, updateTime]
    )

    /** Dừng hoàn toàn */
    const stop = useCallback(() => {
        if (audioRef.current) {
            audioRef.current.pause()
            audioRef.current.currentTime = 0
        }
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        setState({
            currentFilePath: null,
            isPlaying: false,
            currentTime: 0,
            duration: 0,
        })
    }, [])

    /** Seek đến vị trí (giây) */
    const seek = useCallback((time: number) => {
        if (audioRef.current) {
            audioRef.current.currentTime = time
            setState((prev) => ({ ...prev, currentTime: time }))
        }
    }, [])

    return { state, togglePlay, stop, seek }
}
