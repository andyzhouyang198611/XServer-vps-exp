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
        // 1. 等待 5 秒，确保所有异步数据（包括 iframe）都加载完
        await setTimeout(5000);

        oldExpiryTime = await page.evaluate(() => {
            // 定义日期正则 (支持 2026/01/05 或 2026-01-05)
            const dateRegex = /\d{4}[-/]\d{2}[-/]\d{2}/;
            
            // 策略 A：深度搜索所有包含日期的元素
            const elements = document.querySelectorAll('*');
            const dateNodes = [];
            
            for (let el of elements) {
                // 只看没有子节点的纯文本节点，或者特定的单元格
                if (el.children.length === 0 && dateRegex.test(el.innerText)) {
                    dateNodes.push(el.innerText.match(dateRegex)[0]);
                }
            }

            // 策略 B：如果 A 没找到，搜索全网页可见文本
            if (dateNodes.length === 0) {
                const bodyText = document.body.innerText;
                const matches = bodyText.match(/\d{4}[-/]\d{2}[-/]\d{2}/g);
                if (matches) return matches[matches.length - 1]; // 通常最后一个日期是到期日
            }

            // 策略 C：排除掉“今天”的日期（避免抓到登录时间）
            const today = new Date().toISOString().split('T')[0].replace(/-/g, '/');
            const finalDate = dateNodes.find(d => !d.includes(today));

            return finalDate || dateNodes[0] || "Not Found";
        });

        // 策略 D：如果还是 Not Found，尝试进入所有的 iframe 搜索 (针对 VPS 面板常见结构)
        if (oldExpiryTime === "Not Found") {
            const frames = page.frames();
            for (const frame of frames) {
                const frameDate = await frame.evaluate(() => {
                    const match = document.body.innerText.match(/\d{4}[-/]\d{2}[-/]\d{2}/);
                    return match ? match[0] : null;
                }).catch(() => null);
                if (frameDate) {
                    oldExpiryTime = frameDate;
                    break;
                }
            }
        }
    } catch (e) {
        console.log("抓取过程发生异常:", e.message);
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
