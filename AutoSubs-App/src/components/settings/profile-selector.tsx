// profile-selector.tsx
// Nút đổi Profile Video (Documentary, TikTok...)
// Dùng Popover của shadcn/ui. Khi đổi profile, settings lưu lại và app dùng hệ prompt/logics mới

import * as React from "react"
import { Film, Smartphone, Check, LayoutTemplate, Lock, MonitorPlay } from "lucide-react"
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { useSettings } from "@/contexts/SettingsContext"
import { ProfileManagerPanel } from "@/components/profile-manager/ProfileManagerPanel"

const AVAILABLE_PROFILES = [
    { id: "documentary", label: "Documentary", icon: Film, desc: "Video dài, kịch tính, điều tra" },
    { id: "stories", label: "YouTube Stories", icon: MonitorPlay, desc: "Video dài ngang, phong cách kể chuyện" },
    { id: "tiktok", label: "TikTok (Old)", icon: Smartphone, desc: "Giữ lại bản cũ dự phòng" },
]

export function ProfileSelector() {
    const { settings, updateSetting } = useSettings()
    const [open, setOpen] = React.useState(false)
    // State mở Profile Manager (có mật khẩu bảo vệ)
    const [managerOpen, setManagerOpen] = React.useState(false)

    const currentProfileId = settings?.activeProfile || "documentary"

    const handleSelectProfile = async (profileId: string) => {
        updateSetting("activeProfile", profileId)
        setOpen(false)
    }

    const currentProfile = AVAILABLE_PROFILES.find(p => p.id === currentProfileId) || AVAILABLE_PROFILES[0]

    return (
        <>
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-2 text-[10px] font-medium rounded-full transition-all text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/15"
                    data-tauri-drag-region="false"
                    title={`Video Profile: ${currentProfile.label}`}
                >
                    <LayoutTemplate className="h-3 w-3 shrink-0" />
                    <span>{currentProfile.label}</span>
                </Button>
            </PopoverTrigger>

            <PopoverContent className="w-[240px] p-0" align="end" sideOffset={6}>
                <div className="px-3 py-1.5 border-b border-border/50 bg-emerald-500/5 flex items-center gap-1.5">
                    <LayoutTemplate className="h-3 w-3 text-emerald-400" />
                    <span className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider flex-1">
                        Video Profile
                    </span>
                </div>

                <div className="py-1">
                    {AVAILABLE_PROFILES.map(profile => {
                        const isSelected = profile.id === currentProfileId
                        const Icon = profile.icon

                        return (
                            <button
                                key={profile.id}
                                onClick={() => handleSelectProfile(profile.id)}
                                className={`
                                    w-full flex items-center gap-2 px-3 py-2 text-xs text-left
                                    transition-colors duration-100 cursor-pointer
                                    ${isSelected
                                        ? "bg-emerald-500/15 text-emerald-300"
                                        : "hover:bg-accent text-foreground/80 hover:text-foreground"
                                    }
                                `}
                            >
                                <span className="w-4 flex justify-center shrink-0">
                                    {isSelected ? (
                                        <Check className="h-3 w-3 text-emerald-400" />
                                    ) : (
                                        <Icon className="h-3 w-3 opacity-50" />
                                    )}
                                </span>
                                <span className="flex-1">
                                    <span className="font-medium">{profile.label}</span>
                                    <span className="block text-[9px] text-muted-foreground mt-0.5">
                                        {profile.desc}
                                    </span>
                                </span>
                            </button>
                        )
                    })}
                </div>

                {/* Footer + nút mở ProfileManager (kín đáo) */}
                <div className="px-3 py-1.5 border-t border-border/50 bg-muted/20 flex items-center gap-2">
                    <p className="text-[9px] text-muted-foreground flex-1">
                        Profile quyết định luồng <strong>prompt/UI</strong> cho dạng video sẽ được tạo.
                    </p>
                    {/* Nút mở Profile Manager — nhỏ kín đáo */}
                    <button
                        id="profile-manager-lock-btn"
                        onClick={() => { setOpen(false); setManagerOpen(true) }}
                        title="Quản lý Profile (Bảo mật)"
                        className="
                            text-muted-foreground/40 hover:text-muted-foreground
                            p-1 rounded hover:bg-muted/50 transition-colors
                        "
                    >
                        <Lock className="h-3 w-3" />
                    </button>
                </div>

            </PopoverContent>
        </Popover>

        <ProfileManagerPanel
            open={managerOpen}
            onOpenChange={setManagerOpen}
        />
        </>
    )
}
