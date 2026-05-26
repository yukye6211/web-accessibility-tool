const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
const PORT = 3000;

// 静的ファイル（public/index.html など）
app.use(express.static(path.join(__dirname, 'public')));

// 確認用
app.get('/ping', (_req, res) => res.send('ok'));

// ---- Puppeteer 起動（ローカルChrome優先） ----
async function launchBrowser() {
    const opts = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] };
    const cands = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ].filter(Boolean);

    for (const p of cands) {
        try { return await puppeteer.launch({ ...opts, executablePath: p }); }
        catch { /* 次の候補へ */ }
    }
    return await puppeteer.launch(opts); // 同梱Chromium
}

// ---- 評価API ----
app.get('/evaluate', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'URLを指定してください' });

    console.log('[evaluate] start', targetUrl);
    let browser;
    try {
        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36'
        );
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log('[evaluate] loaded');

        // axe-core をページに注入して実行
        await page.addScriptTag({ path: require.resolve('axe-core') });
        const results = await page.evaluate(async () => {
            const r = await axe.run(
                { include: [['html']] },
                { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }
            );
            return r.violations.map(v => ({
                id: v.id,
                impact: v.impact,
                help: v.help,
                description: v.description,
                helpUrl: v.helpUrl,
                nodes: v.nodes.slice(0, 20).map(n => ({ target: n.target, html: (n.html || '').slice(0, 300) }))
            }));
        });
        console.log('[evaluate] axe done, violations:', results.length);

        // ★ ここでスコアを計算（← results が定義された「直後」）
        const weight = { critical: 4, serious: 3, moderate: 2, minor: 1 };
        const totalPenalty = results.reduce(
            (s, v) => s + (weight[v.impact] || 2) * (v.nodes?.length || 1),
            0
        );
        const score = Math.max(0, 100 - Math.min(100, totalPenalty));

        // 応答
        res.json({ url: targetUrl, score, violations: results });
    } catch (err) {
        console.error('[evaluate] ERROR', err);
        res.status(500).json({ error: String(err) });
    } finally {
        if (browser) await browser.close().catch(() => { });
    }
});

// （任意）スクリーンショットAPI：見え方シミュレーション用
app.get("/screenshot", async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send("URLが指定されていません");

    try {
        const browser = await puppeteer.launch({ headless: "new" });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
        const buffer = await page.screenshot({ fullPage: true });
        await browser.close();

        // 👇 CORS許可を追加
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Content-Type", "image/png");
        res.send(buffer);
    } catch (err) {
        console.error(err);
        res.status(500).send("スクリーンショット取得に失敗しました");
    }
});

app.listen(PORT, () => {
    console.log(`サーバー起動: http://localhost:${PORT}`);
    console.log(`UI: http://localhost:${PORT}/index.html`);
});