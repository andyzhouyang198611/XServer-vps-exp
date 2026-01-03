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
        // 等待表格加载
        await page.waitForSelector('table', { timeout: 10000 });
        // 2. 使用循环重试（试 5 次，每次间隔 1 秒），给异步数据加载留出时间
        for (let i = 0; i < 5; i++) {
            oldExpiryTime = await page.evaluate(() => {
                const dateRegex = /\d{4}[-/]\d{2}[-/]\d{2}/;
                
                // 找到所有表头，确定“利用期限”所在的列索引
                const ths = Array.from(document.querySelectorAll('th'));
                const colIndex = ths.findIndex(th => th.innerText.includes('利用期限'));
                
                if (colIndex !== -1) {
                    // 找到对应的 td 单元格（通常数据在 th 同一行的后续或特定位置）
                    // 策略：遍历所有 td，找到第一个符合日期格式且不等于今天的
                    const tds = Array.from(document.querySelectorAll('td'));
                    const today = new Date().toISOString().split('T')[0].replace(/-/g, '/');
                    
                    for (let td of tds) {
                        const match = td.innerText.match(dateRegex);
                        // 排除空值和今天（避开登录时间）
                        if (match && !match[0].includes(today)) {
                            return match[0];
                        }
                    }
                }
                return null;
            });

            if (oldExpiryTime && oldExpiryTime !== "Unknown") break;
            await new Promise(r => setTimeout(r, 1000)); // 等待 1 秒再试
        }
    } catch (e) {
        console.log("获取时间异常:", e.message);
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
