# Câu hỏi dành cho ChatGPT: Fix bug "Mất lịch sử AI Scan / Chưa Scan" ở Footage Tab

---

**[PROMPT DÀNH CHO CHATGPT - BẠN HÃY COPY TOÀN BỘ PHẦN BÊN DƯỚI DÁN VÀO CHATGPT]**

Chào ChatGPT, tôi đang xây dựng một ứng dụng React/TypeScript bằng Tauri. Tôi có một tính năng quét và quản lý lịch sử AI Scan của các file video (footage). 
Ứng dụng lưu metadata (bao gồm mô tả AI, path, trạng thái...) vào một file `autosubs_footage_metadata.json` đặt ngay bên trong thư mục chứa file.

**❌ Lỗi Gặp Phải:** 
1. Đã quét xong, có lịch sử trong JSON, nhưng khi click **Scan Thủ Công** thư mục đó, trên UI lại báo "Chưa Scan" ở một số clip.
2. User cập nhật JSON thủ công bằng tính năng "Nhúng JSON từ Gemini", nhưng sau đó trạng thái bị lỗi, và khi bấm quét AI lại thì mất luôn lịch sử đã dán thủ công.
3. Khi sao chép thư mục sang máy khác (đường dẫn `filePath` thay đổi), load file JSON từ máy tính cũ khiến path bị sai, dữ liệu không rắp khớp được nên bị mất/đánh dấu thành "Chưa scan".

Tôi vừa sửa lại thuật toán map bằng `fileName` thay vì `filePath` (vì `filePath` là tuyệt đối, đổi máy sẽ sai). Dưới đây là code của 2 file xử lý việc merge state và lưu. Bạn làm ơn xem giúp tôi logic phần nào tôi bị sai khiến danh sách UI không load đúng trạng thái "Đã Scan" hoặc làm mất state khi dán thủ công JSON.

---

### File 1: `src/services/footage-library-service.ts`

```typescript
    // Bước 2: Load metadata đã có
    const existingItems = await loadFootageMetadata(folderPath);
    // (FIX): Dùng fileName làm key thay vì filePath để tránh mất scan khi copy folder sang máy mới
    const existingMap = new Map(existingItems.map(i => [i.fileName, i]));

    // Bước 3: Merge — giữ metadata cũ, lọc file mới hoặc file bị lỗi cần re-scan
    let allItems: FootageItem[] = scannedItems.map(scanned => {
        const existing = existingMap.get(scanned.fileName);
        // Giữ metadata cũ NẾU: đã scan thành công (có description, không phải Error, duration > 0)
        // Lỗi có thể nằm ở dòng điều kiện fileHash này!
        if (existing && existing.aiDescription
            && existing.aiMood !== "Error"
            && existing.durationSec > 0
            && existing.fileHash === scanned.fileHash) {
            // Sửa filePath lại theo máy tính hiện tại!
            return {
                ...existing,
                filePath: scanned.filePath
            };
        }
        return scanned; // File mới HOẶC file lỗi → cần scan lại
    });
```

---

### File 2: `src/components/postprod/footage-tab.tsx` (Phần Load UI ban đầu)

```typescript
        // Load metadata và merge file thực tế
        const { loadFootageMetadata, scanFootageFolder } = await import("@/services/footage-library-service")
        const existingItems = await loadFootageMetadata(folderPath) // lấy mảng từ file JSON
        const scannedItems = await scanFootageFolder(folderPath)    // lấy mảng file .mp4 từ ổ cứng

        const existingMap = new Map(existingItems.map(i => [i.fileName, i]));
        const allItems = scannedItems.map(scanned => {
            const existing = existingMap.get(scanned.fileName);
            if (existing) {
                return { ...existing, filePath: scanned.filePath }; // Cập nhật filePath mới nhất
            }
            return scanned;
        });

        setFootageItems(allItems) // Cập nhật state UI. 
        // Phía dưới UI sẽ kiểm tra isScanned theo logic: 
        // const isScanned = !!item.aiDescription && item.aiMood !== "Error";
```

---

### File 2: `src/components/postprod/footage-tab.tsx` (Phần dán JSON scan thủ công)

```typescript
    const handlePasteJson = React.useCallback(async (item: FootageItem) => {
        const jsonStr = window.prompt(`Dán JSON từ Gemini cho file ${item.fileName}:\nVD: {"description":"...","tags":["..."],"mood":"..."}`);
        if (!jsonStr) return;
        try {
            // Regex parse JSON string
            const match = jsonStr.match(/\\{[\\s\\S]*\\}/); // Regex này có vẻ đang sai backslash
            if (!match) throw new Error("Không tìm thấy dấu {} JSON hợp lệ");
            const parsed = JSON.parse(match[0]);

            const newItem: FootageItem = {
                ...item,
                aiDescription: parsed.description || "Manual",
                aiTags: Array.isArray(parsed.tags) ? parsed.tags : [],
                aiMood: parsed.mood || "Manual",
                durationSec: item.durationSec || 5, // fallback if 0
                scannedAt: new Date().toISOString()
            };

            const allItems = footageItems.map(i => i.filePath === item.filePath ? newItem : i);
            setFootageItems(allItems);

            if (footageFolder) {
                const { saveFootageMetadata } = await import("@/services/footage-library-service");
                await saveFootageMetadata(footageFolder, allItems);
            }
            // ...
```

---

***Câu hỏi:***
Hãy tập trung tìm xem:
1. Có phải hàm RegExp `/\\{[\\s\\S]*\\}/` ở chỗ dán JSON bị sai nên dán luôn bị catch exception hay không? 
2. Ở chỗ `scanAndAnalyzeFootageFolder` có check điều kiện `existing.fileHash === scanned.fileHash`. Hàm này băm mã hash dựa vào cái gì? Nếu khi JSON cũ đổi máy và băm mã hash khác, nó có fail dòng này và biến file thành "chưa scan" hay không? Nên bỏ check hash cho an toàn nếu đã có `fileName` không?
3. Với đoạn Logic này, giải pháp chính xác và tốt nhất để tôi sửa 2 block trên là gì? Xin hãy cho code TypeScript sửa lỗi.
