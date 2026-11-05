// ==UserScript==
// @name         OpusMC MC1.8 直连内核（PHPMC 双协议实验）
// @namespace    https://github.com/bigpixel
// @version      0.1.0
// @description  在 OpusMC 网页客户端里实现 Minecraft 1.8.9 协议客户端内核（协议 47）：经 WebSocket 直连 PHPMC 服务端（ws://host:25565 自动识别 / wss://host:24443），握手-登录-Play 状态机、KeepAlive 应答、聊天收发、区块/实体包解码。解码表按 PHPMC src/Server.php 的实际发包字段反向核对。
// @author       BigPixel
// @match        http://localhost:8777/*
// @match        https://www.bilibilitoy.com/*
// @match        https://opuscraft.pages.dev/*
// @match        https://www.bilibili.com/toy/*
// @updateURL    https://raw.githubusercontent.com/dawgnation1986/opusmc-mods/main/opus-mc18-link.user.js
// @downloadURL  https://raw.githubusercontent.com/dawgnation1986/opusmc-mods/main/opus-mc18-link.user.js
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // ---------- VarInt / VarString 读写 ----------
  function writeVarInt(v) {
    v = v >>> 0;
    const out = [];
    do {
      let b = v & 0x7F;
      v >>>= 7;
      if (v !== 0) b |= 0x80;
      out.push(b);
    } while (v !== 0);
    return new Uint8Array(out);
  }

  // 流式读取器（带游标）
  class Reader {
    constructor(buf) { this.b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); this.o = 0; }
    u8() { return this.b[this.o++]; }
    i8() { const v = this.b[this.o++]; return v >= 0x80 ? v - 0x100 : v; }
    u16() { return (this.b[this.o++] << 8) | this.b[this.o++]; }
    i16() { const v = this.u16(); return v >= 0x8000 ? v - 0x10000 : v; }
    u32() { return ((this.b[this.o++] << 24) | (this.b[this.o++] << 16) | (this.b[this.o++] << 8) | this.b[this.o++]) >>> 0; }
    i32() { const v = this.u32(); return v >= 0x80000000 ? v - 0x100000000 : v; }
    i64() {
      const hi = this.i32(), lo = this.u32();
      return hi * 4294967296 + lo;
    }
    f32() {
      const dv = new DataView(this.b.buffer, this.b.byteOffset + this.o, 4);
      this.o += 4;
      return dv.getFloat32(0);
    }
    f64() {
      const dv = new DataView(this.b.buffer, this.b.byteOffset + this.o, 8);
      this.o += 8;
      return dv.getFloat64(0);
    }
    bool() { return this.u8() !== 0; }
    varInt() {
      let v = 0, shift = 0;
      while (true) {
        const b = this.b[this.o++];
        v |= (b & 0x7F) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
        if (shift > 32) throw new Error('varInt 太长');
      }
      return v | 0;
    }
    string() {
      const len = this.varInt();
      const s = new TextDecoder('utf-8').decode(this.b.subarray(this.o, this.o + len));
      this.o += len;
      return s;
    }
    raw(n) { const s = this.b.subarray(this.o, this.o + n); this.o += n; return s; }
    // packed position（MC 标准：x26 | y12 | z26 大端）
    packedPos() {
      const v = BigInt(this.i64());
      const x = Number((v >> 38n) & 0x3FFFFFFn);
      const y = Number((v >> 26n) & 0xFFFn);
      const z = Number(v & 0x3FFFFFFn);
      const sx = x >= 0x2000000 ? x - 0x4000000 : x;
      const sz = z >= 0x2000000 ? z - 0x4000000 : z;
      const sy = y >= 0x800 ? y - 0x1000 : y;
      return [sx, sy, sz];
    }
    // 1.8 实体元数据（watch：byte(类型<<5|索引) + 值，0x00 结尾）
    metadata() {
      const out = [];
      while (true) {
        const h = this.u8();
        if (h === 0) break;
        const type = (h >> 5) & 7;
        let val = null;
        switch (type) {
          case 0: val = this.i8(); break;
          case 1: val = this.i16(); break;
          case 2: val = this.i32(); break;
          case 3: val = this.f32(); break;
          case 4: val = this.string(); break;
          case 5: { // item: short id + byte count + short dmg (+ 可选 nbt，PHPMC 不带就当无)
            const id = this.i16(); const cnt = this.i8(); const dmg = this.i16();
            val = { id, cnt, dmg };
            break;
          }
          case 6: val = [this.i32(), this.i32(), this.i32()]; break;
          case 7: val = [this.f32(), this.f32(), this.f32()]; break;
          default: throw new Error('metadata 未知类型 ' + type);
        }
        out.push({ idx: h & 0x1F, type, val });
      }
      return out;
    }
    // NBT 跳过（PHPMC src/Nbt 是标准 NBT 格式）
    skipNbt() { this.skipNbtAt(this.u8()); }
    skipNbtAt(typeId) {
      if (typeId === 0) return;
      switch (typeId) {
        case 1: this.o += 1; break;
        case 2: this.o += 2; break;
        case 3: this.o += 4; break;
        case 4: this.o += 8; break;
        case 5: this.o += 4; break;
        case 6: this.o += 8; break;
        case 7: this.o += this.u32() ; break;            // byte array: int32 len + bytes
        case 8: this.o += this.u16(); break;             // string: u16 len + utf8
        case 9: {                                        // list
          const it = this.u8();
          const n = this.i32();
          for (let i = 0; i < n; i++) this.skipNbtAt(it);
          break;
        }
        case 10: {                                       // compound
          while (true) {
            const t = this.u8();
            if (t === 0) break;
            this.o += this.u16();
            this.skipNbtAt(t);
          }
          break;
        }
        case 11: this.o += this.i32() * 4; break;
        case 12: this.o += this.i32() * 8; break;
        default: throw new Error('NBT 未知类型 ' + typeId);
      }
    }
    get left() { return this.b.length - this.o; }
  }

  // 小写入器（客户端发包用）
  class Writer {
    constructor() { this.parts = []; }
    push(u8) { this.parts.push(u8); return this; }
    varInt(v) { this.push(writeVarInt(v)); return this; }
    string(s) {
      const b = new TextEncoder().encode(s);
      this.varInt(b.length);
      this.push(b);
      return this;
    }
    bytes(b) { this.push(b instanceof Uint8Array ? b : new Uint8Array(b)); return this; }
    build() {
      const total = this.parts.reduce((a, p) => a + p.length, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const p of this.parts) { out.set(p, o); o += p.length; }
      return out;
    }
  }

  // ---------- 包封装（无压缩：VarInt 长度 + VarInt 包ID + 负载） ----------
  function framePacket(id, body) {
    const idB = writeVarInt(id);
    const payload = new Uint8Array(idB.length + (body ? body.length : 0));
    payload.set(idB, 0);
    if (body) payload.set(body, idB.length);
    const head = writeVarInt(payload.length);
    const out = new Uint8Array(head.length + payload.length);
    out.set(head, 0);
    out.set(payload, head.length);
    return out;
  }

  // ---------- MC1.8 客户端内核 ----------
  const mc = {
    ws: null,
    state: 'idle',        // idle | connecting | handshake | login | play | closed
    server: '',
    name: '',
    buf: new Uint8Array(0),
    entityId: -1,
    log: [],              // 最近的聊天/事件
    chunks: 0,
    lastKeepAlive: 0,
    onChat: null,         // (text, who) => {}
    onState: null,        // (state, detail) => {}

    _setState(s, detail) {
      this.state = s;
      this._log('[状态] ' + s + (detail ? ' — ' + detail : ''));
      if (this.onState) try { this.onState(s, detail); } catch (e) { /* noop */ }
    },
    _log(s) {
      this.log.push({ at: new Date().toLocaleTimeString(), s });
      if (this.log.length > 200) this.log.shift();
      console.log('[mc18] ' + s);
    },

    connect(url, name) {
      if (this.ws) { try { this.ws.close(); } catch (e) { /* noop */ } }
      this.server = url;
      this.name = name || 'WebPlayer';
      this.buf = new Uint8Array(0);
      this.chunks = 0;
      this._setState('connecting', url);
      const ws = this.ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        // 1.8 握手：0x00 varInt 协议号(47) + string 地址 + uShort 端口 + varInt 下一状态(2=登录)
        const hostPort = parseHostPort(url);
        const hs = new Writer().varInt(47).string(hostPort.host).varInt(hostPort.port).varInt(2);
        this._sendRaw(0x00, hs.build(), 'handshake');
        // 2. 登录开始（离线模式）：0x00 string 用户名
        const lg = new Writer().string(this.name);
        this._sendRaw(0x00, lg.build(), 'login start');
        this._setState('login');
      };
      ws.onmessage = (e) => {
        // WS binary 帧拼进缓冲，按 MC VarInt 包长分帧（帧边界 ≠ 包边界）
        const d = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : new Uint8Array(new TextEncoder().encode(e.data));
        const merged = new Uint8Array(this.buf.length + d.length);
        merged.set(this.buf, 0); merged.set(d, this.buf.length);
        this.buf = merged;
        this._drain();
      };
      ws.onclose = () => this._setState('closed', '连接已断开');
      ws.onerror = () => this._log('WS 错误（自签 wss 证书会被浏览器拒；本地测试用 ws://host:25565）');
      return 'connecting to ' + url;
    },

    disconnect() {
      try { this.ws && this.ws.close(); } catch (e) { /* noop */ }
      this._setState('closed', '主动断开');
    },

    say(text) {
      if (this.state !== 'play') return '还没进入 Play 状态';
      this._sendRaw(0x01, new Writer().string(text).build());
      return '已发送: ' + text;
    },

    // 把 OpusMC 玩家位置发给 MC 服务器（触发区块下发；两套世界坐标不同，仅作探针）
    probe(x, y, z) {
      if (this.state !== 'play') return '还没进入 Play 状态';
      const w = new Writer().double(x).double(y).double(z).bool(true);
      this._sendRaw(0x04, w.build());
      const l = new Writer().float(0).float(0).bool(true);
      this._sendRaw(0x06, l.build());
      return '位置探针已发（服务器会按此坐标发区块）';
    },

    _sendRaw(packetId, body, tag) {
      if (!this.ws || this.ws.readyState !== 1) { this._log('未连接，发不了 ' + (tag || packetId)); return; }
      this.ws.send(framePacket(packetId, body).buffer);
      if (tag) this._log('→ ' + tag);
    },

    _drain() {
      while (true) {
        const b = this.buf;
        // 读 VarInt 包长
        let len = 0, shift = 0, o = 0, ok = false;
        while (o < b.length) {
          const byte = b[o++];
          len |= (byte & 0x7F) << shift;
          if (!(byte & 0x80)) { ok = true; break; }
          shift += 7;
          if (shift > 21) break;
        }
        if (!ok || o + len > b.length) break; // 还没收全
        const payload = b.subarray(o, o + len);
        this.buf = b.slice(o + len);
        try { this._handlePacket(payload); } catch (e) {
          this._log('解码异常: ' + e.message);
        }
      }
    },

    _handlePacket(payload) {
      const r = new Reader(payload);
      const id = r.varInt();
      switch (this.state) {
        case 'login': return this._handleLogin(id, r);
        case 'play': return this._handlePlay(id, r);
        default: return this._log('收到非预期状态的包 ' + id);
      }
    },

    // 登录期：0x00 Disconnect / 0x02 LoginSuccess / 0x03 SetCompression（PHPMC 不压缩，未发）
    _handleLogin(id, r) {
      if (id === 0x02) {
        const uuid = r.string(), user = r.string();
        this._setState('play', user + ' (' + uuid.slice(0, 8) + '…) 已通过登录');
      } else if (id === 0x03) {
        this._log('服务器要求压缩（PHPMC 未实现，理论不应出现）');
      } else if (id === 0x00) {
        this._log('被拒: ' + r.string());
        this._setState('closed', '登录被拒');
      } else {
        this._log('登录期未知包 ' + id + '（剩余 ' + r.left + 'B）');
      }
    },

    // Play 期解码表 —— 字段顺序按 PHPMC src/Server.php 的 send 调用点核对
    _handlePlay(id, r) {
      switch (id) {
        case 0x00: { // KeepAlive：回 0x00 同 id
          const kid = r.varInt();
          this.lastKeepAlive = kid;
          this._sendRaw(0x00, new Writer().varInt(kid).build());
          return;
        }
        case 0x01: { // Join Game
          this.entityId = r.i32();
          const gm = r.u8(), dim = r.i8(), diff = r.u8(), max = r.u8(), lvl = r.string();
          this._log(`进入世界：eid=${this.entityId} 模式=${gm} 维度=${dim} 类型=${lvl}`);
          this._setState('play', '已进入 ' + lvl);
          return;
        }
        case 0x02: { // Chat
          const json = r.string(), pos = r.i8();
          let text = json;
          try {
            const j = JSON.parse(json);
            text = flattenChat(j);
          } catch (e) { /* 原样 */ }
          this._log('[聊天' + pos + '] ' + text);
          if (this.onChat) try { this.onChat(text, pos); } catch (e) { /* noop */ }
          return;
        }
        case 0x03: { // Time Update
          r.i64(); r.i64();
          return;
        }
        case 0x05: { // Spawn Position
          const p = r.packedPos();
          this._log('出生点 ' + p.join(','));
          return;
        }
        case 0x06: { // Update Health：float + varInt + float
          const hp = r.f32(), food = r.varInt(), sat = r.f32();
          this._log(`生命 ${hp.toFixed(1)} 饥饿 ${food}`);
          return;
        }
        case 0x07: { // Respawn：int dim + uByte diff + uByte gm + string worldType
          r.i32(); r.u8(); r.u8(); r.string();
          return;
        }
        case 0x08: { // Position & Look（服务器定位玩家）
          const x = r.f64(), y = r.f64(), z = r.f64(), yaw = r.f32(), pitch = r.f32();
          r.u8();
          this._log(`服务器定位 (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
          return;
        }
        case 0x0A: { // Use Bed：eid + packedPos
          r.varInt(); r.packedPos();
          return;
        }
        case 0x0B: { // Animation：eid + byte
          r.varInt(); r.u8();
          return;
        }
        case 0x0C: { // Spawn Player：eid + uuid16 + int×3(*32) + yaw/pitch + held(short) + metadata
          r.varInt(); r.raw(16); r.i32(); r.i32(); r.i32(); r.u8(); r.u8(); r.i16();
          r.metadata();
          return;
        }
        case 0x0D: { // Collect Item：collected + collector
          r.varInt(); r.varInt();
          return;
        }
        case 0x0E: { // Spawn Object：eid + type + int×3(*32) + pitch/yaw + int data + (data>0: vel×3)
          r.varInt(); r.u8(); r.i32(); r.i32(); r.i32(); r.u8(); r.u8();
          const data = r.i32();
          if (data > 0) { r.i16(); r.i16(); r.i16(); }
          return;
        }
        case 0x0F: { // Spawn Mob：eid + uByte type + int×3 + yaw/pitch/head + vel×3 + metadata
          r.varInt(); r.u8(); r.i32(); r.i32(); r.i32(); r.u8(); r.u8(); r.u8();
          r.i16(); r.i16(); r.i16();
          r.metadata();
          return;
        }
        case 0x11: { // Spawn XP Orb：eid + int×3 + short
          r.varInt(); r.i32(); r.i32(); r.i32(); r.i16();
          return;
        }
        case 0x12: { // Entity Velocity：eid + short×3
          r.varInt(); r.i16(); r.i16(); r.i16();
          return;
        }
        case 0x13: { // Destroy Entities：varInt count + eid×n
          const n = r.varInt();
          for (let i = 0; i < n; i++) r.varInt();
          return;
        }
        case 0x15: { // Entity Relative Move：eid + byte×3
          r.varInt(); r.i8(); r.i8(); r.i8();
          return;
        }
        case 0x16: { // Entity Look：eid + yaw/pitch + onGround
          r.varInt(); r.u8(); r.u8(); r.bool();
          return;
        }
        case 0x17: { // Entity Move & Look：eid + byte×3 + yaw/pitch + onGround
          r.varInt(); r.i8(); r.i8(); r.i8(); r.u8(); r.u8(); r.bool();
          return;
        }
        case 0x18: { // Entity Teleport：eid + int×3 + yaw/pitch + onGround
          r.varInt(); r.i32(); r.i32(); r.i32(); r.u8(); r.u8(); r.bool();
          return;
        }
        case 0x19: { // Head Look：eid + byte
          r.varInt(); r.u8();
          return;
        }
        case 0x1A: { // Entity Status：int eid + byte
          r.i32(); r.u8();
          return;
        }
        case 0x1B: { // Attach Entity：int + int + bool
          r.i32(); r.i32(); r.bool();
          return;
        }
        case 0x1C: { // Entity Metadata：eid + metadata
          r.varInt(); r.metadata();
          return;
        }
        case 0x1F: { // Set Experience：float + varInt + varInt
          r.f32(); r.varInt(); r.varInt();
          return;
        }
        case 0x21: { // Chunk Data —— PHPMC 特例：primaryBitmask 用 short（2 字节），不是标准 varInt
          const cx = r.i32(), cz = r.i32();
          r.bool();                     // groundUp = true
          const mask = r.i16();         // ← PHPMC 写的是 short（标准 1.8 是 varInt）
          const size = r.varInt();
          r.raw(size);
          this.chunks++;
          if (this.chunks % 25 === 1) this._log(`已收区块 ${this.chunks} 个（最新 ${cx},${cz} mask=0x${(mask & 0xFFFF).toString(16)} ${size}B）`);
          return;
        }
        case 0x23: { // Block Change：packedPos + varInt blockId
          const p = r.packedPos();
          const bid = r.varInt();
          this._log('方块变化 ' + p.join(',') + ' → ' + bid);
          return;
        }
        case 0x29: { // Spawn Painting：eid + string title + packedPos + byte dir
          r.varInt(); r.string(); r.packedPos(); r.u8();
          return;
        }
        case 0x2B: { // Change Game State：byte reason + float value
          r.u8(); r.f32();
          return;
        }
        case 0x2D: { // Open Window：uByte id + string type + string title + uByte slots (+bool horse)
          r.u8(); r.string(); r.string(); r.u8();
          return;
        }
        case 0x2F: { // Set Slot：byte win + short slot + short item + (item>=0: byte count + short dmg + 可选 nbt)
          r.i8(); r.i16(); const it = r.i16();
          if (it >= 0) { r.i8(); r.i16(); }
          return;
        }
        case 0x30: { // Window Items：byte win + short count + slots
          r.i8();
          const n = r.i16();
          for (let i = 0; i < n; i++) {
            const it = r.i16();
            if (it >= 0) { r.i8(); r.i16(); }
          }
          return;
        }
        case 0x31: { // Window Property：byte + short + short
          r.i8(); r.i16(); r.i16();
          return;
        }
        case 0x32: { // Confirm Transaction：byte + short + bool
          r.i8(); r.i16(); r.bool();
          return;
        }
        case 0x33: { // Update Sign：packedPos + string×4
          r.packedPos(); r.string(); r.string(); r.string(); r.string();
          return;
        }
        case 0x35: { // Update Tile Entity：packedPos + uByte action + NBT
          r.packedPos(); r.u8();
          r.skipNbt();
          return;
        }
        case 0x36: { // Sign Editor Open：packedPos
          r.packedPos();
          return;
        }
        case 0x38: { // Player List：varInt action + varInt count + entries
          const action = r.varInt(), n = r.varInt();
          for (let i = 0; i < n; i++) {
            r.raw(16); // uuid
            if (action === 0) {
              r.string();                       // 名字
              const props = r.varInt();         // 属性（皮肤纹理）
              for (let p = 0; p < props; p++) {
                r.string(); r.string();
                if (r.bool()) r.string();       // 签名
              }
              r.varInt(); r.varInt(); r.bool(); // gamemode / ping / displayName
            } else if (action === 1) { r.varInt(); }
            else if (action === 2) { r.varInt(); }
            else if (action === 3) { r.varInt(); }
            // action 4（移除）只有 uuid
          }
          return;
        }
        case 0x39: { // Abilities：byte flags + float + float
          r.u8(); r.f32(); r.f32();
          return;
        }
        case 0x40: { // Disconnect
          this._log('服务器断开: ' + r.string());
          this._setState('closed', '服务器断开');
          return;
        }
        default:
          // PHPMC 发了表里没有的包：报出来，便于补表（会导致后续流错位，需要重连）
          this._log('⚠ 未收录的包 0x' + id.toString(16) + '（剩余 ' + r.left + 'B）—— 流已错位，建议 __mc18.connect 重连');
          throw new Error('未收录包 0x' + id.toString(16));
      }
    },

    status() {
      return {
        state: this.state,
        server: this.server,
        name: this.name,
        entityId: this.entityId,
        chunks: this.chunks,
        lastKeepAlive: this.lastKeepAlive,
        recent: this.log.slice(-12),
      };
    },
  };

  function flattenChat(j) {
    let out = j.text || '';
    if (Array.isArray(j.extra)) for (const ex of j.extra) out += flattenChat(ex);
    return out;
  }

  function parseHostPort(wsUrl) {
    try {
      const u = new URL(wsUrl);
      const secure = u.protocol === 'wss:';
      const host = u.hostname;
      const port = u.port ? +u.port : (secure ? 443 : 80);
      return { host, port: port || (secure ? 24443 : 25565) };
    } catch (e) {
      return { host: 'localhost', port: 25565 };
    }
  }

  W.__mc18 = mc;
  console.log('[mc18] MC 1.8.9 直连内核就绪：__mc18.connect(\'ws://localhost:25565\', \'名字\') → __mc18.status() / __mc18.say(\'hi\') / __mc18.help()');
  W.__mc18.help = () => console.log([
    '__mc18.connect(url, name)   连接 PHPMC：本地版 ws://localhost:25565，wss 用 wss://host:24443（需受信证书）',
    '__mc18.status()             连接状态 + 最近 12 条日志',
    '__mc18.say("hi")            发聊天',
    '__mc18.probe(x,y,z)         发位置探针（触发服务器按坐标发区块）',
    '__mc18.disconnect()         断开',
    '__mc18.onChat = (t)=>{}     聊天回调',
    '__mc18.onState = (s)=>{}    状态回调',
    '说明：区块解码已通（PHPMC 特例 bitmask=short）；世界渲染/方块桥接是下一阶段。',
  ].join('\n'));
})();
