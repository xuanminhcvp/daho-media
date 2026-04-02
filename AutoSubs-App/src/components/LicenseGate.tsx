import { useState, useEffect } from 'react';
import { validateLicenseKey, saveLicenseActivated, getDeviceFingerprint } from '@/services/licenseService';

// Lấy tên app
const APP_NAME = "Auto Media";

/**
 * LicenseGate.tsx
 * Màn hình chặn toàn bộ app — chỉ cho vào khi nhập đúng License Key
 * Key được cấp riêng cho từng thiết bị (device fingerprint binding)
 */

interface LicenseGateProps {
    onActivated: () => void;
}

export default function LicenseGate({ onActivated }: LicenseGateProps) {
    const [key, setKey] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [success, setSuccess] = useState(false);
    const [deviceFp, setDeviceFp] = useState<string>("...");
    const [copied, setCopied] = useState(false);

    // Load device fingerprint khi component mount
    useEffect(() => {
        getDeviceFingerprint().then(fp => setDeviceFp(fp));
    }, []);

    const handleCopyFp = () => {
        navigator.clipboard.writeText(deviceFp).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!key.trim()) return;

        setLoading(true);
        setError("");

        try {
            const result = await validateLicenseKey(key);
            if (result.valid) {
                setSuccess(true);
                saveLicenseActivated();
                setTimeout(() => onActivated(), 800);
            } else {
                setError(result.message);
            }
        } catch {
            setError("Lỗi xác thực. Vui lòng thử lại.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={styles.overlay}>
            <div style={styles.card}>
                {/* Header */}
                <div style={styles.header}>
                    <div style={styles.logo}>🛡️</div>
                    <h1 style={styles.title}>{APP_NAME}</h1>
                    <p style={styles.subtitle}>Nhập mã kích hoạt để tiếp tục</p>
                </div>

                {/* Hiển thị Mã thiết bị */}
                <div style={styles.fpBox}>
                    <p style={styles.fpLabel}>📱 Mã thiết bị của bạn:</p>
                    <div style={styles.fpRow}>
                        <code style={styles.fpCode}>{deviceFp}</code>
                        <button onClick={handleCopyFp} style={styles.copyBtn} title="Copy mã thiết bị">
                            {copied ? "✅" : "📋"}
                        </button>
                    </div>
                    <p style={styles.fpHint}>
                        Gửi mã này cho Admin để nhận License Key dành riêng cho máy này
                    </p>
                </div>

                {/* Form nhập key */}
                <form onSubmit={handleSubmit} style={styles.form}>
                    <input
                        type="text"
                        value={key}
                        onChange={e => setKey(e.target.value.toUpperCase())}
                        placeholder="BLAUTO-XXXX-XXXX-XXXXXXXX-XXXXXXXXXXXXXXXX"
                        style={{
                            ...styles.input,
                            ...(error ? styles.inputError : {}),
                            ...(success ? styles.inputSuccess : {}),
                        }}
                        disabled={loading || success}
                        autoFocus
                        spellCheck={false}
                    />

                    {error && (
                        <p style={styles.errorMsg}>{error}</p>
                    )}
                    {success && (
                        <p style={styles.successMsg}>✅ Đang mở ứng dụng...</p>
                    )}

                    <button
                        type="submit"
                        style={{
                            ...styles.button,
                            ...(loading || success ? styles.buttonDisabled : {}),
                        }}
                        disabled={loading || success || !key.trim()}
                    >
                        {loading ? "Đang kiểm tra..." : success ? "✅ Thành công" : "Kích hoạt"}
                    </button>
                </form>

                <p style={styles.footer}>Liên hệ admin để nhận mã kích hoạt</p>
            </div>
        </div>
    );
}


// ======================== STYLES ========================
const styles: Record<string, React.CSSProperties> = {
    overlay: {
        position: "fixed",
        inset: 0,
        background: "linear-gradient(135deg, #0f0f0f 0%, #1a1a2e 50%, #16213e 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        fontFamily: "'Inter', 'Segoe UI', sans-serif",
    },
    card: {
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: "20px",
        padding: "40px 36px",
        width: "100%",
        maxWidth: "480px",
        backdropFilter: "blur(20px)",
        boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
    },
    header: { textAlign: "center", marginBottom: "24px" },
    logo: { fontSize: "44px", marginBottom: "10px", display: "block" },
    title: { color: "#ffffff", fontSize: "26px", fontWeight: "700", margin: "0 0 6px 0", letterSpacing: "-0.5px" },
    subtitle: { color: "rgba(255,255,255,0.5)", fontSize: "14px", margin: 0 },

    // Khung hiển thị mã thiết bị
    fpBox: {
        background: "rgba(99,102,241,0.1)",
        border: "1px solid rgba(99,102,241,0.3)",
        borderRadius: "12px",
        padding: "14px 16px",
        marginBottom: "20px",
    },
    fpLabel: { color: "rgba(255,255,255,0.6)", fontSize: "12px", margin: "0 0 8px 0" },
    fpRow: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" },
    fpCode: {
        color: "#a5b4fc",
        fontSize: "20px",
        fontFamily: "'Courier New', monospace",
        fontWeight: "700",
        letterSpacing: "3px",
        flex: 1,
    },
    copyBtn: {
        background: "transparent",
        border: "none",
        cursor: "pointer",
        fontSize: "18px",
        padding: "4px",
        borderRadius: "6px",
        lineHeight: 1,
    },
    fpHint: { color: "rgba(255,255,255,0.35)", fontSize: "11px", margin: 0, lineHeight: "1.5" },

    form: { display: "flex", flexDirection: "column", gap: "12px" },
    input: {
        background: "rgba(255,255,255,0.07)",
        border: "1px solid rgba(255,255,255,0.15)",
        borderRadius: "10px",
        color: "#ffffff",
        fontSize: "12px",
        fontFamily: "'Courier New', monospace",
        letterSpacing: "0.5px",
        padding: "14px 16px",
        outline: "none",
        width: "100%",
        boxSizing: "border-box",
    },
    inputError: { borderColor: "#ef4444" },
    inputSuccess: { borderColor: "#22c55e" },
    errorMsg: {
        color: "#f87171",
        fontSize: "12px",
        margin: "0",
        textAlign: "center",
        whiteSpace: "pre-line", // Hiển thị multiline error
    },
    successMsg: { color: "#4ade80", fontSize: "13px", margin: "0", textAlign: "center" },
    button: {
        background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
        border: "none",
        borderRadius: "10px",
        color: "#ffffff",
        cursor: "pointer",
        fontSize: "15px",
        fontWeight: "600",
        padding: "14px",
        marginTop: "4px",
    },
    buttonDisabled: { opacity: 0.6, cursor: "not-allowed" },
    footer: {
        color: "rgba(255,255,255,0.3)",
        fontSize: "12px",
        textAlign: "center",
        marginTop: "20px",
        marginBottom: 0,
    },
};
