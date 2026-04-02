// profile-crypto.ts
// Lớp mã hóa/giải mã AES-256-GCM cho Profile Prompt
//
// Thuật toán:
//   - PBKDF2: tạo khoá AES từ mật khẩu (100.000 vòng iterration, chống brute-force)
//   - AES-256-GCM: mã hóa authenticated (vừa bảo mật vừa kiểm tra toàn vẹn dữ liệu)
//   - SHA-256: hash mật khẩu để verify mà không lưu mật khẩu thật
//   - Tất cả dùng Web Crypto API chuẩn (built-in, không cần thư viện ngoài)

// ======================== HẰNG SỐ ========================
const PBKDF2_ITERATIONS = 100_000;  // 100k vòng lặp — chống brute-force
const SALT_LENGTH = 16;              // 16 bytes salt ngẫu nhiên
const IV_LENGTH = 12;                // 12 bytes IV cho AES-GCM (chuẩn)
const KEY_LENGTH = 256;              // AES-256

// ======================== HELPER: ArrayBuffer <-> Base64 ========================

/**
 * Chuyển ArrayBuffer thành chuỗi Base64 (để lưu vào file text)
 */
function bufToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Chuyển chuỗi Base64 thành ArrayBuffer (để giải mã)
 */
function base64ToBuf(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// ======================== HASH MẬT KHẨU (để verify login) ========================

/**
 * Hash mật khẩu bằng SHA-256 (để lưu vào Tauri Store — không lưu mật khẩu thật)
 * Mỗi lần đăng nhập: hash lại rồi so sánh với hash đã lưu.
 *
 * @param password - Mật khẩu sếp nhập
 * @returns Chuỗi hex SHA-256 (64 ký tự)
 */
export async function hashPassword(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ======================== TẠO KHOÁ AES TỪ MẬT KHẨU ========================

/**
 * Tạo khoá AES-256 từ mật khẩu bằng PBKDF2
 * Mỗi lần gọi với cùng password + salt → ra khoá giống nhau
 * (Salt ngẫu nhiên → bảo vệ khỏi rainbow table attack)
 *
 * @param password - Mật khẩu
 * @param salt - Salt ngẫu nhiên (tạo khi mã hóa lần đầu, lưu kèm file)
 * @returns CryptoKey để dùng với AES-GCM
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const passwordKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );

    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt as any,
            iterations: PBKDF2_ITERATIONS,
            hash: "SHA-256",
        },
        passwordKey,
        { name: "AES-GCM", length: KEY_LENGTH },
        false,
        ["encrypt", "decrypt"]
    );
}

// ======================== MÃ HÓA / GIẢI MÃ ========================

/**
 * Mã hóa text thành chuỗi base64 an toàn
 * Format đầu ra: "base64(salt):base64(iv):base64(ciphertext)"
 * → Lưu tất cả thông tin cần giải mã trong 1 chuỗi duy nhất
 *
 * @param plaintext - Nội dung JSON cần mã hóa (prompt, config...)
 * @param password  - Mật khẩu của sếp
 * @returns Chuỗi mã hóa dạng base64 (an toàn lưu vào file)
 */
export async function encryptData(plaintext: string, password: string): Promise<string> {
    // Tạo salt và IV ngẫu nhiên mới mỗi lần mã hóa
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv   = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

    // Tạo khoá từ mật khẩu + salt
    const key = await deriveKey(password, salt);

    // Mã hóa
    const encoder = new TextEncoder();
    const encryptedBuf = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        encoder.encode(plaintext)
    );

    // Ghép: salt:iv:ciphertext dạng base64
    return `${bufToBase64(salt.buffer as ArrayBuffer)}:${bufToBase64(iv.buffer as ArrayBuffer)}:${bufToBase64(encryptedBuf)}`;
}

/**
 * Giải mã chuỗi đã mã hóa về nội dung gốc
 * Trả về null nếu mật khẩu sai hoặc dữ liệu bị hỏng
 *
 * @param encryptedData - Chuỗi "salt:iv:ciphertext" từ encryptData()
 * @param password      - Mật khẩu của sếp
 * @returns Nội dung gốc (JSON string) hoặc null nếu giải mã thất bại
 */
export async function decryptData(encryptedData: string, password: string): Promise<string | null> {
    try {
        const parts = encryptedData.split(":");
        if (parts.length !== 3) return null;

        const [saltB64, ivB64, cipherB64] = parts;
        const salt       = base64ToBuf(saltB64);
        const iv         = base64ToBuf(ivB64);
        const cipherBuf  = base64ToBuf(cipherB64);

        // Tạo lại khoá từ mật khẩu + salt đã lưu
        const key = await deriveKey(password, salt);

        // Giải mã — sẽ throw nếu mật khẩu sai (AES-GCM authentication fail)
        const decryptedBuf = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv as any },
            key,
            cipherBuf as any
        );

        const decoder = new TextDecoder();
        return decoder.decode(decryptedBuf);
    } catch {
        // AES-GCM throw khi dữ liệu bị giả mạo hoặc mật khẩu sai
        return null;
    }
}

/**
 * Kiểm tra mật khẩu có đúng không bằng cách giải mã 1 file sample
 * Dùng để verify khi đăng nhập lại
 *
 * @param storedHash - Hash SHA-256 đã lưu trong Tauri Store
 * @param inputPassword - Mật khẩu sếp vừa nhập
 */
export async function verifyPassword(storedHash: string, inputPassword: string): Promise<boolean> {
    const inputHash = await hashPassword(inputPassword);
    return inputHash === storedHash;
}
