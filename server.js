const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let rooms = {}; 
const TURN_TIME_LIMIT = 15;

function generateRoomId() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

io.on('connection', (socket) => {
    
    // 1. Create Room
    socket.on('createRoom', (playerName) => {
        const roomId = generateRoomId();
        rooms[roomId] = {
            id: roomId,
            players: {}, 
            host: socket.id,
            range: 20, 
            turnOrder: [],
            currentTurnIndex: 0,
            gameActive: false,
            secretPhase: true,
            timer: null
        };
        joinRoomLogic(socket, roomId, playerName);
        socket.emit('roomCreated', roomId);
    });

    // 2. Join Room
    socket.on('joinRoom', ({ name, roomId }) => {
        if (rooms[roomId]) {
            joinRoomLogic(socket, roomId, name);
        } else {
            socket.emit('errorMsg', "Invalid Room Code!");
        }
    });

    function joinRoomLogic(socket, roomId, name) {
        socket.join(roomId);
        const room = rooms[roomId];
        
        room.players[socket.id] = {
            id: socket.id,
            name: name,
            secret: null,
            isSafe: false, // Changed from 'out' to 'isSafe'
            score: 0
        };

        socket.emit('roomJoined', { roomId, isHost: room.host === socket.id });
        io.to(roomId).emit('updatePlayerList', Object.values(room.players));
    }

    // 3. Set Range
    socket.on('setRange', ({ roomId, range }) => {
        if (rooms[roomId] && rooms[roomId].host === socket.id) {
            rooms[roomId].range = parseInt(range);
            io.to(roomId).emit('rangeSet', rooms[roomId].range); 
        }
    });

    // 4. Select Secret
    socket.on('selectSecret', ({ roomId, number }) => {
        const room = rooms[roomId];
        if (!room) return;

        if (room.players[socket.id]) {
            room.players[socket.id].secret = number;
            io.to(roomId).emit('updatePlayerList', Object.values(room.players)); // Update ticks
            
            const allSelected = Object.values(room.players).every(p => p.secret !== null);
            if (allSelected) {
                io.to(room.host).emit('allReady'); 
            }
        }
    });

    // 5. Start Game
    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (room && room.host === socket.id) {
            room.secretPhase = false;
            room.gameActive = true;
            room.turnOrder = Object.keys(room.players); // Shuffle optionally
            
            // First turn logic
            const firstPlayer = room.turnOrder[0];
            io.to(roomId).emit('gameStarted', { 
                range: room.range, 
                firstPlayer: firstPlayer,
                firstPlayerName: room.players[firstPlayer].name
            });
            startTimer(roomId);
        }
    });

    // 6. CUT NUMBER LOGIC (Major Changes Here)
    socket.on('cutNumber', ({ roomId, number }) => {
        const room = rooms[roomId];
        if (!room || !room.gameActive) return;
        if (room.turnOrder[room.currentTurnIndex] !== socket.id) return;

        clearInterval(room.timer);
        let safeNames = [];

        // Check if anyone becomes SAFE
        Object.keys(room.players).forEach(pid => {
            const p = room.players[pid];
            if (!p.isSafe && p.secret == number) {
                p.isSafe = true; // They are saved!
                safeNames.push(p.name);
            }
        });

        io.to(roomId).emit('numberCutResult', { number, safeNames });
        
        // CHECK LOSE CONDITION (Are only losers left?)
        const unsafePlayers = Object.values(room.players).filter(p => !p.isSafe);
        
        // Logic: If remaining players all have the SAME secret number (or only 1 player left)
        // Then game is over because that number is the last one.
        const remainingSecrets = [...new Set(unsafePlayers.map(p => p.secret))];

        if (unsafePlayers.length > 0 && remainingSecrets.length === 1) {
            // GAME OVER - All remaining players LOSE
            const losers = unsafePlayers.map(p => p.name).join(" & ");
            
            unsafePlayers.forEach(p => {
                p.score += 1; // Add loss
            });

            io.to(roomId).emit('updatePlayerList', Object.values(room.players));
            io.to(roomId).emit('roundOver', `🔴 ${losers} LOSE! (Last Number Remained)`);
            
            // AUTO RESTART after 3 seconds
            setTimeout(() => {
                resetRoom(roomId);
            }, 3000);

        } else if (unsafePlayers.length === 0) {
            // Rare edge case: Everyone got safe simultaneously?
             resetRoom(roomId);
        } else {
            nextTurn(roomId);
        }
    });

    function resetRoom(roomId) {
        const room = rooms[roomId];
        if(!room) return;
        
        room.gameActive = false;
        room.secretPhase = true;
        room.currentTurnIndex = 0;
        
        // Reset player states but KEEP scores
        Object.keys(room.players).forEach(pid => {
            room.players[pid].secret = null;
            room.players[pid].isSafe = false;
        });

        // Send back to secret screen
        io.to(roomId).emit('newRoundStart');
        // If host, resend range just to trigger grid creation again or keep same
        io.to(roomId).emit('rangeSet', room.range); 
    }

    function startTimer(roomId) {
        const room = rooms[roomId];
        let timeLeft = TURN_TIME_LIMIT;
        io.to(roomId).emit('timerUpdate', timeLeft);

        clearInterval(room.timer);
        room.timer = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) {
                clearInterval(room.timer);
                handleTimeout(roomId);
            }
        }, 1000);
    }

    function handleTimeout(roomId) {
        const room = rooms[roomId];
        const pid = room.turnOrder[room.currentTurnIndex];
        // Note: In new logic, timeout doesn't mean OUT, just skip turn + penalty maybe?
        // Let's just add loss but keep them in game
        // room.players[pid].score += 1; 
        
        io.to(roomId).emit('message', `⏳ ${room.players[pid].name} slept! Turn skipped.`);
        // io.to(roomId).emit('updatePlayerList', Object.values(room.players));
        nextTurn(roomId);
    }

    function nextTurn(roomId) {
        const room = rooms[roomId];
        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
        
        let checks = 0;
        // Skip SAFE players (They don't need to cut numbers anymore)
        while (room.players[room.turnOrder[room.currentTurnIndex]].isSafe && checks < room.turnOrder.length) {
            room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
            checks++;
        }

        const nextPid = room.turnOrder[room.currentTurnIndex];
        io.to(roomId).emit('turnChange', { 
            id: nextPid, 
            name: room.players[nextPid].name 
        });
        startTimer(roomId);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
