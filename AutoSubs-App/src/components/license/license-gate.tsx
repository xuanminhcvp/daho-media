// license-gate.tsx
// ============================================================
// Màn hình nhập License Key — chặn toàn bộ app cho đến khi kích hoạt
// Hiển thị khi mở app lần đầu (hoặc khi chưa có license trong store)
// Sau khi kích hoạt thành công → ẩn đi, hiển thị app bình thường
// ============================================================

import * as React from "react"
import { KeyRound, Loader2, CheckCircle2, XCircle, Shield } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
    checkLicenseExists,
    validateLicenseKey,
    saveLicenseKey,
} from "@/services/license-service"

// ======================== PROPS ========================
interface LicenseGateProps {
    /** Nội dung app (chỉ hiển thị khi đã kích hoạt) */
    children: React.ReactNode;
}

// ======================== COMPONENT ========================
export function LicenseGate({ children }: LicenseGateProps) {
    // State: đang kiểm tra license hay chưa
    const [checking, setChecking] = React.useState(true);
    // State: đã kích hoạt chưa
    const [activated, setActivated] = React.useState(false);
    // State: key user đang nhập
    const [inputKey, setInputKey] = React.useState("");
    // State: đang xác thực key
    const [validating, setValidating] = React.useState(false);
    // State: kết quả xác thực
    const [result, setResult] = React.useState<{ valid: boolean; message: string } | null>(null);

    // === Kiểm tra license khi mở app ===
    React.useEffect(() => {
        async function check() {
            try {
                const info = await checkLicenseExists();
                if (info) {
                    // Đã có license trong store → vào app thẳng
                    setActivated(true);
                }
            } catch (err) {
                console.error("[LicenseGate] Lỗi kiểm tra license:", err);
            } finally {
                setChecking(false);
            }
        }
        check();
    }, []);

    // === Xử lý khi user bấm "Kích hoạt" ===
    const handleActivate = async () => {
        if (!inputKey.trim()) return;

        setValidating(true);
        setResult(null);

        try {
            // Gọi Rust backend kiểm tra key bằng HMAC
            const res = await validateLicenseKey(inputKey.trim());

            if (res.valid) {
                // Key hợp lệ → lưu vào store
                await saveLicenseKey(inputKey.trim());
                setResult(res);
                // Delay 1.5s cho user thấy thông báo xanh rồi mới vào app
                setTimeout(() => {
                    setActivated(true);
                }, 1500);
            } else {
                setResult(res);
            }
        } catch (err) {
            setResult({
                valid: false,
                message: `Lỗi hệ thống: ${err}`,
            });
        } finally {
            setValidating(false);
        }
    };

    // === Enter để kích hoạt ===
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !validating) {
            handleActivate();
        }
    };

    // Đang kiểm tra license lúc khởi động
    if (checking) {
        return (
            <div className="fixed inset-0 flex items-center justify-center bg-background z-[9999]">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    // Đã kích hoạt → hiển thị app bình thường
    if (activated) {
        return <>{children}</>;
    }

    // === Màn hình nhập License Key ===
    return (
        <div className="fixed inset-0 flex items-center justify-center bg-background z-[9999]">
            <div className="w-full max-w-md mx-auto px-6">
                {/* Card chính */}
                <div className="rounded-2xl border bg-card shadow-2xl overflow-hidden">
                    {/* Header gradient */}
                    <div className="bg-gradient-to-br from-indigo-500/10 via-purple-500/10 to-pink-500/10 px-8 pt-10 pb-8 text-center">
                        {/* Icon shield */}
                        <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25 mb-5">
                            <Shield className="h-8 w-8 text-white" />
                        </div>

                        <h1 className="text-2xl font-bold tracking-tight">DahoMedia</h1>
                        <p className="text-sm text-muted-foreground mt-2">
                            Nhập License Key để kích hoạt phần mềm
                        </p>
                    </div>

                    {/* Form nhập key */}
                    <div className="px-8 pb-8 pt-6 space-y-5">
                        {/* Input */}
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-foreground">
                                License Key
                            </label>
                            <div className="relative">
                                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                <input
                                    type="text"
                                    value={inputKey}
                                    onChange={(e) => setInputKey(e.target.value.toUpperCase())}
                                    onKeyDown={handleKeyDown}
                                    placeholder="DAHO-XXXX-XXXX-XXXX"
                                    disabled={validating}
                                    className="w-full rounded-lg border bg-background px-10 py-3 text-sm font-mono tracking-wider placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 disabled:opacity-50 transition-all"
                                    autoFocus
                                />
                            </div>
                        </div>

                        {/* Kết quả xác thực */}
                        {result && (
                            <div className={`flex items-start gap-2.5 rounded-lg px-4 py-3 text-sm ${
                                result.valid
                                    ? "bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20"
                                    : "bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20"
                            }`}>
                                {result.valid ? (
                                    <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                                ) : (
                                    <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                                )}
                                <span>{result.message}</span>
                            </div>
                        )}

                        {/* Nút kích hoạt */}
                        <Button
                            onClick={handleActivate}
                            disabled={!inputKey.trim() || validating}
                            className="w-full h-11 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-medium shadow-lg shadow-indigo-500/25 transition-all"
                        >
                            {validating ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                    Đang xác thực...
                                </>
                            ) : (
                                <>
                                    <KeyRound className="h-4 w-4 mr-2" />
                                    Kích hoạt
                                </>
                            )}
                        </Button>

                        {/* Footer note */}
                        <p className="text-xs text-center text-muted-foreground/60">
                            Liên hệ admin để nhận License Key
                        </p>
                    </div>
                </div>

                {/* Branding */}
                <p className="text-center text-xs text-muted-foreground/40 mt-6">
                    DahoMedia © 2026 • Internal Use Only
                </p>
            </div>
        </div>
    );
}
