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
    
    // 1. Create Room (With Collision Check)
    socket.on('createRoom', (playerName) => {
        let roomId;
        // Ensure Room ID is unique
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
            isSafe: false,
            score: 0,
            roomId: roomId // Store roomId in player object for easier cleanup
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

        // Conflict Check for 2 Players
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

    // 5. Start Game
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

    // 6. Cut Number
    socket.on('cutNumber', ({ roomId, number }) => {
        const room = rooms[roomId];
        if (!room || !room.gameActive) return;
        if (room.turnOrder[room.currentTurnIndex] !== socket.id) return;

        clearInterval(room.timer);
        let safeNames = [];

        Object.keys(room.players).forEach(pid => {
            const p = room.players[pid];
            if (!p.isSafe && p.secret == number) {
                p.isSafe = true;
                safeNames.push(p.name);
            }
        });

        io.to(roomId).emit('numberCutResult', { number, safeNames });
        
        const unsafePlayers = Object.values(room.players).filter(p => !p.isSafe);
        
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
            io.to(roomId).emit('roundOver', `🕸️ DEADLOCK! ${loserNames} phas gaye! (Same Number)`);
            setTimeout(() => resetRoom(roomId), 4000);
            return;
        }
        
        if (unsafePlayers.length === 0) {
            io.to(roomId).emit('roundOver', "😲 Sab Safe? Draw.");
            setTimeout(() => resetRoom(roomId), 3000);
            return;
        }

        nextTurn(roomId);
    });

    // --- CLEANUP LOGIC (Disconnect Handle) ---
    socket.on('disconnect', () => {
        // Find user in rooms (Scan all rooms)
        // Note: In production, we stored roomId in socket/player object to avoid scanning
        // But here we can iterate or use saved ID
        
        Object.keys(rooms).forEach(roomId => {
            const room = rooms[roomId];
            if (room.players[socket.id]) {
                const leavingPlayerName = room.players[socket.id].name;
                delete room.players[socket.id]; // Remove player

                // Notify others
                io.to(roomId).emit('updatePlayerList', Object.values(room.players));
                
                // If room is empty, DELETE ROOM to save memory
                if (Object.keys(room.players).length === 0) {
                    clearInterval(room.timer);
                    delete rooms[roomId];
                    console.log(`Room ${roomId} deleted (Empty)`);
                } else {
                    // If Host left, assign new host (Optional but good)
                    if (room.host === socket.id) {
                        const newHostId = Object.keys(room.players)[0];
                        room.host = newHostId;
                        io.to(roomId).emit('roomJoined', { roomId, isHost: false }); // Reset UI
                        io.to(newHostId).emit('roomJoined', { roomId, isHost: true }); // New Host
                    }
                }
            }
        });
    });

    // ... Helpers (resetRoom, startTimer, nextTurn) same as before ...
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
        io.to(roomId).emit('message', `⏳ ${room.players[pid].name} so gaya! Turn skipped.`);
        nextTurn(roomId);
    }

    function nextTurn(roomId) {
        const room = rooms[roomId];
        let foundNextPlayer = false;
        let checks = 0;
        while (!foundNextPlayer && checks < room.turnOrder.length) {
            room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
            const pid = room.turnOrder[room.currentTurnIndex];
            if (!room.players[pid].isSafe) foundNextPlayer = true;
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
