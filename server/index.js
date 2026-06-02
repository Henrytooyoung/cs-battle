const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, '../public')));

// 游戏房间管理
const rooms = new Map();
const players = new Map();

const TEAM_CT = 'ct';
const TEAM_T = 't';
const MAX_PLAYERS = 4;

function createRoom(roomId) {
  return {
    id: roomId,
    players: new Map(),
    state: 'waiting', // waiting, playing, ended
    scores: { ct: 0, t: 0 },
    round: 1,
    maxRounds: 10
  };
}

function getAvailableTeam(room) {
  let ctCount = 0, tCount = 0;
  room.players.forEach(p => {
    if (p.team === TEAM_CT) ctCount++;
    else if (p.team === TEAM_T) tCount++;
  });
  if (ctCount <= tCount) return TEAM_CT;
  return TEAM_T;
}

function getSpawnPosition(team, index) {
  const basePositions = {
    ct: [
      { x: -15, y: 1.65, z: -15 },
      { x: -12, y: 1.65, z: -15 }
    ],
    t: [
      { x: 15, y: 1.65, z: 15 },
      { x: 12, y: 1.65, z: 15 }
    ]
  };
  return basePositions[team][index % 2];
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('joinRoom', ({ roomId, playerName, character }) => {
    let room = rooms.get(roomId);
    if (!room) {
      room = createRoom(roomId);
      rooms.set(roomId, room);
    }

    if (room.players.size >= MAX_PLAYERS) {
      socket.emit('roomFull');
      return;
    }

    const team = getAvailableTeam(room);
    const teamIndex = [...room.players.values()].filter(p => p.team === team).length;
    const spawn = getSpawnPosition(team, teamIndex);

    const player = {
      id: socket.id,
      name: playerName || `Player${Math.floor(Math.random() * 1000)}`,
      character: character || 'soldier',
      team,
      hp: 100,
      maxHp: 100,
      position: spawn,
      rotation: { yaw: team === TEAM_CT ? Math.PI / 4 : -Math.PI * 3 / 4, pitch: 0 },
      ammo: 30,
      maxAmmo: 30,
      isAlive: true,
      kills: 0,
      deaths: 0
    };

    room.players.set(socket.id, player);
    players.set(socket.id, { roomId, player });
    socket.join(roomId);

    socket.emit('joinedRoom', {
      player,
      room: {
        id: room.id,
        state: room.state,
        scores: room.scores,
        round: room.round,
        players: Array.from(room.players.values())
      }
    });

    socket.to(roomId).emit('playerJoined', player);

    if (room.players.size >= 2 && room.state === 'waiting') {
      room.state = 'playing';
      io.to(roomId).emit('gameStart', { round: room.round });
    }
  });

  socket.on('playerMove', (data) => {
    const playerData = players.get(socket.id);
    if (!playerData) return;
    const { roomId, player } = playerData;
    const room = rooms.get(roomId);
    if (!room || !player.isAlive) return;

    player.position = data.position;
    player.rotation = data.rotation;

    socket.to(roomId).emit('playerMoved', {
      id: socket.id,
      position: data.position,
      rotation: data.rotation
    });
  });

  socket.on('playerShoot', (data) => {
    const playerData = players.get(socket.id);
    if (!playerData) return;
    const { roomId, player } = playerData;
    const room = rooms.get(roomId);
    if (!room || !player.isAlive || room.state !== 'playing') return;

    socket.to(roomId).emit('playerShot', { id: socket.id, direction: data.direction });

    if (data.hitPlayerId) {
      const hitPlayer = room.players.get(data.hitPlayerId);
      if (hitPlayer && hitPlayer.isAlive && hitPlayer.team !== player.team) {
        const damage = data.isHeadshot ? 70 : 25;
        hitPlayer.hp -= damage;

        io.to(roomId).emit('playerHit', {
          attackerId: socket.id,
          targetId: data.hitPlayerId,
          damage,
          isHeadshot: data.isHeadshot,
          remainingHp: hitPlayer.hp
        });

        if (hitPlayer.hp <= 0) {
          hitPlayer.isAlive = false;
          hitPlayer.deaths++;
          player.kills++;

          io.to(roomId).emit('playerKilled', {
            killerId: socket.id,
            killerName: player.name,
            victimId: data.hitPlayerId,
            victimName: hitPlayer.name,
            isHeadshot: data.isHeadshot
          });

          checkRoundEnd(room, roomId);
        }
      }
    }
  });

  socket.on('reload', () => {
    const playerData = players.get(socket.id);
    if (!playerData) return;
    const { roomId, player } = playerData;
    player.ammo = player.maxAmmo;
    socket.to(roomId).emit('playerReloaded', { id: socket.id });
  });

  socket.on('disconnect', () => {
    const playerData = players.get(socket.id);
    if (playerData) {
      const { roomId } = playerData;
      const room = rooms.get(roomId);
      if (room) {
        room.players.delete(socket.id);
        io.to(roomId).emit('playerLeft', { id: socket.id });
        if (room.players.size === 0) {
          rooms.delete(roomId);
        }
      }
    }
    players.delete(socket.id);
    console.log('Player disconnected:', socket.id);
  });
});

function checkRoundEnd(room, roomId) {
  const aliveCT = [...room.players.values()].filter(p => p.team === TEAM_CT && p.isAlive);
  const aliveT = [...room.players.values()].filter(p => p.team === TEAM_T && p.isAlive);

  if (aliveCT.length === 0 || aliveT.length === 0) {
    const winner = aliveCT.length > 0 ? TEAM_CT : TEAM_T;
    room.scores[winner]++;

    io.to(roomId).emit('roundEnd', {
      winner,
      scores: room.scores,
      round: room.round
    });

    if (room.scores.ct >= 6 || room.scores.t >= 6) {
      room.state = 'ended';
      io.to(roomId).emit('gameEnd', {
        winner: room.scores.ct >= 6 ? TEAM_CT : TEAM_T,
        scores: room.scores
      });
    } else {
      setTimeout(() => startNewRound(room, roomId), 3000);
    }
  }
}

function startNewRound(room, roomId) {
  room.round++;
  room.players.forEach((player, id) => {
    player.hp = player.maxHp;
    player.ammo = player.maxAmmo;
    player.isAlive = true;
    const teamIndex = [...room.players.values()].filter(p => p.team === player.team && p.id !== id).length;
    player.position = getSpawnPosition(player.team, teamIndex);
  });

  io.to(roomId).emit('roundStart', {
    round: room.round,
    players: Array.from(room.players.values())
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
