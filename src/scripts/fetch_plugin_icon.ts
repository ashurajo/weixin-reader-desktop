/**
 * 插件图标抓取脚本（通用）
 * 从插件 manifest 的 site.homeUrl 自动抓取网站图标，转成 base64 data URI，
 * 写入该插件 manifest 的 `icon` 字段（离线自包含，不依赖 CDN/网络）。
 *
 * 图标规范（docs/PLUGIN_DEVELOPMENT.md §3.1）：固定 128×128 PNG data URI。
 * 站点源不合格（ICO favicon / 尺寸 <128）时本脚本会拒绝写入并指路
 * App Store 官方图标——那是站点找不到高清源时的标准渠道。
 *
 * 用法:
 *   bun src/scripts/fetch_plugin_icon.ts <pluginId> [图标URL或本地PNG路径]
 * 示例:
 *   bun run icon:fetch fanqie                      # 自动从 homeUrl 探测图标
 *   bun run icon:fetch fanqie ./icon-128.png       # 使用本地 PNG（须 128×128）
 *   bun run icon:fetch fanqie https://.../512.png  # 指定图标 URL（须 128×128 PNG）
 *
 * 站点没有合格图标时的标准流程：
 *   1. App Store 搜站点官方 App，复制图标图床 URL（把 artworkUrl 中
 *      `/512x512bb.jpg` 改为 `/512x512bb.png` 可得 PNG）；
 *   2. curl 下载后统一到 128：sips -s format png -Z 128 源图 --out icon-128.png
 *      （App Store 下载的 jpg 也用这条命令转 PNG）
 *   3. bun run icon:fetch <pluginId> ./icon-128.png
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const EXTERNAL_PLUGINS_DIR = 'plugins';
const BUILTIN_PLUGINS_DIR = 'src/plugins/builtin';

/** 解析插件目录（优先外部 plugins/，回退内置 builtin/） */
function resolvePluginDir(pluginId: string): string | null {
  for (const base of [EXTERNAL_PLUGINS_DIR, BUILTIN_PLUGINS_DIR]) {
    const dir = join(base, pluginId);
    if (existsSync(join(dir, 'manifest.json'))) return dir;
  }
  return null;
}

/** 从站点 HTML 中探测最佳图标 URL */
async function detectIconUrl(homeUrl: string): Promise<string> {
  const origin = new URL(homeUrl).origin;
  try {
    const res = await fetch(homeUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();

    // 收集所有 <link rel="...icon..."> 的 href
    const candidates: Array<{ href: string; rel: string }> = [];
    const linkRe = /<link\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) !== null) {
      const tag = m[0];
      const rel = (tag.match(/rel=["']([^"']+)["']/i)?.[1] || '').toLowerCase();
      const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
      if (href && rel.includes('icon')) candidates.push({ href, rel });
    }

    // 优先级: apple-touch-icon > shortcut icon > icon
    const pick =
      candidates.find(c => c.rel.includes('apple-touch-icon')) ||
      candidates.find(c => c.rel.includes('shortcut')) ||
      candidates[0];

    if (pick) return new URL(pick.href, homeUrl).href;
  } catch (e) {
    console.warn(`  ⚠ 解析首页图标失败，回退 /favicon.ico: ${e}`);
  }
  // 兜底
  return `${origin}/favicon.ico`;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || !PNG_MAGIC.every((byte, i) => buf[i] === byte)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** 读取图标（本地路径或 http(s) URL），校验为 128×128 PNG 并返回 base64 */
async function loadIconPngBase64(source: string): Promise<string> {
  let buf: Buffer;
  if (!/^https?:\/\//.test(source)) {
    if (!existsSync(source)) throw new Error(`本地文件不存在: ${source}`);
    buf = readFileSync(source);
  } else {
    const res = await fetch(source, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${source}`);
    buf = Buffer.from(await res.arrayBuffer());
  }

  const dims = pngDimensions(buf);
  if (!dims) {
    throw new Error(
      '不是 PNG（ICO/JPEG/WebP 都不接受）。ICO favicon 通常只有 16/32px——站点没有高清源时，'
      + '标准做法是改用 App Store 官方图标（见 docs/PLUGIN_DEVELOPMENT.md §3.1）。'
      + `已有合格源时转换命令：sips -s format png -Z 128 源图 --out icon-128.png，然后重跑本命令传入 icon-128.png`,
    );
  }
  if (dims.width < 128 || dims.height < 128) {
    throw new Error(
      `图标只有 ${dims.width}×${dims.height}，低于 128×128 下限（Retina 上会模糊）。`
      + ` 站点没有高清源时，标准做法是改用 App Store 官方图标：搜索该站官方 App，`
      + `下载其图标图床 URL（artworkUrl 的 /512x512bb.jpg 改为 /512x512bb.png 即 PNG），`
      + `sips 缩到 128 后重跑本命令。`,
    );
  }
  if (dims.width !== 128 || dims.height !== 128) {
    throw new Error(
      `图标是 ${dims.width}×${dims.height}，规范要求固定 128×128。`
      + ` 统一命令：sips -s format png -Z 128 源图 --out icon-128.png，然后重跑本命令。`,
    );
  }
  return buf.toString('base64');
}

async function main() {
  const [pluginId, explicitSource] = process.argv.slice(2);
  if (!pluginId) {
    console.error('用法: bun src/scripts/fetch_plugin_icon.ts <pluginId> [图标URL或本地PNG路径]');
    process.exit(1);
  }

  const pluginDir = resolvePluginDir(pluginId);
  if (!pluginDir) {
    console.error(`❌ 未找到插件 '${pluginId}'（plugins/ 或 ${BUILTIN_PLUGINS_DIR}/）`);
    process.exit(1);
  }

  const manifestPath = join(pluginDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  console.log(`\n🎨 抓取插件图标: ${pluginId}`);

  let source = explicitSource;
  if (!source) {
    const homeUrl: string | undefined = manifest?.site?.homeUrl;
    if (!homeUrl) {
      console.error('❌ manifest 缺少 site.homeUrl，且未提供图标参数');
      process.exit(1);
    }
    console.log(`  从首页探测图标: ${homeUrl}`);
    source = await detectIconUrl(homeUrl);
  }
  console.log(`  图标来源: ${source}`);

  const base64 = await loadIconPngBase64(source);
  const sizeKb = ((base64.length * 3) / 4 / 1024).toFixed(1);
  console.log(`  已校验 128×128 PNG (${sizeKb} KB)`);

  manifest.icon = `data:image/png;base64,${base64}`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✅ 已写入 ${manifestPath} 的 icon 字段`);
  console.log(`   提示: 运行 'bun run build:plugin ${pluginId}' 重新打包 .atrd\n`);
}

main().catch((e) => {
  console.error('❌ 失败:', e.message ?? e);
  process.exit(1);
});
