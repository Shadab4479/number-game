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
    console.log('User connected:', socket.id);

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
            out: false,
            score: 0
        };

        // --- BUG FIX IS HERE ---
        // Pehle hum 'io.to' use kar rahe the (galat), ab 'socket.emit' use karenge (sahi).
        // Isse screen sirf naye player ki update hogi, Host ki nahi.
        socket.emit('roomJoined', { roomId, isHost: room.host === socket.id });

        // Player List sabko bhejo (taaki host ko dikhe ki naya banda aaya hai)
        io.to(roomId).emit('updatePlayerList', Object.values(room.players));
    }

    // 3. Host Selects Grid Size
    socket.on('setRange', ({ roomId, range }) => {
        if (rooms[roomId] && rooms[roomId].host === socket.id) {
            rooms[roomId].range = parseInt(range);
            io.to(roomId).emit('rangeSet', rooms[roomId].range); 
        }
    });

    // 4. Select Secret Number
    socket.on('selectSecret', ({ roomId, number }) => {
        const room = rooms[roomId];
        if (!room) return;

        if (room.players[socket.id]) {
            room.players[socket.id].secret = number;
            
            // Check status
            const allPlayers = Object.values(room.players);
            const allSelected = allPlayers.every(p => p.secret !== null);
            
            // Status update (Kaun ready hai)
            io.to(roomId).emit('updatePlayerList', allPlayers);

            if (allSelected) {
                // Sirf Host ko Start Button dikhana hai
                io.to(room.host).emit('allReady'); 
            }
        }
    });

    // 5. Start Game
    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        // Security check: Sirf host start kar sakta hai
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

        if (room.turnOrder[room.currentTurnIndex] !== socket.id) return;

        clearInterval(room.timer);
        let caughtNames = [];

        Object.keys(room.players).forEach(pid => {
            const p = room.players[pid];
            if (!p.out && p.secret == number) {
                p.out = true;
                p.score += 1; 
                caughtNames.push(p.name);
            }
        });

        io.to(roomId).emit('numberCutResult', { number, caughtNames });
        io.to(roomId).emit('updatePlayerList', Object.values(room.players)); 

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
        room.players[pid].score += 1; 
        
        io.to(roomId).emit('message', `${room.players[pid].name} time out! (+1 Loss)`);
        io.to(roomId).emit('updatePlayerList', Object.values(room.players));
        nextTurn(roomId);
    }

    function nextTurn(roomId) {
        const room = rooms[roomId];
        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
        
        let activeCount = 0;
        let checks = 0;
        // Skip eliminated players
        while (room.players[room.turnOrder[room.currentTurnIndex]].out && checks < room.turnOrder.length) {
            room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
            checks++;
        }

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
        // Cleanup logic can be added here
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
