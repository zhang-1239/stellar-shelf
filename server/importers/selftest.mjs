// 导入管线自测：自己造真实文件，跑通每种格式，检查章节/封面/资源。
// 用法：node server/importers/selftest.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { parseBook } from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, '__fixtures__');
fs.mkdirSync(TMP, { recursive: true });

// ---------- 造一本 EPUB 2 ----------
function buildEpub() {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`));

  zip.addFile('OEBPS/content.opf', Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>星槎试读</dc:title>
    <dc:creator>沈约</dc:creator>
    <dc:publisher>夜航船书坊</dc:publisher>
    <dc:date>2024-03-01</dc:date>
    <dc:identifier id="uid">9787000000001</dc:identifier>
    <dc:description>一本用来测试的自制小书，讲一个在星图里找书的人。</dc:description>
    <dc:language>zh-CN</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover-img" href="Images/cover.jpg" media-type="image/jpeg"/>
    <item id="fig" href="Images/fig.png" media-type="image/png"/>
    <item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/><itemref idref="c2"/>
  </spine>
</package>`));

  zip.addFile('OEBPS/toc.ncx', Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>第一章 抬头</text></navLabel><content src="Text/ch1.xhtml"/></navPoint>
    <navPoint id="n2" playOrder="2"><navLabel><text>第二章 星图</text></navLabel><content src="Text/ch2.xhtml"/></navPoint>
  </navMap>
</ncx>`));

  zip.addFile('OEBPS/Text/ch1.xhtml', Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>一</title>
<style>.x{color:red}</style><script>alert(1)</script></head>
<body>
  <h2>第一章 抬头</h2>
  <p>　　那年冬天，我第一次在没有云的夜里看见整条银河。</p>
  <p class="x" style="text-indent:2em;color:red" onclick="evil()">他站在屋顶上，把星图折成一只纸船。</p>
  <img src="../Images/fig.png" alt="插图"/>
</body></html>`));

  zip.addFile('OEBPS/Text/ch2.xhtml', Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h2>第二章 星图</h2>
  <p>书脊上落着灰。<a href="https://example.com">外面的世界</a>还在夜里。</p>
  <blockquote><p>所有的远方都先在纸上出现过。</p></blockquote>
</body></html>`));

  // 1x1 PNG 与一张假 JPEG（内容不必是真图，只要能取到字节）
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const jpg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 0x20), Buffer.from([0xFF, 0xD9])]);
  zip.addFile('OEBPS/Images/fig.png', png);
  zip.addFile('OEBPS/Images/cover.jpg', jpg);

  const p = path.join(TMP, 'star-raft.epub');
  zip.writeZip(p);
  return p;
}

// ---------- TXT ----------
function buildTxt() {
  const text = `星河渡

第一章　夜航
　　船是旧的，星是新的。
　　他把灯拨亮一点，看见纸上浮起一层薄光。

第二章　回声
　　有人在很远的地方，念出同一句话。
　　于是他合上书，听见自己的心跳。

第三章　抵达
　　抵达并不是目的，抵达只是又一次出发。
`;
  const p = path.join(TMP, 'xinghe.txt');
  fs.writeFileSync(p, text, 'utf8');
  const gbk = Buffer.from([0xB5, 0xDA, 0xD2, 0xBB, 0xD5, 0xC2, 0x20, 0xBA, 0xDA, 0xD2, 0xB9, 0x0A, 0xA1, 0xA1, 0xD5, 0xE2, 0xCA, 0xC7, 0x47, 0x42, 0x4B, 0x0A]);
  fs.writeFileSync(path.join(TMP, 'gbk-sample.txt'), gbk);
  return p;
}

function buildMd() {
  const p = path.join(TMP, 'notes.md');
  fs.writeFileSync(p, `# 一份书单\n\n**第一段** 说点什么。\n\n## 之一\n\n- 一本书\n- 另一本\n\n> 引一句。\n\n\`\`\`\ncode\n\`\`\`\n`, 'utf8');
  return p;
}

async function run() {
  const cases = [];
  const epub = buildEpub();
  cases.push(['epub', epub]);
  cases.push(['txt', buildTxt()]);
  cases.push(['txt', path.join(TMP, 'gbk-sample.txt')]);
  cases.push(['md', buildMd()]);
  if (fs.existsSync(path.join(TMP, 'sample.pdf'))) cases.push(['pdf', path.join(TMP, 'sample.pdf')]);

  let fail = 0;
  for (const [ext, file] of cases) {
    const label = `${ext}:${path.basename(file)}`;
    try {
      const t0 = Date.now();
      const r = await parseBook(file, ext);
      const ms = Date.now() - t0;
      const chars = r.chapters.reduce((s, c) => s + c.html.replace(/<[^>]+>/g, '').length, 0);
      const imgs = r.assets.length;
      const ok = r.chapters.length > 0 && chars > 0;
      if (!ok) fail++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(26)} ${ms}ms  「${r.meta.title || '?'}」/${r.meta.author || '-'}  章 ${r.chapters.length}  字 ${chars}  图 ${imgs}  封面 ${r.cover ? r.cover.ext : '无'}`);
      console.log(`       章节：${r.chapters.slice(0, 4).map((c) => c.title).join(' / ')}`);
      console.log(`       首段：${r.chapters[0].html.replace(/<[^>]+>/g, '').trim().slice(0, 70)}`);
      if (r.warnings.length) console.log(`       警告：${r.warnings.slice(0, 3).join('; ')}`);

      // 安全检查
      const unsafe = /<script|onclick=|javascript:/i.test(r.chapters.map((c) => c.html).join(''));
      if (unsafe) { console.log('       !! 未清洗干净的脚本'); fail++; }
      const badSrc = r.chapters.some((c) => /src="(?!assets\/|https?:)/.test(c.html) && !/src="assets\//.test(c.html));
      if (badSrc) { console.log('       !! 存在未重写的图片地址'); fail++; }
    } catch (err) {
      fail++;
      console.log(`FAIL  ${label}: ${err.message}`);
    }
  }
  console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
  return fail;
}

process.exitCode = await run();
