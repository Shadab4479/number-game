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
            isSafe: false,
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

    // 4. Select Secret (NEW LOGIC ADDED HERE)
    socket.on('selectSecret', ({ roomId, number }) => {
        const room = rooms[roomId];
        if (!room) return;

        // --- NEW RULE: 2 Players Conflict Check ---
        const allPlayerIds = Object.keys(room.players);
        
        if (allPlayerIds.length === 2) {
            // Check agar dusre player ne same number liya hai
            const otherPlayerId = allPlayerIds.find(id => id !== socket.id);
            if (otherPlayerId && room.players[otherPlayerId].secret == number) {
                // Conflict!
                socket.emit('message', '⚠️ 2 Players mein Same Number allowed nahi hai! Doosra chuno.');
                return; // Stop here, don't set secret
            }
        }

        // Agar 3+ players hain, ya number unique hai -> Set Secret
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

    // 6. CUT NUMBER LOGIC (UPDATED FOR DEADLOCK)
    socket.on('cutNumber', ({ roomId, number }) => {
        const room = rooms[roomId];
        if (!room || !room.gameActive) return;
        if (room.turnOrder[room.currentTurnIndex] !== socket.id) return;

        clearInterval(room.timer);
        let safeNames = [];

        // Step A: Check who becomes Safe
        Object.keys(room.players).forEach(pid => {
            const p = room.players[pid];
            if (!p.isSafe && p.secret == number) {
                p.isSafe = true; // Player Saved!
                safeNames.push(p.name);
            }
        });

        io.to(roomId).emit('numberCutResult', { number, safeNames });
        
        // Step B: Check Game Over Conditions
        const unsafePlayers = Object.values(room.players).filter(p => !p.isSafe);
        
        // Logic 1: Last Man Standing (Example: B bacha hai, A aur C safe ho gaye)
        if (unsafePlayers.length === 1) {
            const loser = unsafePlayers[0];
            loser.score += 1; // Penalty

            io.to(roomId).emit('updatePlayerList', Object.values(room.players));
            io.to(roomId).emit('roundOver', `🔴 ${loser.name} FASS GAYA! (Loser)`);
            setTimeout(() => resetRoom(roomId), 3000);
            return;
        }

        // Logic 2: Deadlock / Same Number Trap (Example: A aur C bache hain, dono ka number 15 hai)
        // Check agar bache hue sabhi players ka secret number SAME hai
        const remainingSecrets = [...new Set(unsafePlayers.map(p => p.secret))];

        if (unsafePlayers.length > 1 && remainingSecrets.length === 1) {
            // Deadlock! Koi kisi ko nahi kaat sakta. Sab Haar Gaye.
            const loserNames = unsafePlayers.map(p => p.name).join(" & ");
            
            unsafePlayers.forEach(p => {
                p.score += 1; // Sabko loss milega
            });

            io.to(roomId).emit('updatePlayerList', Object.values(room.players));
            io.to(roomId).emit('roundOver', `🕸️ DEADLOCK! ${loserNames} sab phas gaye! (Sabka number same tha)`);
            setTimeout(() => resetRoom(roomId), 4000); // Thoda zyada time padhne ke liye
            return;
        }
        
        // Logic 3: Rare Case (Sab safe ho gaye - Draw)
        if (unsafePlayers.length === 0) {
            io.to(roomId).emit('roundOver', "😲 Sab Safe ho gaye! Draw.");
            setTimeout(() => resetRoom(roomId), 3000);
            return;
        }

        // Step C: Game Continues
        nextTurn(roomId);
    });

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
        
        // Timeout penalty logic (Optional: +1 loss or just skip?)
        // room.players[pid].score += 1; 
        
        io.to(roomId).emit('message', `⏳ ${room.players[pid].name} so gaya! Turn skipped.`);
        nextTurn(roomId);
    }

    function nextTurn(roomId) {
        const room = rooms[roomId];
        
        let foundNextPlayer = false;
        let checks = 0;

        // Loop to find next UNSAFE player
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
