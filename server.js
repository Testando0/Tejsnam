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
        return JSON.parse(data || '[]');
    } catch (error) {
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
        const filename = `${username}_${Date.now()}.${ext}`;
        const filepath = path.join(AVATAR_DIR, filename);
        fs.writeFileSync(filepath, Buffer.from(matches[2], 'base64'));
        return `/avatars/${filename}`;
    } catch (e) {
        return '';
    }
};

const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 }); 

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

const db = new sqlite3.Database('./chat_database.db');
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, r TEXT, c TEXT, type TEXT, status INTEGER DEFAULT 0, time TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS stories (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, content TEXT, type TEXT DEFAULT 'image', caption TEXT, bg_color TEXT, viewers TEXT DEFAULT '[]', time TEXT)");
});

const onlineUsers = {}; 

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
        const timestamp = new Date().toISOString();
        
        db.run("INSERT INTO messages (s, r, c, type, status, time) VALUES (?, ?, ?, ?, ?, ?)", 
            [data.s, data.r, data.c, data.type, status, timestamp], 
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

    socket.on('call_user', (data) => {
        if (onlineUsers[data.to]) io.to(onlineUsers[data.to]).emit('call_incoming', data);
    });
    socket.on('answer_call', (data) => {
        if (onlineUsers[data.to]) io.to(onlineUsers[data.to]).emit('call_answered', data);
    });
    socket.on('ice_candidate', (data) => {
        if (onlineUsers[data.to]) io.to(onlineUsers[data.to]).emit('ice_candidate', data);
    });
    socket.on('end_call', (data) => {
        if (onlineUsers[data.to]) io.to(onlineUsers[data.to]).emit('call_ended', data);
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

app.post('/register', async (req, res) => {
    try {
        const { username, password, display_name } = req.body;
        if(!username || !password) return res.status(400).json({error: "Dados inválidos"});
        let users = getUsers();
        const un = username.toLowerCase().trim();
        if(users.find(u => u.username === un)) return res.status(400).json({error: "Usuário já existe"});
        const hash = await bcrypt.hash(password, 10);
        const newUser = {
            username: un,
            display_name: display_name || un,
            password: hash,
            bio: 'Olá! Estou usando o Telegram 2026.',
            avatar: '',
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
        const user = users.find(u => u.username === username.toLowerCase().trim());
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
    } else res.json({ username: req.params.u, avatar: '', display_name: req.params.u });
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
        }
        saveUsers(users);
        res.json({ok: true, user: users[userIndex]});
    } else res.status(404).json({error: "User not found"});
});

app.post('/post-status', (req, res) => {
    const { username, content, type, caption } = req.body;
    const timestamp = new Date().toISOString();
    db.run("INSERT INTO stories (username, content, type, caption, time) VALUES (?, ?, ?, ?, ?)", 
        [username, content, type || 'image', caption || '', timestamp], 
        function(err) {
            if(err) return res.status(500).json({error: err.message});
            res.json({ok: true});
        }
    );
});

app.get('/get-status', (req, res) => {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    db.all("SELECT * FROM stories WHERE time > ? ORDER BY time ASC", [twentyFourHoursAgo], (e, rows) => {
        if(e) return res.json([]);
        const users = getUsers();
        const result = rows.map(r => {
            const u = users.find(user => user.username === r.username);
            return { ...r, avatar: u ? u.avatar : '', display_name: u ? u.display_name : r.username };
        });
        res.json(result);
    });
});

app.get('/chats/:me', (req, res) => {
    const q = "SELECT * FROM messages WHERE (s = ? OR r = ?) ORDER BY time DESC";
    db.all(q, [req.params.me, req.params.me], (e, rows) => {
        if(e) return res.json([]);
        const chatsMap = {};
        rows.forEach(row => {
            const contact = row.s === req.params.me ? row.r : row.s;
            if(!chatsMap[contact]) {
                chatsMap[contact] = {
                    contact, last_msg: row.c, last_time: row.time, unread: 0,
                    last_sender: row.s, last_status: row.status
                };
            }
            if(row.r === req.params.me && row.s === contact && row.status < 2) chatsMap[contact].unread++;
        });
        const users = getUsers();
        const result = Object.values(chatsMap).map(chat => {
            const u = users.find(u => u.username === chat.contact);
            return { ...chat, display_name: u ? u.display_name : chat.contact, avatar: u ? u.avatar : '', is_online: u ? u.is_online : false };
        });
        res.json(result);
    });
});

app.get('/messages/:u1/:u2', (req, res) => {
    db.all("SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", 
        [req.params.u1, req.params.u2, req.params.u2, req.params.u1], 
        (e, r) => res.json(r || [])
    );
});

server.listen(3001, () => console.log('Servidor rodando em http://localhost:3001'));