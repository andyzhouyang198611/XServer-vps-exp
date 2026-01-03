import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'
import fs from 'node:fs' // 导入文件系统模块

const args = ['--no-sandbox', '--disable-setuid-sandbox']
if (process.env.PROXY_SERVER) {
    const proxy_url = new URL(process.env.PROXY_SERVER)
    proxy_url.username = ''
    proxy_url.password = ''
    args.push(`--proxy-server=${proxy_url}`.replace(/\/$/, ''))
}

const browser = await puppeteer.launch({
    defaultViewport: { width: 1080, height: 1024 },
    args,
})
const [page] = await browser.pages()
const userAgent = await browser.userAgent()
await page.setUserAgent(userAgent.replace('Headless', ''))
const recorder = await page.screencast({ path: 'recording.webm' })

// --- 状态跟踪变量 ---
let renewalStatus = "Failed"; // 默认为失败
let oldExpiryTime = "Unknown";

try {
    if (process.env.PROXY_SERVER) {
        const { username, password } = new URL(process.env.PROXY_SERVER)
        if (username && password) {
            await page.authenticate({ username, password })
        }
    }

    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' })
    await page.locator('#memberid').fill(process.env.EMAIL)
    await page.locator('#user_password').fill(process.env.PASSWORD)
    await page.locator('text=ログインする').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2' })

    // 尝试获取旧的到期时间（根据页面结构可能需要调整选择器）
    try {
        // 1. 显式等待包含“利用期限”字样的元素出现，最长等 10 秒
        // 这解决了页面加载慢的问题
        await page.waitForFunction(
            () => document.body.innerText.includes('利用期限'),
            { timeout: 10000 }
        ).catch(() => console.log("未发现‘利用期限’字样"));

        // 2. 采用 Python 版的正则思路，直接在全页查找所有符合 YYYY-MM-DD 的文本
        oldExpiryTime = await page.evaluate(() => {
            const dateRegex = /\d{4}[-/]\d{2}[-/]\d{2}/g;
            const bodyText = document.body.innerText;
            const matches = bodyText.match(dateRegex);

            if (matches && matches.length > 0) {
                // 过滤逻辑：
                // A. 排除掉今天 (脚本运行日期)
                // B. 排除掉 1970 等异常日期
                const today = new Date().toISOString().split('T')[0];
                const validDates = matches.filter(d => !d.includes(today.replace(/-/g, '/')) && !d.includes(today));
                
                // 返回找到的第一个有效日期（通常就是利用期限）
                return validDates.length > 0 ? validDates[0] : matches[0];
            }
            return "Not Found";
        });

        console.log("抓取结果:", oldExpiryTime);
    } catch (e) {
        console.log("抓取超时，页面可能未完全加载");
    }
    
    await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click()
    await page.locator('text=更新する').click()
    await page.locator('text=引き続き無料VPSの利用を継続する').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2' })
    const body = await page.$eval('img[src^="data:"]', img => img.src)
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { method: 'POST', body }).then(r => r.text())
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)
    await page.locator('text=無料VPSの利用を継続する').click()

    await setTimeout(5000)
    renewalStatus = "Success"; // 标记为成功
} catch (e) {
    console.error("运行出错:", e)
    renewalStatus = "Failed";
} finally {

    // --- 生成 README.md 功能 ---
    try {
        // 获取北京时间 (UTC+8)
        const now = new Date();
        const beijingTime = new Date(now.getTime() + (8 * 60 * 60 * 1000)).toISOString().replace(/T/, ' ').replace(/\..+/, '');
        
        let statusEmoji = renewalStatus === "Success" ? "✅Success" : "❌Failed";
        
        const readmeContent = `**最后运行时间**: \`${beijingTime}\`

**运行结果**: <br>
🖥️服务器：\`🇯🇵Xserver(VPS)\`<br>
📊续期结果：${statusEmoji}<br>
🕛️旧到期时间: \`${oldExpiryTime}\`<br>
${renewalStatus === "Success" ? `🕡️新到期时间: \`已续期\`<br>` : ""}`;

        fs.writeFileSync('README.md', readmeContent, 'utf8');
        console.log("✅ README.md 文件已更新");
    } catch (err) {
        console.error("❌ 生成 README.md 失败:", err);
    }
    
    console.log("等待 5 秒确保视频录制完整...");
    await setTimeout(5000);
    await recorder.stop()
    await browser.close()
}
