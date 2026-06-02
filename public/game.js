// CS Battle - 游戏客户端
const socket = io();

// 角色属性配置
const CHARACTER_STATS = {
    soldier: { hp: 100, speed: 5.5, damage: 25, color: 0x4a7c4e },
    sniper: { hp: 80, speed: 5.0, damage: 45, color: 0x2c3e50 },
    tank: { hp: 150, speed: 4.0, damage: 20, color: 0x7f8c8d },
    scout: { hp: 90, speed: 7.0, damage: 22, color: 0xd35400 }
};

// 游戏状态
let gameState = {
    inGame: false,
    myId: null,
    myPlayer: null,
    players: new Map(),
    room: null
};

// Three.js 变量
let scene, camera, renderer, clock;
let playerMeshes = new Map();
let gunGroup;

// 控制
const keys = { w: false, s: false, a: false, d: false };
let cameraRotation = { yaw: 0, pitch: 0 };
let lastShootTime = 0;
const SHOOT_DELAY = 150;

// UI 元素
const menu = document.getElementById('menu');
const waitingScreen = document.getElementById('waitingScreen');
const gameUI = document.getElementById('gameUI');

// 角色选择
let selectedCharacter = 'soldier';
document.querySelectorAll('.character-card').forEach(card => {
    card.addEventListener('click', () => {
        document.querySelectorAll('.character-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selectedCharacter = card.dataset.char;
    });
});

// 加入游戏
document.getElementById('joinBtn').addEventListener('click', () => {
    const playerName = document.getElementById('playerName').value.trim() || `Player${Math.floor(Math.random() * 1000)}`;
    let roomId = document.getElementById('roomId').value.trim();
    if (!roomId) roomId = 'room_' + Math.floor(Math.random() * 10000);

    document.getElementById('displayRoomId').textContent = roomId;
    menu.classList.add('hidden');
    waitingScreen.classList.remove('hidden');

    socket.emit('joinRoom', { roomId, playerName, character: selectedCharacter });
});

// Socket 事件
socket.on('joinedRoom', (data) => {
    gameState.myId = socket.id;
    gameState.myPlayer = data.player;
    gameState.room = data.room;

    updateWaitingPlayers(data.room.players);

    if (data.room.state === 'playing') {
        startGame(data.room.players);
    }
});

socket.on('playerJoined', (player) => {
    if (gameState.room) {
        gameState.room.players.push(player);
        updateWaitingPlayers(gameState.room.players);
    }
    if (gameState.inGame) {
        addPlayerMesh(player);
        updatePlayerList();
    }
});

socket.on('gameStart', () => {
    startGame(gameState.room.players);
});

socket.on('playerMoved', (data) => {
    const mesh = playerMeshes.get(data.id);
    if (mesh && data.id !== gameState.myId) {
        mesh.position.set(data.position.x, 0, data.position.z);
        mesh.rotation.y = data.rotation.yaw;
    }
    const player = gameState.players.get(data.id);
    if (player) {
        player.position = data.position;
        player.rotation = data.rotation;
    }
});

socket.on('playerShot', (data) => {
    if (data.id !== gameState.myId) {
        addMuzzleFlash(data.id);
    }
});

socket.on('playerHit', (data) => {
    if (data.targetId === gameState.myId) {
        gameState.myPlayer.hp = data.remainingHp;
        updateHealthUI();
        flashDamage();
    }
    showDamageEffect(data.targetId, data.damage, data.isHeadshot);
});

socket.on('playerKilled', (data) => {
    addKillFeed(data.killerName, data.victimName, data.isHeadshot);
    const mesh = playerMeshes.get(data.victimId);
    if (mesh) mesh.visible = false;

    const player = gameState.players.get(data.victimId);
    if (player) player.isAlive = false;

    if (data.victimId === gameState.myId) {
        showCenterMessage('你被击杀了', '#ff4444');
    }
    updatePlayerList();
});

socket.on('roundEnd', (data) => {
    const winnerText = data.winner === 'ct' ? 'CT 获胜!' : 'T 获胜!';
    const color = data.winner === 'ct' ? '#4a9eff' : '#ff6b4a';
    showCenterMessage(winnerText, color);
    updateScores(data.scores);
});

socket.on('roundStart', (data) => {
    document.getElementById('roundNum').textContent = data.round;
    hideCenterMessage();

    data.players.forEach(p => {
        const player = gameState.players.get(p.id);
        if (player) {
            Object.assign(player, p);
        }
        const mesh = playerMeshes.get(p.id);
        if (mesh) {
            mesh.visible = true;
            mesh.position.set(p.position.x, 0, p.position.z);
        }
        if (p.id === gameState.myId) {
            gameState.myPlayer = p;
            camera.position.set(p.position.x, p.position.y, p.position.z);
            cameraRotation.yaw = p.rotation.yaw;
            updateHealthUI();
            updateAmmoUI();
        }
    });
    updatePlayerList();
});

socket.on('gameEnd', (data) => {
    const winnerText = data.winner === 'ct' ? 'CT 队伍获胜!' : 'T 队伍获胜!';
    showCenterMessage(`游戏结束\n${winnerText}\n${data.scores.ct} - ${data.scores.t}`, '#ffd700');
});

socket.on('playerLeft', (data) => {
    const mesh = playerMeshes.get(data.id);
    if (mesh) {
        scene.remove(mesh);
        playerMeshes.delete(data.id);
    }
    gameState.players.delete(data.id);
    updatePlayerList();
});

socket.on('roomFull', () => {
    alert('房间已满!');
    location.reload();
});

function updateWaitingPlayers(players) {
    const container = document.getElementById('waitingPlayers');
    container.innerHTML = players.map(p =>
        `<div class="waiting-player" style="border-left: 3px solid ${p.team === 'ct' ? '#4a9eff' : '#ff6b4a'}">
            ${p.name} (${p.team.toUpperCase()}) - ${p.character}
        </div>`
    ).join('');
}

function startGame(players) {
    waitingScreen.classList.add('hidden');
    gameUI.classList.remove('hidden');
    gameState.inGame = true;

    initThreeJS();
    players.forEach(p => {
        gameState.players.set(p.id, p);
        if (p.id !== gameState.myId) {
            addPlayerMesh(p);
        }
    });

    const myPlayer = gameState.myPlayer;
    camera.position.set(myPlayer.position.x, myPlayer.position.y, myPlayer.position.z);
    cameraRotation.yaw = myPlayer.rotation.yaw;

    updateHealthUI();
    updateAmmoUI();
    updateScores(gameState.room.scores);
    updatePlayerList();

    initControls();
    animate();
}

function initThreeJS() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);
    scene.fog = new THREE.FogExp2(0x1a1a2e, 0.015);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    clock = new THREE.Clock();

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    document.body.appendChild(renderer.domElement);

    // 光照
    const ambient = new THREE.AmbientLight(0x404050, 0.6);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffeedd, 1);
    sun.position.set(10, 20, 10);
    sun.castShadow = true;
    scene.add(sun);

    // 地面
    const floorGeo = new THREE.PlaneGeometry(60, 60);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.8 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // 墙壁和掩体
    createMap();

    // 持枪模型
    createGunModel();

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

function createMap() {
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x34495e });
    const coverMat = new THREE.MeshStandardMaterial({ color: 0x7f8c8d });

    // 边界墙
    const wallGeo = new THREE.BoxGeometry(60, 4, 1);
    [[-30, 0], [30, 0], [0, -30], [0, 30]].forEach(([x, z], i) => {
        const wall = new THREE.Mesh(i < 2 ? new THREE.BoxGeometry(1, 4, 60) : wallGeo, wallMat);
        wall.position.set(x || 0, 2, z || 0);
        wall.castShadow = true;
        scene.add(wall);
    });

    // 中央掩体
    const covers = [
        { pos: [0, 0], size: [4, 2, 4] },
        { pos: [-10, -10], size: [3, 1.5, 3] },
        { pos: [10, 10], size: [3, 1.5, 3] },
        { pos: [-8, 8], size: [2, 1.2, 5] },
        { pos: [8, -8], size: [5, 1.2, 2] },
        { pos: [-15, 0], size: [2, 2, 6] },
        { pos: [15, 0], size: [2, 2, 6] },
    ];
    covers.forEach(c => {
        const geo = new THREE.BoxGeometry(...c.size);
        const mesh = new THREE.Mesh(geo, coverMat);
        mesh.position.set(c.pos[0], c.size[1] / 2, c.pos[1]);
        mesh.castShadow = true;
        scene.add(mesh);
    });
}

function createGunModel() {
    gunGroup = new THREE.Group();
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.8, roughness: 0.3 });

    // 枪身
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.5), gunMat);
    gunGroup.add(body);

    // 枪管
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.35, 8),
        new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.9 }));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.03, 0.35);
    gunGroup.add(barrel);

    // 握把
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.15, 0.08),
        new THREE.MeshStandardMaterial({ color: 0x4a3728 }));
    grip.position.set(0, -0.1, -0.1);
    grip.rotation.x = 0.2;
    gunGroup.add(grip);

    // 弹匣
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.06),
        new THREE.MeshStandardMaterial({ color: 0x1a1a1a }));
    mag.position.set(0, -0.12, 0.05);
    gunGroup.add(mag);

    // 瞄准镜
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 0.08),
        new THREE.MeshStandardMaterial({ color: 0x111111 }));
    sight.position.set(0, 0.08, 0.1);
    gunGroup.add(sight);

    gunGroup.position.set(0.25, -0.2, -0.4);
    gunGroup.rotation.set(0, -0.1, 0.05);
    camera.add(gunGroup);
    scene.add(camera);
}

function createPlayerModel(player) {
    const group = new THREE.Group();
    const stats = CHARACTER_STATS[player.character] || CHARACTER_STATS.soldier;
    const teamColor = player.team === 'ct' ? 0x4a9eff : 0xff6b4a;
    const bodyColor = stats.color;

    // 腿部
    const legMat = new THREE.MeshStandardMaterial({ color: 0x2c2c2c });
    const legGeo = new THREE.CylinderGeometry(0.08, 0.1, 0.5, 8);
    const leftLeg = new THREE.Mesh(legGeo, legMat);
    leftLeg.position.set(-0.12, 0.25, 0);
    const rightLeg = new THREE.Mesh(legGeo, legMat);
    rightLeg.position.set(0.12, 0.25, 0);
    group.add(leftLeg, rightLeg);

    // 靴子
    const bootMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a });
    const bootGeo = new THREE.BoxGeometry(0.12, 0.1, 0.18);
    const leftBoot = new THREE.Mesh(bootGeo, bootMat);
    leftBoot.position.set(-0.12, 0.05, 0.03);
    const rightBoot = new THREE.Mesh(bootGeo, bootMat);
    rightBoot.position.set(0.12, 0.05, 0.03);
    group.add(leftBoot, rightBoot);

    // 身体/防弹衣
    const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.55, 0.25), bodyMat);
    torso.position.set(0, 0.8, 0);
    group.add(torso);

    // 战术背心
    const vestMat = new THREE.MeshStandardMaterial({ color: teamColor });
    const vest = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.35, 0.28), vestMat);
    vest.position.set(0, 0.85, 0);
    group.add(vest);

    // 手臂
    const armMat = new THREE.MeshStandardMaterial({ color: bodyColor });
    const armGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.4, 8);
    const leftArm = new THREE.Mesh(armGeo, armMat);
    leftArm.position.set(-0.3, 0.75, 0);
    leftArm.rotation.z = 0.3;
    const rightArm = new THREE.Mesh(armGeo, armMat);
    rightArm.position.set(0.3, 0.75, 0);
    rightArm.rotation.z = -0.3;
    group.add(leftArm, rightArm);

    // 手
    const handMat = new THREE.MeshStandardMaterial({ color: 0xe0bb87 });
    const handGeo = new THREE.SphereGeometry(0.06, 8, 8);
    const leftHand = new THREE.Mesh(handGeo, handMat);
    leftHand.position.set(-0.38, 0.55, 0.1);
    const rightHand = new THREE.Mesh(handGeo, handMat);
    rightHand.position.set(0.38, 0.55, 0.1);
    group.add(leftHand, rightHand);

    // 脖子
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.1, 8),
        new THREE.MeshStandardMaterial({ color: 0xe0bb87 }));
    neck.position.set(0, 1.1, 0);
    group.add(neck);

    // 头部
    const headMat = new THREE.MeshStandardMaterial({ color: 0xe0bb87 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), headMat);
    head.position.set(0, 1.35, 0);
    group.add(head);

    // 头盔
    const helmetMat = new THREE.MeshStandardMaterial({ color: teamColor, metalness: 0.3 });
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), helmetMat);
    helmet.position.set(0, 1.38, 0);
    group.add(helmet);

    // 护目镜
    const goggleMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.8 });
    const goggles = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.05), goggleMat);
    goggles.position.set(0, 1.35, 0.16);
    group.add(goggles);

    // 武器
    const weaponGroup = new THREE.Group();
    const gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.4),
        new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.7 }));
    weaponGroup.add(gunBody);
    const gunBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.25, 6),
        new THREE.MeshStandardMaterial({ color: 0x333333 }));
    gunBarrel.rotation.x = Math.PI / 2;
    gunBarrel.position.z = 0.3;
    weaponGroup.add(gunBarrel);
    weaponGroup.position.set(0.35, 0.65, 0.25);
    weaponGroup.rotation.y = -0.1;
    group.add(weaponGroup);

    // 名字标签
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = player.team === 'ct' ? '#4a9eff' : '#ff6b4a';
    ctx.font = 'bold 28px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(player.name, 128, 40);
    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: texture });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.position.set(0, 1.8, 0);
    sprite.scale.set(1.5, 0.4, 1);
    group.add(sprite);

    group.castShadow = true;
    return group;
}

function addPlayerMesh(player) {
    if (player.id === gameState.myId) return;
    const mesh = createPlayerModel(player);
    mesh.position.set(player.position.x, 0, player.position.z);
    mesh.rotation.y = player.rotation?.yaw || 0;
    scene.add(mesh);
    playerMeshes.set(player.id, mesh);
}

function initControls() {
    document.addEventListener('keydown', (e) => {
        const key = e.key.toLowerCase();
        if (key === 'w') keys.w = true;
        if (key === 's') keys.s = true;
        if (key === 'a') keys.a = true;
        if (key === 'd') keys.d = true;
        if (key === 'r') reload();
    });

    document.addEventListener('keyup', (e) => {
        const key = e.key.toLowerCase();
        if (key === 'w') keys.w = false;
        if (key === 's') keys.s = false;
        if (key === 'a') keys.a = false;
        if (key === 'd') keys.d = false;
    });

    renderer.domElement.addEventListener('click', () => {
        if (document.pointerLockElement !== renderer.domElement) {
            renderer.domElement.requestPointerLock();
        } else {
            shoot();
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (document.pointerLockElement === renderer.domElement) {
            cameraRotation.yaw -= (e.movementX || 0) * 0.002;
            cameraRotation.pitch -= (e.movementY || 0) * 0.002;
            cameraRotation.pitch = Math.max(-Math.PI / 2.5, Math.min(Math.PI / 2.5, cameraRotation.pitch));
        }
    });
}

function shoot() {
    if (!gameState.myPlayer?.isAlive) return;
    if (gameState.myPlayer.ammo <= 0) return;

    const now = Date.now();
    if (now - lastShootTime < SHOOT_DELAY) return;
    lastShootTime = now;

    gameState.myPlayer.ammo--;
    updateAmmoUI();

    // 枪口闪光
    addMuzzleFlash(gameState.myId);

    // 射线检测
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

    let hitPlayerId = null;
    let isHeadshot = false;

    playerMeshes.forEach((mesh, id) => {
        const player = gameState.players.get(id);
        if (!player || !player.isAlive || player.team === gameState.myPlayer.team) return;

        const intersects = raycaster.intersectObject(mesh, true);
        if (intersects.length > 0) {
            hitPlayerId = id;
            isHeadshot = intersects[0].point.y > 1.2;
        }
    });

    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    socket.emit('playerShoot', { direction, hitPlayerId, isHeadshot });
}

function reload() {
    if (gameState.myPlayer.ammo < 30) {
        gameState.myPlayer.ammo = 30;
        updateAmmoUI();
        socket.emit('reload');
    }
}

function updateMovement(delta) {
    if (!gameState.myPlayer?.isAlive) return;

    const stats = CHARACTER_STATS[gameState.myPlayer.character] || CHARACTER_STATS.soldier;
    const speed = stats.speed * delta;

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    forward.y = 0; right.y = 0;
    forward.normalize(); right.normalize();

    const move = new THREE.Vector3();
    if (keys.w) move.add(forward);
    if (keys.s) move.sub(forward);
    if (keys.d) move.add(right);
    if (keys.a) move.sub(right);
    move.multiplyScalar(speed);

    const newPos = camera.position.clone().add(move);
    newPos.x = Math.max(-28, Math.min(28, newPos.x));
    newPos.z = Math.max(-28, Math.min(28, newPos.z));
    newPos.y = 1.65;
    camera.position.copy(newPos);

    camera.quaternion.setFromEuler(new THREE.Euler(cameraRotation.pitch, cameraRotation.yaw, 0, 'YXZ'));

    gameState.myPlayer.position = { x: newPos.x, y: newPos.y, z: newPos.z };
    gameState.myPlayer.rotation = { yaw: cameraRotation.yaw, pitch: cameraRotation.pitch };

    socket.emit('playerMove', {
        position: gameState.myPlayer.position,
        rotation: gameState.myPlayer.rotation
    });
}

function updateHealthUI() {
    const hp = gameState.myPlayer?.hp || 0;
    const maxHp = gameState.myPlayer?.maxHp || 100;
    document.getElementById('healthFill').style.width = `${(hp / maxHp) * 100}%`;
    document.getElementById('healthText').textContent = Math.max(0, hp);
    document.getElementById('maxHealthText').textContent = maxHp;
}

function updateAmmoUI() {
    document.getElementById('ammoCount').textContent = gameState.myPlayer?.ammo || 0;
}

function updateScores(scores) {
    document.getElementById('scoreCT').textContent = scores.ct;
    document.getElementById('scoreT').textContent = scores.t;
}

function updatePlayerList() {
    const container = document.getElementById('playerList');
    let html = '<div style="margin-bottom:8px;font-weight:bold;color:#4a9eff">CT</div>';
    gameState.players.forEach(p => {
        if (p.team === 'ct') {
            html += `<div class="player-item ${p.isAlive ? '' : 'dead'}">${p.name} <span>${p.kills}/${p.deaths}</span></div>`;
        }
    });
    html += '<div style="margin:8px 0;font-weight:bold;color:#ff6b4a">T</div>';
    gameState.players.forEach(p => {
        if (p.team === 't') {
            html += `<div class="player-item ${p.isAlive ? '' : 'dead'}">${p.name} <span>${p.kills}/${p.deaths}</span></div>`;
        }
    });
    container.innerHTML = html;
}

function addKillFeed(killer, victim, isHeadshot) {
    const feed = document.getElementById('killFeed');
    const item = document.createElement('div');
    item.className = 'kill-item';
    item.innerHTML = `${killer} ${isHeadshot ? '💀' : '🔫'} ${victim}`;
    feed.appendChild(item);
    setTimeout(() => item.remove(), 5000);
}

function showCenterMessage(text, color = '#fff') {
    const msg = document.getElementById('centerMessage');
    msg.innerHTML = text.replace(/\n/g, '<br>');
    msg.style.color = color;
    msg.style.display = 'block';
}

function hideCenterMessage() {
    document.getElementById('centerMessage').style.display = 'none';
}

function flashDamage() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(255,0,0,0.3);pointer-events:none;z-index:100';
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), 100);
}

function addMuzzleFlash(playerId) {
    if (playerId === gameState.myId) {
        const flash = document.createElement('div');
        flash.style.cssText = 'position:fixed;bottom:45%;right:45%;width:60px;height:60px;background:radial-gradient(circle,#ffaa44,transparent);border-radius:50%;pointer-events:none;z-index:50';
        document.body.appendChild(flash);
        setTimeout(() => flash.remove(), 50);
    } else {
        const mesh = playerMeshes.get(playerId);
        if (mesh) {
            const flash = new THREE.Mesh(
                new THREE.SphereGeometry(0.15, 8, 8),
                new THREE.MeshBasicMaterial({ color: 0xffaa44 })
            );
            flash.position.set(0.4, 0.7, 0.5);
            mesh.add(flash);
            setTimeout(() => mesh.remove(flash), 50);
        }
    }
}

function showDamageEffect(targetId, damage, isHeadshot) {
    const mesh = playerMeshes.get(targetId);
    if (mesh) {
        const particle = new THREE.Mesh(
            new THREE.SphereGeometry(0.2, 6, 6),
            new THREE.MeshBasicMaterial({ color: isHeadshot ? 0xff0000 : 0xff6644 })
        );
        particle.position.copy(mesh.position);
        particle.position.y = isHeadshot ? 1.4 : 0.9;
        scene.add(particle);
        setTimeout(() => scene.remove(particle), 150);
    }
}

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    if (gameState.inGame && gameState.myPlayer?.isAlive) {
        updateMovement(delta);
    }

    renderer.render(scene, camera);
}

