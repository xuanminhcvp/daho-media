const fs = require('fs');
const https = require('https');

async function testAI() {
    const text = fs.readFileSync('/Users/may1/Desktop/test/kich-ban-chia-cau.txt', 'utf8').substring(0, 1500);
    const apiKey = "sk-570848c49fda787c748cd58f3a21a1d95f00afd87a5cba6e";
    const prompt = `Bạn là một trợ lý AI. Tôi đang test tính năng tạo SFX Plan. Dựa vào nội dung:\n${text}\n\nHãy tạo ra 3 cặp {"text_reference": "từ khóa tiếng Việt", "sfx_keyword": "tên SFX tiếng Anh tương ứng mưu tả sự việc"}. Output strictly JSON array.`;

    const data = JSON.stringify({
        model: "claude-3-5-sonnet-20240620", // or try mapped open-router / custom proxy model
        messages: [{ role: "user", content: prompt }]
    });

    console.log("SENDING REQUEST TO OPENAI-FORMAT PROXY API...");
    // Let's assume ai-provider normally points to https://api.openai.com or specific proxy.
    // I better just grab the logic from ai-provider if possible.
}
