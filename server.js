const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Route for homepage
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Store all active rooms
let rooms = {}; 

const TURN_TIME_LIMIT = 15;

// Helper: Generate 4-digit Room Code
function generateRoomId() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 1. Create Room
    socket.on('createRoom', (playerName) => {
        const roomId = generateRoomId();
        rooms[roomId] = {
            id: roomId,
            players: {}, // { socketId: { name, secret, out, score } }
            host: socket.id,
            range: 20, // Default
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
            out: false,
            score: 0
        };

        // Notify everyone in room
        io.to(roomId).emit('updatePlayerList', Object.values(room.players));
        io.to(roomId).emit('roomJoined', { roomId, isHost: room.host === socket.id });
    }

    // 3. Host Selects Grid Size
    socket.on('setRange', ({ roomId, range }) => {
        if (rooms[roomId] && rooms[roomId].host === socket.id) {
            rooms[roomId].range = parseInt(range);
            io.to(roomId).emit('rangeSet', rooms[roomId].range); // Show secret grid to all
        }
    });

    // 4. Select Secret Number
    socket.on('selectSecret', ({ roomId, number }) => {
        const room = rooms[roomId];
        if (!room) return;

        if (room.players[socket.id]) {
            room.players[socket.id].secret = number;
            // Check if everyone selected
            const allSelected = Object.values(room.players).every(p => p.secret !== null);
            
            // Send status update (who is ready)
            io.to(roomId).emit('playerReady', socket.id);

            if (allSelected) {
                io.to(roomId).emit('allReady'); // Enable "Start Game" button for host
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
            
            io.to(roomId).emit('gameStarted', { 
                range: room.range, 
                firstPlayer: room.turnOrder[0] 
            });
            startTimer(roomId);
        }
    });

    // 6. Cut Number Logic
    socket.on('cutNumber', ({ roomId, number }) => {
        const room = rooms[roomId];
        if (!room || !room.gameActive) return;

        // Verify Turn
        if (room.turnOrder[room.currentTurnIndex] !== socket.id) return;

        clearInterval(room.timer);
        let caughtNames = [];

        // Check who got caught (Duplicate Rule)
        Object.keys(room.players).forEach(pid => {
            const p = room.players[pid];
            if (!p.out && p.secret == number) {
                p.out = true;
                p.score += 1; // Add loss
                caughtNames.push(p.name);
            }
        });

        io.to(roomId).emit('numberCutResult', { number, caughtNames });
        io.to(roomId).emit('updatePlayerList', Object.values(room.players)); // Update scores

        nextTurn(roomId);
    });

    // --- Helpers ---
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
        room.players[pid].score += 1; // Penalty
        
        io.to(roomId).emit('message', `${room.players[pid].name} time out! (+1 Loss)`);
        io.to(roomId).emit('updatePlayerList', Object.values(room.players));
        nextTurn(roomId);
    }

    function nextTurn(roomId) {
        const room = rooms[roomId];
        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
        
        // Skip eliminated players
        let activeCount = 0;
        let checks = 0;
        while (room.players[room.turnOrder[room.currentTurnIndex]].out && checks < room.turnOrder.length) {
            room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
            checks++;
        }

        // Check for Winners
        const survivors = room.turnOrder.filter(pid => !room.players[pid].out);
        if (survivors.length <= 1) {
            const winnerName = survivors.length === 1 ? room.players[survivors[0]].name : "No one";
            io.to(roomId).emit('gameOver', winnerName);
            clearInterval(room.timer);
        } else {
            const nextPid = room.turnOrder[room.currentTurnIndex];
            io.to(roomId).emit('turnChange', nextPid);
            startTimer(roomId);
        }
    }

    socket.on('disconnect', () => {
        // Simple cleanup: If host leaves, room might break (Basic version)
        // Production apps need better reconnect logic
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
