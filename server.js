const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let players = {}; // Players data
let gameActive = false;
let secretPhase = false;
let turnOrder = [];
let currentTurnIndex = 0;
let numbersRange = 20; // Default
let leaderboard = {}; // Permanent scores
let turnTimer = null;
const TURN_TIME_LIMIT = 15; // Seconds

// Helper: Start Timer
function startTimer() {
    let timeLeft = TURN_TIME_LIMIT;
    io.emit('timerUpdate', timeLeft);

    clearInterval(turnTimer);
    turnTimer = setInterval(() => {
        timeLeft--;
        io.emit('timerUpdate', timeLeft);

        if (timeLeft <= 0) {
            clearInterval(turnTimer);
            handleTimeout();
        }
    }, 1000);
}

// Helper: Handle Timeout (Jab time khatam ho jaye)
function handleTimeout() {
    const currentPlayerId = turnOrder[currentTurnIndex];
    if (players[currentPlayerId]) {
        // Penalty: Add to Lost count
        leaderboard[players[currentPlayerId].name] = (leaderboard[players[currentPlayerId].name] || 0) + 1;
        io.emit('updateLeaderboard', leaderboard);
        io.emit('message', `⏳ ${players[currentPlayerId].name} ne time waste kiya! (Penalty +1)`);
    }
    nextTurn();
}

// Helper: Next Turn
function nextTurn() {
    currentTurnIndex = (currentTurnIndex + 1) % turnOrder.length;
    // Skip eliminated players
    let checks = 0;
    while (players[turnOrder[currentTurnIndex]].out && checks < turnOrder.length) {
        currentTurnIndex = (currentTurnIndex + 1) % turnOrder.length;
        checks++;
    }
    
    // Check if game over (only 1 or 0 players left)
    const activePlayers = turnOrder.filter(id => !players[id].out);
    if (activePlayers.length <= 1) {
        endGame(activePlayers);
    } else {
        const nextPlayerId = turnOrder[currentTurnIndex];
        io.emit('turnChange', nextPlayerId);
        startTimer();
    }
}

// Helper: End Game
function endGame(winners) {
    clearInterval(turnTimer);
    gameActive = false;
    secretPhase = false;
    
    // Duplicate Rule Result: Agar bache hue log fas gaye
    if (winners.length > 0) {
        let winnerNames = winners.map(id => players[id].name).join(" & ");
        io.emit('gameOver', `${winnerNames} Bach Gaye (Ya Jeet Gaye)!`);
    } else {
        io.emit('gameOver', "Sab Fas Gaye! Game Over.");
    }
}

io.on('connection', (socket) => {
    console.log('New player:', socket.id);

    socket.on('joinGame', (name) => {
        players[socket.id] = { 
            id: socket.id, 
            name: name, 
            secret: null, 
            out: false 
        };
        if (!leaderboard[name]) leaderboard[name] = 0; // Init score
        
        io.emit('updatePlayerList', Object.values(players));
        io.emit('updateLeaderboard', leaderboard);
    });

    socket.on('startGame', (range) => {
        numbersRange = parseInt(range);
        gameActive = true;
        secretPhase = true;
        turnOrder = Object.keys(players);
        
        // Reset player states for new round
        turnOrder.forEach(id => {
            players[id].secret = null;
            players[id].out = false;
        });

        io.emit('startSecretPhase', numbersRange);
    });

    socket.on('selectSecret', (number) => {
        if (!players[socket.id]) return;
        players[socket.id].secret = number;
        
        // Check if all players selected
        const allSelected = turnOrder.every(id => players[id].secret !== null);
        if (allSelected) {
            secretPhase = false;
            currentTurnIndex = 0;
            io.emit('startGamePhase', turnOrder[0]); // Start game logic
            startTimer();
        }
    });

    socket.on('cutNumber', (number) => {
        // Validation: Kya ye iski turn hai?
        if (turnOrder[currentTurnIndex] !== socket.id) return;

        clearInterval(turnTimer); // Stop timer
        let caughtPlayers = [];

        // Check kis kis ka number kata (Duplicate Rule)
        turnOrder.forEach(id => {
            if (!players[id].out && players[id].secret == number) {
                players[id].out = true;
                caughtPlayers.push(players[id].name);
                // Fasne wale ka score badhao
                leaderboard[players[id].name] = (leaderboard[players[id].name] || 0) + 1;
            }
        });

        io.emit('numberCutResult', { number, caughtPlayers });
        io.emit('updateLeaderboard', leaderboard);

        nextTurn();
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('updatePlayerList', Object.values(players));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));