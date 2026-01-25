const socket = io();
let myRoomId = null;
let myName = "";
let myId = null;
let mySecretNumber = null;

// --- Funny Validations ---
function checkName() {
    myName = document.getElementById('username').value.trim();
    if(!myName) {
        alert("⚠️ Abe naam to daal de! Bina naam ke Ghost ban ke khelega kya? 👻");
        return false;
    }
    return true;
}

function createRoomMenu() {
    if(checkName()) socket.emit('createRoom', myName);
}

function joinRoomMenu() {
    if(checkName()) {
        document.getElementById('menu-screen').classList.add('hidden');
        document.getElementById('join-input-screen').classList.remove('hidden');
    }
}

function joinRoom() {
    const code = document.getElementById('room-code-input').value;
    if(!code) {
        alert("⚠️ Bina code ke kahan ja raha hai? Code daal! 🔑");
        return;
    }
    socket.emit('joinRoom', { name: myName, roomId: code });
}

// --- Socket Events ---
socket.on('connect', () => { myId = socket.id; });

socket.on('roomCreated', (id) => { myRoomId = id; enterLobby(id, true); });
socket.on('roomJoined', (data) => { myRoomId = data.roomId; enterLobby(data.roomId, data.isHost); });

socket.on('errorMsg', (msg) => alert(`❌ Oye! ${msg}`));

function enterLobby(id, isHost) {
    hideAll();
    document.getElementById('lobby-screen').classList.remove('hidden');
    document.getElementById('display-room-code').innerText = id;
    if(isHost) document.getElementById('host-controls').classList.remove('hidden');
}

socket.on('updatePlayerList', (players) => {
    // Leaderboard Update
    const scoreList = players.map(p => 
        `<li style="padding:10px; background:#444; margin:5px; border-radius:5px; display:flex; justify-content:space-between;">
            <span>${p.name} ${p.isSafe ? '✅' : '🤔'}</span> 
            <span style="color:#ff4757;">${p.score} L</span>
        </li>`
    ).join('');
    document.getElementById('scoreboard-list').innerHTML = scoreList;

    // Lobby Pills
    document.getElementById('lobby-pills').innerHTML = players.map(p => 
        `<div class="player-pill" style="background: var(--primary)">👤 ${p.name}</div>`
    ).join('');

    // Secret Phase Pills
    document.getElementById('secret-pills').innerHTML = players.map(p => {
        if (p.secret) return `<div class="player-pill ready">✅ ${p.name} Ready</div>`;
        return `<div class="player-pill waiting">🤔 ${p.name} Soch raha hai...</div>`;
    }).join('');
});

function setGameRange() {
    socket.emit('setRange', { roomId: myRoomId, range: document.getElementById('grid-range').value });
}

socket.on('rangeSet', (range) => {
    hideAll();
    document.getElementById('secret-screen').classList.remove('hidden');
    createGrid(range, 'secret-grid', (num, div) => {
        document.querySelectorAll('#secret-grid .cell').forEach(c => c.classList.remove('selected'));
        div.classList.add('selected');
        mySecretNumber = num;
        socket.emit('selectSecret', { roomId: myRoomId, number: num });
    });
});

socket.on('selectionError', () => {
    alert("❌ Oye! Copy mat kar, apna number chuno! 🧠");
    document.querySelectorAll('#secret-grid .cell').forEach(c => c.classList.remove('selected'));
    mySecretNumber = null;
});

socket.on('allReady', () => {
    const btn = document.getElementById('start-btn');
    btn.classList.remove('hidden');
    btn.innerText = "SAB READY! SHURU KARO! 🚀";
});

function triggerStartGame() { socket.emit('startGame', myRoomId); }

socket.on('gameStarted', ({ range, firstPlayer, firstPlayerName }) => {
    hideAll();
    document.getElementById('game-screen').classList.remove('hidden');
    createGrid(range, 'main-grid', (num) => {
        socket.emit('cutNumber', { roomId: myRoomId, number: num });
    });
    updateTurnUI(firstPlayer, firstPlayerName);
});

socket.on('turnChange', ({ id, name }) => updateTurnUI(id, name));

function updateTurnUI(id, name) {
    const msg = document.getElementById('turn-msg');
    const wrapper = document.getElementById('game-grid-wrapper');
    const grid = document.getElementById('main-grid');

    if(id === socket.id) {
        msg.innerText = "👉 TERI BAARI HAI! Maar thappa! 🎯";
        msg.style.color = "#2ecc71";
        wrapper.classList.add('my-turn-glow'); 
        grid.style.pointerEvents = 'auto';
    } else {
        msg.innerText = `⏳ ${name} dimaag laga raha hai...`;
        msg.style.color = "#ccc";
        wrapper.classList.remove('my-turn-glow');
        grid.style.pointerEvents = 'none';
    }
}

socket.on('timerUpdate', (t) => {
    const timerEl = document.getElementById('timer');
    timerEl.innerText = t;
    timerEl.style.color = t <= 5 ? "yellow" : "#ff4757";
});

socket.on('numberCutResult', ({ number, safeNames }) => {
    const cell = document.querySelectorAll('#main-grid .cell')[number-1];
    if(cell) {
        if(safeNames.length > 0) {
            cell.classList.add('safe-cut');
            showOverlay(`🥳 ${safeNames.join(', ')} nikal gaya! SAFE! 🛡️`);
        } else {
            cell.classList.add('normal-cut');
        }
    }
});

socket.on('roundOver', (msg) => showOverlay(msg));

socket.on('newRoundStart', () => {
    setTimeout(() => {
        document.getElementById('result-overlay').style.display = 'none';
        hideAll();
        document.getElementById('secret-screen').classList.remove('hidden');
        mySecretNumber = null;
        document.getElementById('my-secret-display').innerText = "My Secret: 🔒 (Hold/Click)";
    }, 1500);
});

// --- Helpers ---
function peekSecret() {
    if(!mySecretNumber) return;
    const el = document.getElementById('my-secret-display');
    el.innerText = `Tera Number: ${mySecretNumber}`;
    setTimeout(() => el.innerText = "My Secret: 🔒 (Hold/Click)", 1500);
}

function showOverlay(text) {
    const el = document.getElementById('result-overlay');
    el.innerText = text;
    el.style.display = 'block';
    setTimeout(() => { if(!text.includes("FASS")) el.style.display = 'none'; }, 2500);
}

function hideAll() { document.querySelectorAll('.container > div').forEach(d => d.classList.add('hidden')); }

function createGrid(range, id, callback) {
    const con = document.getElementById(id); con.innerHTML='';
    for(let i=1; i<=range; i++) {
        const d = document.createElement('div');
        d.className = 'cell'; d.innerText=i;
        d.onclick = () => callback(i, d);
        con.appendChild(d);
    }
}

function toggleScoreboard() {
    const modal = document.getElementById('score-modal');
    modal.style.display = modal.style.display === 'flex' ? 'none' : 'flex';
}
