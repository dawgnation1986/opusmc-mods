// ==UserScript==
// @name         OpusMC 资源还原工具（纹理 / 文本数据 dump）
// @namespace    https://github.com/bigpixel
// @version      0.1.0
// @description  把运行时生成的资源还原成实体文件：hook WebGL 纹理上传（texImage2D/texSubImage2D），把游戏的代码生成贴图逐张导出 PNG；数据表（MC_TEXTS/ENTITY_DATA/SOUND_EVENTS/ITEMS）导出 JSON。配合主脚本（OpusHUD）使用。
// @author       BigPixel
// @match        http://localhost:8777/*
// @match        https://www.bilibilitoy.com/*
// @match        https://opuscraft.pages.dev/*
// @match        https://www.bilibili.com/toy/*
// @updateURL    https://raw.githubusercontent.com/dawgnation1986/opusmc-mods/main/opus-resource-dump.user.js
// @downloadURL  https://raw.githubusercontent.com/dawgnation1986/opusmc-mods/main/opus-resource-dump.user.js
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // ---------- 纹理记录 ----------
  const texStore = [];      // 全部捕获（去重后）
  const seenSig = new Set();
  const CAP = 800;          // 防内存爆的上限
  let capped = false;

  // 签名（去重）：同一纹理重复上传（如 lightmap 每帧刷新）只记第一份
  function sigOf(fn, target, format, w, h, dataLen, headBytes) {
    let head = '';
    try {
      if (headBytes) {
        const u8 = headBytes instanceof Uint8Array ? headBytes : new Uint8Array(headBytes.buffer || headBytes);
        for (let i = 0; i < 32 && i < u8.length; i++) head += u8[i].toString(16).padStart(2, '0');
      }
    } catch (e) { /* noop */ }
    return fn + '|' + target + '|' + format + '|' + w + 'x' + h + '|' + dataLen + '|' + head;
  }

  function record(fn, target, format, w, h, pixels, gl) {
    if (texStore.length >= CAP) { if (!capped) { capped = true; console.warn('[resDump] 纹理记录达到上限 ' + CAP + '，后续跳过'); } return; }
    let rec;
    try {
      if (pixels instanceof ImageData) {
        rec = { kind: 'imageData', imageData: pixels, w: pixels.width, h: pixels.height };
      } else if (typeof HTMLCanvasElement !== 'undefined' && pixels instanceof HTMLCanvasElement) {
        rec = { kind: 'canvas', canvas: pixels, w: pixels.width, h: pixels.height };
      } else if (typeof ImageBitmap !== 'undefined' && pixels instanceof ImageBitmap) {
        rec = { kind: 'bitmap', bitmap: pixels, w: pixels.width, h: pixels.height };
      } else if (typeof HTMLImageElement !== 'undefined' && pixels instanceof HTMLImageElement) {
        rec = { kind: 'img', img: pixels, w: pixels.naturalWidth || pixels.width, h: pixels.naturalHeight || pixels.height };
      } else if (pixels && (ArrayBufferView.isView(pixels) || pixels instanceof ArrayBuffer)) {
        rec = { kind: 'bytes', bytes: pixels, w, h, format };
      } else {
        return; // null（只分配不填充）等，跳过
      }
    } catch (e) { return; }

    const dataLen = rec.kind === 'bytes'
      ? (rec.bytes.byteLength || rec.bytes.length)
      : (rec.kind === 'imageData' ? rec.imageData.data.length : 0);
    let headBytes = null;
    try {
      if (rec.kind === 'bytes') headBytes = rec.bytes;
      else if (rec.kind === 'imageData') headBytes = rec.imageData.data;
    } catch (e) { /* noop */ }
    const sig = sigOf(fn, target, format, rec.w, rec.h, dataLen, headBytes);
    if (seenSig.has(sig)) return;
    seenSig.add(sig);

    rec.id = texStore.length + 1;
    rec.fn = fn;
    rec.target = target;
    rec.format = format;
    rec.src = guessSource(gl);
    texStore.push(rec);
  }

  // 从调用堆栈猜来源（渲染器/实体纹理/字体…），帮助辨认每张图是什么
  function guessSource(gl) {
    try {
      const stack = new Error().stack || '';
      for (const line of stack.split('\n')) {
        if (/etex|textures|atlas|font|emoji|lightmap|panorama|itemIcons|iconCubes/i.test(line)) {
          const m = line.match(/([\w\-]+\.js.*?:\d+:\d+)/);
          return m ? m[1].split('?')[0] : line.trim().slice(0, 80);
        }
      }
      const m2 = stack.split('\n')[3] || '';
      return m2.trim().slice(0, 80);
    } catch (e) { return '(?)'; }
  }

  // ---------- hook WebGL1/2 的纹理上传 ----------
  for (const proto of [W.WebGL2RenderingContext?.prototype, W.WebGLRenderingContext?.prototype].filter(Boolean)) {
    for (const fn of ['texImage2D', 'texSubImage2D']) {
      if (!proto[fn]) continue;
      const orig = proto[fn];
      proto[fn] = function (target, level, a3, a4, a5, a6, a7, a8, a9) {
        try {
          // 标准签名：texImage2D(target, level, internalformat, width, height, border, format, type, pixels)
          if (fn === 'texImage2D' && arguments.length >= 9) {
            record(fn, target, a6, a3, a4, a8, this);
          } else if (fn === 'texImage2D') {
            // DOM 源签名：texImage2D(target, level, internalformat, format, type, source)
            record(fn, target, a3, null, null, a5, this);
          } else {
            // texSubImage2D(target, level, xoff, yoff, width, height, format, type, pixels)
            record(fn, target, a6, a4, a5, a8, this);
          }
        } catch (e) { /* 记录失败不影响游戏 */ }
        return orig.apply(this, arguments);
      };
    }
  }

  // ---------- 还原为 canvas ----------
  function toCanvas(rec) {
    if (rec.canvas) return rec.canvas;
    if (rec.imageData) {
      const c = document.createElement('canvas');
      c.width = rec.imageData.width; c.height = rec.imageData.height;
      c.getContext('2d').putImageData(rec.imageData, 0, 0);
      return c;
    }
    if (rec.bitmap) {
      const c = document.createElement('canvas');
      c.width = rec.bitmap.width; c.height = rec.bitmap.height;
      c.getContext('2d').drawImage(rec.bitmap, 0, 0);
      return c;
    }
    if (rec.img) {
      const c = document.createElement('canvas');
      c.width = rec.img.naturalWidth || rec.img.width; c.height = rec.img.naturalHeight || rec.img.height;
      c.getContext('2d').drawImage(rec.img, 0, 0);
      return c;
    }
    if (rec.bytes && rec.w && rec.h) {
      // 假定 RGBA/UNSIGNED_BYTE（WebGL 常规）；其他 format 的给出提示跳过
      const fmt = rec.format;
      if (fmt !== 6408 /* RGBA */ && fmt !== 6402 /* DEPTH_COMPONENT */ && fmt !== 6403 /* DEPTH_STENCIL */) {
        if (fmt !== 32992) { /* 不认识就尽量试 RGBA */ }
      }
      const len = rec.w * rec.h * 4;
      const u8 = rec.bytes instanceof Uint8Array ? rec.bytes
        : rec.bytes instanceof Uint8ClampedArray ? rec.bytes
        : new Uint8Array(rec.bytes.buffer || rec.bytes);
      if (u8.length < len) return null;
      const c = document.createElement('canvas');
      c.width = rec.w; c.height = rec.h;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(u8.buffer, u8.byteOffset, len), rec.w, rec.h), 0, 0);
      return c;
    }
    return null;
  }

  function download(canvas, filename) {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = filename;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
  }

  function safeName(s) {
    return String(s).replace(/[^\w\-.]/g, '_').slice(0, 60);
  }

  // ---------- 对外接口 ----------
  W.__resDump = {
    stats() {
      return { textures: texStore.length, capped, objects: this._objs() };
    },
    _objs() {
      const o = {};
      for (const k of ['MC_TEXTS', 'ENTITY_DATA', 'SOUND_EVENTS', 'ITEMS', 'MOB_TYPES', 'BLOCKS']) {
        try { if (W[k]) o[k] = 'object' === typeof W[k] ? Object.keys(W[k]).length + ' keys' : 'yes'; } catch (e) { /* noop */ }
      }
      return o;
    },
    // 清单：id / 上传函数 / 尺寸 / 猜测来源
    list() {
      const rows = texStore.map(r => ({
        id: r.id, fn: r.fn, size: r.w && r.h ? `${r.w}x${r.h}` : '-', kind: r.kind, src: r.src,
      }));
      console.table(rows);
      return rows;
    },
    // 导出单张 PNG：__resDump.save(3)
    save(id) {
      const rec = texStore.find(r => r.id === id);
      if (!rec) return '没有 id=' + id + ' 的记录，先 __resDump.list() 看';
      const c = toCanvas(rec);
      if (!c) return 'id=' + id + ' 无法还原（不支持的格式 ' + rec.format + '）';
      download(c, safeName(`tex-${String(rec.id).padStart(3, '0')}-${rec.fn}-${rec.w}x${rec.h}-${safeName(rec.src).slice(0, 30)}`) + '.png');
      return '已下载';
    },
    // 全部导出：__resDump.saveAll() 或限量 __resDump.saveAll(20)
    saveAll(limit) {
      const n = Math.min(limit ?? texStore.length, texStore.length);
      if (!n) return '纹理记录为空（游戏还没初始化？进一局再试）';
      let i = 0;
      const step = () => {
        if (i >= n) { console.log('[resDump] 导出完成，共 ' + n + ' 张'); return; }
        try { this.save(texStore[i].id); } catch (e) { console.warn('save 失败', texStore[i].id, e); }
        i++;
        setTimeout(step, 180); // 间隔下载，避免浏览器拦截批量下载
      };
      step();
      return '开始导出 ' + n + ' 张 PNG…';
    },
    // 数据表导出：一个 JSON 捆（文本/实体/音效事件/物品等）
    texts() {
      const pack = {};
      for (const k of ['MC_TEXTS', 'ENTITY_DATA', 'SOUND_EVENTS', 'ITEMS', 'MOB_TYPES']) {
        try { if (W[k]) pack[k] = W[k]; } catch (e) { /* noop */ }
      }
      const blob = new Blob([JSON.stringify(pack, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'opusmc-datatables.json';
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return '已下载 opusmc-datatables.json（' + Object.keys(pack).join(', ') + '）';
    },
    // 清空记录重新抓（比如想抓进世界后的动态纹理）
    reset() {
      texStore.length = 0; seenSig.clear(); capped = false;
      return '已清空，继续游戏会重新捕获';
    },
    help() {
      console.log([
        '__resDump.stats()              概况（抓了多少纹理 / 哪些数据表在）',
        '__resDump.list()               纹理清单（表格）',
        '__resDump.save(id)             导出单张 PNG',
        '__resDump.saveAll([limit])     批量导出 PNG（默认全部，可限量）',
        '__resDump.texts()              数据表导出 JSON（MC_TEXTS/ENTITY_DATA/SOUND_EVENTS/ITEMS/MOB_TYPES）',
        '__resDump.reset()              清空记录重抓',
        '提示：标题屏时大部分贴图已生成；进世界后会有实体贴图/区块纹理动态上传，玩一会儿再 saveAll 更全。',
      ].join('\n'));
      return 'see console';
    },
  };

  console.log('[resDump] 资源还原工具就绪：__resDump.help() 查看用法');
})();
