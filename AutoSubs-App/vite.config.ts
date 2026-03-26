import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path"
// Plugin obfuscation: làm rối code JS khi build production
// → user không đọc được source code trong app bundle
import obfuscatorPlugin from "vite-plugin-obfuscator";

const host = (process.env.TAURI_DEV_HOST as string) || undefined;

// Kiểm tra có đang build production không
const isProduction = process.env.NODE_ENV === "production";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    // Chỉ bật obfuscation khi build production
    // Khi dev: không obfuscate (để debug dễ dàng)
    ...(isProduction ? [obfuscatorPlugin({
      options: {
        // Làm rối tên biến/function → không đọc được
        renameGlobals: false,
        // ⚠️ MÃ HÓA 100% string literals (đặc biệt quan trọng cho prompts!)
        // RC4 encrypt tất cả chuỗi text → không ai đọc được nội dung prompt
        stringArray: true,
        stringArrayEncoding: ["rc4"],
        stringArrayThreshold: 1, // 100% strings bị mã hóa (bao gồm prompts)
        // Xáo trộn vị trí string trong mảng
        stringArrayRotate: true,
        stringArrayShuffle: true,
        // Ẩn ký tự unicode (tiếng Việt trong prompts)
        unicodeEscapeSequence: true,
        // Thêm dead code để gây nhiễu
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 0.3,
        // Chặn debug tools
        debugProtection: false, // set true nếu muốn chặn DevTools
        // Tự bảo vệ: phát hiện nếu code bị format lại
        selfDefending: true,
      },
    })] : []),
  ],

  // ⚠️ QUAN TRỌNG: Dùng đường dẫn tương đối cho production build
  // Nếu không có dòng này, Vite sẽ build ra "/assets/..." (tuyệt đối)
  // mà giao thức tauri:// không resolve được → app trắng xoá
  base: "./",

  // === BẢO MẬT PRODUCTION ===
  // Khi build: tự động xóa sạch console.log() và debugger
  // → user mở Chrome DevTools cũng KHÔNG thấy log gì
  build: {
    minify: "esbuild" as const,
    esbuild: isProduction ? {
      drop: ["console" as const, "debugger" as const],
    } : undefined,
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
