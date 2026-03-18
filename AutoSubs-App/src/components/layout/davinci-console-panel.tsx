// =====================================================
// davinci-console-panel.tsx
// Nút copy mã Lua 1 chạm — paste thẳng vào DaVinci Console
// =====================================================
import * as React from "react"
import { Check, Copy, Terminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { resourceDir } from "@tauri-apps/api/path"

// Tạo mã Lua từ đường dẫn resources (tự detect dev/production)
function buildLuaCode(resPath: string): string {
    // Clear module cache + dofile — đảm bảo reload mỗi lần chạy
    return `package.loaded["init"]=nil;package.loaded["helpers"]=nil;package.loaded["timeline_info"]=nil;package.loaded["template_manager"]=nil;package.loaded["audio_export"]=nil;package.loaded["subtitle_renderer"]=nil;package.loaded["media_import"]=nil;package.loaded["preview_generator"]=nil;package.loaded["motion_effects"]=nil;package.loaded["server"]=nil;dofile("${resPath}/AutoSubs.lua")`
}

export function DaVinciConsolePanel() {
    const [copied, setCopied] = React.useState(false)
    const [luaCode, setLuaCode] = React.useState("")

    // Lấy đường dẫn resources khi component mount
    React.useEffect(() => {
        resourceDir()
            .then((dir) => {
                // Tauri resourceDir() trả về Contents/Resources/
                // File thực tế nằm trong Contents/Resources/resources/
                const cleanPath = dir.endsWith("/") ? dir.slice(0, -1) : dir
                const fullPath = cleanPath + "/resources"
                setLuaCode(buildLuaCode(fullPath))
            })
            .catch(() => {
                // Fallback production path nếu API lỗi
                setLuaCode(buildLuaCode("/Applications/AutoSubs_Media.app/Contents/Resources/resources"))
            })
    }, [])

    // Copy mã vào clipboard → hiệu ứng ✓ 1.5s
    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(luaCode)
        } catch {
            const el = document.createElement("textarea")
            el.value = luaCode
            document.body.appendChild(el)
            el.select()
            document.execCommand("copy")
            document.body.removeChild(el)
        }
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
    }

    return (
        <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            className={`w-full h-9 text-xs gap-2 transition-all duration-200 border-dashed ${
                copied
                    ? "border-green-500 text-green-400 bg-green-500/10 hover:bg-green-500/15"
                    : "border-amber-500/50 text-amber-300 bg-amber-500/5 hover:bg-amber-500/15"
            }`}
        >
            {copied ? (
                <><Check className="h-3.5 w-3.5" /> Đã copy! Paste vào Console (Lua) → Ctrl+Enter</>
            ) : (
                <><Terminal className="h-3.5 w-3.5" /><Copy className="h-3 w-3 -ml-1" /> Copy mã kết nối DaVinci</>
            )}
        </Button>
    )
}

