require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// Пути
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const META_FILE = path.join(__dirname, 'global_metadata.json');
const ENV_FILE = path.join(__dirname, '.env');

// Состояние в памяти
let isRunning = false;
let currentAction = 'Ожидание команды...';
let delayMinutes = 5;
let currentCookie = process.env.MY_COOKIE || "";
let globalMetadata = { title: '', caption: '' };

// Загрузка сохраненных метаданных
if (fs.existsSync(META_FILE)) {
    try { globalMetadata = JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch (e) { }
}

app.use(express.static('public'));
app.use(express.json());

// Вспомогательные функции
function getHeaders() {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/148.0',
        'Cookie': currentCookie,
        'Origin': 'https://namevids.me',
        'Referer': 'https://namevids.me/'
    };
}

async function interruptibleSleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (!isRunning) return false;
        await new Promise(r => setTimeout(r, 1000));
    }
    return true;
}

// --- API ---

app.get('/api/state', (req, res) => {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
    const files = fs.readdirSync(UPLOAD_DIR).filter(f => !f.startsWith('.'));
    res.json({ isRunning, currentAction, delayMinutes, files, metadata: globalMetadata, cookie: currentCookie });
});

app.post('/api/cookie', (req, res) => {
    const { cookie } = req.body;
    currentCookie = cookie;
    fs.writeFileSync(ENV_FILE, `MY_COOKIE="${cookie.replace(/"/g, '\\"')}"`);
    console.log('✅ Cookie обновлена через панель');
    res.json({ success: true });
});

app.post('/api/metadata', (req, res) => {
    const { field, value } = req.body;
    globalMetadata[field] = value;
    fs.writeFileSync(META_FILE, JSON.stringify(globalMetadata, null, 2));
    res.json({ success: true });
});

app.post('/api/start', (req, res) => {
    if (!isRunning) {
        delayMinutes = parseFloat(req.body.delay) || 5;
        isRunning = true;
        startPublishingLoop();
    }
    res.json({ success: true });
});

app.post('/api/stop', (req, res) => {
    isRunning = false;
    currentAction = 'Остановка...';
    res.json({ success: true });
});

// --- ЦИКЛ РАБОТЫ ---

async function getFreshKeys() {
    currentAction = 'Обновление API ключей...';
    const resp = await axios.get('https://namevids.me/share', { headers: getHeaders() });
    const match = resp.data.match(/apiKey:\s*['"]([^'"]+)['"]/);
    if (match && match[1]) return match[1];
    throw new Error('Не удалось найти apiKey. Проверьте Cookie!');
}

async function startPublishingLoop() {
    try {
        while (isRunning) {
            const files = fs.readdirSync(UPLOAD_DIR).filter(f => !f.startsWith('.'));
            if (files.length === 0) {
                currentAction = 'Очередь пуста.';
                isRunning = false;
                break;
            }

            const apiKey = await getFreshKeys();
            const fileName = files[0];
            const filePath = path.join(UPLOAD_DIR, fileName);
            const isVideo = ['.mp4', '.avi', '.mov', '.mkv'].includes(path.extname(fileName).toLowerCase());

            console.log(`\n🚀 Обработка: ${fileName}`);
            currentAction = `Загрузка: ${fileName}`;

            try {
                // 1. УПЛОАД
                const form = new FormData();
                form.append('file', fs.createReadStream(filePath));
                form.append('key', apiKey);

                const uploadResp = await axios.post('https://add4.oakroot.top/api/upload.php', form, {
                    headers: { ...getHeaders(), ...form.getHeaders() },
                    maxBodyLength: Infinity, maxContentLength: Infinity
                });

                const fileId = uploadResp.data.id;

                if (!fileId) {
                    if (uploadResp.data.error === "You already added this file") {
                        currentAction = `Дубликат ${fileName} удален.`;
                        fs.unlinkSync(filePath);
                        continue;
                    }
                    throw new Error(uploadResp.data.error || 'Ошибка загрузки');
                }

                await interruptibleSleep(3000);

                // 2. СОХРАНЕНИЕ
                currentAction = `Настройка метаданных...`;
                let postData = `caption=${encodeURIComponent(globalMetadata.caption)}&fileId=${fileId}&key=${apiKey}`;
                if (isVideo) postData = `title=${encodeURIComponent(globalMetadata.title)}&` + postData;

                await axios.post('https://add4.oakroot.top/api/share.php', postData, {
                    headers: { ...getHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' }
                });

                await interruptibleSleep(3000);

                // 3. ПУБЛИКАЦИЯ
                currentAction = `Финальная публикация...`;
                await axios.post('https://add4.oakroot.top/api/share.php', `share=true&key=${apiKey}`, {
                    headers: { ...getHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' }
                });

                // 4. УДАЛЕНИЕ
                fs.unlinkSync(filePath);
                console.log(`✅ ${fileName} завершен и удален.`);

            } catch (err) {
                console.error(`❌ Ошибка файла ${fileName}:`, err.message);
                currentAction = `Ошибка: ${err.message}. Пропуск...`;
                await interruptibleSleep(5000);
            }

            currentAction = `Пауза ${delayMinutes} мин...`;
            if (!await interruptibleSleep(delayMinutes * 60 * 1000)) break;
        }
    } catch (err) {
        currentAction = `❌ Критическая ошибка: ${err.message}`;
        isRunning = false;
    }
}

app.listen(PORT, () => console.log(`🚀 Панель на порту ${PORT}`));