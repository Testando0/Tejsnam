const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// --- CONFIGURAÇÃO DE ARQUIVOS E PASTAS ---
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const AVATAR_DIR = path.join(PUBLIC_DIR, 'avatars');

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');

// --- FUNÇÕES AUXILIARES ---
const getUsers = () => {
    try {
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        const parsed = JSON.parse(data || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error("Erro ao ler users.json:", error);
        return [];
    }
};

const saveUsers = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

const saveAvatarImage = (username, base64Data) => {
    if (!base64Data || !base64Data.startsWith('data:image')) return '';
    try {
        const matches = base64Data.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) return '';
        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const filename = `${username}_${Date.now()}.${ext}`;
        const filepath = path.join(AVATAR_DIR, filename);
        fs.writeFileSync(filepath, buffer);
        return `/avatars/${filename}`;
    } catch (e) {
        console.error("Erro ao salvar imagem:", e);
        return '';
    }
};

// --- CONFIGURAÇÃO DO SERVIDOR ---
const io = new Server(server, { 
    cors: { origin: "*" }, 
    maxHttpBufferSize: 1e8 
}); 

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

const db = new sqlite3.Database('./chat_database.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, time DATETIME DEFAULT (datetime('now')))");
    db.run("CREATE TABLE IF NOT EXISTS stories (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, content TEXT, type TEXT DEFAULT 'image', caption TEXT, bg_color TEXT, viewers TEXT DEFAULT '[]', time DATETIME DEFAULT (datetime('now')))");
});

const onlineUsers = {}; 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    socket.on('join', (username) => { 
        socket.username = username; 
        onlineUsers[username] = socket.id;
        
        let users = getUsers();
        let user = users.find(u => u.username === username);
        if (user) {
            user.is_online = true;
            saveUsers(users);
        }
        io.emit('user_status_change', { username, status: 'online' });
    });

    socket.on('send_msg', (data) => {
        const recipientSocketId = onlineUsers[data.r];
        const status = recipientSocketId ? 1 : 0; 
        
        db.run("INSERT INTO messages (s, r, c, type, status, time) VALUES (?, ?, ?, ?, ?, datetime('now'))", 
            [data.s, data.r, data.c, data.type, status], 
            function(err) {
                if(!err) {
                    const msgId = this.lastID;
                    db.get("SELECT * FROM messages WHERE id = ?", [msgId], (e, row) => {
                        if(recipientSocketId) io.to(recipientSocketId).emit('new_msg', row);
                        socket.emit('msg_sent_ok', row);
                    });
                }
            }
        );
    });

    socket.on('mark_read', (data) => {
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", [data.s, data.r], function(err) {
            if(!err && this.changes > 0 && onlineUsers[data.s]) {
                io.to(onlineUsers[data.s]).emit('msgs_read_update', { reader: data.r });
            }
        });
    });

    // WebRTC Signaling
    socket.on('call_user', (data) => {
        const recipientSocketId = onlineUsers[data.to];
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('call_incoming', {
                from: data.from,
                offer: data.offer,
                type: data.type
            });
        }
    });

    socket.on('answer_call', (data) => {
        const recipientSocketId = onlineUsers[data.to];
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('call_answered', {
                from: data.from,
                answer: data.answer
            });
        }
    });

    socket.on('ice_candidate', (data) => {
        const recipientSocketId = onlineUsers[data.to];
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('ice_candidate', {
                from: data.from,
                candidate: data.candidate
            });
        }
    });

    socket.on('end_call', (data) => {
        const recipientSocketId = onlineUsers[data.to];
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('call_ended', { from: data.from });
        }
    });

    socket.on('disconnect', () => { 
        if(socket.username) {
            delete onlineUsers[socket.username];
            let users = getUsers();
            let user = users.find(u => u.username === socket.username);
            if (user) {
                user.is_online = false;
                user.last_seen = new Date().toISOString();
                saveUsers(users);
            }
            io.emit('user_status_change', { username: socket.username, status: 'offline', last_seen: new Date().toISOString() });
        }
    });
});

// --- API DE USUÁRIOS ---
app.post('/register', async (req, res) => {
    try {
        const { username, password, display_name } = req.body;
        if(!username || !password) return res.status(400).json({error: "Dados inválidos"});
        let users = getUsers();
        if(users.find(u => u.username === username)) return res.status(400).json({error: "Usuário já existe"});
        const hash = await bcrypt.hash(password, 10);
        const newUser = {
            username: username.toLowerCase(),
            display_name: display_name || username,
            password: hash,
            bio: 'Olá! Estou usando o Telegram 2026.',
            avatar: '',
            is_verified: false,
            is_online: false,
            last_seen: null,
            bg_image: ''
        };
        users.push(newUser);
        saveUsers(users);
        res.json({ok: true});
    } catch(e) { res.status(500).send(e.message); }
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        let users = getUsers();
        const user = users.find(u => u.username === username.toLowerCase());
        if(user && await bcrypt.compare(password, user.password)) { 
            const { password, ...userSafe } = user;
            res.json(userSafe); 
        } else {
            res.status(401).json({error: "Credenciais inválidas"});
        }
    } catch (e) { res.status(500).send(); }
});

app.get('/user/:u', (req, res) => {
    const users = getUsers();
    const user = users.find(u => u.username === req.params.u.toLowerCase());
    if(user) {
        const { password, ...userSafe } = user;
        res.json(userSafe);
    } else {
        res.json({ username: req.params.u, avatar: '', is_verified: false });
    }
});

app.post('/update-profile', (req, res) => {
    const { username, bio, avatar, bg_image, display_name } = req.body;
    let users = getUsers();
    let userIndex = users.findIndex(u => u.username === username.toLowerCase());
    if(userIndex !== -1) {
        if (bio !== undefined) users[userIndex].bio = bio;
        if (display_name !== undefined) users[userIndex].display_name = display_name;
        if (bg_image !== undefined) users[userIndex].bg_image = bg_image;
        if(avatar && avatar.startsWith('data:image')) {
            const savedPath = saveAvatarImage(username, avatar);
            if(savedPath) users[userIndex].avatar = savedPath;
        } else if (avatar === "") {
            users[userIndex].avatar = "";
        }
        saveUsers(users);
        res.json({ok: true, user: users[userIndex]});
    } else {
        res.status(404).json({error: "User not found"});
    }
});

// --- API STATUS ---
app.post('/post-status', (req, res) => {
    const { username, content, type, caption, bg_color } = req.body;
    db.run("INSERT INTO stories (username, content, type, caption, bg_color, time) VALUES (?, ?, ?, ?, ?, datetime('now'))", 
        [username, content, type || 'image', caption || '', bg_color || ''], 
        function(err) {
            if(err) return res.status(500).json({error: err.message});
            res.json({ok: true});
        }
    );
});

app.get('/get-status', (req, res) => {
    db.all("SELECT * FROM stories WHERE time > datetime('now', '-24 hours') ORDER BY time ASC", (e, rows) => {
        if(e) return res.json([]);
        const users = getUsers();
        const result = rows.map(r => {
            const u = users.find(user => user.username === r.username);
            return {
                ...r,
                viewers: JSON.parse(r.viewers || "[]"),
                avatar: u ? u.avatar : '',
                display_name: u ? u.display_name : r.username
            };
        });
        res.json(result);
    });
});

app.get('/chats/:me', (req, res) => {
    const q = `
        SELECT m.id, m.s, m.r, m.c, m.type, m.status, m.time 
        FROM messages m 
        WHERE (m.s = ? OR m.r = ?)
        ORDER BY m.id DESC`;
    db.all(q, [req.params.me, req.params.me], (e, rows) => {
        if(e) return res.json([]);
        const chatsMap = {};
        rows.forEach(row => {
            const contact = row.s === req.params.me ? row.r : row.s;
            if(!chatsMap[contact]) {
                chatsMap[contact] = {
                    contact: contact,
                    last_msg: row.c,
                    last_type: row.type,
                    last_status: row.status,
                    last_sender: row.s,
                    last_time: row.time,
                    unread: 0
                };
            }
            if(row.r === req.params.me && row.s === contact && row.status < 2) {
                chatsMap[contact].unread++;
            }
        });
        const users = getUsers();
        const result = Object.values(chatsMap).map(chat => {
            const uData = users.find(u => u.username === chat.contact);
            return {
                ...chat,
                display_name: uData ? uData.display_name : chat.contact,
                avatar: uData ? uData.avatar : '',
                is_online: uData ? uData.is_online : false,
                is_verified: uData ? uData.is_verified : false
            };
        });
        res.json(result);
    });
});

app.get('/messages/:u1/:u2', (req, res) => {
    db.all("SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY id ASC", 
        [req.params.u1, req.params.u2, req.params.u2, req.params.u1], 
        (e, r) => res.json(r || [])
    );
});

server.listen(3001, () => console.log('Servidor rodando em http://localhost:3001'));
