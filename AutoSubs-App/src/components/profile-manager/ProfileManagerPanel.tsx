// ProfileManagerPanel.tsx
// Dialog chính của Profile Manager — điều phối PasswordGate + ProfileList + PromptEditor
// Được mở từ nút 🔐 nhỏ kín đáo trong ProfileSelector

import * as React from "react"
import { Plus, Trash2, ChevronRight, Film, Smartphone, BookOpen, Video, Star, Zap, MonitorPlay } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { PasswordGate } from "@/components/profile-manager/PasswordGate"
import { PromptEditor } from "@/components/profile-manager/PromptEditor"
import {
    loadAllCustomProfiles,
    saveCustomProfile,
    deleteCustomProfile,
    createNewProfile,
    type CustomProfile,
} from "@/services/profile-storage"
import { useSettings } from "@/contexts/SettingsContext"

// Map icon name → Lucide component
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
    Film, Smartphone, BookOpen, Video, Star, Zap, MonitorPlay
}


// ======================== PROPS ========================
interface ProfileManagerPanelProps {
    open: boolean
    onOpenChange: (open: boolean) => void
}

// ======================== MAIN COMPONENT ========================
export function ProfileManagerPanel({ open, onOpenChange }: ProfileManagerPanelProps) {
    const { updateSetting } = useSettings()

    // ── State chính của luồng UI ──
    type Step = "gate" | "list" | "editor"
    const [step, setStep] = React.useState<Step>("gate")

    // Mật khẩu đang dùng trong session (KHÔNG persist)
    const [sessionPassword, setSessionPassword] = React.useState<string | null>(null)

    const [profiles, setProfiles] = React.useState<CustomProfile[]>([])
    const [editingProfile, setEditingProfile] = React.useState<CustomProfile | null>(null)
    const [loading, setLoading] = React.useState(false)
    const [deleteConfirm, setDeleteConfirm] = React.useState<string | null>(null)

    // ── Khi dialog mở: luôn mở cổng ──
    React.useEffect(() => {
        if (!open) {
            // Khi đóng: reset toàn bộ state để logout
            setStep("gate")
            setSessionPassword(null)
            setEditingProfile(null)
            return
        }
        setStep("gate")
    }, [open])

    // ── Sau khi unlock thành công: load danh sách profiles ──
    const handleUnlocked = async (password: string) => {
        setSessionPassword(password)
        setLoading(true)
        try {
            const loaded = await loadAllCustomProfiles(password)
            setProfiles(loaded)
        } catch (e) {
            console.error("[ProfileManager] Lỗi load profiles:", e)
        } finally {
            setLoading(false)
        }
        setStep("list")
    }

    // ── Thêm profile mới ──
    const handleAddProfile = async () => {
        const id = `profile_${Date.now()}`
        const newProfile = createNewProfile(id, "Profile Mới")
        
        // Load một số template mẫu có sẵn từ documentary để user có sườn edit
        const { loadDefaultPrompts } = await import("@/services/profile-storage")
        const defaultPrompts = await loadDefaultPrompts("documentary")
        newProfile.prompts = { ...newProfile.prompts, ...defaultPrompts }
        
        setEditingProfile(newProfile)
        setStep("editor")
    }

    // ── Mở editor cho profile có sẵn ──
    const handleEditProfile = (profile: CustomProfile) => {
        setEditingProfile({ ...profile })
        setStep("editor")
    }

    // ── Lưu profile từ editor ──
    const handleSaveProfile = async (updated: CustomProfile) => {
        if (!sessionPassword) return
        await saveCustomProfile(updated, sessionPassword)
        // Cập nhật danh sách local
        setProfiles(prev => {
            const idx = prev.findIndex(p => p.id === updated.id)
            if (idx >= 0) {
                const next = [...prev]
                next[idx] = updated
                return next
            }
            return [...prev, updated]
        })
    }

    // ── Xóa profile ──
    const handleDeleteProfile = async (profileId: string) => {
        await deleteCustomProfile(profileId)
        if (sessionPassword) {
            const loaded = await loadAllCustomProfiles(sessionPassword)
            setProfiles(loaded)
        }
        setDeleteConfirm(null)
    }

    // ── Kích hoạt profile (đặt là activeProfile) ──
    const handleActivateProfile = (profileId: string) => {
        updateSetting("activeProfile", profileId)
    }

    // ======================== RENDER ========================
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className={`
                    p-0 gap-0 overflow-hidden
                    ${step === "editor"
                        ? "max-w-3xl h-[80vh]"
                        : "max-w-sm"
                    }
                `}
            >
                <DialogHeader className="hidden">
                    <DialogTitle>Profile Manager</DialogTitle>
                </DialogHeader>

                {/* ── Step 1: Nhập mật khẩu ── */}
                {step === "gate" && (
                    <PasswordGate
                        onSuccess={handleUnlocked}
                        onCancel={() => onOpenChange(false)}
                    />
                )}

                {/* ── Step 2: Danh sách profiles ── */}
                {step === "list" && (
                    <div className="flex flex-col">
                        {/* Header */}
                        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/40">
                            <div className="flex-1">
                                <p className="text-sm font-bold text-foreground">Quản lý Video Profile</p>
                                <p className="text-[9px] text-muted-foreground mt-0.5">
                                    {profiles.length} profile • Mã hóa AES-256
                                </p>
                            </div>
                            <Button
                                size="sm"
                                className="h-7 px-2.5 text-xs gap-1"
                                onClick={handleAddProfile}
                            >
                                <Plus className="h-3 w-3" />
                                Thêm
                            </Button>
                        </div>

                        {/* Danh sách */}
                        <div className="py-1 max-h-80 overflow-y-auto">
                            {loading ? (
                                <p className="text-center text-xs text-muted-foreground py-6 animate-pulse">
                                    Đang giải mã...
                                </p>
                            ) : profiles.length === 0 ? (
                                <div className="flex flex-col items-center gap-2 py-8 px-4 text-center">
                                    <p className="text-xs text-muted-foreground">Chưa có profile nào</p>
                                    <p className="text-[9px] text-muted-foreground/50">
                                        Nhấn "Thêm" để tạo profile đầu tiên
                                    </p>
                                </div>
                            ) : (
                                profiles.map(profile => {
                                    const IconComp = ICON_MAP[profile.icon] || Film
                                    const isDeleting = deleteConfirm === profile.id
                                    return (
                                        <div
                                            key={profile.id}
                                            className="flex items-center gap-2 px-4 py-2 hover:bg-muted/30 transition-colors group"
                                        >
                                            {/* Icon */}
                                            <div className="h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                                                <IconComp className="h-3.5 w-3.5 text-primary" />
                                            </div>

                                            {/* Info */}
                                            <div className="flex-1 min-w-0">
                                                <p className="text-xs font-semibold text-foreground truncate">{profile.label}</p>
                                                <p className="text-[9px] text-muted-foreground truncate">{profile.desc || profile.id}</p>
                                            </div>

                                            {/* Actions */}
                                            {isDeleting ? (
                                                <div className="flex items-center gap-1">
                                                    <span className="text-[9px] text-destructive">Xóa?</span>
                                                    <button
                                                        onClick={() => handleDeleteProfile(profile.id)}
                                                        className="text-[9px] text-destructive font-bold hover:underline px-1"
                                                    >Có</button>
                                                    <button
                                                        onClick={() => setDeleteConfirm(null)}
                                                        className="text-[9px] text-muted-foreground hover:underline px-1"
                                                    >Không</button>
                                                </div>
                                            ) : (
                                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    {/* Kích hoạt */}
                                                    <button
                                                        onClick={() => handleActivateProfile(profile.id)}
                                                        title="Đặt làm profile đang dùng"
                                                        className="text-[9px] text-emerald-400 hover:text-emerald-300 px-1.5 py-0.5 rounded hover:bg-emerald-500/10"
                                                    >
                                                        Dùng
                                                    </button>
                                                    {/* Xóa */}
                                                    <button
                                                        onClick={() => setDeleteConfirm(profile.id)}
                                                        className="text-muted-foreground hover:text-destructive p-1 rounded hover:bg-destructive/10 transition-colors"
                                                    >
                                                        <Trash2 className="h-3 w-3" />
                                                    </button>
                                                    {/* Mở editor */}
                                                    <button
                                                        onClick={() => handleEditProfile(profile)}
                                                        className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/50 transition-colors"
                                                    >
                                                        <ChevronRight className="h-3 w-3" />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )
                                })
                            )}
                        </div>

                        {/* Footer */}
                        <div className="px-4 py-2.5 border-t border-border/30 bg-muted/10">
                            <p className="text-[9px] text-muted-foreground/50">
                                Session này đã mở khoá. Đóng cửa sổ để thoát.
                            </p>
                        </div>
                    </div>
                )}

                {/* ── Step 3: Editor prompt ── */}
                {step === "editor" && editingProfile && (
                    <PromptEditor
                        profile={editingProfile}
                        onSave={async (updated) => {
                            await handleSaveProfile(updated)
                        }}
                        onCancel={() => setStep("list")}
                    />
                )}
            </DialogContent>
        </Dialog>
    )
}
