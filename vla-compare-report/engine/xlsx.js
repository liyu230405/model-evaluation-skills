// 极简 xlsx 读写（无第三方依赖）：读取用 DecompressionStream 解 deflate，写入用 stored zip。
// 浏览器与 Node(>=18) 共用。
(function () {
  const V = (globalThis.VLA = globalThis.VLA || {});

  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const unesc = (s) => s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] !== undefined ? ENT[e] : m;
  });
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  async function inflateRaw(u8) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 xlsx（zip）文件');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {};
    const dec = new TextDecoder();
    for (let k = 0; k < count; k++) {
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      const dataStart = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const raw = u8.subarray(dataStart, dataStart + csize);
      files[name] = method === 0 ? raw : method === 8 ? await inflateRaw(raw) : null;
      p += 46 + nlen + xlen + clen;
    }
    return files;
  }

  function colIndex(ref) {
    const m = /^([A-Z]+)/.exec(ref);
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }
  function colName(i) {
    let s = '';
    i += 1;
    while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  const textOf = (xml) => {
    let out = '';
    xml.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (_, t) => { out += unesc(t); return ''; });
    return out;
  };

  // 返回 { 工作表名: 二维数组(字符串/数字) }
  async function readXlsx(buf) {
    const files = await unzip(buf);
    const dec = new TextDecoder();
    const get = (n) => (files[n] ? dec.decode(files[n]) : null);
    const shared = [];
    const ss = get('xl/sharedStrings.xml');
    if (ss) ss.replace(/<si>([\s\S]*?)<\/si>/g, (_, si) => { shared.push(textOf(si)); return ''; });
    const wb = get('xl/workbook.xml');
    const rels = get('xl/_rels/workbook.xml.rels') || '';
    const relMap = {};
    rels.replace(/<Relationship\b([^>]*)\/?>/g, (_, attrs) => {
      const id = /Id="([^"]+)"/.exec(attrs), tg = /Target="([^"]+)"/.exec(attrs);
      if (id && tg) relMap[id[1]] = tg[1];
      return '';
    });
    const out = {};
    const sheetRe = /<sheet\b([^>]*)\/?>/g;
    let m;
    while ((m = sheetRe.exec(wb))) {
      const name = unesc(/name="([^"]*)"/.exec(m[1])[1]);
      const rid = /r:id="([^"]+)"/.exec(m[1]);
      let target = rid ? relMap[rid[1]] : null;
      if (!target) continue;
      target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
      const xml = get(target);
      if (!xml) continue;
      const rows = [];
      const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
      let r, autoRow = 0;
      while ((r = rowRe.exec(xml))) {
        const rn = /\br="(\d+)"/.exec(r[1]);
        const ri = rn ? parseInt(rn[1], 10) - 1 : autoRow;
        autoRow = ri + 1;
        const row = [];
        const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let c, autoCol = 0;
        while ((c = cellRe.exec(r[2]))) {
          const ref = /\br="([A-Z]+\d+)"/.exec(c[1]);
          const ci = ref ? colIndex(ref[1]) : autoCol;
          autoCol = ci + 1;
          const type = (/\bt="(\w+)"/.exec(c[1]) || [])[1];
          const body = c[2] || '';
          const v = /<v>([\s\S]*?)<\/v>/.exec(body);
          let val = '';
          if (type === 's') val = v ? shared[parseInt(v[1], 10)] : '';
          else if (type === 'inlineStr') val = textOf(body);
          else if (type === 'str' || type === 'e') val = v ? unesc(v[1]) : '';
          else if (type === 'b') val = v ? (v[1] === '1' ? 'TRUE' : 'FALSE') : '';
          else val = v ? Number(v[1]) : '';
          row[ci] = val;
        }
        for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
        rows[ri] = row;
      }
      for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
      out[name] = rows;
    }
    return out;
  }

  // ---------- 写入 ----------
  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zipStore(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const [name, content] of entries) {
      const nb = enc.encode(name), data = typeof content === 'string' ? enc.encode(content) : content;
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, nb.length, true);
      parts.push(new Uint8Array(lh.buffer), nb, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, nb.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nb);
      offset += 30 + nb.length + data.length;
    }
    const csize = central.reduce((s, x) => s + x.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, csize, true); end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((s, x) => s + x.length, 0));
    let p = 0;
    for (const x of all) { out.set(x, p); p += x.length; }
    return out;
  }

  // 样式：0 默认，1 表头加粗，2 百分比 0.0%，3 小数 0.000，4 小数 0.0000，5 校验高亮，6 说明文字
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="0.000"/><numFmt numFmtId="166" formatCode="0.0000"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF666666"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF4D6"/></patternFill></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="3" borderId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" applyFont="1"/>
</cellXfs></styleSheet>`;

  // sheets: [{ name, rows: [[cell]], widths?: [n] }]
  // cell: 数字 | 字符串 | null | { v, f, s }（f 为公式，不带等号；s 为样式号）
  function writeXlsx(sheets) {
    const sheetXml = sheets.map((sh) => {
      const rowsXml = sh.rows.map((row, ri) => {
        const cells = (row || []).map((cell, ci) => {
          if (cell === null || cell === undefined || cell === '') return '';
          const ref = colName(ci) + (ri + 1);
          const o = typeof cell === 'object' ? cell : { v: cell };
          const s = o.s ? ` s="${o.s}"` : '';
          // Excel 2010+ 新函数在文件中必须带 _xlfn. 前缀，否则 Excel 显示 #NAME?
          if (o.f) return `<c r="${ref}"${s}><f>${esc(o.f.replace(/(^|[^.\w])(T\.TEST|T\.INV\.2T|STDEV\.S)\(/g, '$1_xlfn.$2('))}</f></c>`;
          if (typeof o.v === 'number' && isFinite(o.v)) return `<c r="${ref}"${s}><v>${o.v}</v></c>`;
          if (o.v === null || o.v === undefined || (typeof o.v === 'number' && !isFinite(o.v))) return '';
          return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(o.v)}</t></is></c>`;
        }).join('');
        return `<row r="${ri + 1}">${cells}</row>`;
      }).join('');
      const cols = sh.widths ? `<cols>${sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
      const pane = sh.freeze ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '';
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${rowsXml}</sheetData></worksheet>`;
    });
    const entries = [
      ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
      ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`],
      ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ['xl/styles.xml', STYLES],
      ...sheetXml.map((x, i) => [`xl/worksheets/sheet${i + 1}.xml`, x]),
    ];
    return zipStore(entries);
  }

  // CSV 解析（支持引号、BOM）
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const rows = [];
    let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); rows.push(row); row = []; cur = '';
      } else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  V.xlsx = { readXlsx, writeXlsx, parseCSV, colName, crc32 };
})();
