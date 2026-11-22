import { Server } from 'socket.io';
import crypto from 'crypto';
import { isValidWord, normalize, stripAl } from '../../dictionary';

const CATEGORIES = ['اسم', 'بلد', 'حيوان', 'نبات', 'جماد', 'أكلة'];
const LETTERS = [...'ابتثجحخدذرزسشصضطظعغفقكلمنهوي'];
const DEFAULT_SETTINGS = { rounds: 10, seconds: 30 }; // 30 ثانية لتناسب Vercel
const STOP_SECONDS = 10;
const MAX_PLAYERS = 8;
const GRACE_MS = 60000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));

// ⚠️ الحالة في الذاكرة — بتفضل طول ما الـ instance شغال
const rooms = new Map();

function code() {
  let s;
  do { s = crypto.randomBytes(3).toString('hex').slice(0, 5).toUpperCase(); }
  while (rooms.has(s));
  return s;
}

function newPlayer(name, socketId) {
  return {
    id: crypto.randomBytes(8).toString('hex'),
    name, score: 0, socketId,
    token: crypto.randomBytes(16).toString('hex'),
    disconnected: false
  };
}

function publicRoom(r) {
  return {
    code: r.code, hostId: r.hostId, settings: r.settings, started: r.round > 0,
    players: [...r.players.values()].map(p => ({
      id: p.id, name: p.name, score: p.score, disconnected: !!p.disconnected
    }))
  };
}

function finalScores(r) {
  return [...r.players.values()]
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function setup(io) {
  const broadcast = r => io.to(r.code).emit('room_update', publicRoom(r));

  function startRound(r) {
    if (r.round >= r.settings.rounds) {
      r.gameOver = true;
      io.to(r.code).emit('game_finished', { scores: finalScores(r) });
      return;
    }
    const avail = LETTERS.filter(x => !r.used.has(x));
    if (!avail.length) {
      r.gameOver = true;
      io.to(r.code).emit('game_finished', { scores: finalScores(r) });
      return;
    }
    r.round++;
    r.letter = avail[Math.floor(Math.random() * avail.length)];
    r.used.add(r.letter);
    r.submissions.clear();
    r.finished = false;
    r.lastResults = null;
    r.timeLeft = r.settings.seconds;
    io.to(r.code).emit('game_started', { round: r.round, letter: r.letter, total: r.settings.rounds });
    io.to(r.code).emit('round_tick', r.timeLeft);
    clearInterval(r.clock);
    r.clock = setInterval(() => {
      r.timeLeft--;
      io.to(r.code).emit('round_tick', r.timeLeft);
      if (r.timeLeft <= 0) { clearInterval(r.clock); scoreRound(r); }
    }, 1000);
  }

  function scoreRound(r) {
    if (r.finished) return;
    r.finished = true;
    clearInterval(r.clock);

    const normalizedByCategory = {};
    for (const cat of CATEGORIES) {
      normalizedByCategory[cat] = [];
      for (const p of r.players.values()) {
        const word = (r.submissions.get(p.id) || {})[cat] || '';
        const n = normalize(word);
        const key = stripAl(n);
        const starts = !!key && key[0] === normalize(r.letter)[0];
        normalizedByCategory[cat].push({ p, word, n, key, starts });
      }
    }

    const rows = [];
    for (const cat of CATEGORIES) {
      const arr = normalizedByCategory[cat];
      const counts = {};
      arr.forEach(e => {
        e.valid = e.starts && e.key.length >= 2 && isValidWord(cat, e.n);
        if (e.valid) counts[e.key] = (counts[e.key] || 0) + 1;
      });
      for (const e of arr) {
        let points = 0, status = 'فارغ';
        if (e.word) {
          if (!e.starts) status = 'لا يبدأ بالحرف';
          else if (e.key.length < 2) status = 'كلمة غير مكتملة';
          else if (!e.valid) status = 'كلمة غير صحيحة';
          else {
            const unique = counts[e.key] === 1;
            points = unique ? 15 : 10;
            status = unique ? 'صحيح وفريد' : 'صحيح ومكرر';
          }
        }
        e.p.score += points;
        rows.push({ playerId: e.p.id, player: e.p.name, category: cat, word: e.word, points, status });
      }
    }

    const scores = finalScores(r);
    r.lastResults = { rows, scores, canNext: true };
    io.to(r.code).emit('round_results', r.lastResults);
    broadcast(r);
  }

  function findPlayerInRoomBySocket(r, socketId) {
    for (const p of r.players.values()) if (p.socketId === socketId) return p;
    return null;
  }

  function socketIsHost(r, socketId) {
    const host = r.players.get(r.hostId);
    return host && host.socketId === socketId;
  }

  function handleDisconnect(r, playerId) {
    const player = r.players.get(playerId);
    if (!player) return;
    player.disconnected = true;
    broadcast(r);
    const timer = setTimeout(() => removePlayer(r, playerId, false), GRACE_MS);
    r.graceTimers.set(playerId, timer);
  }

  function removePlayer(r, playerId, intentional) {
    const player = r.players.get(playerId);
    if (!player) return;
    const t = r.graceTimers.get(playerId);
    if (t) { clearTimeout(t); r.graceTimers.delete(playerId); }
    r.players.delete(playerId);
    r.submissions.delete(playerId);

    if (!r.players.size) { clearInterval(r.clock); rooms.delete(r.code); return; }

    if (r.hostId === playerId) {
      if (r.round > 0 && !r.finished && !r.gameOver && !intentional) {
        io.to(r.code).emit('room_closed', { reason: 'قائد الغرفة انقطع اتصاله' });
        clearInterval(r.clock);
        rooms.delete(r.code);
        return;
      }
      r.hostId = r.players.keys().next().value;
      io.to(r.code).emit('host_changed', { hostId: r.hostId });
    }

    broadcast(r);

    if (!r.finished && r.round > 0) {
      const active = [...r.players.values()].filter(p => !p.disconnected);
      if (active.length > 0 && active.every(p => r.submissions.has(p.id))) scoreRound(r);
    }
  }

  io.on('connection', socket => {
    socket.on('create_room', ({ name }) => {
      name = String(name || '').trim().slice(0, 18);
      if (!name) return socket.emit('error_message', 'اكتب اسم اللاعب');
      const c = code();
      const r = {
        code: c, hostId: null, players: new Map(),
        round: 0, letter: '', used: new Set(),
        submissions: new Map(), finished: false, gameOver: false,
        clock: null, timeLeft: 0, lastResults: null, graceTimers: new Map(),
        settings: { ...DEFAULT_SETTINGS }
      };
      const player = newPlayer(name, socket.id);
      r.players.set(player.id, player);
      r.hostId = player.id;
      rooms.set(c, r);
      socket.join(c);
      socket.emit('room_joined', { code: c, token: player.token, playerId: player.id });
      broadcast(r);
    });

    socket.on('join_room', ({ name, code: c }) => {
      c = String(c || '').trim().toUpperCase();
      name = String(name || '').trim().slice(0, 18);
      const r = rooms.get(c);
      if (!r) return socket.emit('error_message', 'الغرفة غير موجودة');
      if (!name) return socket.emit('error_message', 'اكتب اسم اللاعب');
      if (r.players.size >= MAX_PLAYERS) return socket.emit('error_message', 'الغرفة مكتملة');
      if (r.round > 0) return socket.emit('error_message', 'اللعبة بدأت بالفعل');

      const reclaim = [...r.players.values()].find(p => p.name === name && p.disconnected);
      if (reclaim) {
        const t = r.graceTimers.get(reclaim.id);
        if (t) { clearTimeout(t); r.graceTimers.delete(reclaim.id); }
        reclaim.socketId = socket.id;
        reclaim.disconnected = false;
        socket.join(c);
        socket.emit('room_joined', { code: c, token: reclaim.token, playerId: reclaim.id });
        broadcast(r);
        return;
      }

      if ([...r.players.values()].some(p => p.name === name && !p.disconnected)) {
        return socket.emit('error_message', 'هذا الاسم مستخدم بالفعل');
      }

      const player = newPlayer(name, socket.id);
      r.players.set(player.id, player);
      socket.join(c);
      socket.emit('room_joined', { code: c, token: player.token, playerId: player.id });
      broadcast(r);
    });

    socket.on('rejoin_room', ({ code: c, token }) => {
      c = String(c || '').trim().toUpperCase();
      const r = rooms.get(c);
      if (!r) return socket.emit('rejoin_failed', { reason: 'الغرفة لم تعد موجودة' });
      const player = [...r.players.values()].find(p => p.token === token);
      if (!player) return socket.emit('rejoin_failed', { reason: 'لم يتم العثور على اللاعب' });

      const t = r.graceTimers.get(player.id);
      if (t) { clearTimeout(t); r.graceTimers.delete(player.id); }
      player.socketId = socket.id;
      player.disconnected = false;
      socket.join(c);
      socket.emit('room_joined', { code: c, token: player.token, playerId: player.id });
      broadcast(r);

      if (r.gameOver) socket.emit('game_finished', { scores: finalScores(r) });
      else if (r.finished && r.lastResults) socket.emit('round_results', r.lastResults);
      else if (r.round > 0) {
        socket.emit('game_started', { round: r.round, letter: r.letter, total: r.settings.rounds });
        socket.emit('round_tick', r.timeLeft);
        if (r.submissions.has(player.id)) socket.emit('submitted', { answers: r.submissions.get(player.id) });
      }
    });

    socket.on('start_game', ({ code: c }) => {
      const r = rooms.get(String(c || '').toUpperCase());
      if (!r || !socketIsHost(r, socket.id)) return;
      const active = [...r.players.values()].filter(p => !p.disconnected);
      if (active.length < 2) return socket.emit('error_message', 'تحتاج إلى لاعبين متصلين على الأقل');
      if (r.round === 0) startRound(r);
    });

    socket.on('update_settings', ({ code: c, rounds, seconds }) => {
      const r = rooms.get(String(c || '').toUpperCase());
      if (!r || !socketIsHost(r, socket.id) || r.round > 0) return;
      r.settings = { rounds: clamp(rounds, 3, 20), seconds: clamp(seconds, 20, 60) };
      broadcast(r);
    });

    socket.on('submit_answers', ({ code: c, answers, stop }) => {
      const r = rooms.get(String(c || '').toUpperCase());
      if (!r || r.finished || r.round === 0) return;
      const player = findPlayerInRoomBySocket(r, socket.id);
      if (!player || r.submissions.has(player.id)) return;
      const safe = {};
      for (const cat of CATEGORIES) safe[cat] = String(answers?.[cat] || '').trim().slice(0, 40);
      r.submissions.set(player.id, safe);
      socket.emit('submitted');

      const active = [...r.players.values()].filter(p => !p.disconnected);
      if (active.length > 0 && active.every(p => r.submissions.has(p.id))) return scoreRound(r);

      if (stop && CATEGORIES.every(cat => safe[cat]) && r.timeLeft > STOP_SECONDS) {
        r.timeLeft = STOP_SECONDS;
        io.to(r.code).emit('stop_called', { by: player.name });
        io.to(r.code).emit('round_tick', r.timeLeft);
      }
    });

    socket.on('accept_word', ({ code: c, index }) => {
      const r = rooms.get(String(c || '').toUpperCase());
      if (!r || !socketIsHost(r, socket.id) || !r.finished || !r.lastResults) return;
      const row = r.lastResults.rows[index];
      if (!row || row.status !== 'كلمة غير صحيحة') return;
      const p = r.players.get(row.playerId);
      if (!p) return;
      row.points = 10;
      row.status = 'مقبولة من القائد';
      p.score += 10;
      r.lastResults.scores = finalScores(r);
      io.to(r.code).emit('round_results', r.lastResults);
      broadcast(r);
    });

    socket.on('play_again', ({ code: c }) => {
      const r = rooms.get(String(c || '').toUpperCase());
      if (!r || !socketIsHost(r, socket.id) || !r.gameOver) return;
      clearInterval(r.clock);
      r.round = 0; r.letter = ''; r.used.clear(); r.submissions.clear();
      r.finished = false; r.gameOver = false; r.lastResults = null;
      for (const p of r.players.values()) p.score = 0;
      io.to(r.code).emit('back_to_lobby');
      broadcast(r);
    });

    socket.on('next_round', ({ code: c }) => {
      const r = rooms.get(String(c || '').toUpperCase());
      if (!r || !socketIsHost(r, socket.id) || !r.finished) return;
      startRound(r);
    });

    socket.on('leave_room', ({ code: c }) => {
      const r = rooms.get(String(c || '').toUpperCase());
      if (!r) return;
      const player = findPlayerInRoomBySocket(r, socket.id);
      if (player) removePlayer(r, player.id, true);
      socket.leave(c);
    });

    socket.on('disconnect', () => {
      for (const r of rooms.values()) {
        const player = findPlayerInRoomBySocket(r, socket.id);
        if (player) { handleDisconnect(r, player.id); return; }
      }
    });
  });
}

export default function handler(req, res) {
  if (res.socket.server.io) {
    res.end();
    return;
  }

  const io = new Server(res.socket.server, {
    path: '/api/socket',
    addTrailingSlash: false,
    cors: { origin: '*', methods: ['GET', 'POST'] },
    connectionStateRecovery: { maxDisconnectionDuration: 60000, skipMiddlewares: true }
  });

  res.socket.server.io = io;
  setup(io);

  res.end();
}

export const config = {
  api: { bodyParser: false }
};