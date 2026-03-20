require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

// ==========================================
// ⚙️ НАСТРОЙКИ
// ==========================================
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DONE_DIR = path.join(__dirname, 'done');

const myCookie = process.env.MY_COOKIE;

if (!myCookie) {
    console.error('❌ Ошибка: Не найдена переменная MY_COOKIE в файле .env');
    process.exit(1);
}

const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0',
    'Cookie': myCookie,
    'Origin': 'https://namevids.me',
    'Referer': 'https://namevids.me/'
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// 🕵️‍♂️ АВТОДОБЫЧА КЛЮЧЕЙ (ПАРСИНГ HTML)
// ==========================================
async function getFreshKeys() {
    console.log('🔄 Запрашиваем свежие ключи с сайта...');
    try {
        // ВАЖНО: Судя по вашему HTML, вы брали его со страницы Share. 
        // Обращаемся именно к ней.
        const response = await axios.get('https://namevids.me/share', { headers: commonHeaders });
        const html = response.data;

        // Наша новая снайперская регулярка: ищем apiKey: 'ЧТО-ТО_ДЛИННОЕ'
        const keyRegex = /apiKey:\s*['"]([^'"]+)['"]/;
        const match = html.match(keyRegex);

        if (match && match[1]) {
            const extractedKey = match[1];
            console.log(`✅ Ключ успешно найден и извлечен!`);

            // Так как ключ один для всего, мы просто дублируем его для всех этапов
            return {
                uploadKey: extractedKey,
                saveKey: extractedKey,
                shareKey: extractedKey
            };
        } else {
            throw new Error('Ключ (apiKey) не найден в HTML коде! Возможно, куки устарели или сайт изменил код.');
        }

    } catch (error) {
        console.error('❌ Ошибка при получении ключей:');
        if (error.response && error.response.status === 401) {
            console.error('Сайт не пустил нас. Похоже, ваша Cookie в файле .env устарела. Скопируйте новую!');
        } else {
            console.error(error.message);
        }
        process.exit(1);
    }
}

// ==========================================
// 🚀 ОСНОВНОЙ КОНВЕЙЕР (МАССОВАЯ ЗАГРУЗКА)
// ==========================================
async function startBatchUpload() {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
    if (!fs.existsSync(DONE_DIR)) fs.mkdirSync(DONE_DIR);

    const files = fs.readdirSync(UPLOAD_DIR).filter(file => !file.startsWith('.'));

    if (files.length === 0) {
        return console.log('📂 Папка uploads пуста. Нет файлов для загрузки.');
    }

    console.log(`📦 Найдено файлов для загрузки: ${files.length}`);

    // 1. Добываем свежие ключи перед началом работы
    const keys = await getFreshKeys();

    // 2. Начинаем цикл по файлам
    for (let i = 0; i < files.length; i++) {
        const fileName = files[i];
        const filePath = path.join(UPLOAD_DIR, fileName);
        const fileExt = path.extname(fileName).toLowerCase();
        const isVideo = ['.mp4', '.avi', '.mov', '.mkv'].includes(fileExt);

        console.log(`\n=========================================`);
        console.log(`⏳ ФАЙЛ [${i + 1}/${files.length}]: ${fileName}`);
        console.log(`=========================================`);

        try {
            // --- ШАГ 1: ЗАГРУЗКА ---
            const form = new FormData();
            form.append('file', fs.createReadStream(filePath));
            form.append('key', keys.uploadKey);

            const uploadResp = await axios.post('https://add4.oakroot.top/api/upload.php', form, {
                headers: { ...commonHeaders, ...form.getHeaders() },
                maxBodyLength: Infinity, maxContentLength: Infinity,
            });

            const fileId = uploadResp.data.id;
            if (!fileId) throw new Error('ID видео/фото не получен от сервера');
            console.log(`✅ Загружено! ID: ${fileId}`);

            await sleep(3000); // Пауза 3 секунды, имитируем человека

            // --- ШАГ 2: СОХРАНЕНИЕ ---
            const caption = `Автоматическая загрузка: ${fileName}`;
            let saveData = `caption=${encodeURIComponent(caption)}&fileId=${fileId}&key=${keys.saveKey}`;

            // Если это видео, добавляем title
            if (isVideo) {
                saveData = `title=${encodeURIComponent(fileName)}&` + saveData;
            }

            await axios.post('https://add4.oakroot.top/api/share.php', saveData, {
                headers: { ...commonHeaders, 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            console.log('✅ Описание сохранено!');

            await sleep(3000); // Пауза 3 секунды

            // --- ШАГ 3: ПУБЛИКАЦИЯ ---
            const shareData = `share=true&key=${keys.shareKey}`;
            await axios.post('https://add4.oakroot.top/api/share.php', shareData, {
                headers: { ...commonHeaders, 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            console.log('✅ Успешно опубликовано!');

            // --- ШАГ 4: ПЕРЕМЕЩЕНИЕ ФАЙЛА В DONE ---
            const donePath = path.join(DONE_DIR, fileName);
            fs.renameSync(filePath, donePath);
            console.log(`📁 Файл перемещен в папку 'done'.`);

            // Большая пауза между разными файлами (чтобы не забанили за спам)
            if (i < files.length - 1) {
                console.log(`⏳ Ожидаем 10 секунд перед следующим файлом...`);
                await sleep(10000);
            }

        } catch (error) {
            console.error(`❌ Ошибка при обработке файла ${fileName}:`, error.response ? error.response.data : error.message);
            console.log('⚠️ Скрипт продолжит работу со следующим файлом.');
        }
    }

    console.log('\n🎉 Все файлы из папки uploads обработаны!');
}

startBatchUpload();