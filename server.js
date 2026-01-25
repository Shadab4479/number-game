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
// 1. Updated Time Limit to 30 Seconds
const TURN_TIME_LIMIT = 30; 

function generateRoomId() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

io.on('connection', (socket) => {
    
    // Create Room
    socket.on('createRoom', (playerName) => {
        let roomId;
        do {
            roomId = generateRoomId();
        } while (rooms[roomId]);

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

    // Join Room
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
            isSafe: false,
            score: 0,
            roomId: roomId 
        };

        socket.emit('roomJoined', { roomId, isHost: room.host === socket.id });
        io.to(roomId).emit('updatePlayerList', Object.values(room.players));
    }

    // Set Range
    socket.on('setRange', ({ roomId, range }) => {
        if (rooms[roomId] && rooms[roomId].host === socket.id) {
            rooms[roomId].range = parseInt(range);
            io.to(roomId).emit('rangeSet', rooms[roomId].range); 
        }
    });

    // Select Secret
    socket.on('selectSecret', ({ roomId, number }) => {
        const room = rooms[roomId];
        if (!room) return;

        const allPlayerIds = Object.keys(room.players);
        if (allPlayerIds.length === 2) {
            const otherPlayerId = allPlayerIds.find(id => id !== socket.id);
            if (otherPlayerId && room.players[otherPlayerId].secret == number) {
                socket.emit('selectionError', '⛔ Same number allowed nahi hai 2 players mein!');
                return; 
            }
        }

        if (room.players[socket.id]) {
            room.players[socket.id].secret = number;
            io.to(roomId).emit('updatePlayerList', Object.values(room.players));
            
            const allSelected = Object.values(room.players).every(p => p.secret !== null);
            if (allSelected) {
                io.to(room.host).emit('allReady'); 
            }
        }
    });

    // Start Game
    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (room && room.host === socket.id) {
            room.secretPhase = false;
            room.gameActive = true;
            room.turnOrder = Object.keys(room.players); 
            
            const firstPlayer = room.turnOrder[0];
            io.to(roomId).emit('gameStarted', { 
                range: room.range, 
                firstPlayer: firstPlayer,
                firstPlayerName: room.players[firstPlayer].name
            });
            startTimer(roomId);
        }
    });

    // 2. Updated Cut Number Logic
    socket.on('cutNumber', ({ roomId, number }) => {
        const room = rooms[roomId];
        if (!room || !room.gameActive) return;
        if (room.turnOrder[room.currentTurnIndex] !== socket.id) return;

        clearInterval(room.timer);
        let safeNames = [];

        Object.keys(room.players).forEach(pid => {
            const p = room.players[pid];
            // If someone matches the number, they become safe
            if (!p.isSafe && p.secret == number) {
                p.isSafe = true;
                safeNames.push(p.name);
            }
        });

        io.to(roomId).emit('numberCutResult', { number, safeNames });
        
        const unsafePlayers = Object.values(room.players).filter(p => !p.isSafe);
        
        // Check for Game Over Conditions
        if (unsafePlayers.length === 1) {
            const loser = unsafePlayers[0];
            loser.score += 1;
            io.to(roomId).emit('updatePlayerList', Object.values(room.players));
            io.to(roomId).emit('roundOver', `🔴 ${loser.name} FASS GAYA! (Loser)`);
            setTimeout(() => resetRoom(roomId), 3000);
            return;
        }

        const remainingSecrets = [...new Set(unsafePlayers.map(p => p.secret))];
        if (unsafePlayers.length > 1 && remainingSecrets.length === 1) {
            const loserNames = unsafePlayers.map(p => p.name).join(" & ");
            unsafePlayers.forEach(p => p.score += 1);
            io.to(roomId).emit('updatePlayerList', Object.values(room.players));
            io.to(roomId).emit('roundOver', `🕸️ DEADLOCK! ${loserNames} phas gaye!`);
            setTimeout(() => resetRoom(roomId), 4000);
            return;
        }
        
        if (unsafePlayers.length === 0) {
            io.to(roomId).emit('roundOver', "😲 Sab Safe? Draw.");
            setTimeout(() => resetRoom(roomId), 3000);
            return;
        }

        // If game continues, move to next UNSAFE player
        nextTurn(roomId);
    });

    // Helper: Reset Room
    function resetRoom(roomId) {
        const room = rooms[roomId];
        if(!room) return;
        room.gameActive = false;
        room.secretPhase = true;
        room.currentTurnIndex = 0;
        Object.keys(room.players).forEach(pid => {
            room.players[pid].secret = null;
            room.players[pid].isSafe = false;
        });
        io.to(roomId).emit('newRoundStart');
        io.to(roomId).emit('rangeSet', room.range); 
    }

    // Helper: Start Timer
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
        io.to(roomId).emit('message', `⏳ ${room.players[pid].name} ka turn gaya!`);
        nextTurn(roomId);
    }

    // 3. Updated Next Turn Logic (Strictly skips safe players)
    function nextTurn(roomId) {
        const room = rooms[roomId];
        let foundNextPlayer = false;
        let checks = 0;

        // Loop through turn order to find the next player who IS NOT safe
        while (!foundNextPlayer && checks < room.turnOrder.length) {
            room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
            const pid = room.turnOrder[room.currentTurnIndex];
            if (!room.players[pid].isSafe) {
                foundNextPlayer = true;
            }
            checks++;
        }

        const nextPid = room.turnOrder[room.currentTurnIndex];
        io.to(roomId).emit('turnChange', { 
            id: nextPid, 
            name: room.players[nextPid].name 
        });
        startTimer(roomId);
    }

    // Disconnect Logic
    socket.on('disconnect', () => {
        Object.keys(rooms).forEach(roomId => {
            const room = rooms[roomId];
            if (room.players[socket.id]) {
                delete room.players[socket.id];
                io.to(roomId).emit('updatePlayerList', Object.values(room.players));
                if (Object.keys(room.players).length === 0) {
                    clearInterval(room.timer);
                    delete rooms[roomId];
                }
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
