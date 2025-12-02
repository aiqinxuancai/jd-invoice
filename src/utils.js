import fs from 'fs'
import path from 'path'
import util from 'util'

const stat = util.promisify(fs.stat)
const mkdir = util.promisify(fs.mkdir)
export const cookiePath = path.resolve(__dirname, './cookies.json')

/**
 * @param int ms
 * @returns {Promise<any>}
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function restTime() {
  const time = Math.random() * 1000 + 500
  await sleep(time)
}

export async function setCookie(page) {
  try {
    const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'))
    for (const cookie of cookies) {
      await page.setCookie(cookie)
    }
    console.log('✅ Cookie 已成功加载')
  } catch (error) {
    console.error('加载 Cookie 时出错:', error)
    return false
  }
  return true
}

export async function saveCookie(page) {
  const cookies = await page.cookies()
  // 添加错误处理
  try {
    fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2))
    console.log('✅ Cookie 已成功保存')
  } catch (error) {
    console.error('保存 Cookie 时出错:', error)
  }
}

export function existsInvoice(orderId) {
  const fileDir = path.resolve(__dirname, './file')
  if (!fs.existsSync(fileDir)) {
    return false
  }
  const files = fs.readdirSync(fileDir)
  const exists = files.some((file) => file.includes(orderId) && file.endsWith('.pdf'))
  if (exists) {
    // 如果发票 已经存在，就不需要重复下载
    console.log(` ✅ 发票  ${orderId} 已经存在,跳过下载`)
    return true
  }
  return false
}

export async function ensureDirectoryExists(directory) {
  try {
    // 判断文件夹是否存在
    await stat(directory)
  } catch (err) {
    // 如果文件夹不存在，则创建文件夹
    if (err.code === 'ENOENT') {
      await mkdir(directory)
    } else {
      console.error(err)
    }
  }
}
