import path from 'path'
import fs from 'fs'
import https from 'https'
import puppeteer from 'puppeteer'
import { exec } from 'child_process'
import queryString from 'query-string'
import config from './config'
import {
  sleep,
  restTime,
  setCookie,
  saveCookie,
  cookiePath,
  existsInvoice,
  ensureDirectoryExists,
} from './utils'

// 发票列表页
const targetUrl = 'https://myivc.jd.com/fpzz/index.action'
const maxPageNo = config.maxPageNo
let pageNum = config.pageNum
let browser
let page

async function init() {
  await ensureDirectoryExists(path.resolve(__dirname, './file'))
  browser = await puppeteer.launch({
    headless: false,
    defaultViewport: {
      width: 1440,
      height: 800,
    },
  })
  page = await browser.newPage()
  if (fs.existsSync(cookiePath)) {
    console.log('cookie is have')
    await setCookie(page)
  }
}
async function start() {
  await init()
  console.log(` 💾 发票保存路径 ${path.resolve(__dirname)}/file`)

  await page.goto(targetUrl)
  
  const isLoggedIn = await checkLogin()
  if (!isLoggedIn) {
    console.log(' ❌ 登录失败')
    return
  }
  
  console.log(' ✅ 登录成功')
  
  // 如果是新登录，保存cookie
  await saveCookie(page)
  
  if (pageNum > 1) {
    await jumpPage(pageNum)
  }
  await downloadNextPage()
}

// 下载一页 递归加载
async function downloadNextPage() {
  await page.waitForSelector('.operate a')
  const tableBody = await page.$$('.order-tb tbody')
  // 获取订单号
  const orderNumList = await page.evaluate(() => {
    return Array.from(
      document.querySelectorAll('.order-tb .tr-th .number')
    ).map((el) => el.innerText.match(/(\d)+/)[0])
  })
  // 获取订单状态信息
  const statusList = await Promise.all(
    tableBody.map(async (row) => {
      return await row.evaluate((el) => {
        let ele = el.querySelector('td:nth-child(3)')
        if (!ele) {
          ele = el.querySelector('td:nth-child(2)')
          return ele.innerText
        }
        return ele.innerText
      })
    })
  )
  const rowList = orderNumList.map((orderId, index) => {
    return { row: tableBody[index], orderId, status: statusList[index], index }
  })
  const pageText = await page.evaluate(
    () => document.querySelector('.ui-page-curr').innerText
  )
  console.log(` 📗 当前页码${pageText}`)
  console.table(
    rowList.map(({ orderId, status }) => {
      return { 单号: orderId, 状态: status }
    })
  )

  /**
   * 两种情况: 换开\无法开票
   * 其中换开需要判断发票是否是个人. 如果是个人,就进行换开,否则进行发票下载
   */
  for (let index = 0; index < rowList.length; index++) {
    const item = rowList[index]
    const { orderId, row, status } = item
    const isDownloadComplete = existsInvoice(orderId)
    if (isDownloadComplete) continue
    if (status === '已开票') {
      await downInvoice(item)
    } else if (status === '未开票') {
      const text = await row.evaluate(
        (el) => el.querySelector('.operate a').innerText
      )
      if (text === '发票申请') {
        // 开具发票
        console.log(' ⭕️ 进行发票申请', orderId)
      } else {
        // 无法开具发票
        console.log(' ❌ 无法开具发票', orderId)
      }
    }
  }

  await sleep(3000)

  // 还有下一页的话
  if ((await page.$('.ui-pager-next')) !== null) {
    pageNum++
    if (pageNum > maxPageNo && maxPageNo != 1) {
      console.log(` ⏹ 达到最大页码 ${pageNum} , 停止下载`)
      return
    }
    await jumpPage(pageNum)
    await downloadNextPage()
  }
}

async function checkErrorDialog(page) {
  try {
    // 设置短超时，因为弹窗通常是立即出现的 (例如 1-2秒)
    // 这里的 selector 是根据你提供的 HTML 确定的
    const dialogSelector = '.ui-dialog .m-thickbox-warn .title-main';
    
    await page.waitForSelector(dialogSelector, { visible: true, timeout: 2000 });
    
    // 获取错误文字
    const errorText = await page.$eval(dialogSelector, el => el.innerText);
    console.log(` ⚠️ 检测到换开限制: ${errorText}`);

    // 如果包含关键字，则视为无法换开
    if (errorText.includes('不支持发票换开') || errorText.includes('不是一单一开票')) {
      // 必须点击“确定”或关闭按钮，否则遮罩层会挡住后续操作
      const closeBtnSelector = '.ui-dialog .ui-dialog-btn-cancel';
      // 或者右上角的关闭 X : '.ui-dialog .ui-dialog-close'
      
      await page.waitForSelector(closeBtnSelector);
      await page.click(closeBtnSelector);
      
      // 等待弹窗消失
      await page.waitForSelector('.ui-dialog', { hidden: true });
      return true; // 表示发生了错误
    }
  } catch (e) {
    // 超时未找到弹窗，说明没有报错，可以继续后续流程
    return false;
  }
  return false;
}


async function downInvoice(item) {
  const { row, orderId } = item
  // 如果是发票详情就访问并且下载发票至 file 目录
  // urlLinkHash{'发票详情' , '换开申请', '该订单暂不支持发票开具业务'}
  await restTime()

  const urlLinkHash = await row.evaluate((el) => {
    const hash = {}
    Array.from(el.querySelectorAll('.operate a')).map((i) => {
      hash[i.innerText] = i.href
    })
    return hash
  })
  if (!urlLinkHash['发票详情']) return
  const needChange = await needChangeSubject(urlLinkHash['发票详情'])
  if (needChange && config.companyName && config.companyTaxNo) {
    // 监听新打开的页面
    const newPagePromise = new Promise((resolve) => page.once('popup', resolve))
    // 点击按钮打开新页面
    await row.evaluate((el) => {
      el.querySelector('.operate a').click()
    })
    const hasError = await checkErrorDialog(page);

    if (hasError) {
      console.log(` ⏭️ 跳过订单 ${orderId}，因为不支持换开`);
      return; // 直接结束当前订单的处理，继续下一个循环
    }

    // 获取新打开的页面
    const newPage = await newPagePromise
    console.log(` 🔄 开始[换开] ${orderId} 发票`)
    await changeInvoice(newPage)
    return
  } else {
    await download(urlLinkHash['发票详情'])
    await restTime()
  }
}

/**
 * @param {string} url 发票详情页链接
 * @returns {boolean} true=需要且能够换开, false=不需要或无法换开
 */
async function needChangeSubject(url) {
  const popupPage = await browser.newPage()
  // 稍微增加超时设置，防止网络慢误判
  await popupPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })

  try {
    // 1. 等待核心内容加载
    await popupPage.waitForSelector('.invoice-detail', { timeout: 5000 }).catch(() => {})

    // 2. 检测是否包含“不支持换开”的提示，或者是否存在换开按钮
    const canChange = await popupPage.evaluate(() => {
      // 检查1：是否有明显的禁止提示文本
      const bodyText = document.body.innerText;
      if (bodyText.includes('暂不支持换开') || bodyText.includes('暂不支持发票换开')) {
        return false;
      }

      // 检查2：底部按钮区是否有“换开”字样的按钮
      const actionDiv = document.getElementById('buttomDivForAsync');
      if (!actionDiv) return false;
      
      const buttons = Array.from(actionDiv.querySelectorAll('a'));
      const hasChangeBtn = buttons.some(btn => btn.innerText.includes('换开'));
      
      return hasChangeBtn;
    });

    if (!canChange) {
      console.log(' ⚠️ 该订单不支持换开（可能是国补订单或超过时限），跳过。');
      await popupPage.close();
      return false; // 直接返回不需要换开
    }

    // 3. 既然能换开，再检查抬头是否匹配
    // 获取当前抬头
    const currentTitle = await popupPage.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('.invoice-detail .tb-void td.label'));
      const targetLabel = labels.find(el => el.innerText.includes('发票抬头'));
      return targetLabel && targetLabel.nextElementSibling ? targetLabel.nextElementSibling.innerText.trim() : null;
    });

    console.log(` 🔎 当前发票抬头: "${currentTitle}"`);

    if (currentTitle && currentTitle !== config.companyName) {
      console.log(` 🔄 抬头不匹配，且具备换开条件，准备换开...`);
      await popupPage.close();
      return true; // 需要换开
    }

    console.log(' ✅ 抬头已匹配，无需换开');
    await popupPage.close();
    return false;

  } catch (error) {
    console.log(' ❌ 检测发票详情页失败:', error.message);
    if (!popupPage.isClosed()) await popupPage.close();
    return false;
  }
}

async function changeInvoice(popupPage) {
  const query = '#ivcTitleType'
  try {
    await popupPage.waitForSelector(query)
    await popupPage.waitForSelector('#ivcContentSpan100', { idleTime: 1000 })
    // 选择类别
    await popupPage.click('#ivcContentSpan100')

    // 选择单位
    // const select = await popupPage.$('select#ivcTitleType')
    await popupPage.select('select#ivcTitleType', '5')
    await sleep(100)
    // 输入单位
    await popupPage.type('input#company', config.companyName)
    await popupPage.type('input#taxNo', config.companyTaxNo)
    await restTime()
    // 提交
    await popupPage.click('.invoice-main .form.mt10:last-child a:first-child', {
      delay: 100,
    })
  } catch (error) {
    console.log('无法直接换开')
  }
  await restTime()
  popupPage.close()
}

async function download(url) {
  if (url.indexOf('orderId') > 0) {
    // 通过当前链接 的 orderId 来命名发票 名称 TODO 优化命名
    const { query } = queryString.parseUrl(url)
    const popupPage = await browser.newPage()
    await popupPage.goto(url)
    try {
      await sleep(1000)
      const invoiceTitle = await popupPage.evaluate(() => {
        // 找到包含 "发票抬头" 文本的 span 元素
        const labelSpan = Array.from(
          document.querySelectorAll('td.label span')
        ).find((span) => span.textContent.includes('发票抬头'))

        // 获取父级 td 元素
        const labelTd = labelSpan.parentNode

        // 获取相邻的 td 元素
        const valueTd = labelTd.nextElementSibling

        // 返回相邻 td 元素中的文本
        return valueTd.textContent.trim()
      })
      const invoicePath = `./file/${invoiceTitle}-${query.orderId}.pdf`
      const filename = path.resolve(__dirname, invoicePath)
      await popupPage.waitForSelector('.download-trigger', {
        timeout: 2000,
      })
      const href = await popupPage.$eval('.download-trigger', (el) => el.href)

      // 获取发票的下载链接
      const file = fs.createWriteStream(filename)
      console.log(` ⬇️ 开始下载 ${query.orderId} 发票`)

      // 开始下载
      https.get(href, (response) => {
        response.pipe(file)
        file.on('finish', () => {
          console.log(` ✅ 发票  ${invoicePath} 下载完成`)
          file.close()
        })
      })
    } catch (e) {
      console.log(
        ` ❌ ${query.orderId} 下载发票失败, 或许是退货订单, 请手动下载.`
      )
      console.log(e)
    }

    await popupPage.close()
  }
}

async function jumpPage(pageNum) {
  await page.waitForSelector('#page')
  await page.evaluate(`jQuery('#page').val('${pageNum}')
      document.getElementById('indexForm').submit()`)
}

async function login() {
  page.on('response', async (response) => {
    const url = response.url()
    if (url.indexOf('qr.m.jd.com') > 0 && queryString.parseUrl(url).query.t) {
      const buffer = await response.buffer()
      const filePath = './login.png'
      fs.writeFileSync(filePath, buffer)
      openImage(filePath)
    }
  })
  await page.reload({
    waitUntil: 'networkidle0',
  })
}

function openImage(imagePath) {
  switch (process.platform) {
    case 'darwin':
      exec(`open ${imagePath}`)
      break
    case 'win32':
      exec(`start ${imagePath}`)
      break
    case 'linux':
      if (process.env['XDG_CURRENT_DESKTOP'] === 'GNOME') {
        exec(`gnome-open ${imagePath}`)
      } else {
        exec(`xdg-open ${imagePath}`)
      }
      break
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}

async function checkLogin() {
  if (fs.existsSync(cookiePath)) {
    console.log('发现已保存的 Cookie，尝试使用...')
    const success = await setCookie(page)
    if (success) {
      // 使用实际的目标URL来验证
      await page.goto(targetUrl)
      
      // 检查是否在登录页面
      const currentURL = await page.url()
      if (currentURL === targetUrl) {
        console.log('✅ Cookie 有效，无需重新登录')
        return true
      }
    }
  }
  
  console.log('需要重新登录...')
  // 执行原有的登录流程
  await login()
  
  // 等待登录完成
  while (await page.url() !== targetUrl) {
    await sleep(2000)
  }
  
  return true
}

start()
