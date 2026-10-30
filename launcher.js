// เปิด Chromium แบบไม่มีหน้าจอ แล้วให้เปิดหน้า cloud-host.html (ทำหน้าที่เป็นโฮสต์แทนมือถือ)
async function start(port) {
  const { chromium } = require('playwright-core');
  const room = (process.env.ROOM || 'DOKAPN').toUpperCase();
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
  ];
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chromium', headless: true, args });
  } catch (e) {
    console.log('เปิดแบบ channel=chromium ไม่ได้ ใช้ตัวเริ่มต้นแทน:', String(e.message).split('\n')[0]);
    browser = await chromium.launch({ headless: true, args });
  }
  browser.on('disconnected', () => { console.log('เบราว์เซอร์ปิดลง'); process.exit(1); });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  page.on('console', (m) => console.log('[page]', m.text().slice(0, 300)));
  page.on('pageerror', (e) => console.log('[page error]', String(e.message).slice(0, 300)));
  page.on('crash', () => { console.log('หน้าโฮสต์ crash'); process.exit(1); });
  await page.goto(`http://127.0.0.1:${port}/cloud-host.html?room=${room}`);
  console.log('เปิดหน้าโฮสต์ในเครื่องแล้ว ห้อง ' + room);
}
module.exports = { start };
