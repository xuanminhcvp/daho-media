const https = require('https');
const axios = require('axios'); // AutoSubs probably uses axios/fetch. We can use built-in fetch if node >= 18.
const fs = require('fs');

async function run() {
    const text = fs.readFileSync('/Users/may1/Desktop/test/kich-ban-chia-cau.txt', 'utf8').substring(0, 1000);
    const apiurl = 'https://ai-proxy.wong110493.workers.dev/v1/chat/completions'; // Guessing it might be open AI format proxy based on keys or whatever the app uses.
}
