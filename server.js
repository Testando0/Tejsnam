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

// --- CONFIGURAÇÃO DE DIRETÓRIOS ---
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const AVATAR_DIR = path.join(PUBLIC_DIR, 'avatars');

// Garantir que pastas existam antes de qualquer operação
[PUBLIC_DIR, DATA_DIR, UPLOADS_DIR, AVATAR_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');

// --- DATABASE CORE ---
const db = new sqlite3.Database(path.join(DATA_DIR, 'chat_database.db'), (err) => {
    if (err) console.error('DB Connection Error:', err);
});

db.serialize(() => {
    // Tabelas com índices para performance e integridade
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        s TEXT NOT NULL, 
        r TEXT NOT NULL, 
        c TEXT, 
        type TEXT DEFAULT 'text', 
        status INTEGER DEFAULT 0, 
        time TEXT NOT NULL, 
        caption TEXT,
        reaction TEXT DEFAULT NULL
    )`);
    db.run("CREATE INDEX IF NOT EXISTS idx_msg_users ON messages(s, r)");
    
    db.run(`CREATE TABLE IF NOT EXISTS stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT NOT NULL, 
        content TEXT NOT NULL, 
        type TEXT, 
        caption TEXT, 
        bg_color TEXT, 
        viewers TEXT DEFAULT '[]', 
        time TEXT NOT NULL
    )`);
});

// --- USER MANAGEMENT CORE ---
const getUsers = () => {
    try {
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        return JSON.parse(data || '[]');
    } catch (e) {
        return [];
    }
};

const saveUsers = (users) => {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (e) {
        console.error('Save Users Error:', e);
    }
};

// --- SOCKET.IO CORE (MULTI-SESSION & REAL-TIME) ---
const io = new Server(server, { 
    cors: { origin: "*" }, 
    maxHttpBufferSize: 1e8, // 100MB
    pingInterval: 10000,
    pingTimeout: 5000
}); 

const onlineUsers = new Map(); // username -> Set(socketIds)

const broadcastUserStatus = (username, isOnline, lastSeen = null) => {
    io.emit('user_status_change', { 
        username: username.toLowerCase(), 
        status: isOnline ? 'online' : 'offline',
        last_seen: lastSeen || new Date().toISOString()
    });
};

io.on('connection', (socket) => {
    socket.on('join', (username) => { 
        if (!username) return;
        const un = username.toLowerCase().trim();
        socket.username = un;
        
        if (!onlineUsers.has(un)) {
            onlineUsers.set(un, new Set());
            let users = getUsers();
            let uIdx = users.findIndex(u => u.username === un);
            if (uIdx !== -1) {
                users[uIdx].is_online = true;
                saveUsers(users);
            }
        }
        onlineUsers.get(un).add(socket.id);
        broadcastUserStatus(un, true);
        console.log(`[JOIN] ${un} | Sockets: ${onlineUsers.get(un).size}`);
    });

    socket.on('send_msg', (data) => {
        if (!data.s || !data.r || !data.c) return;
        const sender = data.s.toLowerCase().trim();
        const recipient = data.r.toLowerCase().trim();
        const timestamp = new Date().toISOString();
        
        const isRecipientOnline = onlineUsers.has(recipient) && onlineUsers.get(recipient).size > 0;
        const status = isRecipientOnline ? 1 : 0; 

        let content = data.c;
        if (data.type !== 'text' && content.startsWith('data:')) {
            content = saveBase64File(content, 'uploads', sender);
        }

        db.run("INSERT INTO messages (s, r, c, type, status, time, caption) VALUES (?, ?, ?, ?, ?, ?, ?)", 
            [sender, recipient, content, data.type || 'text', status, timestamp, data.caption || ''], 
            function(err) {
                if(err) return console.error('Insert Msg Error:', err);
                
                const msgId = this.lastID;
                db.get("SELECT * FROM messages WHERE id = ?", [msgId], (e, row) => {
                    if(row) {
                        if(onlineUsers.has(recipient)) {
                            onlineUsers.get(recipient).forEach(sid => io.to(sid).emit('new_msg', row));
                        }
                        if(onlineUsers.has(sender)) {
                            onlineUsers.get(sender).forEach(sid => io.to(sid).emit('new_msg', row));
                        }
                    }
                });
            }
        );
    });

    socket.on('delete_msg', (data) => {
        const { id, username } = data;
        db.get("SELECT * FROM messages WHERE id = ?", [id], (err, row) => {
            if (row && (row.s === username || row.r === username)) {
                db.run("DELETE FROM messages WHERE id = ?", [id], (err) => {
                    if (!err) {
                        if (onlineUsers.has(row.s)) onlineUsers.get(row.s).forEach(sid => io.to(sid).emit('msg_deleted', id));
                        if (onlineUsers.has(row.r)) onlineUsers.get(row.r).forEach(sid => io.to(sid).emit('msg_deleted', id));
                    }
                });
            }
        });
    });

    socket.on('react_msg', (data) => {
        const { id, reaction, username } = data;
        db.get("SELECT * FROM messages WHERE id = ?", [id], (err, row) => {
            if (row) {
                db.run("UPDATE messages SET reaction = ? WHERE id = ?", [reaction, id], (err) => {
                    if (!err) {
                        if (onlineUsers.has(row.s)) onlineUsers.get(row.s).forEach(sid => io.to(sid).emit('msg_reacted', { id, reaction }));
                        if (onlineUsers.has(row.r)) onlineUsers.get(row.r).forEach(sid => io.to(sid).emit('msg_reacted', { id, reaction }));
                    }
                });
            }
        });
    });

    socket.on('mark_read', (data) => {
        if (!data.s || !data.r) return;
        const sender = data.s.toLowerCase().trim();
        const reader = data.r.toLowerCase().trim();
        
        db.run("UPDATE messages SET status = 2 WHERE s = ? AND r = ? AND status < 2", [sender, reader], function(err) {
            if(!err && this.changes > 0) {
                if (onlineUsers.has(sender)) {
                    onlineUsers.get(sender).forEach(sid => io.to(sid).emit('msgs_read_update', { reader, sender }));
                }
                if (onlineUsers.has(reader)) {
                    onlineUsers.get(reader).forEach(sid => io.to(sid).emit('msgs_read_update', { reader, sender }));
                }
            }
        });
    });

    socket.on('disconnect', () => { 
        if(socket.username) {
            const un = socket.username;
            if (onlineUsers.has(un)) {
                onlineUsers.get(un).delete(socket.id);
                if (onlineUsers.get(un).size === 0) {
                    onlineUsers.delete(un);
                    let users = getUsers();
                    let uIdx = users.findIndex(u => u.username === un);
                    let lastSeen = new Date().toISOString();
                    if (uIdx !== -1) {
                        users[uIdx].is_online = false;
                        users[uIdx].last_seen = lastSeen;
                        saveUsers(users);
                    }
                    broadcastUserStatus(un, false, lastSeen);
                }
            }
        }
    });
});

// --- API ENDPOINTS ---
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static('public'));

app.post('/register', async (req, res) => {
    const { username, password, display_name } = req.body;
    if (!username || !password) return res.status(400).json({error: "Campos obrigatórios"});
    
    let users = getUsers();
    const un = username.toLowerCase().trim();
    if(users.find(u => u.username === un)) return res.status(400).json({error: "Usuário já existe"});
    
    const hash = await bcrypt.hash(password, 10);
    const newUser = { 
        username: un, 
        display_name: display_name || un, 
        password: hash, 
        bio: 'Telegram 2026 Premium', 
        avatar: '', 
        bg_image: '', 
        last_seen: null,
        is_online: false
    };
    users.push(newUser);
    saveUsers(users);
    res.json({ok: true});
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = getUsers().find(u => u.username === username.toLowerCase().trim());
    if(user && await bcrypt.compare(password, user.password)) {
        const { password, ...safe } = user;
        res.json(safe);
    } else res.status(401).json({error: "Credenciais inválidas"});
});

app.get('/chats/:me', (req, res) => {
    const me = req.params.me.toLowerCase().trim();
    db.all(`
        SELECT m.*, 
        CASE WHEN s = ? THEN r ELSE s END as contact
        FROM messages m
        WHERE s = ? OR r = ?
        ORDER BY time DESC
    `, [me, me, me], (err, rows) => {
        if (err) return res.status(500).json([]);
        
        const chats = new Map();
        const users = getUsers();
        
        rows.forEach(r => {
            if (!chats.has(r.contact)) {
                const u = users.find(u => u.username === r.contact);
                chats.set(r.contact, {
                    contact: r.contact,
                    display_name: u?.display_name || r.contact,
                    avatar: u?.avatar || '',
                    is_online: u?.is_online || false,
                    last_seen: u?.last_seen || null,
                    last_msg: r.c,
                    last_time: r.time,
                    type: r.type,
                    unread: 0
                });
            }
            if (r.r === me && r.status < 2) {
                chats.get(r.contact).unread++;
            }
        });
        
        res.json(Array.from(chats.values()));
    });
});

app.get('/messages/:u1/:u2', (req, res) => {
    const u1 = req.params.u1.toLowerCase().trim();
    const u2 = req.params.u2.toLowerCase().trim();
    db.all("SELECT * FROM messages WHERE (s=? AND r=?) OR (s=? AND r=?) ORDER BY time ASC", [u1, u2, u2, u1], (e, r) => res.json(r || []));
});

app.get('/user/:u', (req, res) => {
    const user = getUsers().find(u => u.username === req.params.u.toLowerCase().trim());
    if(user) {
        const { password, ...safe } = user;
        res.json(safe);
    } else res.status(404).json({error: "Não encontrado"});
});

app.post('/update-profile', (req, res) => {
    const { username, bio, avatar, bg_image, display_name } = req.body;
    let users = getUsers();
    let idx = users.findIndex(u => u.username === username.toLowerCase().trim());
    if(idx !== -1) {
        if(bio !== undefined) users[idx].bio = bio;
        if(display_name !== undefined) users[idx].display_name = display_name;
        if(avatar && avatar.startsWith('data:')) users[idx].avatar = saveBase64File(avatar, 'avatars', username);
        if(bg_image && bg_image.startsWith('data:')) users[idx].bg_image = saveBase64File(bg_image, 'uploads', 'bg_'+username);
        saveUsers(users);
        res.json({ok: true, user: users[idx]});
    } else res.status(404).send();
});

// --- HELPER: FILE SAVE ---
function saveBase64File(base64Data, subDir, prefix) {
    try {
        const [meta, data] = base64Data.split(';base64,');
        const ext = meta.split('/')[1].split(';')[0] || 'png';
        const filename = `${prefix}_${Date.now()}.${ext}`;
        const filepath = path.join(PUBLIC_DIR, subDir, filename);
        fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
        return `/${subDir}/${filename}`;
    } catch (e) {
        return '';
    }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[SERVER] Running on port ${PORT}`));
