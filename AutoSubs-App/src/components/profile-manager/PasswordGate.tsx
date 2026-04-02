// PasswordGate.tsx
// Màn hình nhập mã bảo mật (License Key) — bảo vệ cửa vào Profile Manager
// Chỉ chấp nhận License Key được tạo cho danh tính "ADMIN"

import * as React from "react"
import { Lock, Eye, EyeOff, ShieldCheck, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { validateLicenseKey, checkLicenseExists } from "@/services/license-service"

interface PasswordGateProps {
    onSuccess: (password: string) => void  // Trả password về để dùng giải mã AES
    onCancel: () => void
}


export function PasswordGate({ onSuccess, onCancel }: PasswordGateProps) {
    const [password, setPassword] = React.useState("")
    const [showPw, setShowPw] = React.useState(false)
    const [error, setError] = React.useState("")
    const [loading, setLoading] = React.useState(false)
    const inputRef = React.useRef<HTMLInputElement>(null)

    // Auto-check stored license
    React.useEffect(() => {
        setTimeout(() => inputRef.current?.focus(), 100)
        checkLicenseExists().then(info => {
            if (info && info.key) {
                onSuccess(info.key); // Chấp nhận mọi License hợp lệ trong máy
            }
        }).catch(err => console.error("[PasswordGate] Error checking auto-license", err));
    }, [onSuccess])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError("")
        setLoading(true)

        try {
            const key = password.trim().toUpperCase()

            // 1. Kiểm tra bằng Rust backend
            const res = await validateLicenseKey(key)
            if (!res.valid) {
                setError("Mã bảo mật không hợp lệ!")
                return
            }

            // Không check quyền theo identifier nữa

            // Không cần check ID ADMIN nữa, vì user binh thuong cung vao duoc
            onSuccess(key)
        } catch (err) {
            setError("Lỗi hệ thống: " + String(err))
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="flex flex-col items-center justify-center p-6 gap-5">
            <div className="flex flex-col items-center gap-2">
                <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center border border-primary/20">
                    <Lock className="h-5 w-5 text-primary" />
                </div>
                <div className="text-center">
                    <p className="text-sm font-bold text-foreground">Xác nhận Quản Trị Viên</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                        Nhập License Key của ADMIN để truy cập
                    </p>
                </div>
            </div>

            <form onSubmit={handleSubmit} className="w-full space-y-2.5">
                <div className="relative">
                    <input
                        ref={inputRef}
                        type={showPw ? "text" : "password"}
                        placeholder="DAHO-..."
                        value={password}
                        onChange={e => { setPassword(e.target.value); setError("") }}
                        className="
                            w-full h-9 pl-3 pr-9 text-sm rounded-lg font-mono
                            bg-muted/50 border border-border/60 text-foreground
                            placeholder:text-muted-foreground/50 uppercase
                            focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/50
                            transition-all
                        "
                        autoComplete="off"
                    />
                    <button
                        type="button"
                        onClick={() => setShowPw(!showPw)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        tabIndex={-1}
                    >
                        {showPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                </div>

                {error && (
                    <div className="flex items-center justify-center gap-1.5 text-[10px] text-destructive">
                        <AlertCircle className="h-3 w-3 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                <div className="flex gap-2 pt-1">
                    <Button type="button" variant="ghost" size="sm" className="flex-1 h-8 text-xs" onClick={onCancel}>
                        Hủy
                    </Button>
                    <Button type="submit" size="sm" className="flex-1 h-8 text-xs gap-1.5" disabled={loading || !password}>
                        {loading ? <span className="animate-pulse">Đang kiểm tra...</span> : <><ShieldCheck className="h-3 w-3" /> Mở khoá</>}
                    </Button>
                </div>
            </form>
        </div>
    )
}
