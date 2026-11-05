// ==UserScript==
// @name         OpusMC 生存辅助（彗星式客户端）
// @namespace    https://github.com/bigpixel
// @version      0.5.5
// @description  网页版 MC 运行时注入：RShift 呼出 Meteor 式 ClickGUI（多列模块 / 左键开关 / 列拖动 / 搜索）。ESP 生物方框（3D 线框）、追踪线、名字血条、物品与投射物 ESP、实体雷达、方位罗盘、夜视、时间与天气。适配 B 站 OpusMC / OpusCraft / 本地离线版。
// @author       BigPixel
// @match        https://opuscraft.pages.dev/*
// @match        https://www.bilibilitoy.com/*
// @match        https://www.bilibili.com/toy/*
// @match        http://localhost:8777/*
// @updateURL    https://raw.githubusercontent.com/dawgnation1986/opusmc-mods/main/opusmc-hud.user.js
// @downloadURL  https://raw.githubusercontent.com/dawgnation1986/opusmc-mods/main/opusmc-hud.user.js
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  // Tampermonkey 沙箱里的 window 是代理，必须拿页面真身才能摸到游戏挂的全局对象
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const VERSION = '0.5.5'; // 与头部 @version 同步改；显示在 HUD 标题和 GUI 底部，用户可核对更新
  const REF_POLL_MS = 800;
  const REF_POLL_MAX_TRIES = 375; // 最多找 5 分钟
  const SLOW_ROWS_MS = 250;
  const TIME_ROW_MS = 500;

  const state = { game: null, player: null, flavor: '' };

  // ---------- 配置 ----------
  const CFG_KEY = '__opusHudCfg';
  const cfg = Object.assign({
    hud: true,          // 坐标 HUD
    esp: false,         // ESP 生物方框
    tracers: false,     // 追踪线
    labels: true,       // 名字与血条
    itemEsp: false,     // 物品与投射物 ESP
    radar: false,       // 实体雷达
    radarSize: 140,     // 雷达直径（像素）
    mcAddr: 'ws://localhost:25565',  // MC1.8 服务器地址（PHPMC）
    mcName: 'WebPlayer',             // MC 服务器里的玩家名
    compass: false,     // 方位罗盘
    nightVision: false, // 夜视（游戏原生渲染路径）
    timeWeather: false, // 时间与天气
    espDist: 64,        // ESP 最大距离（格）
    servers: [{ name: '官方', url: 'https://xz.honghemc.cn:8443' }], // 房间服务器列表
    serverIdx: 0,       // 当前使用的服务器
  }, (() => { try { return JSON.parse(W.localStorage.getItem(CFG_KEY) || '{}'); } catch (e) { return {}; } })());

  function saveCfg() {
    try { W.localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* 内存态兜底 */ }
  }

  // ---------- 工具 ----------
  function num(o, ...keys) {
    if (!o) return null;
    for (const k of keys) {
      try {
        const v = o[k];
        if (typeof v === 'number' && isFinite(v)) return v;
      } catch (e) { /* getter 可能抛 */ }
    }
    return null;
  }

  function vec3(o, ...keys) {
    if (!o) return null;
    for (const k of keys) {
      try {
        const v = o[k];
        if (Array.isArray(v) && typeof v[0] === 'number' && typeof v[2] === 'number') return v;
      } catch (e) { /* noop */ }
    }
    return null;
  }

  // OpusMC: p.pos=[x,y,z] yaw 弧度 | OpusCraft: p.x/y/z yaw 度数
  function readPos(p) {
    const pos = vec3(p, 'pos', 'position');
    const vel = vec3(p, 'vel', 'velocity');
    const yaw = num(p, 'yaw', 'rotationY', 'rotation');
    return {
      x: pos ? pos[0] : num(p, 'x'),
      y: pos ? pos[1] : num(p, 'y'),
      z: pos ? pos[2] : num(p, 'z'),
      vx: vel ? vel[0] : num(p, 'dx', 'vx'),
      vy: vel ? vel[1] : num(p, 'dy', 'vy'),
      vz: vel ? vel[2] : num(p, 'dz', 'vz'),
      yaw,
      pitch: num(p, 'pitch', 'rotationX'),
      health: num(p, 'health', 'hp'),
      food: num(p, 'food', 'hunger'),
      fps: num(state.game, 'fps'),
      dim: (() => { try { return state.game ? state.game.dim : null; } catch (e) { return null; } })(),
      mode: (() => {
        try {
          return p.gameMode ?? p.gamemode
            ?? (state.game ? state.game.mode : null) ?? null;
        } catch (e) { return null; }
      })(),
    };
  }

  // 朝向角：弧度（OpusMC）与度数（OpusCraft）以 7 为界自动判别
  function yawDeg(yaw) {
    if (yaw == null) return null;
    return Math.abs(yaw) <= 7 ? yaw * 180 / Math.PI : yaw;
  }
  function yawRad(yaw) {
    if (yaw == null) return 0;
    return Math.abs(yaw) <= 7 ? yaw : yaw * Math.PI / 180;
  }

  function facingOf(yaw) {
    const deg = yawDeg(yaw);
    if (deg == null) return '?';
    const dirs = ['south(+Z)', 'west(-X)', 'north(-Z)', 'east(+X)'];
    return dirs[Math.floor(((deg % 360) + 360 + 45) / 90) % 4];
  }

  const CN_DIM = { overworld: '主世界', nether: '下界', end: '末地' };

  // ---------- 生物中文名（fallback 表；首选游戏内置的 ENTITY_DATA.types[*].cn） ----------
  const CN_NAMES = {
    ZombieKind: '僵尸', SkeletonKind: '骷髅', CaveSpider: '洞穴蜘蛛', Crawler: '蠹虫',
    Slime: '史莱姆', SulfurCube: '硫磺方块', Phantom: '幻翼', Witch: '女巫',
    Pillager: '掠夺者', Vindicator: '卫道士', Evoker: '唤魔者', Vex: '恼鬼',
    Ravager: '劫掠兽', Breeze: '旋风人', Creaking: '嘎枝', Warden: '监守者',
    Shulker: '潜影贝', Zoglin: '僵尸疣猪兽', Wither: '凋灵', EnderDragon: '末影龙',
    Blaze: '烈焰人', Ghast: '恶魂', MagmaCube: '岩浆怪', Piglin: '猪灵',
    Hoglin: '疣猪兽', ZombifiedPiglin: '僵尸猪灵', Enderman: '末影人',
    Guardian: '守卫者', Drowned: '溺尸', SnowGolem: '雪傀儡',
    Allay: '悦灵', Armadillo: '犰狳', Axolotl: '美西螈', Bat: '蝙蝠', Bee: '蜜蜂',
    Camel: '骆驼', Cat: '猫', Cod: '鳕鱼', Dolphin: '海豚', Fox: '狐狸', Frog: '青蛙',
    Goat: '山羊', HappyGhast: '快乐恶魂', Horse: '马', Llama: '羊驼', Mooshroom: '哞菇',
    Ocelot: '豹猫', Panda: '熊猫', Parrot: '鹦鹉', PolarBear: '北极熊', Pufferfish: '河豚',
    Rabbit: '兔子', Salmon: '鲑鱼', Sniffer: '嗅探兽', Squid: '鱿鱼', Strider: '炽足兽',
    Tadpole: '蝌蚪', TropicalFish: '热带鱼', Turtle: '海龟', Wolf: '狼', Villager: '村民',
    WanderingTrader: '流浪商人', Nautilus: '鹦鹉螺',
    ItemEntity: '掉落物', Arrow: '箭', ExperienceOrb: '经验球', Fireball: '火球',
    ThrownPearl: '末影珍珠', PrimedTNT: '点燃的TNT', WitherSkull: '凋灵之首',
    ShulkerBullet: '潜影弹', DragonFireball: '龙息火球', EyeOfEnder: '末影之眼',
    FallingBlock: '掉落方块', EvokerFangs: '唤魔者尖牙', AreaCloud: '药水云',
  };
  function cnName(e) {
    try {
      const T = e.T || (e.type && W.ENTITY_DATA && W.ENTITY_DATA.types ? W.ENTITY_DATA.types[e.type] : null);
      let n = (T && T.cn) || e.type || null;
      if (!n) return (e.constructor && e.constructor.name) || '?';
      if (e.baby) n = '幼年' + n;
      return CN_NAMES[n] || n;
    } catch (err) {
      return (e.constructor && e.constructor.name) || '?';
    }
  }

  // 物品/投射物分类（无 health 的实体），返回颜色或 null（不显示）
  const PROJ = new Set(['Arrow', 'Fireball', 'ThrownPearl', 'WitherSkull', 'ShulkerBullet',
    'DragonFireball', 'EyeOfEnder', 'MobShot', 'PrimedTNT', 'EvokerFangs']);
  function itemKindOf(e) {
    const n = (e && e.constructor && e.constructor.name) || '';
    if (n === 'ItemEntity') return '#ffd54f';      // 掉落物（黄）
    if (n === 'ExperienceOrb') return '#69f0ae';   // 经验球（绿）
    if (PROJ.has(n)) return '#ff8a65';             // 投射物（橙红）
    if (n === 'FallingBlock' || n === 'AreaCloud') return '#b0bec5'; // 其他（灰）
    return null;
  }

  // ---------- 引用发现 Tier 1：全局挂载（OpusMC: window.game / OpusCraft: window.__game） ----------
  function tryGlobalMount() {
    for (const key of ['game', '__game', 'G', 'engine', '__OPUS', 'mc', 'world']) {
      try {
        const g = W[key];
        if (g && typeof g === 'object') {
          if (g.player && looksLikePlayer(g.player)) return { game: g, player: g.player, key };
          if (looksLikePlayer(g)) return { game: null, player: g, key };
        }
      } catch (e) { /* 忽略跨域/抛错属性 */ }
    }
    return null;
  }

  function looksLikePlayer(o) {
    try {
      if (!o || typeof o !== 'object') return false;
      const hasYaw = typeof o.yaw === 'number' || typeof o.rotationY === 'number';
      if (!hasYaw) return false;
      if (typeof o.x === 'number' && typeof o.y === 'number' && typeof o.z === 'number') return true;
      if (Array.isArray(o.pos) && typeof o.pos[0] === 'number') return true;
      return false;
    } catch (e) { return false; }
  }

  function scanWindow() {
    let keys;
    try { keys = Object.getOwnPropertyNames(W); } catch (e) { return null; }
    for (const key of keys) {
      let v;
      try { v = W[key]; } catch (e) { continue; }
      if (!v || typeof v !== 'object' || v === W || v === W.document) continue;
      if (looksLikePlayer(v)) return { game: null, player: v, key };
      let sub;
      try { sub = Object.getOwnPropertyNames(v); } catch (e) { continue; }
      if (sub.length > 300) continue;
      for (const sk of sub) {
        let sv;
        try { sv = v[sk]; } catch (e) { continue; }
        if (sv && typeof sv === 'object' && looksLikePlayer(sv)) {
          return { game: v, player: sv, key: key + '.' + sk };
        }
      }
    }
    return null;
  }

  // ---------- 引用发现 Tier 3：hook fillText 嗅探 ----------
  function installFillTextSniffer() {
    if (W.__opusHud && W.__opusHud._snifferInstalled) return;
    const orig = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y) {
      const h = W.__opusHud;
      if (h && h._sniffing) {
        h._sniffing.count++;
        if (h._sniffing.count <= 400) {
          let where = '(native)';
          try {
            where = new Error().stack.split('\n')[2]?.trim().slice(0, 120) ?? '(?)';
          } catch (e) { /* noop */ }
          h.fillTextLog.push({
            text: String(text).slice(0, 60),
            canvas: (this.canvas && (this.canvas.id || this.canvas.className)) || '(unnamed)',
            where,
          });
        }
      }
      return orig.call(this, text, x, y);
    };
    if (W.__opusHud) W.__opusHud._snifferInstalled = true;
  }

  // ---------- CSS（集中一个 style 块，DOM 只用类名） ----------
  const css = `
    #__opus_hud {
      position: fixed; left: 8px; top: 8px; z-index: 2147483647;
      font: 12px/1.5 Consolas, Menlo, monospace; color: #e8e8e8;
      background: rgba(16,16,16,0.55); border: 1px solid rgba(255,255,255,0.18);
      border-radius: 6px; padding: 6px 10px; pointer-events: none;
      text-shadow: 0 1px 2px #000; white-space: pre;
    }
    #__opus_hud .op-title { color: #7fd48a; font-weight: bold; margin-bottom: 2px; }
    #__opus_time {
      position: fixed; left: 8px; top: 118px; z-index: 2147483646;
      font: 12px/1.4 "Microsoft YaHei", sans-serif; color: #e8e8e8;
      background: rgba(16,16,16,0.55); border: 1px solid rgba(255,255,255,0.18);
      border-radius: 6px; padding: 4px 10px; pointer-events: none;
      text-shadow: 0 1px 2px #000;
    }
    #__opus_menu {
      position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
      font: 12px/1.35 "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    #__opus_menu.op-hidden { display: none; }
    .op-col {
      position: fixed; width: 152px; pointer-events: auto; user-select: none;
      background: rgba(18,20,26,0.94); border-radius: 7px; overflow: hidden;
      box-shadow: 0 6px 24px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1);
    }
    .op-col-head {
      padding: 6px 10px; font-weight: bold; color: #fff; cursor: move;
      letter-spacing: 1px; text-align: center; font-size: 12px;
      background: linear-gradient(90deg, #7c5cff, #a06bff);
    }
    .op-col-head.blue { background: linear-gradient(90deg, #3aa0ff, #5fc7ff); }
    .op-col-head.green { background: linear-gradient(90deg, #3fae5f, #6fd48a); }
    .op-mod {
      padding: 5px 10px; cursor: pointer; color: #c9cdd4;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .op-mod:hover { background: rgba(255,255,255,0.07); }
    .op-mod.on { color: #b39bff; background: rgba(124,92,255,0.14); }
    .op-col-foot { padding: 5px 8px; border-top: 1px solid rgba(255,255,255,0.08); }
    .op-stepper { display: flex; align-items: center; gap: 6px; }
    .op-stepper .op-steplabel { color: #9aa0a8; }
    .op-step-btn {
      width: 22px; height: 20px; line-height: 18px; text-align: center;
      border: 1px solid rgba(255,255,255,0.2); border-radius: 5px;
      cursor: pointer; color: #ddd; font-size: 13px;
    }
    .op-step-btn:hover { background: rgba(255,255,255,0.1); }
    .op-step-val { min-width: 28px; text-align: center; color: #b39bff; font-weight: 600; }
    .op-search {
      width: 128px; margin: 5px auto; display: block; background: #23262e; color: #ddd;
      border: 1px solid rgba(255,255,255,0.15); border-radius: 5px;
      padding: 4px 8px; font-size: 12px; outline: none;
    }
    .op-gui-foot {
      position: fixed; left: 50%; bottom: 10px; transform: translateX(-50%);
      color: rgba(255,255,255,0.5); font-size: 11px;
      text-shadow: 0 1px 2px #000; pointer-events: none;
    }
    #__opus_esp { position: fixed; left: 0; top: 0; width: 100%; height: 100%; z-index: 2147483646; pointer-events: none; }
    #__opus_radar {
      position: fixed; right: 12px; bottom: 12px; z-index: 2147483645; pointer-events: none;
      border-radius: 50%; box-shadow: 0 2px 10px rgba(0,0,0,0.4);
    }
    #__opus_compass {
      position: fixed; left: 50%; top: 6px; transform: translateX(-50%);
      z-index: 2147483645; pointer-events: none;
      box-shadow: 0 2px 8px rgba(0,0,0,0.35); border-radius: 7px;
    }
  `;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;

  // ---------- HUD 文本层 ----------
  const hud = document.createElement('div');
  hud.id = '__opus_hud';
  const titleRow = document.createElement('div');
  titleRow.className = 'op-title';
  titleRow.textContent = 'OpusHUD v' + VERSION + ' · RShift 开菜单';
  const bodyRow = document.createElement('div');
  hud.append(titleRow, bodyRow);

  let lastSlow = 0;
  const slowCache = { fps: null, health: null, food: null, mode: null, dim: null };

  function frame(now) {
    try {
      const p = state.player;
      if (!p) {
        bodyRow.textContent = '还没抓到 player 引用…（见 README 手册）';
      } else {
        const d = readPos(p);
        const speed = (d.vx != null) ? Math.hypot(d.vx, d.vy ?? 0, d.vz ?? 0) : null;
        const coords = `XYZ  ${fmt(d.x)}  ${fmt(d.y)}  ${fmt(d.z)}\n`
          + `Block  ${d.x == null ? '?' : Math.floor(d.x)} ${d.y == null ? '?' : Math.floor(d.y)} ${d.z == null ? '?' : Math.floor(d.z)}\n`
          + `Facing  ${facingOf(d.yaw)}  yaw=${fmt(d.yaw)} pitch=${fmt(d.pitch)}`
          + (speed != null ? `  spd=${speed.toFixed(2)}` : '');
        if (now - lastSlow > SLOW_ROWS_MS) {
          lastSlow = now;
          slowCache.fps = d.fps;
          slowCache.health = d.health;
          slowCache.food = d.food;
          slowCache.mode = d.mode;
          slowCache.dim = d.dim ? (CN_DIM[d.dim] || d.dim) : null;
        }
        const slow = `FPS  ${slowCache.fps ?? '-'}   HP  ${slowCache.health ?? '-'}`
          + `   饥饿  ${slowCache.food ?? '-'}   ${slowCache.dim ?? ''}   ${slowCache.mode ?? ''}`;
        bodyRow.textContent = coords + '\n' + slow;
      }
    } catch (e) {
      bodyRow.textContent = 'HUD 出错: ' + e.message;
    }
    if (cfg.hud) requestAnimationFrame(frame);
    else hud.style.display = 'none';
  }

  function startHud() {
    hud.style.display = '';
    requestAnimationFrame(frame);
  }

  function fmt(v) {
    return v == null ? '?' : (Math.round(v * 1000) / 1000).toFixed(3);
  }

  // ---------- 时间与天气（独立小模块） ----------
  const timeRow = document.createElement('div');
  timeRow.id = '__opus_time';
  let lastTime = 0;

  function updateTimeRow(now) {
    if (!cfg.timeWeather) { timeRow.style.display = 'none'; return; }
    timeRow.style.display = '';
    if (now - lastTime < TIME_ROW_MS) return;
    lastTime = now;
    const g = state.game;
    if (!g) { timeRow.textContent = '时间 --'; return; }
    const wt = num(g, 'worldTime') ?? 0;
    const day = Math.floor(wt / 24000) + 1;
    const t = ((wt % 24000) + 24000) % 24000;
    const hh = String(Math.floor((t / 1000 + 6) % 24)).padStart(2, '0');
    const mm = String(Math.floor((t % 1000) / 1000 * 60)).padStart(2, '0');
    const wv = num(g, 'weather') ?? 0;
    const wTxt = wv > 0.2 ? '降雨 ' + Math.round(wv * 100) + '%' : '晴';
    timeRow.textContent = `第 ${day} 天  ${hh}:${mm}  ·  ${wTxt}`;
  }

  // ---------- ESP / 雷达 / 罗盘 ----------
  const espCanvas = document.createElement('canvas');
  espCanvas.id = '__opus_esp';
  const ectx = espCanvas.getContext('2d');

  const radar = document.createElement('canvas');
  radar.id = '__opus_radar';
  radar.width = 140; radar.height = 140;
  const rctx = radar.getContext('2d');

  const compass = document.createElement('canvas');
  compass.id = '__opus_compass';
  compass.width = 460; compass.height = 30;
  const cctx = compass.getContext('2d');

  // 敌对生物 fallback（首选 e.T.hostile 原生标记）
  const HOSTILE = new Set([
    'SkeletonKind', 'ZombieKind', 'CaveSpider', 'Crawler', 'Slime', 'SulfurCube',
    'Phantom', 'Witch', 'Illager', 'Pillager', 'Vindicator', 'Evoker', 'EvokerFangs',
    'Vex', 'Ravager', 'Breeze', 'Creaking', 'Warden', 'Shulker', 'Zoglin', 'Wither',
  ]);
  const COLORS = {
    hostile: '#ff5252',
    passive: '#4fc3f7',
    player: '#c084fc',
    line: 'rgba(255,82,82,0.65)',
    text: '#ffffff',
    hpBg: 'rgba(0,0,0,0.55)',
    hpFill: '#69f0ae',
  };

  function colorOf(e) {
    try {
      if (e.T) { if (e.T.hostile) return COLORS.hostile; if (e.T.passive) return COLORS.passive; }
      if (e.type === 'player') return COLORS.player;
    } catch (err) { }
    const name = e.constructor?.name ?? '';
    if (name === 'Player') return COLORS.player;
    if (HOSTILE.has(name)) return COLORS.hostile;
    return COLORS.passive;
  }

  // 世界 → 屏幕投影：读游戏 renderer 的 vp 矩阵（列主序），与游戏渲染完全同参
  function project(v, x, y, z, w_, h_) {
    const m = v.vp;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    // 相机后方剔除（cw = -z_eye，后方为负）；贴脸保护：cw 极小时投影坐标爆炸（除以接近
    // 零的 w），画出横跨整屏的巨大线框 —— 0.1m 内的实体不画（本来就看不见）
    if (cw <= 0.1) return null;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    // 注意：不要用 clip.z 做 [-1,1] 裁剪 —— 透视投影下 clip.z 的范围是 -(far) ~ -(near)
    // 量级（除以 cw 才是 NDC z）。v0.3.1 及之前在这里错裁了 1 米外的所有实体。
    return { x: (cx / cw * 0.5 + 0.5) * w_, y: (1 - (cy / cw * 0.5 + 0.5)) * h_ };
  }

  let renderHooked = false; // v0.5.2 修复：v0.5.0 重写时丢了声明，严格模式下读它直接抛错，ESP 全灭
  function espFrame() {
    if (!renderHooked) requestAnimationFrame(espFrame);
    const anyOn = cfg.esp || cfg.tracers || cfg.itemEsp || cfg.radar || cfg.compass || cfg.timeWeather;
    if (!anyOn) {
      ectx.clearRect(0, 0, espCanvas.width, espCanvas.height);
      rctx.clearRect(0, 0, radar.width, radar.height);
      cctx.clearRect(0, 0, compass.width, compass.height);
      updateTimeRow(performance.now());
      return;
    }
    const g = state.game, p = state.player;
    if (!g || !p) return;
    // 标题屏/加载中不画 ESP：game.entities 里是上个世界的残留实体（state: boot/title/loading/play）
    if (g.state && g.state !== 'play') {
      ectx.clearRect(0, 0, espCanvas.width, espCanvas.height);
      rctx.clearRect(0, 0, radar.width, radar.height);
      cctx.clearRect(0, 0, compass.width, compass.height);
      updateTimeRow(performance.now());
      return;
    }
    const r = g.renderer;
    if (!r || !r.vp || !r.camPos) return;
    // 渲染插值：游戏 20Hz tick 后每帧按 alpha 插值渲染（game.js run(): render(acc/50)），
    // 方框用同一 alpha 才不会 20Hz 抖动。render hook 驱动时由游戏直接传 alpha。
    const alpha = (espFrame.alpha != null) ? espFrame.alpha
      : (g.pauseA != null) ? g.pauseA
      : (typeof g.acc === 'number' && isFinite(g.acc) ? Math.max(0, Math.min(1, g.acc / 50)) : 1);

    // 尺寸跟随 #gl 的物理像素
    const glCv = g.canvas;
    if (!glCv) return;
    if (espCanvas.width !== glCv.width || espCanvas.height !== glCv.height) {
      espCanvas.width = glCv.width;
      espCanvas.height = glCv.height;
    }
    ectx.clearRect(0, 0, espCanvas.width, espCanvas.height);

    const W_ = espCanvas.width, H_ = espCanvas.height;
    const cam = r.camPos;
    const maxD2 = cfg.espDist * cfg.espDist;
    let ents;
    try { ents = g.entities; } catch (e) { return; }
    if (!Array.isArray(ents)) return;

    for (const e of ents) {
      try {
        if (!e || e === p || e.dead) continue;
        const isMob = e.health != null && e.maxHealth != null; // 生物（Living）
        let kind = null;
        if (!isMob) {
          if (!cfg.itemEsp) continue;
          kind = itemKindOf(e);
          if (!kind) continue;
        }
        let pos;
        try {
          pos = (typeof e.ipos === 'function') ? e.ipos(alpha)
            : (Array.isArray(e.pos) ? e.pos.slice() : null);
        } catch (err) { pos = null; }
        if (!pos || typeof pos[0] !== 'number') {
          pos = Array.isArray(e.pos) ? e.pos : (typeof e.x === 'number' ? [e.x, e.y, e.z] : null);
        }
        if (!pos) continue;
        const dx = pos[0] - cam[0], dy = pos[1] - cam[1], dz = pos[2] - cam[2];
        if (dx * dx + dy * dy + dz * dz > maxD2) continue;

        // 生物：3D 立体线框（8 角投影画 12 条棱）；物品/投射物：小点框
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, ok = true;
        let pts = null;
        if (isMob) {
          const hw = (num(e, 'w') ?? 0.6) / 2, hh = num(e, 'h') ?? 1.8;
          const bb = [pos[0] - hw, pos[1], pos[2] - hw, pos[0] + hw, pos[1] + hh, pos[2] + hw];
          pts = [];
          for (let i = 0; i < 8; i++) {
            const pt = project(r, bb[i & 1 ? 3 : 0], bb[i & 2 ? 4 : 1], bb[i & 4 ? 5 : 2], W_, H_);
            if (!pt) { ok = false; break; }
            // 爆炸坐标保护：角点远超画布（贴脸/极端透视）则整个框不画，防止棱线拉满屏
            if (pt.x < -W_ * 3 || pt.x > W_ * 4 || pt.y < -H_ * 3 || pt.y > H_ * 4) { ok = false; break; }
            pts.push(pt);
            if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
            if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
          }
        } else {
          const pt = project(r, pos[0], pos[1], pos[2], W_, H_);
          if (pt) { const s = 5; minX = pt.x - s; maxX = pt.x + s; minY = pt.y - s; maxY = pt.y + s; }
          else ok = false;
        }
        if (!ok || maxX <= minX || maxY <= minY) continue;

        const color = isMob ? colorOf(e) : kind;
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

        if (cfg.tracers && isMob) {
          ectx.strokeStyle = HOSTILE.has(e.constructor?.name)
            || (e.T && e.T.hostile) ? COLORS.line : 'rgba(79,195,247,0.5)';
          ectx.lineWidth = 1;
          ectx.beginPath();
          ectx.moveTo(W_ / 2, H_ / 2);
          ectx.lineTo(cx, cy);
          ectx.stroke();
        }

        if ((cfg.esp && isMob) || (cfg.itemEsp && !isMob)) {
          ectx.strokeStyle = color;
          ectx.lineWidth = isMob ? 1.5 : 1;
          if (isMob && pts) {
            // 3D 线框：底面 4 棱 + 顶面 4 棱 + 4 根立柱（彗星式立体框）
            const EDGES = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
            ectx.beginPath();
            for (const [a0, b0] of EDGES) { ectx.moveTo(pts[a0].x, pts[a0].y); ectx.lineTo(pts[b0].x, pts[b0].y); }
            ectx.stroke();
          } else {
            ectx.strokeRect(minX, minY, maxX - minX, maxY - minY);
          }
        }

        if (cfg.labels && (isMob || cfg.itemEsp)) {
          const name = cnName(e);
          const dist = Math.hypot(dx, dy, dz);
          const label = `${name}  ${dist.toFixed(0)}m`;
          ectx.textAlign = 'center';
          if (isMob) {
            ectx.font = 'bold 14px "Microsoft YaHei", sans-serif';
            const hp = Math.max(0, e.health) / e.maxHealth;
            const barW = Math.max(46, maxX - minX), barH = 5;
            const barX = cx - barW / 2, barY = minY - 12;
            ectx.fillStyle = COLORS.hpBg;
            ectx.fillRect(barX, barY, barW, barH);
            ectx.fillStyle = COLORS.hpFill;
            ectx.fillRect(barX, barY, barW * Math.min(1, hp), barH);
            // 大字 + 黑描边：远处 / 亮背景下都看得清
            ectx.lineWidth = 3;
            ectx.strokeStyle = 'rgba(0,0,0,0.85)';
            ectx.strokeText(label, cx, barY - 5);
            ectx.fillStyle = COLORS.text;
            ectx.fillText(label, cx, barY - 5);
          } else {
            ectx.font = 'bold 12px "Microsoft YaHei", sans-serif';
            ectx.lineWidth = 3;
            ectx.strokeStyle = 'rgba(0,0,0,0.85)';
            ectx.strokeText(label, cx, minY - 3);
            ectx.fillStyle = color;
            ectx.fillText(label, cx, minY - 3);
          }
          ectx.textAlign = 'start';
          ectx.lineWidth = 1;
        }
      } catch (err) { /* 单个实体出错不影响整体 */ }
    }
    drawRadar();
    drawCompass();
    updateTimeRow(performance.now());
  }

  // ---------- 实体雷达（俯视点位，玩家朝向为上） ----------
  function drawRadar() {
    const size = (radar.width !== cfg.radarSize || radar.height !== cfg.radarSize)
      ? (radar.width = radar.height = cfg.radarSize) : radar.width;
    const c = rctx;
    c.clearRect(0, 0, size, size);
    if (!cfg.radar) return;
    const g = state.game, p = state.player;
    if (!g || !p || !g.renderer || !g.renderer.camPos) return;
    const cx = size / 2, cy = size / 2, R = size / 2 - 4;
    const cam = g.renderer.camPos;
    const yaw = yawRad(num(p, 'yaw'));
    const fx = -Math.sin(yaw), fz = Math.cos(yaw); // 前向（yaw=0 面南 +Z）
    const rx = -fz, rz = fx;                        // 右向（面南时右手 = 西）
    const scale = R / Math.max(8, cfg.espDist);
    const px = (dx, dz) => cx + (dx * rx + dz * rz) * scale;
    const py = (dx, dz) => cy - (dx * fx + dz * fz) * scale;

    c.save();
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.clip();
    c.fillStyle = 'rgba(12,14,16,0.62)';
    c.fillRect(0, 0, size, size);
    c.strokeStyle = 'rgba(255,255,255,0.15)';
    c.beginPath(); c.arc(cx, cy, R / 2, 0, Math.PI * 2); c.stroke();

    let ents; try { ents = g.entities; } catch (e) { ents = null; }
    if (Array.isArray(ents)) {
      for (const e of ents) {
        try {
          if (!e || e === p || e.dead) continue;
          const pos = Array.isArray(e.pos) ? e.pos : null;
          if (!pos) continue;
          const dx = pos[0] - cam[0], dz = pos[2] - cam[2];
          if (dx * dx + dz * dz > cfg.espDist * cfg.espDist) continue;
          const isMob = e.health != null && e.maxHealth != null;
          c.fillStyle = isMob ? colorOf(e)
            : (e.constructor?.name === 'ItemEntity' ? '#ffd54f'
              : e.constructor?.name === 'ExperienceOrb' ? '#69f0ae' : '#ff8a65');
          c.beginPath();
          c.arc(px(dx, dz), py(dx, dz), isMob ? 3 : 2, 0, Math.PI * 2);
          c.fill();
        } catch (err) { /* noop */ }
      }
    }
    c.restore();
    c.strokeStyle = 'rgba(255,255,255,0.3)';
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
    // 中心玩家（朝上前三角）
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.moveTo(cx, cy - 5); c.lineTo(cx - 4, cy + 4); c.lineTo(cx + 4, cy + 4);
    c.closePath(); c.fill();
  }

  // ---------- 方位罗盘（顶部横条，南/西/北/东） ----------
  function drawCompass() {
    const w = compass.width, h = compass.height, c = cctx;
    c.clearRect(0, 0, w, h);
    if (!cfg.compass) return;
    const p = state.player;
    if (!p) return;
    const deg = yawDeg(num(p, 'yaw')) ?? 0;
    const pxPerDeg = 6;
    c.fillStyle = 'rgba(8,10,13,0.88)';
    c.beginPath();
    if (c.roundRect) c.roundRect(0, 0, w, h, 7); else c.rect(0, 0, w, h);
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.25)';
    c.stroke();
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let a = 0; a < 360; a += 15) {
      const diff = ((a - deg + 180) % 360 + 360) % 360 - 180;
      const x = w / 2 + diff * pxPerDeg;
      if (x < 6 || x > w - 6) continue;
      const big = a % 90 === 0;
      c.strokeStyle = big ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.25)';
      c.beginPath();
      c.moveTo(x, h - (big ? 13 : 8)); c.lineTo(x, h - 3);
      c.stroke();
      if (big) {
        c.fillStyle = 'rgba(255,255,255,0.95)';
        c.font = 'bold 13px "Microsoft YaHei", sans-serif';
        c.fillText({ 0: '南', 90: '西', 180: '北', 270: '东' }[a], x, 10);
      }
    }
    // 中心指针 + 当前朝向度数
    c.fillStyle = '#7fd48a';
    c.fillRect(w / 2 - 1.5, h - 14, 3, 12);
    c.fillStyle = 'rgba(255,255,255,0.65)';
    c.font = '11px Consolas, monospace';
    c.textAlign = 'left';
    c.fillText(Math.round(((deg % 360) + 360) % 360) + '°', w - 30, 10);
    c.textAlign = 'start';
  }

  // ---------- 模块定义（ClickGUI） ----------
  const MODS = [
    { col: 'render', key: 'esp', label: 'ESP 生物方框' },
    { col: 'render', key: 'tracers', label: '追踪线' },
    { col: 'render', key: 'labels', label: '名字与血条' },
    { col: 'render', key: 'itemEsp', label: '物品与投射物' },
    { col: 'render', key: 'radar', label: '实体雷达' },
    { col: 'render', key: 'compass', label: '方位罗盘' },
    { col: 'render', key: 'nightVision', label: '夜视' },
    { col: 'info', key: 'hud', label: '坐标 HUD' },
    { col: 'info', key: 'timeWeather', label: '时间与天气' },
  ];

  // ---------- ClickGUI（RShift 呼出，Meteor 式） ----------
  const menu = document.createElement('div');
  menu.id = '__opus_menu';
  menu.className = 'op-hidden';
  let menuSwitches = [];

  function guiOpen() {
    return menu && !menu.classList.contains('op-hidden');
  }

  function buildMenu() {
    menu.innerHTML = '';

    const makeCol = (title, x, y, colorCls) => {
      const col = document.createElement('div');
      col.className = 'op-col';
      col.style.left = x + 'px'; col.style.top = y + 'px';
      const head = document.createElement('div');
      head.className = 'op-col-head' + (colorCls ? ' ' + colorCls : '');
      head.textContent = title;
      head.addEventListener('mousedown', (ev) => {
        // 列头拖动（GUI 开启时游戏鼠标已被 capturePointer hook 拦下，可放心拖）
        const sx = ev.clientX - col.offsetLeft, sy = ev.clientY - col.offsetTop;
        const move = (e2) => {
          col.style.left = Math.max(0, e2.clientX - sx) + 'px';
          col.style.top = Math.max(0, e2.clientY - sy) + 'px';
        };
        const up = () => { W.removeEventListener('mousemove', move); W.removeEventListener('mouseup', up); };
        W.addEventListener('mousemove', move);
        W.addEventListener('mouseup', up);
        ev.preventDefault();
      });
      col.append(head);
      menu.append(col);
      return col;
    };

    const addModRow = (col, m) => {
      const row = document.createElement('div');
      row.className = 'op-mod' + (cfg[m.key] ? ' on' : '');
      row.textContent = m.label;
      row.addEventListener('click', () => {
        cfg[m.key] = !cfg[m.key];
        row.classList.toggle('on', cfg[m.key]);
        saveCfg();
        syncSwitches();
        if (m.key === 'hud' && cfg.hud) startHud();
      });
      col.append(row);
      m.row = row;
      return row;
    };

    // Render 列
    const cRender = makeCol('Render', 24, 64);
    for (const m of MODS.filter(m => m.col === 'render')) addModRow(cRender, m);
    // Render 列尾：ESP 距离
    const foot = document.createElement('div');
    foot.className = 'op-col-foot';
    const st = document.createElement('div');
    st.className = 'op-stepper';
    const lab = document.createElement('span');
    lab.className = 'op-steplabel';
    lab.textContent = '距离';
    const minus = document.createElement('span');
    minus.className = 'op-step-btn';
    minus.textContent = '−';
    const val = document.createElement('span');
    val.className = 'op-step-val';
    val.textContent = cfg.espDist;
    const plus = document.createElement('span');
    plus.className = 'op-step-btn';
    plus.textContent = '＋';
    const clampSet = (v) => {
      cfg.espDist = Math.max(8, Math.min(128, v));
      val.textContent = cfg.espDist;
      saveCfg();
    };
    minus.addEventListener('click', () => clampSet(cfg.espDist - 8));
    plus.addEventListener('click', () => clampSet(cfg.espDist + 8));
    st.append(lab, minus, val, plus);
    // 雷达大小 stepper
    const st2 = document.createElement('div');
    st2.className = 'op-stepper';
    const rl = document.createElement('span');
    rl.className = 'op-steplabel';
    rl.textContent = '雷达';
    const rminus = document.createElement('span');
    rminus.className = 'op-step-btn';
    rminus.textContent = '−';
    const rval = document.createElement('span');
    rval.className = 'op-step-val';
    rval.textContent = cfg.radarSize;
    const rplus = document.createElement('span');
    rplus.className = 'op-step-btn';
    rplus.textContent = '＋';
    const rset = (v) => { cfg.radarSize = Math.max(100, Math.min(220, v)); rval.textContent = cfg.radarSize; saveCfg(); };
    rminus.addEventListener('click', () => rset(cfg.radarSize - 20));
    rplus.addEventListener('click', () => rset(cfg.radarSize + 20));
    st2.append(rl, rminus, rval, rplus);
    foot.append(st, st2);
    cRender.append(foot);

    // 信息列
    const cInfo = makeCol('信息', 190, 64, 'blue');
    for (const m of MODS.filter(m => m.col === 'info')) addModRow(cInfo, m);
    // 信息列尾：房间服务器切换（点击在已配置的服务器间循环）
    const sfoot = document.createElement('div');
    sfoot.className = 'op-col-foot';
    const srow = document.createElement('div');
    srow.className = 'op-stepper';
    const slab = document.createElement('span');
    slab.className = 'op-steplabel';
    const refreshS = () => {
      const s = (cfg.servers || [])[cfg.serverIdx];
      slab.textContent = '服务器: ' + (s ? s.name : '默认');
    };
    srow.append(slab);
    srow.addEventListener('click', () => {
      if (!cfg.servers || cfg.servers.length < 2) {
        slab.textContent = '控制台 __opusHud.addServer(名, 地址) 添加';
        setTimeout(refreshS, 3000);
        return;
      }
      cfg.serverIdx = (cfg.serverIdx + 1) % cfg.servers.length;
      applyServer();
      refreshS();
      saveCfg();
    });
    refreshS();
    sfoot.append(srow);
    cInfo.append(sfoot);
    // MC1.8 直连（PHPMC）：地址/玩家名/连接按钮/状态 —— 依赖 opus-mc18-link 内核脚本
    const mfoot = document.createElement('div');
    mfoot.className = 'op-col-foot';
    const mAddr = document.createElement('input');
    mAddr.className = 'op-search';
    mAddr.value = cfg.mcAddr || 'ws://localhost:25565';
    mAddr.placeholder = 'ws://IP:25565';
    mAddr.addEventListener('change', () => { cfg.mcAddr = mAddr.value.trim() || cfg.mcAddr; saveCfg(); });
    const mName = document.createElement('input');
    mName.className = 'op-search';
    mName.value = cfg.mcName || 'WebPlayer';
    mName.placeholder = '玩家名';
    mName.addEventListener('change', () => { cfg.mcName = mName.value.trim() || 'WebPlayer'; saveCfg(); });
    const mBtn = document.createElement('div');
    mBtn.className = 'op-mod';
    mBtn.textContent = '连接 / 断开';
    const mStat = document.createElement('div');
    mStat.className = 'op-steplabel';
    const refreshM = () => {
      try {
        const M = W.__mc18;
        if (!M) { mStat.textContent = '状态: 请先安装 opus-mc18-link'; return; }
        const st = M.status().state;
        mStat.textContent = '状态: ' + ({ idle: '未连接', connecting: '连接中', login: '登录中', play: '已连接', closed: '已断开' }[st] || st);
      } catch (err) { /* noop */ }
    };
    mBtn.addEventListener('click', () => {
      const M = W.__mc18;
      if (!M) { mStat.textContent = '请先安装 opus-mc18-link 脚本'; return; }
      const st = M.status().state;
      if (st === 'play' || st === 'connecting' || st === 'login') { M.disconnect(); }
      else {
        cfg.mcAddr = mAddr.value.trim() || cfg.mcAddr;
        cfg.mcName = mName.value.trim() || 'WebPlayer';
        saveCfg();
        M.connect(cfg.mcAddr, cfg.mcName);
      }
      setTimeout(refreshM, 400);
    });
    mStat.textContent = '状态: -';
    setInterval(() => { if (guiOpen()) refreshM(); }, 2000);
    mfoot.append(mAddr, mName, mBtn, mStat);
    cInfo.append(mfoot);

    // 搜索列
    const cSearch = makeCol('Search', 356, 64, 'green');
    const input = document.createElement('input');
    input.className = 'op-search';
    input.placeholder = '搜索模块…';
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      for (const m of MODS) {
        if (!m.row) continue;
        m.row.style.display = (!q || m.label.toLowerCase().includes(q)) ? '' : 'none';
      }
    });
    cSearch.append(input);

    // 底部提示
    const footTip = document.createElement('div');
    footTip.className = 'op-gui-foot';
    footTip.textContent = 'v' + VERSION + ' · 左键 切换模块 · 拖列头 移动 · RShift 关闭 · 仅建议单人';
    menu.append(footTip);

    menuSwitches = MODS.map(m => ({ key: m.key, el: m.row }));
  }

  function toggleMenu(force) {
    const show = force != null ? force : menu.classList.contains('op-hidden');
    menu.classList.toggle('op-hidden', !show);
    // 打开 GUI 必须松开鼠标指针：游戏锁着指针时看得见却点不到
    if (show) {
      try { if (document.pointerLockElement) document.exitPointerLock(); } catch (err) { }
      try { if (state.game && state.game.releasePointer) state.game.releasePointer(); } catch (err) { }
    }
  }

  // 统一键盘：window capture 且先于游戏脚本注册 —— RShift 归我们，GUI 开着时吞掉游戏按键
  W.addEventListener('keydown', (e) => {
    if (e.code === 'ShiftRight') {
      e.stopImmediatePropagation();
      e.preventDefault();
      toggleMenu();
      return;
    }
    if (e.key === 'l' || e.key === 'L') { toggleMenu(); return; }
    if (e.key === 'h' || e.key === 'H') {
      cfg.hud = !cfg.hud;
      saveCfg();
      hud.style.display = cfg.hud ? '' : 'none';
      if (cfg.hud) startHud();
      syncSwitches();
      return;
    }
    if (e.key === 'Escape' && guiOpen()) { toggleMenu(false); return; }
    // GUI 开着时吞掉传给游戏的其余按键（角色别乱动）；
    // 搜索框打字：拦游戏的 keydown 但不 preventDefault —— 文字照常输入
    if (guiOpen()) {
      if (e.target && e.target.tagName === 'INPUT') { e.stopImmediatePropagation(); return; }
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);

  function syncSwitches() {
    menuSwitches.forEach(({ key, el }) => el && el.classList.toggle('on', cfg[key]));
  }

  // ---------- 夜视：游戏渲染原生支持 env.nightVision（夜视药水），替换全局换算函数 ----------
  function hookNightVision() {
    if (typeof W.nightVisionScale !== 'function') {
      console.warn('[OpusHUD] nightVisionScale 不存在，夜视开关不可用');
      return;
    }
    const orig = W.nightVisionScale;
    W.nightVisionScale = function (p) {
      const v = orig.call(this, p);
      try { return cfg.nightVision ? Math.max(v, 1) : v; } catch (err) { return v; }
    };
  }

  // ---------- 渲染循环挂钩：渲染完立即画 ESP，消除独立 rAF 的一帧滞后 ----------
  let hookedOrig = null, hookedProto = null;
  function hookRender() {
    try {
      const G = state.game && state.game.constructor;
      if (!G || !G.prototype || typeof G.prototype.render !== 'function') return false;
      if (G.prototype.__opusRenderHooked) { renderHooked = true; return true; }
      hookedProto = G.prototype;
      hookedOrig = G.prototype.render;
      G.prototype.render = function (a, now) {
        const out = hookedOrig.call(this, a, now);
        try { espFrame.alpha = a; espFrame(); } catch (e) { }
        return out;
      };
      G.prototype.__opusRenderHooked = true;
      renderHooked = true;
      console.log('[OpusHUD] 已挂入游戏渲染循环（每帧渲染后立即绘制）');
      return true;
    } catch (e) { return false; }
  }

  // ---------- 房间服务器切换（RoomService.base() 动态读 NET_CONFIG.rooms，热切换生效） ----------
  function applyServer() {
    try {
      const s = cfg.servers && cfg.servers[cfg.serverIdx];
      if (s && W.NET_CONFIG) W.NET_CONFIG.rooms = s.url;
    } catch (err) { /* noop */ }
  }

  // ---------- 装配 ----------
  function boot() {
    // 只在真正的游戏页面启动 UI：游戏 HTML 里有静态的 <canvas id="gl">，
    // B 站 Toy 外壳页没有。外壳页那份实例是「假身」——它的菜单开关存在自己的
    // localStorage 里，永远作用于一个没有游戏的页面。
    if (!document.getElementById('gl')) {
      console.log('[OpusHUD] 当前是 Toy 外壳页（无 #gl 画布），跳过注入，只在游戏画面里生效。');
      return;
    }
    installFillTextSniffer();
    hookNightVision();
    applyServer();
    document.head.appendChild(styleEl);
    document.documentElement.append(hud, timeRow, espCanvas, radar, compass, menu);
    buildMenu();
    startHud();
    // ESP 绘制驱动：优先挂进游戏渲染循环（渲染完立即画，零滞后），
    // 挂不上（异构实现）才退回自己的 rAF 循环 —— 由 pollRef 决定
    pollRef(0);
  }

  function pollRef(tries) {
    if (state.player) return;
    const found = tryGlobalMount() || scanWindow();
    if (found) {
      state.game = found.game;
      state.player = found.player;
      state.flavor = found.key;
      titleRow.textContent = `OpusHUD v${VERSION} · 已接入（${found.key}）· RShift 开菜单`;
      console.log('[OpusHUD] 引用接入成功:', found.key, { game: found.game, player: found.player });
      // GUI 开着时拦下游戏的指针锁定（点 GUI / 点空白都不再锁视角）
      try {
        if (typeof state.game.capturePointer === 'function') {
          const origCap = state.game.capturePointer;
          state.game.capturePointer = function () {
            if (guiOpen()) return;
            return origCap.call(this);
          };
        }
      } catch (e) { /* noop */ }
      if (!hookRender()) requestAnimationFrame(espFrame);
      return;
    }
    if (tries < REF_POLL_MAX_TRIES) setTimeout(() => pollRef(tries + 1), REF_POLL_MS);
    else titleRow.textContent = 'OpusHUD · 自动发现失败，用 __opusHud.setRef() 手动接入';
  }

  W.__opusHud = {
    setRef(obj) {
      if (!obj) return '传个对象进来';
      if (obj.player && looksLikePlayer(obj.player)) {
        state.game = obj; state.player = obj.player;
      } else if (looksLikePlayer(obj)) {
        state.player = obj;
      } else {
        return '这个对象不像 game/player（没找到坐标字段）';
      }
      titleRow.textContent = `OpusHUD v${VERSION} · 手动接入成功 · RShift 开菜单`;
      if (!hookRender()) requestAnimationFrame(espFrame);
      return 'OK';
    },
    sniffFillText() {
      this._sniffing = { count: 0 };
      this.fillTextLog = [];
      return '嗅探已开启，玩两秒再看 __opusHud.fillTextLog';
    },
    stopSniff() { this._sniffing = null; },
    toggleMenu,
    toggleHud() {
      cfg.hud = !cfg.hud;
      saveCfg();
      hud.style.display = cfg.hud ? '' : 'none';
      if (cfg.hud) startHud();
      syncSwitches();
    },
    destroy() {
      try { if (hookedProto && hookedOrig) { hookedProto.render = hookedOrig; delete hookedProto.__opusRenderHooked; } } catch (err) { }
      hud.remove(); timeRow.remove(); espCanvas.remove(); radar.remove(); compass.remove();
      menu.remove(); styleEl.remove();
      delete W.__opusHud;
    },
    addServer(name, url) {
      if (!name || !url || !/^(wss?|https?):\/\//.test(url)) return '用法: __opusHud.addServer(名字, https/wss 地址)';
      cfg.servers = cfg.servers || [{ name: '官方', url: 'https://xz.honghemc.cn:8443' }];
      cfg.servers.push({ name: String(name).slice(0, 16), url: String(url) });
      saveCfg();
      return '已添加（共 ' + cfg.servers.length + ' 个）。GUI 信息列点「服务器」切换，或 __opusHud.setServer(序号)';
    },
    listServers() {
      return (cfg.servers || []).map((s, i) => (i === cfg.serverIdx ? '> ' : '  ') + i + ': ' + s.name + ' ' + s.url);
    },
    setServer(i) {
      if (!cfg.servers || !cfg.servers[i]) return '序号不存在，__opusHud.listServers() 查看';
      cfg.serverIdx = i;
      applyServer();
      saveCfg();
      return '已切换到 ' + cfg.servers[i].name + ' —— 重进房间生效（正在连接中的不变）';
    },
    cfg,
    fillTextLog: [],
    _sniffing: null,
    _snifferInstalled: false,
    state,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
